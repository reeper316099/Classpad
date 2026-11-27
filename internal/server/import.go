package server

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/reeper316099/classpad/internal/importers"
	"github.com/reeper316099/classpad/internal/jsv"
	"github.com/reeper316099/classpad/internal/schema"
)

var Strategies = []string{"skip", "update_empty", "overwrite", "keep_both"}

// entityRepo is what imports need from Repo and NoteRepo.
type entityRepo interface {
	List() []*jsv.Obj
	Get(id string) *jsv.Obj
	Create(input *jsv.Obj) (*jsv.Obj, error)
	Update(id string, patch *jsv.Obj) (*jsv.Obj, error)
	Put(entity *jsv.Obj) (*jsv.Obj, error)
	Delete(id string) error
	Schema() *schema.Object
}

var allKinds = []string{"semesters", "classes", "assignments", "tasks", "readings", "notes", "journal", "contacts",
	"activities", "jobs", "admissions", "budget", "cards"}

// backupKey: backups call the cards collection "flashcards".
func backupKey(k string) string {
	if k == "cards" {
		return "flashcards"
	}
	return k
}

func (c *Context) repoByKind(k string) entityRepo {
	switch k {
	case "semesters":
		return c.Semesters
	case "classes":
		return c.Classes
	case "assignments":
		return c.Assignments
	case "tasks":
		return c.Tasks
	case "readings":
		return c.Readings
	case "notes":
		return c.Notes
	case "journal":
		return c.Journal
	case "contacts":
		return c.Contacts
	case "activities":
		return c.Activities
	case "jobs":
		return c.Jobs
	case "admissions":
		return c.Admissions
	case "budget":
		return c.Budget
	case "cards":
		return c.Cards
	}
	panic("unknown kind " + k)
}

func isEmptyValue(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case string:
		return x == ""
	case []any:
		return len(x) == 0
	}
	return v == jsv.Undefined
}

func isZip(b []byte) bool { return len(b) > 3 && b[0] == 0x50 && b[1] == 0x4b }

type importSession struct {
	id      string
	kind    string
	preview *importers.ImportPreview
	archive importers.Archive
	backup  *jsv.Obj // the parsed backup, key order kept
	at      time.Time
}

type PreviewInput struct {
	Kind         string // notion, csv, ics, markdown, json
	Data         []byte
	Text         *string
	Collection   string
	PluginID     string
	IcsAs        string
	ClassName    string
	DropTooltips *bool
}

func (in PreviewInput) text() string {
	if in.Text != nil {
		return *in.Text
	}
	return string(in.Data)
}

type ImportService struct {
	ctx  *Context
	atts *Attachments

	mu       sync.Mutex
	sessions []*importSession // insertion order, like a Map
}

func NewImportService(ctx *Context, atts *Attachments) *ImportService {
	return &ImportService{ctx: ctx, atts: atts}
}

// ------------------------------------------------------------------ preview

func (s *ImportService) Preview(in PreviewInput) (*jsv.Obj, error) {
	var preview *importers.ImportPreview
	var archive importers.Archive
	var backup *jsv.Obj
	err := func() error {
		switch {
		case in.Kind == "notion" || in.Kind == "markdown":
			if in.Data == nil || !isZip(in.Data) {
				return apiErr(422, "BAD_INPUT", "Expected a .zip export")
			}
			a, err := importers.OpenZip(in.Data)
			if err != nil {
				return err
			}
			archive = a
			if in.Kind == "notion" {
				preview = importers.PreviewNotion(a, importers.NotionOptions{KeepTooltips: in.DropTooltips != nil && !*in.DropTooltips})
			} else {
				preview = importers.PreviewMarkdownFolder(a)
			}
		case in.Kind == "csv" && in.PluginID != "":
			p, err := FindPlugin(s.ctx.Store, in.PluginID)
			if err != nil {
				return err
			}
			if p == nil {
				return apiErr(404, "NOT_FOUND", fmt.Sprintf(`plugin "%s" not found`, in.PluginID))
			}
			preview = importers.PreviewGradebook(in.text(), *p, in.ClassName)
		case in.Kind == "csv":
			if in.Collection == "" {
				return apiErr(422, "BAD_INPUT", `"collection" is required for CSV imports`)
			}
			preview = importers.PreviewCSV(in.text(), in.Collection)
		case in.Kind == "ics":
			p, err := importers.PreviewICS(in.text(), importers.ICSOptions{As: in.IcsAs, ClassName: in.ClassName})
			if err != nil {
				return err
			}
			preview = p
		default:
			b, err := importers.ParseBackup(in.text())
			if err != nil {
				return err
			}
			raw, err := jsv.Parse(in.text())
			if err != nil {
				return err
			}
			backup, _ = raw.(*jsv.Obj)
			preview = backupPreview(b)
		}
		return nil
	}()
	if err != nil {
		if _, ok := asAPI(err); ok {
			return nil, err
		}
		return nil, apiErr(422, "BAD_INPUT", err.Error())
	}
	id := NewID()
	s.mu.Lock()
	s.sessions = append(s.sessions, &importSession{id: id, kind: in.Kind, preview: preview, archive: archive, backup: backup, at: Now()})
	// the Map loop: drop the oldest while more than five are kept, and any older than an hour
	kept := s.sessions[:0]
	size := len(s.sessions)
	for _, x := range s.sessions {
		if size > 5 || Now().Sub(x.at) > time.Hour {
			size--
			continue
		}
		kept = append(kept, x)
	}
	s.sessions = kept
	s.mu.Unlock()
	out := jsv.O("previewId", id)
	sum := Summarize(preview)
	for _, k := range sum.Keys() {
		out.Set(k, sum.Get(k))
	}
	return out, nil
}

func backupPreview(b *importers.Backup) *importers.ImportPreview {
	p := &importers.ImportPreview{Source: "json", Semesters: []importers.DraftSemester{}, Classes: []importers.DraftClass{},
		Assignments: []importers.DraftAssignment{}, Tasks: []importers.DraftTask{}, Readings: []importers.DraftReading{},
		Notes: []importers.DraftNote{}, Journal: []importers.DraftJournal{}, Contacts: []importers.DraftContact{},
		Jobs: []importers.DraftJob{}, Budget: []importers.DraftBudget{}, Templates: []importers.DraftTemplate{},
		Attachments: []importers.AttachmentRef{}, Skipped: []importers.SkippedGroup{}, Mapping: []importers.MappingEntry{},
		Warnings: []importers.Warning{}, Validation: []importers.ValidationRow{}}
	when := b.ExportedAt
	if when == "" {
		when = "unknown date"
	}
	p.Warnings = append(p.Warnings, importers.Warning{Code: "BACKUP", Message: fmt.Sprintf(
		"Backup from %s: %d semesters, %d classes, %d assignments, %d notes",
		when, len(b.Semesters), len(b.Classes), len(b.Assignments), len(b.Notes))})
	return p
}

func first500[T any](xs []T, f func(T) string) []any {
	out := []any{}
	for i, x := range xs {
		if i == 500 {
			break
		}
		out = append(out, f(x))
	}
	return out
}

func each[T any](xs []T, f func(T) string) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = f(x)
	}
	return out
}

// Summarize is the preview as the API returns it: counts, item titles and the notes for the user.
func Summarize(p *importers.ImportPreview) *jsv.Obj {
	n := func(l int) float64 { return float64(l) }
	return jsv.O(
		"source", p.Source,
		"counts", jsv.O(
			"semesters", n(len(p.Semesters)), "classes", n(len(p.Classes)), "assignments", n(len(p.Assignments)),
			"tasks", n(len(p.Tasks)), "readings", n(len(p.Readings)), "notes", n(len(p.Notes)),
			"journal", n(len(p.Journal)), "contacts", n(len(p.Contacts)), "jobs", n(len(p.Jobs)),
			"budget", n(len(p.Budget)), "templates", n(len(p.Templates)), "attachments", n(len(p.Attachments)),
		),
		"items", jsv.O(
			"semesters", first500(p.Semesters, func(x importers.DraftSemester) string { return x.Name }),
			"classes", first500(p.Classes, func(x importers.DraftClass) string { return x.Name }),
			"assignments", first500(p.Assignments, func(x importers.DraftAssignment) string { return x.Title }),
			"tasks", first500(p.Tasks, func(x importers.DraftTask) string { return x.Title }),
			"readings", first500(p.Readings, func(x importers.DraftReading) string { return x.Title }),
			"notes", first500(p.Notes, func(x importers.DraftNote) string { return x.Title }),
			"journal", first500(p.Journal, func(x importers.DraftJournal) string { return x.Title }),
			"contacts", first500(p.Contacts, func(x importers.DraftContact) string { return x.Name }),
			"jobs", each(p.Jobs, func(j importers.DraftJob) string {
				if j.Company != "" {
					return j.Position + " @ " + j.Company
				}
				return j.Position
			}),
			"budget", each(p.Budget, func(b importers.DraftBudget) string { return b.Purchase }),
			"templates", each(p.Templates, func(t importers.DraftTemplate) string { return t.Kind + ": " + t.Name }),
		),
		"skipped", jsv.FromGo(p.Skipped),
		"mapping", jsv.FromGo(p.Mapping),
		"warnings", jsv.FromGo(p.Warnings),
		"validation", jsv.FromGo(p.Validation),
	)
}

// ------------------------------------------------------------------ commit

// manifest is what an import changed, so it can be undone.
type manifest struct{ o *jsv.Obj }

func kindsWith(f func() any) *jsv.Obj {
	o := jsv.NewObj()
	for _, k := range allKinds {
		o.Set(k, f())
	}
	return o
}

func (m manifest) id() string             { return m.o.Str("id") }
func (m manifest) suffix() string         { return strings.ToLower(m.id()[len(m.id())-6:]) }
func (m manifest) created(k string) []any { return m.o.ObjAt("created").Arr(k) }
func (m manifest) updated(k string) *jsv.Obj {
	u := m.o.ObjAt("updated")
	if u == nil {
		return nil
	}
	return u.ObjAt(k)
}
func (m manifest) addCreated(k, id string) {
	m.o.ObjAt("created").Set(k, append(m.created(k), id))
}
func (m manifest) warn(msg string) { m.o.Set("warnings", append(m.o.Arr("warnings"), msg)) }
func (m manifest) createdHas(k, id string) bool {
	for _, x := range m.created(k) {
		if x == id {
			return true
		}
	}
	return false
}

func (s *ImportService) takeSession(id string) *importSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, x := range s.sessions {
		if x.id == id {
			s.sessions = append(s.sessions[:i], s.sessions[i+1:]...)
			return x
		}
	}
	return nil
}

func (s *ImportService) Commit(previewID, strategy string) (*jsv.Obj, error) {
	sess := s.takeSession(previewID)
	if sess == nil {
		return nil, apiErr(404, "NOT_FOUND", "preview expired; run the preview again")
	}
	st := s.ctx.Store
	id := NewID()
	if _, err := st.Backup("pre-import", 20); err != nil {
		return nil, err
	}
	m := manifest{jsv.O(
		"id", id, "source", sess.kind, "strategy", strategy, "at", nowISO(),
		"created", kindsWith(func() any { return []any{} }),
		"updated", kindsWith(func() any { return jsv.NewObj() }),
		"attachments", []any{},
		"templates", jsv.O("created", []any{}, "overwritten", jsv.NewObj()),
		"warnings", []any{},
	)}
	rel := "imports/" + id + "/manifest.json"
	if err := st.WriteJSON(rel, m.o, nil); err != nil {
		return nil, err
	}
	var err error
	if sess.backup != nil {
		err = s.restoreBackup(sess.backup, strategy, m)
	} else {
		err = s.commitDrafts(sess, strategy, m)
	}
	if werr := st.WriteJSON(rel, m.o, nil); err == nil && werr != nil {
		err = werr
	}
	if err != nil {
		return nil, err
	}
	created, updated := jsv.NewObj(), jsv.NewObj()
	for _, k := range allKinds {
		created.Set(k, float64(len(m.created(k))))
		updated.Set(k, float64(m.updated(k).Len()))
	}
	warnings := []any{}
	for _, w := range sess.preview.Warnings {
		warnings = append(warnings, w.Message)
	}
	warnings = append(warnings, m.o.Arr("warnings")...)
	return jsv.O("importId", id, "strategy", strategy, "created", created, "updated", updated,
		"attachments", float64(len(m.o.Arr("attachments"))),
		"templates", float64(len(m.o.ObjAt("templates").Arr("created"))),
		"warnings", warnings), nil
}

func (s *ImportService) touch(kind, id string, patch *jsv.Obj, m manifest) error {
	repo := s.ctx.repoByKind(kind)
	if !m.createdHas(kind, id) && !m.updated(kind).Has(id) {
		m.updated(kind).Set(id, repo.Get(id).Clone())
	}
	_, err := repo.Update(id, patch)
	return err
}

// draft is a draft as a plain object, without the given keys (the `{ ref, ...rest }` spreads).
func draft(v any, drop ...string) *jsv.Obj {
	o := jsv.FromGo(v).(*jsv.Obj)
	for _, k := range drop {
		o.Delete(k)
	}
	return o
}

func undefinedIfEmpty(s string) any {
	if s == "" {
		return jsv.Undefined
	}
	return s
}

var reAttachmentRefLink = regexp.MustCompile(`\(attachment-ref:([^)\s]+)\)`)

func (s *ImportService) commitDrafts(sess *importSession, strategy string, m manifest) error {
	ctx := s.ctx
	p := sess.preview
	existing := map[string]*jsv.Obj{}
	for _, k := range allKinds {
		for _, e := range ctx.repoByKind(k).List() {
			if ref := optStr(e, "importRef"); ref != "" {
				existing[ref] = e
			}
		}
	}
	refToID := map[string]string{}
	copySuffix := "#copy-" + m.suffix()

	apply := func(kind, ref string, input *jsv.Obj) (string, error) {
		repo := ctx.repoByKind(kind)
		found := existing[ref]
		data := input.Clone().Set("importRef", ref)
		if found == nil || strategy == "keep_both" {
			if strategy == "keep_both" && found != nil {
				data.Set("importRef", ref+copySuffix)
			}
			e, err := repo.Create(data)
			if err != nil {
				return "", err
			}
			m.addCreated(kind, e.Str("id"))
			refToID[ref] = e.Str("id")
			return e.Str("id"), nil
		}
		id := found.Str("id")
		refToID[ref] = id
		if strategy == "skip" {
			return id, nil
		}
		patch := jsv.NewObj()
		for _, k := range input.Keys() {
			v := input.Get(k)
			if v == jsv.Undefined {
				continue
			}
			if strategy == "overwrite" || (isEmptyValue(found.Get(k)) && !isEmptyValue(v)) {
				patch.Set(k, v)
			}
		}
		if patch.Len() > 0 {
			if err := s.touch(kind, id, patch, m); err != nil {
				return "", err
			}
		}
		return id, nil
	}

	byName := func(kind, ref string) string {
		parts := strings.Split(ref, ":")
		want := ""
		if len(parts) > 2 {
			want = strings.Join(parts[2:], ":")
		}
		list := ctx.Semesters.List()
		if kind == "class" {
			list = ctx.Classes.List()
		}
		for _, x := range list {
			if importers.NormTitle(x.Str("name")) == want {
				return x.Str("id")
			}
			if code := optStr(x, "code"); code != "" && importers.NormTitle(code) == want {
				return x.Str("id")
			}
		}
		return ""
	}
	resolve := func(kind, ref string) string {
		if ref == "" {
			return ""
		}
		if strings.HasPrefix(ref, "name:") {
			if id, ok := refToID[ref]; ok {
				return id
			}
			return byName(kind, ref)
		}
		return refToID[ref]
	}

	// attachments
	linkFor, attIDFor := map[string]string{}, map[string]string{}
	if sess.archive != nil {
		for _, a := range p.Attachments {
			err := func() error {
				data, err := sess.archive.Read(a.ArchivePath)
				if err != nil {
					return err
				}
				rec, created, err := s.atts.Add(a.Filename, data)
				if err != nil {
					return err
				}
				if created {
					m.o.Set("attachments", append(m.o.Arr("attachments"), rec.Str("id")))
				}
				linkFor[a.ArchivePath] = AttachmentLink(rec)
				attIDFor[a.ArchivePath] = rec.Str("id")
				return nil
			}()
			if err != nil {
				m.warn(fmt.Sprintf(`Attachment "%s" skipped: %s`, a.Filename, err.Error()))
			}
		}
	}
	rewrite := func(md string) string {
		return reAttachmentRefLink.ReplaceAllStringFunc(md, func(x string) string {
			enc := reAttachmentRefLink.FindStringSubmatch(x)[1]
			path := enc
			if d, ok := jsDecodeURI(enc); ok {
				path = d
			}
			if l, ok := linkFor[path]; ok && l != "" {
				return "(" + l + ")"
			}
			return x
		})
	}

	for _, d := range p.Semesters {
		in := jsv.O("name", d.Name, "start", undefinedIfEmpty(d.Start), "end", undefinedIfEmpty(d.End),
			"isCurrent", d.IsCurrent, "goals", jsv.FromGo(d.Goals))
		if _, err := apply("semesters", d.Ref, in); err != nil {
			return err
		}
	}
	fallbackSemester := ""
	defaultSemester := func() (string, error) {
		if fallbackSemester != "" {
			return fallbackSemester, nil
		}
		var cur *jsv.Obj
		list := ctx.Semesters.List()
		for _, x := range list {
			if x.Bool("isCurrent") {
				cur = x
				break
			}
		}
		if cur == nil && len(list) > 0 {
			cur = list[0]
		}
		if cur != nil {
			fallbackSemester = cur.Str("id")
			return fallbackSemester, nil
		}
		id, err := apply("semesters", "import:default-semester", jsv.O("name", "Imported"))
		fallbackSemester = id
		return id, err
	}
	for _, d := range p.Classes {
		semesterID := resolve("semester", d.SemesterRef)
		if semesterID == "" {
			var err error
			if semesterID, err = defaultSemester(); err != nil {
				return err
			}
		}
		in := draft(d, "ref", "semesterRef", "syllabusPath")
		in.Set("semesterId", semesterID)
		var syl any = jsv.Undefined
		if d.SyllabusPath != "" {
			if id, ok := attIDFor[d.SyllabusPath]; ok {
				syl = id
			}
		}
		in.Set("syllabusAttachmentId", syl)
		if _, err := apply("classes", d.Ref, in); err != nil {
			return err
		}
	}
	unassigned := ""
	unassignedClass := func() (string, error) {
		if unassigned != "" {
			return unassigned, nil
		}
		sem, err := defaultSemester()
		if err != nil {
			return "", err
		}
		unassigned, err = apply("classes", "import:unassigned-class", jsv.O("name", "Unassigned", "semesterId", sem,
			"color", "#94a3b8", "includeInGpa", false,
			"quickNotes", "Imported items that had no class. Move them to the right class."))
		return unassigned, err
	}
	for _, d := range p.Assignments {
		classID := resolve("class", d.ClassRef)
		if classID == "" {
			var err error
			if classID, err = unassignedClass(); err != nil {
				return err
			}
			m.warn(fmt.Sprintf(`Assignment "%s" has no matching class; placed in "Unassigned"`, d.Title))
		}
		in := draft(d, "ref", "classRef", "filePaths")
		ids := []any{}
		for _, f := range d.FilePaths {
			if id := attIDFor[f]; id != "" {
				ids = append(ids, id)
			}
		}
		in.Set("classId", classID).Set("attachmentIds", ids)
		if _, err := apply("assignments", d.Ref, in); err != nil {
			return err
		}
	}
	for _, d := range p.Readings {
		in := draft(d, "ref", "classRef").Set("classId", undefinedIfEmpty(resolve("class", d.ClassRef)))
		if _, err := apply("readings", d.Ref, in); err != nil {
			return err
		}
	}
	for _, d := range p.Tasks {
		in := draft(d, "ref", "classRef", "assignmentRef").Set("classId", undefinedIfEmpty(resolve("class", d.ClassRef)))
		var aid any = jsv.Undefined
		if d.AssignmentRef != "" {
			if id, ok := refToID[d.AssignmentRef]; ok {
				aid = id
			}
		}
		in.Set("assignmentId", aid)
		if _, err := apply("tasks", d.Ref, in); err != nil {
			return err
		}
	}
	idsFor := func(refs []string) []any {
		out := []any{}
		for _, r := range refs {
			if id := refToID[r]; id != "" {
				out = append(out, id)
			}
		}
		return out
	}
	type link struct{ aid, nid string }
	var noteLinks []link
	for _, d := range p.Notes {
		assignmentIDs := idsFor(d.AssignmentRefs)
		in := draft(d, "ref", "classRef", "assignmentRefs", "readingRefs", "markdown")
		in.Set("markdown", rewrite(d.Markdown)).Set("classId", undefinedIfEmpty(resolve("class", d.ClassRef))).
			Set("assignmentIds", assignmentIDs).Set("readingIds", idsFor(d.ReadingRefs))
		nid, err := apply("notes", d.Ref, in)
		if err != nil {
			return err
		}
		if nid != "" {
			for _, a := range assignmentIDs {
				noteLinks = append(noteLinks, link{a.(string), nid})
			}
		}
	}
	for _, l := range noteLinks {
		a := ctx.Assignments.Get(l.aid)
		if a == nil {
			continue
		}
		ids := a.Arr("noteIds")
		has := false
		for _, x := range ids {
			if x == l.nid {
				has = true
			}
		}
		if !has {
			next := append(append([]any{}, ids...), l.nid)
			if err := s.touch("assignments", l.aid, jsv.O("noteIds", next), m); err != nil {
				return err
			}
		}
	}

	// optional modules
	for _, d := range p.Journal {
		if _, err := apply("journal", d.Ref, draft(d, "ref")); err != nil {
			return err
		}
	}
	for _, d := range p.Contacts {
		in := draft(d, "ref", "classRefs").Set("classIds", idsFor(d.ClassRefs))
		if _, err := apply("contacts", d.Ref, in); err != nil {
			return err
		}
	}
	for _, d := range p.Jobs {
		if _, err := apply("jobs", d.Ref, draft(d, "ref")); err != nil {
			return err
		}
	}
	for _, d := range p.Budget {
		if _, err := apply("budget", d.Ref, draft(d, "ref")); err != nil {
			return err
		}
	}

	// templates
	tpl := m.o.ObjAt("templates")
	for _, t := range p.Templates {
		rel := "config/templates/" + t.Kind + "/" + Slugify(t.Name) + ".md"
		prev, exists, err := ctx.Store.ReadText(rel)
		if err != nil {
			return err
		}
		if exists && (strategy == "skip" || strategy == "update_empty") {
			continue
		}
		target := rel
		if exists && strategy == "keep_both" {
			target = strings.TrimSuffix(rel, ".md") + "-" + m.suffix() + ".md"
		} else if exists {
			tpl.ObjAt("overwritten").Set(rel, prev)
		}
		if !exists || target != rel {
			tpl.Set("created", append(tpl.Arr("created"), target))
		}
		if err := ctx.Store.WriteText(target, t.Markdown); err != nil {
			return err
		}
	}
	return nil
}

// jsDecodeURI is decodeURI: %XX sequences become UTF-8 text, except reserved characters, which
// stay escaped; malformed input fails.
func jsDecodeURI(s string) (string, bool) {
	const reserved = ";/?:@&=+$,#"
	hexv := func(c byte) int {
		switch {
		case c >= '0' && c <= '9':
			return int(c - '0')
		case c >= 'a' && c <= 'f':
			return int(c-'a') + 10
		case c >= 'A' && c <= 'F':
			return int(c-'A') + 10
		}
		return -1
	}
	byteAt := func(i int) (byte, bool) {
		if i+2 >= len(s) || s[i] != '%' {
			return 0, false
		}
		h, l := hexv(s[i+1]), hexv(s[i+2])
		if h < 0 || l < 0 {
			return 0, false
		}
		return byte(h<<4 | l), true
	}
	var b strings.Builder
	for i := 0; i < len(s); {
		if s[i] != '%' {
			b.WriteByte(s[i])
			i++
			continue
		}
		c, ok := byteAt(i)
		if !ok {
			return "", false
		}
		if c < 0x80 {
			if strings.IndexByte(reserved, c) >= 0 {
				b.WriteString(s[i : i+3])
			} else {
				b.WriteByte(c)
			}
			i += 3
			continue
		}
		n := 0
		switch {
		case c&0xE0 == 0xC0:
			n = 2
		case c&0xF0 == 0xE0:
			n = 3
		case c&0xF8 == 0xF0:
			n = 4
		default:
			return "", false
		}
		seq := []byte{c}
		for k := 1; k < n; k++ {
			x, ok := byteAt(i + 3*k)
			if !ok || x&0xC0 != 0x80 {
				return "", false
			}
			seq = append(seq, x)
		}
		r, size := utf8.DecodeRune(seq)
		if r == utf8.RuneError || size != n {
			return "", false
		}
		b.Write(seq)
		i += 3 * n
	}
	return b.String(), true
}

// ------------------------------------------------------------------ JSON backup restore

func (s *ImportService) restoreBackup(b *jsv.Obj, strategy string, m manifest) error {
	ctx := s.ctx
	arr := func(k string) []any {
		if a, ok := b.Get(k).([]any); ok {
			return a
		}
		return []any{}
	}
	for _, kind := range allKinds {
		repo := ctx.repoByKind(kind)
		for _, raw := range arr(backupKey(kind)) {
			e, err := schema.ParseObj(repo.Schema(), raw)
			if err != nil {
				msg := "undefined"
				var se *schema.Error
				if errors.As(err, &se) && len(se.Issues) > 0 {
					msg = se.Issues[0].Message
				}
				m.warn(fmt.Sprintf("Skipped invalid %s entry: %s", kind, msg))
				continue
			}
			id := e.Str("id")
			cur := repo.Get(id)
			err = func() error {
				switch {
				case cur == nil:
					if _, err := repo.Put(e); err != nil {
						return err
					}
					m.addCreated(kind, id)
				case strategy == "skip":
				case strategy == "keep_both":
					ref := optStr(e, "importRef")
					if !defined(e.Get("importRef")) {
						ref = id
					}
					cp := e.Clone().Set("id", NewID()).Set("importRef", ref+"#copy-"+m.suffix())
					if _, err := repo.Put(cp); err != nil {
						return err
					}
					m.addCreated(kind, cp.Str("id"))
				default:
					m.updated(kind).Set(id, cur.Clone())
					next := e
					if strategy != "overwrite" {
						next = e.Clone()
						for _, k := range cur.Keys() {
							if v := cur.Get(k); !isEmptyValue(v) {
								next.Set(k, v)
							}
						}
					}
					if _, err := repo.Put(next); err != nil {
						return err
					}
				}
				return nil
			}()
			if err != nil {
				m.warn(fmt.Sprintf(`Could not restore %s "%s": %s`, kind, id, err.Error()))
			}
		}
	}
	schemes, scales := arr("gradingSchemes"), arr("gpaScales")
	if strategy == "overwrite" && (len(schemes) > 0 || len(scales) > 0) {
		m.o.Set("config", jsv.O("schemes", deepClone(ctx.Config.Schemes()), "scales", deepClone(ctx.Config.Scales())))
		if len(schemes) > 0 {
			if _, err := ctx.Config.PutSchemes(schemes); err != nil {
				return err
			}
		}
		if len(scales) > 0 {
			if _, err := ctx.Config.PutScales(scales); err != nil {
				return err
			}
		}
	}
	if len(arr("attachments")) > 0 {
		m.warn("Attachment files are not part of JSON backups; restore them from a zip backup if needed")
	}
	return nil
}

// ------------------------------------------------------------------ undo and history

func (s *ImportService) readManifest(rel string) (*jsv.Obj, error) {
	text, ok, err := s.ctx.Store.ReadText(rel)
	if err != nil || !ok {
		return nil, err
	}
	v, err := jsv.Parse(text)
	if err != nil {
		return nil, err
	}
	o, _ := v.(*jsv.Obj)
	return o, nil
}

func (s *ImportService) History() ([]any, error) {
	files, err := s.ctx.Store.List("imports", "manifest.json", true)
	if err != nil {
		return nil, err
	}
	var rows []*jsv.Obj
	for _, f := range files {
		m, err := s.readManifest(f)
		if err != nil || m == nil {
			continue
		}
		row := jsv.O("id", m.Get("id"), "source", m.Get("source"), "at", m.Get("at"), "strategy", m.Get("strategy"))
		if defined(m.Get("undoneAt")) {
			row.Set("undoneAt", m.Get("undoneAt"))
		}
		rows = append(rows, row)
	}
	sort.SliceStable(rows, func(i, j int) bool { return localeCompare(rows[j].Str("at"), rows[i].Str("at")) < 0 })
	return listAny(rows), nil
}

var reImportID = regexp.MustCompile(`^[0-9A-Za-z]{26}$`)

var undoOrder = []string{"cards", "notes", "journal", "contacts", "activities", "jobs", "admissions", "budget",
	"tasks", "readings", "assignments", "classes", "semesters"}

func (s *ImportService) Undo(importID string) (*jsv.Obj, error) {
	if !reImportID.MatchString(importID) {
		return nil, apiErr(400, "BAD_ID", "invalid import id")
	}
	ctx := s.ctx
	rel := "imports/" + importID + "/manifest.json"
	mo, err := s.readManifest(rel)
	if err != nil {
		return nil, err
	}
	if mo == nil {
		return nil, apiErr(404, "NOT_FOUND", "import not found")
	}
	if truthy(mo.Get("undoneAt")) {
		return nil, apiErr(409, "ALREADY_UNDONE", "this import was already undone")
	}
	m := manifest{mo}
	warnings := []any{}
	if _, err := ctx.Store.Backup("pre-undo", 20); err != nil {
		return nil, err
	}
	// edited entities first (they may be parents of created ones), then the created ones, children first
	for _, kind := range allKinds {
		u := m.updated(kind)
		if u == nil {
			continue
		}
		for _, id := range u.Keys() {
			prev, ok := u.Get(id).(*jsv.Obj)
			if !ok {
				continue
			}
			if _, err := ctx.repoByKind(kind).Put(prev); err != nil {
				return nil, err
			}
		}
	}
	created := func(k string) []any {
		if c := mo.ObjAt("created"); c != nil {
			return c.Arr(k)
		}
		return nil
	}
	mine := func(k string) map[string]bool {
		out := map[string]bool{}
		for _, x := range created(k) {
			if s, ok := x.(string); ok {
				out[s] = true
			}
		}
		return out
	}
	for _, kind := range undoOrder {
		repo := ctx.repoByKind(kind)
		ids := created(kind)
		for i := len(ids) - 1; i >= 0; i-- {
			id, _ := ids[i].(string)
			if repo.Get(id) == nil {
				continue
			}
			if kind == "classes" {
				own, kept := mine("assignments"), false
				for _, a := range ctx.Assignments.List() {
					if a.Str("classId") == id && !own[a.Str("id")] {
						kept = true
						break
					}
				}
				if kept {
					warnings = append(warnings, "Kept a class that now has assignments you added")
					continue
				}
			}
			if kind == "semesters" {
				own, kept := mine("classes"), false
				for _, c := range ctx.Classes.List() {
					if c.Str("semesterId") == id && !own[c.Str("id")] {
						kept = true
						break
					}
				}
				if kept {
					warnings = append(warnings, "Kept a semester that now has classes you added")
					continue
				}
			}
			if err := repo.Delete(id); err != nil {
				return nil, err
			}
		}
	}
	for _, x := range mo.Arr("attachments") {
		id, _ := x.(string)
		if a := ctx.Attachments.Get(id); a != nil {
			if err := s.atts.Remove(a); err != nil {
				return nil, err
			}
		}
	}
	if tpl := mo.ObjAt("templates"); tpl != nil {
		for _, x := range tpl.Arr("created") {
			if err := ctx.Store.Remove(jsString(x)); err != nil {
				return nil, err
			}
		}
		if ow := tpl.ObjAt("overwritten"); ow != nil {
			for _, p := range ow.Keys() {
				if err := ctx.Store.WriteText(p, jsString(ow.Get(p))); err != nil {
					return nil, err
				}
			}
		}
	}
	if cfg := mo.ObjAt("config"); cfg != nil {
		if _, err := ctx.Config.PutSchemes(cfg.Get("schemes")); err != nil {
			return nil, err
		}
		if _, err := ctx.Config.PutScales(cfg.Get("scales")); err != nil {
			return nil, err
		}
	}
	mo.Set("undoneAt", nowISO())
	if err := ctx.Store.WriteJSON(rel, mo, nil); err != nil {
		return nil, err
	}
	return jsv.O("importId", importID, "undone", true, "warnings", warnings), nil
}

// truthy is JavaScript truthiness for JSON values.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && x == x
	}
	return v != jsv.Undefined
}

// deepClone is structuredClone for JSON values.
func deepClone(v any) any {
	out, err := jsv.Parse(jsv.Stringify(v, ""))
	if err != nil {
		return v
	}
	return out
}
