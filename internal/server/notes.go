package server

import (
	"fmt"
	"math"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/reeper316099/classpad/internal/frontmatter"
	"github.com/reeper316099/classpad/internal/jsonstore"
	"github.com/reeper316099/classpad/internal/jsv"
	"github.com/reeper316099/classpad/internal/schema"
)

const notesDir = "data/notes"

// NoteRepo keeps notes as Markdown files with YAML front matter, one folder per class.
type NoteRepo struct {
	store     *jsonstore.Store
	bus       *Bus
	classSlug func(classID string) (string, bool)

	mu         sync.Mutex
	rw         sync.RWMutex
	order      []string
	items      map[string]*jsv.Obj
	files      map[string]string
	LoadErrors []struct{ Rel, Message string }
}

func NewNoteRepo(store *jsonstore.Store, bus *Bus, classSlug func(string) (string, bool)) *NoteRepo {
	return &NoteRepo{store: store, bus: bus, classSlug: classSlug, items: map[string]*jsv.Obj{}, files: map[string]string{}}
}

func (n *NoteRepo) Name() string           { return "notes" }
func (n *NoteRepo) Schema() *schema.Object { return schema.Note }

func (n *NoteRepo) Owns(rel string) bool {
	return strings.HasPrefix(rel, notesDir+"/") && strings.HasSuffix(rel, ".md")
}

// isoValue is the TypeScript iso(): dates YAML gave as Date objects become ISO text; other values
// become strings. (The YAML core schema keeps dates as strings, so this is String(v).)
func isoValue(v any) (string, bool) {
	if v == nil {
		return "", false
	}
	return jsString(v), true
}

func (n *NoteRepo) parse(rel, text string) (*jsv.Obj, error) {
	fm, err := frontmatter.Parse(text)
	if err != nil {
		return nil, err
	}
	d := toJSV(fm.Data).(*jsv.Obj)
	now := nowISO()
	o := d.Clone()
	if v := d.Get("id"); jsv.Truthy(v) {
		o.Set("id", jsString(v))
	} else {
		o.Set("id", NewID())
	}
	if v := d.Get("title"); jsv.Truthy(v) {
		o.Set("title", jsString(v))
	} else {
		o.Set("title", strings.TrimSuffix(path.Base(rel), ".md"))
	}
	if s, ok := isoValue(d.Get("date")); ok {
		o.Set("date", s)
	} else {
		o.Set("date", jsv.Undefined)
	}
	for _, k := range []string{"createdAt", "updatedAt"} {
		if s, ok := isoValue(d.Get(k)); ok {
			o.Set(k, s)
		} else {
			o.Set(k, now)
		}
	}
	o.Set("markdown", strings.TrimPrefix(fm.Content, "\n"))
	return schema.ParseObj(schema.Note, o)
}

func (n *NoteRepo) serialize(note *jsv.Obj) string {
	fm := note.Clone()
	fm.Delete("markdown")
	return frontmatter.Stringify(note.Str("markdown"), fm)
}

func (n *NoteRepo) ValidateText(text, rel string) error {
	_, err := n.parse(rel, text)
	return err
}

var hasID = regexp.MustCompile(`(?m)^id:`)
var fenceLine = regexp.MustCompile(`(?m)^---[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*$`)

func (n *NoteRepo) Load() error {
	n.rw.Lock()
	n.order, n.items, n.files = nil, map[string]*jsv.Obj{}, map[string]string{}
	n.LoadErrors = nil
	n.rw.Unlock()
	rels, err := n.store.List(notesDir, ".md", true)
	if err != nil {
		return err
	}
	for _, rel := range rels {
		text, ok, err := n.store.ReadText(rel)
		if err != nil {
			return err
		}
		if ok {
			n.loadText(rel, text)
		}
	}
	return nil
}

func (n *NoteRepo) loadText(rel, text string) {
	parts := fenceLine.Split(text, -1)
	head := ""
	if len(parts) > 1 {
		head = parts[1]
	}
	hadID := hasID.MatchString(head)
	note, err := n.parse(rel, text)
	if err != nil {
		n.LoadErrors = append(n.LoadErrors, struct{ Rel, Message string }{rel, err.Error()})
		return
	}
	n.rw.Lock()
	id := note.Str("id")
	if _, ok := n.items[id]; !ok {
		n.order = append(n.order, id)
	}
	n.items[id] = note
	n.files[id] = rel
	n.rw.Unlock()
	if !hadID {
		n.store.WriteText(rel, n.serialize(note))
	}
}

func (n *NoteRepo) ReloadFile(rel string) (bool, error) {
	if !n.Owns(rel) {
		return false, nil
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	n.rw.Lock()
	for id, f := range n.files {
		if f == rel {
			delete(n.items, id)
			delete(n.files, id)
		}
	}
	n.compact()
	n.rw.Unlock()
	text, ok, err := n.store.ReadText(rel)
	if err != nil {
		return true, err
	}
	if ok {
		n.loadText(rel, text)
	}
	return true, nil
}

func (n *NoteRepo) compact() {
	out := n.order[:0]
	for _, id := range n.order {
		if _, ok := n.items[id]; ok {
			out = append(out, id)
		}
	}
	n.order = out
}

func (n *NoteRepo) List() []*jsv.Obj {
	n.rw.RLock()
	defer n.rw.RUnlock()
	out := make([]*jsv.Obj, 0, len(n.order))
	for _, id := range n.order {
		out = append(out, n.items[id])
	}
	return out
}

func (n *NoteRepo) Get(id string) *jsv.Obj {
	n.rw.RLock()
	defer n.rw.RUnlock()
	return n.items[id]
}

func (n *NoteRepo) FileOf(id string) string {
	n.rw.RLock()
	defer n.rw.RUnlock()
	return n.files[id]
}

func (n *NoteRepo) dirFor(note *jsv.Obj) string {
	if s, ok := n.classSlug(note.Str("classId")); ok && note.Has("classId") {
		return notesDir + "/" + s
	}
	return notesDir + "/_unfiled"
}

func (n *NoteRepo) freeFile(dir, base, ignoreID string) string {
	taken := map[string]bool{}
	n.rw.RLock()
	for id, f := range n.files {
		if id != ignoreID && path.Dir(f) == dir {
			taken[strings.TrimSuffix(path.Base(f), ".md")] = true
		}
	}
	n.rw.RUnlock()
	return dir + "/" + UniqueSlug(base, taken) + ".md"
}

func (n *NoteRepo) set(note *jsv.Obj, rel string) {
	n.rw.Lock()
	id := note.Str("id")
	if _, ok := n.items[id]; !ok {
		n.order = append(n.order, id)
	}
	n.items[id] = note
	n.files[id] = rel
	n.rw.Unlock()
}

func (n *NoteRepo) Create(input *jsv.Obj) (*jsv.Obj, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	now := nowISO()
	note, err := schema.ParseObj(schema.Note, input.Clone().Set("id", NewID()).Set("createdAt", now).Set("updatedAt", now))
	if err != nil {
		return nil, err
	}
	rel := n.freeFile(n.dirFor(note), Slugify(note.Str("title")), "")
	if err := n.store.WriteText(rel, n.serialize(note)); err != nil {
		return nil, err
	}
	n.set(note, rel)
	n.bus.Publish("created", "notes", note.Str("id"), "")
	return note, nil
}

func (n *NoteRepo) Update(id string, patch *jsv.Obj) (*jsv.Obj, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	cur := n.Get(id)
	if cur == nil {
		return nil, notFound("notes", id)
	}
	next := jsv.Merge(cur, patch)
	next.Set("id", cur.Get("id")).Set("createdAt", cur.Get("createdAt")).Set("updatedAt", nowISO())
	note, err := schema.ParseObj(schema.Note, next)
	if err != nil {
		return nil, err
	}
	oldRel := n.FileOf(id)
	dir := n.dirFor(note)
	rel := oldRel
	if path.Dir(oldRel) != dir {
		rel = n.freeFile(dir, strings.TrimSuffix(path.Base(oldRel), ".md"), id)
	}
	ops := []jsonstore.Op{{Type: "write", Rel: rel, Text: n.serialize(note)}}
	if rel != oldRel {
		ops = append(ops, jsonstore.Op{Type: "remove", Rel: oldRel})
	}
	if err := n.store.Batch(ops); err != nil {
		return nil, err
	}
	n.set(note, rel)
	n.bus.Publish("updated", "notes", id, "")
	return note, nil
}

// Put inserts or replaces a whole note (import, undo, restore).
func (n *NoteRepo) Put(entity *jsv.Obj) (*jsv.Obj, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	note, err := schema.ParseObj(schema.Note, entity)
	if err != nil {
		return nil, err
	}
	id := note.Str("id")
	oldRel := n.FileOf(id)
	dir := n.dirFor(note)
	var rel string
	switch {
	case oldRel != "" && path.Dir(oldRel) == dir:
		rel = oldRel
	case oldRel != "":
		rel = n.freeFile(dir, strings.TrimSuffix(path.Base(oldRel), ".md"), id)
	default:
		rel = n.freeFile(dir, Slugify(note.Str("title")), id)
	}
	ops := []jsonstore.Op{{Type: "write", Rel: rel, Text: n.serialize(note)}}
	if oldRel != "" && rel != oldRel {
		ops = append(ops, jsonstore.Op{Type: "remove", Rel: oldRel})
	}
	if err := n.store.Batch(ops); err != nil {
		return nil, err
	}
	n.set(note, rel)
	kind := "created"
	if oldRel != "" {
		kind = "updated"
	}
	n.bus.Publish(kind, "notes", id, "")
	return note, nil
}

func (n *NoteRepo) Delete(id string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	rel := n.FileOf(id)
	if rel == "" {
		return notFound("notes", id)
	}
	if err := n.store.Remove(rel); err != nil {
		return err
	}
	n.rw.Lock()
	delete(n.items, id)
	delete(n.files, id)
	n.compact()
	n.rw.Unlock()
	n.bus.Publish("deleted", "notes", id, "")
	return nil
}

// ---------------- study sessions ----------------

const studyDir = "data/study"
const activeTimer = studyDir + "/active.json"

// StudyRepo keeps study sessions in one JSONL file per month, plus the running timer.
type StudyRepo struct {
	store *jsonstore.Store
	bus   *Bus

	mu         sync.Mutex
	rw         sync.RWMutex
	order      []string
	items      map[string]*jsv.Obj
	files      map[string]string
	active     *jsv.Obj
	LoadErrors []string
}

func NewStudyRepo(store *jsonstore.Store, bus *Bus) *StudyRepo {
	return &StudyRepo{store: store, bus: bus, items: map[string]*jsv.Obj{}, files: map[string]string{}}
}

func (s *StudyRepo) Name() string { return "study-sessions" }

func (s *StudyRepo) Owns(rel string) bool {
	return strings.HasPrefix(rel, studyDir+"/") && strings.HasSuffix(rel, ".jsonl")
}

func (s *StudyRepo) ValidateText(text string) error {
	for _, line := range strings.Split(text, "\n") {
		if jsTrim(line) == "" {
			continue
		}
		v, err := jsv.Parse(line)
		if err != nil {
			return err
		}
		if _, err := schema.Parse(schema.StudySession, v); err != nil {
			return err
		}
	}
	return nil
}

func (s *StudyRepo) Active() *jsv.Obj {
	s.rw.RLock()
	defer s.rw.RUnlock()
	return s.active
}

func (s *StudyRepo) readActive() *jsv.Obj {
	v, err := s.store.ReadJSON(activeTimer, jsonstore.ReadOptions{Fallback: func() any { return nil }})
	if err != nil || v == nil {
		return nil
	}
	o, _ := toJSV(v).(*jsv.Obj)
	return o
}

func (s *StudyRepo) Load() error {
	s.rw.Lock()
	s.order, s.items, s.files = nil, map[string]*jsv.Obj{}, map[string]string{}
	s.rw.Unlock()
	rels, err := s.store.List(studyDir, ".jsonl", false)
	if err != nil {
		return err
	}
	for _, rel := range rels {
		if err := s.loadFile(rel); err != nil {
			return err
		}
	}
	a := s.readActive()
	s.rw.Lock()
	s.active = a
	s.rw.Unlock()
	return nil
}

func (s *StudyRepo) loadFile(rel string) error {
	s.rw.Lock()
	for id, f := range s.files {
		if f == rel {
			delete(s.items, id)
			delete(s.files, id)
		}
	}
	s.compact()
	s.rw.Unlock()
	text, ok, err := s.store.ReadText(rel)
	if err != nil || !ok {
		return err
	}
	for i, line := range strings.Split(text, "\n") {
		if jsTrim(line) == "" {
			continue
		}
		v, err := jsv.Parse(line)
		var o *jsv.Obj
		if err == nil {
			o, err = schema.ParseObj(schema.StudySession, v)
		}
		if err != nil {
			s.LoadErrors = append(s.LoadErrors, fmt.Sprintf("%s:%d: %s", rel, i+1, strings.SplitN(err.Error(), "\n", 2)[0]))
			continue
		}
		s.rw.Lock()
		id := o.Str("id")
		if _, ok := s.items[id]; !ok {
			s.order = append(s.order, id)
		}
		s.items[id] = o
		s.files[id] = rel
		s.rw.Unlock()
	}
	return nil
}

func (s *StudyRepo) compact() {
	out := s.order[:0]
	for _, id := range s.order {
		if _, ok := s.items[id]; ok {
			out = append(out, id)
		}
	}
	s.order = out
}

func (s *StudyRepo) ReloadFile(rel string) (bool, error) {
	if rel == activeTimer {
		a := s.readActive()
		s.rw.Lock()
		s.active = a
		s.rw.Unlock()
		return true, nil
	}
	if !s.Owns(rel) {
		return false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return true, s.loadFile(rel)
}

func (s *StudyRepo) List() []*jsv.Obj {
	s.rw.RLock()
	defer s.rw.RUnlock()
	out := make([]*jsv.Obj, 0, len(s.order))
	for _, id := range s.order {
		out = append(out, s.items[id])
	}
	return out
}

func (s *StudyRepo) Get(id string) *jsv.Obj {
	s.rw.RLock()
	defer s.rw.RUnlock()
	return s.items[id]
}

func monthFile(session *jsv.Obj) string {
	start := session.Str("start")
	if len(start) > 7 {
		start = start[:7]
	}
	return studyDir + "/" + start + ".jsonl"
}

// sortedLine is JSON.stringify with keys sorted (localeCompare) and undefined values dropped.
func sortedLine(o *jsv.Obj) string {
	keys := append([]string(nil), o.Keys()...)
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && localeCompare(keys[j], keys[j-1]) < 0; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	c := jsv.NewObj()
	for _, k := range keys {
		if v := o.Get(k); v != jsv.Undefined {
			c.Set(k, v)
		}
	}
	return jsv.Stringify(c, "")
}

func (s *StudyRepo) writeMonth(rel string, order []string, items map[string]*jsv.Obj, files map[string]string) error {
	var in []*jsv.Obj
	for _, id := range order {
		if e, ok := items[id]; ok && files[id] == rel {
			in = append(in, e)
		}
	}
	for i := 1; i < len(in); i++ {
		for j := i; j > 0; j-- {
			a, b := in[j], in[j-1]
			c := localeCompare(a.Str("start"), b.Str("start"))
			if c == 0 {
				c = localeCompare(a.Str("id"), b.Str("id"))
			}
			if c >= 0 {
				break
			}
			in[j], in[j-1] = in[j-1], in[j]
		}
	}
	if len(in) == 0 {
		return s.store.Remove(rel)
	}
	var lines []string
	for _, e := range in {
		lines = append(lines, sortedLine(e))
	}
	return s.store.WriteText(rel, strings.Join(lines, "\n")+"\n")
}

func (s *StudyRepo) commit(put []*jsv.Obj, del []string) error {
	s.rw.RLock()
	items := make(map[string]*jsv.Obj, len(s.items))
	files := make(map[string]string, len(s.files))
	order := append([]string(nil), s.order...)
	for k, v := range s.items {
		items[k] = v
	}
	for k, v := range s.files {
		files[k] = v
	}
	s.rw.RUnlock()
	dirty := map[string]bool{}
	var dirtyOrder []string
	mark := func(f string) {
		if !dirty[f] {
			dirty[f] = true
			dirtyOrder = append(dirtyOrder, f)
		}
	}
	for _, id := range del {
		if f, ok := files[id]; ok {
			mark(f)
		}
		delete(items, id)
		delete(files, id)
	}
	for _, e := range put {
		id := e.Str("id")
		if old, ok := files[id]; ok {
			mark(old)
		}
		f := monthFile(e)
		mark(f)
		if _, ok := items[id]; !ok {
			order = append(order, id)
		}
		items[id], files[id] = e, f
	}
	for _, rel := range dirtyOrder {
		if err := s.writeMonth(rel, order, items, files); err != nil {
			return err
		}
	}
	s.rw.Lock()
	s.items, s.files, s.order = items, files, order
	s.compact()
	s.rw.Unlock()
	return nil
}

func jsDateParse(v string) (float64, bool) {
	t, ok := parseJSDate(v)
	if !ok {
		return 0, false
	}
	return float64(t.UnixMilli()), true
}

func (s *StudyRepo) parse(input *jsv.Obj, base *jsv.Obj) (*jsv.Obj, error) {
	now := nowISO()
	merged := jsv.Merge(jsv.O("createdAt", now, "updatedAt", now), base, input)
	o, err := schema.ParseObj(schema.StudySession, merged)
	if err != nil {
		return nil, err
	}
	st, ok1 := jsDateParse(o.Str("start"))
	en, ok2 := jsDateParse(o.Str("end"))
	if !ok1 || !ok2 {
		return nil, apiErr(422, "VALIDATION", "start and end must be valid dates")
	}
	if en < st {
		return nil, apiErr(422, "VALIDATION", "end is before start")
	}
	if o.Num("minutes") > 24*60 {
		return nil, apiErr(422, "VALIDATION", "a session cannot be longer than 24 hours")
	}
	return o, nil
}

func (s *StudyRepo) Create(input *jsv.Obj) (*jsv.Obj, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := input.Clone()
	start, sok := data.Get("start").(string)
	end, eok := data.Get("end").(string)
	if (!data.Has("minutes") || data.Get("minutes") == jsv.Undefined) && sok && eok {
		a, ok1 := jsDateParse(start)
		b, ok2 := jsDateParse(end)
		if ok1 && ok2 {
			data.Set("minutes", jsRound((b-a)/60000))
		} else {
			data.Set("minutes", math.NaN()) // Math.round(NaN): the schema reports it
		}
	}
	o, err := s.parse(data.Set("id", NewID()), nil)
	if err != nil {
		return nil, err
	}
	if err := s.commit([]*jsv.Obj{o}, nil); err != nil {
		return nil, err
	}
	s.bus.Publish("created", s.Name(), o.Str("id"), "")
	return o, nil
}

func (s *StudyRepo) Update(id string, patch *jsv.Obj) (*jsv.Obj, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.Get(id)
	if cur == nil {
		return nil, notFound(s.Name(), id)
	}
	o, err := s.parse(patch.Clone().Set("id", id).Set("createdAt", cur.Get("createdAt")).Set("updatedAt", nowISO()), cur)
	if err != nil {
		return nil, err
	}
	if err := s.commit([]*jsv.Obj{o}, nil); err != nil {
		return nil, err
	}
	s.bus.Publish("updated", s.Name(), id, "")
	return o, nil
}

func (s *StudyRepo) DeleteMany(ids []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var present []string
	for _, id := range ids {
		if s.Get(id) != nil {
			present = append(present, id)
		}
	}
	if len(present) == 0 {
		return nil
	}
	if err := s.commit(nil, present); err != nil {
		return err
	}
	for _, id := range present {
		s.bus.Publish("deleted", s.Name(), id, "")
	}
	return nil
}

func (s *StudyRepo) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Get(id) == nil {
		return notFound(s.Name(), id)
	}
	if err := s.commit(nil, []string{id}); err != nil {
		return err
	}
	s.bus.Publish("deleted", s.Name(), id, "")
	return nil
}

// StartTimer starts the study timer (only one at a time).
func (s *StudyRepo) StartTimer(t *jsv.Obj) (*jsv.Obj, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Active() != nil {
		return nil, apiErr(409, "ALREADY_RUNNING", "A study timer is already running")
	}
	a := t.Clone().Set("start", nowISO())
	if err := s.store.WriteJSON(activeTimer, a, nil); err != nil {
		return nil, err
	}
	s.rw.Lock()
	s.active = a
	s.rw.Unlock()
	s.bus.Publish("updated", s.Name(), "", "")
	return a, nil
}

// StopTimer stops the timer and logs the session; under 30 seconds it is discarded (nil).
func (s *StudyRepo) StopTimer(now time.Time) (*jsv.Obj, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.Active()
	if a == nil {
		return nil, apiErr(409, "NOT_RUNNING", "No study timer is running")
	}
	s.rw.Lock()
	s.active = nil
	s.rw.Unlock()
	if err := s.store.Remove(activeTimer); err != nil {
		return nil, err
	}
	startMs, _ := jsDateParse(a.Str("start"))
	ms := float64(now.UnixMilli()) - startMs
	if ms < 30000 {
		s.bus.Publish("updated", s.Name(), "", "")
		return nil, nil
	}
	in := jsv.O("id", NewID(), "start", a.Str("start"), "end", ISO(now),
		"minutes", max(1, jsRound(ms/60000)))
	for _, k := range []string{"classId", "taskId", "assignmentId", "kind"} {
		if a.Has(k) {
			in.Set(k, a.Get(k))
		} else {
			in.Set(k, jsv.Undefined)
		}
	}
	o, err := s.parse(in, nil)
	if err != nil {
		return nil, err
	}
	if err := s.commit([]*jsv.Obj{o}, nil); err != nil {
		return nil, err
	}
	s.bus.Publish("created", s.Name(), o.Str("id"), "")
	return o, nil
}
