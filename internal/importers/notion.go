package importers

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/reeper316099/classpad/internal/grades"
	"github.com/reeper316099/classpad/internal/jsonstore"
)

type notionKind = string

func lcSet(a []string) map[string]bool {
	m := map[string]bool{}
	for _, x := range a {
		m[strings.ToLower(jsTrim(x))] = true
	}
	return m
}

// DetectKind recognizes a Notion database by its columns.
func DetectKind(fields []string) notionKind {
	h := lcSet(fields)
	has := func(ks ...string) bool {
		for _, k := range ks {
			if !h[k] {
				return false
			}
		}
		return true
	}
	switch {
	case has("assignment") && (h["weight"] || h["final grade"] || h["priority"]):
		return "assignments"
	case has("class") && (h["credits"] || h["times"] || h["days"]):
		return "classes"
	case has("semester", "dates") && !h["class"]:
		return "semesters"
	case has("task") && (h["target (hrs)"] || h["actual (hrs)"] || h["done"]):
		return "tasks"
	case h["total pages"] || h["pages read"]:
		return "readings"
	case has("mood"):
		return "journal"
	case has("title") && (h["related assignments"] || h["readings"]):
		return "notebook"
	case has("position", "company"):
		return "jobs"
	case has("purchase") && h["cost"]:
		return "budget"
	case has("name") && (h["phone"] || h["email"]):
		return "contacts"
	}
	return ""
}

var notionColumns = map[notionKind]struct{ used, computed []string }{
	"semesters": {[]string{"semester", "dates"}, []string{"average grade", "credits", "classes", "activities"}},
	"classes": {[]string{"class", "semester", "type", "category", "credits", "days", "times", "location", "dates", "syllabus", "quick notes", "contacts"},
		[]string{"% grade", "grade (#)", "letter grade", "weight sum", "weighted grade sum", "active to-dos", "assignments", "notes", "readings"}},
	"assignments": {[]string{"assignment", "class", "type", "status", "priority", "date", "weight", "final grade", "link", "file", "quick notes"},
		[]string{"days left", "impact weight", "weighted grade", "semester", "notes"}},
	"notebook": {[]string{"title", "class", "date", "readings", "related assignments"}, []string{"semester"}},
	"readings": {[]string{"title", "class", "status", "format", "total pages", "pages read", "date read", "quick notes"},
		[]string{"progress", "pgs read [display]", "total pgs [display]", "notes"}},
	"tasks":    {[]string{"task", "deliverable", "class", "date", "priority", "done", "target (hrs)", "actual (hrs)"}, []string{"outcome"}},
	"journal":  {[]string{"name", "date", "mood"}, []string{}},
	"contacts": {[]string{"name", "category", "phone", "email", "class"}, []string{"activities", "notes"}},
	"jobs":     {[]string{"position", "company", "compensation", "priority", "status", "type", "url"}, []string{}},
	"budget":   {[]string{"purchase", "category", "cost", "date", "vendor", "sentiment"}, []string{"receipt"}},
}

var classColors = []string{"#6366f1", "#ec4899", "#10b981", "#f59e0b", "#06b6d4", "#8b5cf6", "#ef4444", "#84cc16"}

var (
	templateName = regexp.MustCompile(`(?i)template|^(new class|default|new note|new entry|new page)$`)
	csvName      = regexp.MustCompile(`(?i)\.csv$`)
	notionID     = jsRe(`\s[0-9a-f]{32}`)
	goalLine     = jsRe(`^\s*[-*]\s+(?:\[[ x]\]\s*)?(.+)$`)
	courseCode   = jsRe(`^[A-Za-z]{2,8}\s?-?\s?\d{2,4}[A-Za-z]?$`)
	fileParen    = jsRe(`\s*\([^)]*\)\s*$`)
	parenMoney   = jsRe(`^\(.*\)$`)
	moneyLead    = regexp.MustCompile(`^[^\d(-]+`)
	notMoney     = regexp.MustCompile(`[^0-9.]`)
	anyDigit     = regexp.MustCompile(`\d`)
)

type notionCSV struct {
	path, dir string
	isAll     bool
	kind      notionKind
	table     Table
}

type notionPage struct {
	path, title, id, dir string
}

// NotionOptions: Today decides which semester is current (YYYY-MM-DD; default today);
// KeepTooltips keeps template tip callouts.
type NotionOptions struct {
	Today        string `json:"today,omitempty"`
	KeepTooltips bool   `json:"keepTooltips,omitempty"`
}

func in(list []string, x string) bool {
	for _, y := range list {
		if y == x {
			return true
		}
	}
	return false
}

// jsDateParse is Date.parse for the two forms the importer makes: YYYY-MM-DD (UTC) and
// YYYY-MM-DDTHH:mm (local). NaN when JavaScript gives NaN.
func jsDateParse(s string) float64 {
	var y, mo, d, h, mi int
	if _, err := fmt.Sscanf(s, "%4d-%2d-%2dT%2d:%2d", &y, &mo, &d, &h, &mi); err == nil && len(s) == 16 {
		if mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59 || (h == 24 && mi != 0) {
			return math.NaN()
		}
		return float64(time.Date(y, time.Month(mo), d, h, mi, 0, 0, Local).UnixMilli())
	}
	if _, err := fmt.Sscanf(s, "%4d-%2d-%2d", &y, &mo, &d); err == nil && len(s) == 10 {
		if mo < 1 || mo > 12 || d < 1 || d > 31 {
			return math.NaN()
		}
		return float64(time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC).UnixMilli())
	}
	return math.NaN()
}

func spanDays(start, end string) float64 { return (jsDateParse(end) - jsDateParse(start)) / 86400000 }

func numDec(f float64) grades.Dec { return grades.MustParse(jsonstore.JSNumber(f)) }

// PreviewNotion reads a Notion export: its databases (CSV), their pages (Markdown) and files.
func PreviewNotion(a Archive, o NotionOptions) *ImportPreview {
	out := emptyPreview("notion")
	warn := out.warn
	today := o.Today
	if today == "" {
		today = time.Now().UTC().Format("2006-01-02")
	}
	dropTooltips := !o.KeepTooltips
	safe := func(p string) string { return notionID.ReplaceAllString(p, "") }

	// ---- find and choose databases ----
	var csvs []*notionCSV
	for _, f := range a.Files() {
		if !csvName.MatchString(f) {
			continue
		}
		table := ParseCSV(readText(a, f))
		kind := DetectKind(table.Fields)
		if kind == "" {
			continue
		}
		parts := strings.Split(f, "/")
		_, _, suffix := SplitName(parts[len(parts)-1])
		csvs = append(csvs, &notionCSV{path: f, dir: strings.Join(parts[:len(parts)-1], "/"),
			isAll: strings.HasPrefix(strings.ToLower(suffix), "_all"), kind: kind, table: table})
	}
	var kinds []notionKind
	byKind := map[notionKind][]*notionCSV{}
	for _, c := range csvs {
		if _, ok := byKind[c.kind]; !ok {
			kinds = append(kinds, c.kind)
		}
		byKind[c.kind] = append(byKind[c.kind], c)
	}
	chosen := map[notionKind]*notionCSV{}
	for _, kind := range kinds {
		list := byKind[kind]
		depth := func(c *notionCSV) int { return len(strings.Split(c.dir, "/")) }
		sort.SliceStable(list, func(i, j int) bool {
			x, y := list[i], list[j]
			if x.isAll != y.isAll {
				return x.isAll
			}
			if depth(x) != depth(y) {
				return depth(x) < depth(y)
			}
			return len(x.table.Rows) > len(y.table.Rows)
		})
		chosen[kind] = list[0]
		cols := notionColumns[kind]
		for _, c := range list {
			e := MappingEntry{File: safe(c.path), Kind: kind, Chosen: c == list[0], Rows: len(c.table.Rows),
				Used: []string{}, Computed: []string{}, Ignored: []string{}}
			for _, f := range c.table.Fields {
				x := strings.ToLower(f)
				switch {
				case in(cols.used, x):
					e.Used = append(e.Used, x)
				case in(cols.computed, x):
					e.Computed = append(e.Computed, x)
				default:
					e.Ignored = append(e.Ignored, x)
				}
			}
			if c != list[0] {
				e.Note = "duplicate or embedded view; skipped in favour of the main database"
			}
			out.Mapping = append(out.Mapping, e)
		}
	}
	if len(chosen) == 0 {
		warn("NO_DATABASES", "No recognizable databases (CSV files) found in this export", "")
	}

	// ---- page index ----
	var pages []notionPage
	for _, p := range a.Files() {
		if !mdFile.MatchString(p) {
			continue
		}
		parts := strings.Split(p, "/")
		base, id, _ := SplitName(mdFile.ReplaceAllString(parts[len(parts)-1], ""))
		pages = append(pages, notionPage{path: p, title: CleanLabel(base), id: id, dir: strings.Join(parts[:len(parts)-1], "/")})
	}
	pageByID := map[string]*notionPage{}
	for i := range pages {
		if pages[i].id != "" {
			pageByID[pages[i].id] = &pages[i]
		}
	}
	usedPages := map[string]bool{}
	pageFor := func(dbDir, title string) *notionPage {
		n := NormTitle(title)
		var c []*notionPage
		for i := range pages {
			if NormTitle(pages[i].title) == n {
				c = append(c, &pages[i])
			}
		}
		for _, p := range c {
			if strings.HasPrefix(p.dir, dbDir) || p.dir == dbDir {
				return p
			}
		}
		last := lastSegment(dbDir)
		for _, p := range c {
			if strings.Contains(p.dir, last) {
				return p
			}
		}
		return nil
	}
	pageID := func(p *notionPage) string {
		if p == nil {
			return ""
		}
		return p.id
	}

	// ---- reference registry ----
	registry := map[string]string{}
	refs := map[string]bool{}
	nextRef := map[string]int{}
	mkRef := func(kind, title, id, scope string) string {
		idPart := id
		if idPart == "" {
			idPart = "-"
		}
		base := "notion:" + kind + ":" + idPart + ":" + NormTitle(title)
		if scope != "" {
			base += "@" + NormTitle(scope)
		}
		r := base
		if refs[r] {
			n := max(nextRef[base], 2)
			for refs[fmt.Sprintf("%s#%d", base, n)] {
				n++
			}
			r = fmt.Sprintf("%s#%d", base, n)
			nextRef[base] = n + 1
		}
		refs[r] = true
		if id != "" {
			registry[kind+"|id|"+id] = r
		}
		if _, ok := registry[kind+"|t|"+NormTitle(title)]; !ok {
			registry[kind+"|t|"+NormTitle(title)] = r
		}
		return r
	}
	resolve := func(kind string, rel RelationRef) string {
		if rel.ID != "" {
			if r := registry[kind+"|id|"+rel.ID]; r != "" {
				return r
			}
		}
		return registry[kind+"|t|"+NormTitle(rel.Title)]
	}

	propNames := map[string]bool{}
	for _, c := range csvs {
		for _, f := range c.table.Fields {
			propNames[strings.ToLower(f)] = true
		}
	}
	body := func(p *notionPage) string {
		if p == nil {
			return ""
		}
		usedPages[p.path] = true
		r := ConvertNotionMarkdown(readText(a, p.path), BodyContext{
			PagePath: p.path, PropertyNames: propNames, HasFile: a.Has, DropTooltips: dropTooltips,
		})
		for _, w := range r.Warnings {
			warn("BODY", w, safe(p.path))
		}
		for _, x := range r.Attachments {
			out.addAttachment(x)
		}
		return r.Markdown
	}
	baseIndex := map[string][]string{}
	for _, f := range a.Files() {
		baseIndex[lastSegment(f)] = append(baseIndex[lastSegment(f)], f)
	}
	findFiles := func(cell, dir string) []string {
		found := []string{}
		for _, raw := range strings.Split(cell, ",") {
			raw = jsTrim(raw)
			if raw == "" {
				continue
			}
			tok := fileParen.ReplaceAllString(raw, "")
			dec := tok
			if d, ok := decodeURIComponent(tok); ok {
				dec = d
			}
			hit := ""
			for _, c := range []string{dec, dir + "/" + dec} {
				if a.Has(c) {
					hit = c
					break
				}
			}
			if hit == "" {
				if list := baseIndex[lastSegment(dec)]; len(list) > 0 {
					hit = list[0]
				}
			}
			if hit != "" {
				found = append(found, hit)
			} else {
				warn("FILE", fmt.Sprintf(`Attachment "%s" is not in the export; skipped`, dec), "Assignments")
			}
		}
		return found
	}
	tzSeen := map[string]bool{}
	date := func(cell, where string) *ParsedDate {
		d := ParseNotionDate(cell)
		if d == nil && jsTrim(cell) != "" {
			warn("DATE", fmt.Sprintf(`Unreadable date "%s"`, cell), where)
		}
		if d != nil && d.TimezoneLabel != "" && !tzSeen[where] {
			tzSeen[where] = true
			warn("TIMEZONE", fmt.Sprintf("Time zone labels (%s) are ignored; local wall time kept", d.TimezoneLabel), where)
		}
		return d
	}
	rowsOf := func(kind string) []Row {
		if c := chosen[kind]; c != nil {
			return c.table.Rows
		}
		return nil
	}
	dirOf := func(kind string) string {
		if c := chosen[kind]; c != nil {
			return c.dir
		}
		return ""
	}
	first := func(rs []RelationRef) *RelationRef {
		if len(rs) == 0 {
			return nil
		}
		return &rs[0]
	}
	relTitle := func(r *RelationRef) string {
		if r == nil {
			return ""
		}
		return r.Title
	}

	// ---- semesters ----
	for _, r := range rowsOf("semesters") {
		name := CleanLabel(r.Get("Semester"))
		if name == "" {
			continue
		}
		page := pageFor(dirOf("semesters"), name)
		d := date(r.Get("Dates"), "Semesters: "+name)
		b := ""
		if page != nil {
			b = body(page)
		}
		goals := []string{}
		for _, l := range strings.Split(b, "\n") {
			if m := goalLine.FindStringSubmatch(l); m != nil {
				if g := jsTrim(m[1]); g != "" {
					goals = append(goals, g)
				}
			}
		}
		long := false
		if d != nil && d.End != "" {
			if d.End < d.Start {
				warn("DATES", fmt.Sprintf(`Semester "%s" ends before it starts`, name), "Semesters")
			} else if spanDays(d.Start, d.End) > 400 {
				warn("DATES", fmt.Sprintf(`Semester "%s" spans more than a year (%s to %s); check the dates`, name, jsSlice(d.Start, 10), jsSlice(d.End, 10)), "Semesters")
			}
			long = spanDays(d.Start, d.End) > 400
		}
		s := DraftSemester{Ref: mkRef("semester", name, pageID(page), ""), Name: name, Goals: goals}
		if d != nil {
			s.Start = jsSlice(d.Start, 10)
			if d.End != "" {
				s.End = jsSlice(d.End, 10)
			}
			endOrStart := d.End
			if endOrStart == "" {
				endOrStart = d.Start
			}
			s.IsCurrent = jsSlice(d.Start, 10) <= today && jsSlice(endOrStart, 10) >= today && !long
		}
		out.Semesters = append(out.Semesters, s)
	}

	// ---- classes ----
	classExported := map[string]string{}
	classOfNote := map[string]string{}
	classOfAssignment := map[string]string{}
	classOfReading := map[string]string{}
	for idx, r := range rowsOf("classes") {
		name := CleanLabel(r.Get("Class"))
		if name == "" {
			continue
		}
		where := "Classes: " + name
		page := pageFor(dirOf("classes"), name)
		sem := first(ParseRelation(r.Get("Semester")))
		days := ParseDays(r.Get("Days"))
		times := jsTrim(r.Get("Times"))
		meetings, tw := ParseTimes(times, days)
		if times != "" {
			for _, w := range tw {
				warn("TIMES", w, where)
			}
		}
		dates := date(r.Get("Dates"), where)
		credits := ParseNumber(r.Get("Credits"))
		cat := SlugOption(r.Get("Category"))
		var contacts []string
		for _, c := range ParseRelation(r.Get("Contacts")) {
			if c.Title != "" {
				contacts = append(contacts, c.Title)
			}
		}
		c := DraftClass{
			Ref: mkRef("class", name, pageID(page), ""), Name: name, Color: classColors[idx%len(classColors)],
			Type: SlugOption(r.Get("Type")), Credits: credits, Instructor: strings.Join(contacts, ", "),
			Location: jsTrim(r.Get("Location")), Meetings: meetings, RawTimes: times,
			QuickNotes: jsTrim(r.Get("Quick Notes")),
		}
		if sem != nil {
			c.SemesterRef = resolve("semester", *sem)
		}
		if courseCode.MatchString(name) {
			c.Code = name
		}
		if cat == "in_person" || cat == "online" || cat == "hybrid" {
			c.Delivery = cat
		}
		if dates != nil && dates.End != "" {
			c.Dates = &DateSpan{jsSlice(dates.Start, 10), jsSlice(dates.End, 10)}
		}
		if s := first(ParseRelation(r.Get("Syllabus"))); s != nil && s.Path != "" {
			c.SyllabusPath = s.Path
		} else {
			c.SyllabusPath = jsTrim(r.Get("Syllabus"))
		}
		if cat != "" && c.Delivery == "" {
			warn("OPTION", fmt.Sprintf(`Unknown delivery "%s"`, r.Get("Category")), where)
		}
		if sem != nil && c.SemesterRef == "" {
			warn("RELATION", fmt.Sprintf(`Semester "%s" not found`, sem.Title), where)
		}
		if credits == nil {
			warn("CREDITS", "No credits set; this class will be left out of GPA until credits are added", where)
		}
		out.Classes = append(out.Classes, c)
		ci := len(out.Classes) - 1
		for _, pair := range []struct {
			col string
			m   map[string]string
		}{{"Assignments", classOfAssignment}, {"Readings", classOfReading}} {
			for _, x := range ParseRelation(r.Get(pair.col)) {
				if x.ID != "" {
					pair.m["id:"+x.ID] = c.Ref
				}
				pair.m["t:"+NormTitle(x.Title)] = c.Ref
			}
		}
		for _, nr := range ParseRelation(r.Get("Notes")) {
			if nr.ID != "" {
				classOfNote["id:"+nr.ID] = c.Ref
			}
			classOfNote["t:"+NormTitle(nr.Title)] = c.Ref
		}
		classExported[c.Ref] = r.Get("% Grade")
		if b := body(page); jsTrim(b) != "" {
			out.Notes = append(out.Notes, DraftNote{
				Ref: mkRef("note", name+" page", pageID(page), ""), Title: name + " page", ClassRef: c.Ref,
				Markdown: b, Tags: []string{"imported"}, AssignmentRefs: []string{}, ReadingRefs: []string{},
			})
		}
		if sp := out.Classes[ci].SyllabusPath; sp != "" && !a.Has(sp) {
			out.Classes[ci].SyllabusPath = ""
		} else if sp != "" {
			out.Attachments = append(out.Attachments, AttachmentRef{ArchivePath: sp, Filename: lastSegment(sp)})
		}
	}

	// ---- assignments ----
	classTitleToRef := func(rel *RelationRef) string {
		if rel == nil {
			return ""
		}
		return resolve("class", *rel)
	}
	for _, r := range rowsOf("assignments") {
		title := CleanLabel(r.Get("Assignment"))
		if title == "" {
			continue
		}
		classRel := first(ParseRelation(r.Get("Class")))
		where := "Assignments: " + title
		page := pageFor(dirOf("assignments"), title)
		status, known := NormalizeAssignmentStatus(r.Get("Status"))
		if !known {
			warn("OPTION", fmt.Sprintf(`Unknown status "%s"; set to Not started`, CleanLabel(r.Get("Status"))), where)
		}
		pri := NormalizePriority(r.Get("Priority"))
		if jsTrim(r.Get("Priority")) != "" && pri == nil {
			warn("OPTION", fmt.Sprintf(`Unknown priority "%s"`, CleanLabel(r.Get("Priority"))), where)
		}
		d := date(r.Get("Date"), where)
		weight := ParsePercent(r.Get("Weight"))
		grade := ParsePercent(r.Get("Final Grade"))
		if jsTrim(r.Get("Weight")) != "" && weight == nil {
			warn("PERCENT", fmt.Sprintf(`Unreadable weight "%s"`, r.Get("Weight")), where)
		}
		files := findFiles(r.Get("File"), dirOf("assignments"))
		asg := DraftAssignment{
			Ref: mkRef("assignment", title, pageID(page), relTitle(classRel)), Title: title, Type: []string{},
			Status: status, Weight: weight, Link: jsTrim(r.Get("Link")), QuickNotes: jsTrim(r.Get("Quick Notes")),
			FilePaths: files,
		}
		asg.ClassRef = classTitleToRef(classRel)
		if asg.ClassRef == "" && pageID(page) != "" {
			asg.ClassRef = classOfAssignment["id:"+pageID(page)]
		}
		if asg.ClassRef == "" {
			asg.ClassRef = classOfAssignment["t:"+NormTitle(title)]
		}
		for _, x := range SplitMulti(r.Get("Type")) {
			if s := SlugOption(x); s != "" {
				asg.Type = append(asg.Type, s)
			}
		}
		if pri != nil {
			asg.Priority, asg.PriorityLabel = pri.Value, pri.Label
		}
		if d != nil {
			asg.Due = FormatInterval(d)
		}
		if grade != nil {
			asg.Score = &PercentScore{*grade}
		}
		for _, f := range files {
			out.addAttachment(f)
		}
		switch {
		case classRel != nil && asg.ClassRef == "":
			msg := fmt.Sprintf(`Class "%s" not found; it will go to the Unassigned class`, classRel.Title)
			if classRel.URL != "" {
				msg = "Class relation points to a page outside the export; it will go to the Unassigned class"
			}
			warn("RELATION", msg, where)
		case classRel == nil:
			warn("RELATION", "No class set; it will go to the Unassigned class", where)
		}
		out.Assignments = append(out.Assignments, asg)
		if b := body(page); jsTrim(b) != "" {
			out.Notes = append(out.Notes, DraftNote{
				Ref: mkRef("note", title+" page", pageID(page), relTitle(classRel)), Title: title + " page",
				ClassRef: asg.ClassRef, Markdown: b, Tags: []string{"imported"},
				AssignmentRefs: []string{asg.Ref}, ReadingRefs: []string{},
			})
		}
	}

	// ---- readings ----
	for _, r := range rowsOf("readings") {
		title := CleanLabel(r.Get("Title"))
		if title == "" {
			continue
		}
		classRel := first(ParseRelation(r.Get("Class")))
		status, known := NormalizeReadingStatus(r.Get("Status"))
		if !known {
			warn("OPTION", fmt.Sprintf(`Unknown reading status "%s"; set to To read`, CleanLabel(r.Get("Status"))), "Readings: "+title)
		}
		d := date(r.Get("Date Read"), "Readings: "+title)
		page := pageFor(dirOf("readings"), title)
		rd := DraftReading{
			Ref: mkRef("reading", title, pageID(page), ""), Title: title, Status: status,
			Format: SlugOption(r.Get("Format")), TotalPages: ParseNumber(r.Get("Total Pages")),
			PagesRead: ParseNumber(r.Get("Pages Read")), QuickNotes: jsTrim(r.Get("Quick Notes")),
		}
		rd.ClassRef = classTitleToRef(classRel)
		if rd.ClassRef == "" && pageID(page) != "" {
			rd.ClassRef = classOfReading["id:"+pageID(page)]
		}
		if rd.ClassRef == "" {
			rd.ClassRef = classOfReading["t:"+NormTitle(title)]
		}
		if d != nil {
			rd.DateRead = jsSlice(d.Start, 10)
		}
		out.Readings = append(out.Readings, rd)
		if b := body(page); jsTrim(b) != "" {
			out.Notes = append(out.Notes, DraftNote{
				Ref: mkRef("note", title+" page", pageID(page), "reading"), Title: title + " page",
				ClassRef: classTitleToRef(classRel), Markdown: b, Tags: []string{"imported"},
				AssignmentRefs: []string{}, ReadingRefs: []string{rd.Ref},
			})
		}
	}

	// ---- tasks ----
	for _, r := range rowsOf("tasks") {
		title := CleanLabel(r.Get("Task"))
		if title == "" {
			continue
		}
		deliv := first(ParseRelation(r.Get("Deliverable")))
		classRel := first(ParseRelation(r.Get("Class")))
		d := date(r.Get("Date"), "Tasks: "+title)
		tk := DraftTask{
			Ref: mkRef("task", title, "", r.Get("Date")), Title: title,
			Priority: NormalizeTaskPriority(r.Get("Priority")), Done: ParseBool(r.Get("Done")),
			TargetHours: ParseNumber(r.Get("Target (Hrs)")), ActualHours: ParseNumber(r.Get("Actual (Hrs)")),
		}
		if deliv != nil {
			tk.AssignmentRef = resolve("assignment", *deliv)
		}
		if classRel != nil {
			tk.ClassRef = resolve("class", *classRel)
			if tk.ClassRef == "" {
				for _, c := range out.Classes {
					if NormTitle(c.Name) == NormTitle(classRel.Title) {
						tk.ClassRef = c.Ref
						break
					}
				}
			}
		}
		if tk.Priority == "" {
			tk.Priority = "medium"
		}
		if d != nil {
			tk.Date = FormatInterval(d)
		}
		out.Tasks = append(out.Tasks, tk)
	}

	// ---- notebook ----
	for _, r := range rowsOf("notebook") {
		title := CleanLabel(r.Get("Title"))
		if title == "" {
			continue
		}
		page := pageFor(dirOf("notebook"), title)
		if templateName.MatchString(title) {
			continue // handled as a template below
		}
		b := body(page)
		classRel := first(ParseRelation(r.Get("Class")))
		if jsTrim(b) == "" && classRel == nil {
			warn("EMPTY_PAGE", fmt.Sprintf(`Skipped empty page "%s"`, title), "Notebook")
			continue
		}
		d := date(r.Get("Date"), "Notebook: "+title)
		assignmentRefs, readingRefs := []string{}, []string{}
		for _, x := range ParseRelation(r.Get("Related Assignments")) {
			if ref := resolve("assignment", x); ref != "" {
				assignmentRefs = append(assignmentRefs, ref)
			}
		}
		for _, x := range ParseRelation(r.Get("Readings")) {
			if ref := resolve("reading", x); ref != "" {
				readingRefs = append(readingRefs, ref)
			}
		}
		// Which class? Its own Class relation, then the class's list of notes, then related work.
		classRef := classTitleToRef(classRel)
		how := ""
		if classRef == "" {
			if pageID(page) != "" {
				classRef = classOfNote["id:"+pageID(page)]
			}
			if classRef == "" {
				classRef = classOfNote["t:"+NormTitle(title)]
			}
			if classRef != "" {
				how = "from the class page"
			}
		}
		if classRef == "" {
			for _, ar := range assignmentRefs {
				for _, x := range out.Assignments {
					if x.Ref == ar {
						if x.ClassRef != "" && classRef == "" {
							classRef = x.ClassRef
						}
						break
					}
				}
				if classRef != "" {
					break
				}
			}
			if classRef == "" {
				for _, rr := range readingRefs {
					for _, y := range out.Readings {
						if y.Ref == rr {
							if y.ClassRef != "" && classRef == "" {
								classRef = y.ClassRef
							}
							break
						}
					}
					if classRef != "" {
						break
					}
				}
			}
			if classRef != "" {
				how = "from its related assignment or reading"
			}
		}
		if classRef != "" && how != "" {
			warn("NOTE_CLASS", fmt.Sprintf(`Class for "%s" was worked out %s`, title, how), "Notebook")
		}
		if classRef == "" {
			msg := fmt.Sprintf(`Note "%s" has no class; it was imported without one`, title)
			if classRel != nil {
				msg = fmt.Sprintf(`Class "%s" for note "%s" is not in the export; the note was imported without a class`, classRel.Title, title)
			}
			warn("NOTE_CLASS", msg, "Notebook")
		}
		n := DraftNote{
			Ref: mkRef("note", title, pageID(page), relTitle(classRel)), Title: title, ClassRef: classRef,
			Markdown: b, Tags: []string{"imported"}, AssignmentRefs: assignmentRefs, ReadingRefs: readingRefs,
		}
		if d != nil {
			n.Date = jsSlice(d.Start, 10)
		}
		out.Notes = append(out.Notes, n)
	}

	// ---- templates: pages in a database's folder that aren't rows (or are named like templates) ----
	type owner struct {
		kind, pageDir, target, titleCol string
		titles                          map[string]bool
	}
	var owners []owner
	for _, kind := range kinds {
		if !in([]string{"classes", "assignments", "notebook", "readings", "tasks", "journal"}, kind) {
			continue
		}
		c := chosen[kind]
		base, _, _ := SplitName(csvName.ReplaceAllString(lastSegment(c.path), ""))
		col := map[string]string{"classes": "Class", "assignments": "Assignment", "tasks": "Task", "journal": "Name"}[kind]
		if col == "" {
			col = "Title"
		}
		target := "notes"
		if kind == "classes" || kind == "assignments" {
			target = kind
		}
		titles := map[string]bool{}
		for _, r := range c.table.Rows {
			titles[NormTitle(r.Get(col))] = true
		}
		owners = append(owners, owner{kind, c.dir + "/" + base, target, col, titles})
	}
	for i := range pages {
		p := &pages[i]
		if usedPages[p.path] {
			continue
		}
		var o *owner
		for k := range owners {
			if owners[k].pageDir == p.dir {
				o = &owners[k]
				break
			}
		}
		if o == nil {
			continue
		}
		if templateName.MatchString(p.title) || !o.titles[NormTitle(p.title)] {
			out.Templates = append(out.Templates, DraftTemplate{Kind: o.target, Name: p.title, Markdown: body(p)})
		}
	}
	hasTemplate := func(name string) bool {
		for _, t := range out.Templates {
			if NormTitle(t.Name) == NormTitle(name) {
				return true
			}
		}
		return false
	}
	for _, o := range owners {
		for _, r := range chosen[o.kind].table.Rows {
			title := CleanLabel(r.Get(o.titleCol))
			if title != "" && templateName.MatchString(title) && !hasTemplate(title) {
				out.Templates = append(out.Templates, DraftTemplate{Kind: o.target, Name: title, Markdown: ""})
			}
		}
	}

	// ---- optional modules: journal, contacts, jobs, budget ----
	money := func(cell string) *float64 {
		raw := jsTrim(cell)
		if raw == "" {
			return nil
		}
		neg := parenMoney.MatchString(raw) || strings.HasPrefix(moneyLead.ReplaceAllString(raw, ""), "-")
		n := jsNumber(notMoney.ReplaceAllString(raw, ""))
		if !isFinite(n) || !anyDigit.MatchString(raw) {
			return nil
		}
		if neg {
			n = -n
		}
		return &n
	}
	for _, r := range rowsOf("journal") {
		name := CleanLabel(r.Get("Name"))
		if name == "" || templateName.MatchString(name) {
			continue
		}
		d := date(r.Get("Date"), "Journal: "+name)
		if d == nil {
			warn("DATE", fmt.Sprintf(`Journal entry "%s" has no readable date; skipped`, name), "Journal")
			continue
		}
		page := pageFor(dirOf("journal"), name)
		j := DraftJournal{Ref: mkRef("journal", name, pageID(page), r.Get("Date")), Date: jsSlice(d.Start, 10),
			Title: name, Mood: []string{}}
		for _, m := range SplitMulti(r.Get("Mood")) {
			if s := SlugOption(m); s != "" {
				j.Mood = append(j.Mood, s)
			}
		}
		j.Markdown = body(page)
		out.Journal = append(out.Journal, j)
	}
	for _, r := range rowsOf("contacts") {
		name := CleanLabel(r.Get("Name"))
		if name == "" {
			continue
		}
		c := DraftContact{Ref: mkRef("contact", name, "", ""), Name: name, Role: CleanLabel(r.Get("Category")),
			Email: jsTrim(r.Get("Email")), Phone: jsTrim(r.Get("Phone")), ClassRefs: []string{}}
		for _, x := range ParseRelation(r.Get("Class")) {
			if ref := resolve("class", x); ref != "" {
				c.ClassRefs = append(c.ClassRefs, ref)
			}
		}
		out.Contacts = append(out.Contacts, c)
	}
	jobStatus := []struct {
		re     *regexp.Regexp
		status string
	}{
		{regexp.MustCompile(`interview`), "interview"},
		{regexp.MustCompile(`offer`), "offer"},
		{regexp.MustCompile(`accept|hired`), "accepted"},
		{regexp.MustCompile(`reject|declin|denied`), "rejected"},
		{regexp.MustCompile(`appl|submit`), "applied"},
		{regexp.MustCompile(`wish|save|to apply|interest|research|idea`), "wishlist"},
	}
	for _, r := range rowsOf("jobs") {
		position := CleanLabel(r.Get("Position"))
		if position == "" {
			continue
		}
		st := strings.ToLower(jsTrim(r.Get("Status")))
		status := ""
		for _, js := range jobStatus {
			if js.re.MatchString(st) {
				status = js.status
				break
			}
		}
		if st != "" && status == "" {
			warn("OPTION", fmt.Sprintf(`Unknown job status "%s"`, r.Get("Status")), "Jobs: "+position)
		}
		if status == "" {
			status = "wishlist"
		}
		company := CleanLabel(r.Get("Company"))
		j := DraftJob{Ref: mkRef("job", position, "", company), Position: position, Company: company,
			Type: SlugOption(r.Get("Type")), Status: status, Compensation: jsTrim(r.Get("Compensation")),
			URL: jsTrim(r.Get("URL"))}
		if p := NormalizePriority(r.Get("Priority")); p != nil {
			j.Priority = p.Value
		}
		out.Jobs = append(out.Jobs, j)
	}
	for _, r := range rowsOf("budget") {
		purchase := CleanLabel(r.Get("Purchase"))
		if purchase == "" {
			continue
		}
		cost := money(r.Get("Cost"))
		d := date(r.Get("Date"), "Budget: "+purchase)
		if cost == nil || d == nil {
			why := "no readable date"
			if cost == nil {
				why = "unreadable cost"
			}
			warn("BUDGET", fmt.Sprintf(`Skipped "%s": %s`, purchase, why), "Budget")
			continue
		}
		typ := "expense"
		if *cost < 0 {
			typ = "income"
		}
		out.Budget = append(out.Budget, DraftBudget{
			Ref: mkRef("budget", purchase, "", r.Str("Date")+"|"+r.Str("Cost")), Purchase: purchase, Type: typ,
			Cost: math.Abs(*cost), Category: CleanLabel(r.Get("Category")), Date: jsSlice(d.Start, 10),
			Vendor: CleanLabel(r.Get("Vendor")), Sentiment: CleanLabel(r.Get("Sentiment")),
		})
	}

	// ---- unmapped pages ----
	unmapped := 0
	for _, p := range pages {
		if !usedPages[p.path] && !hasTemplate(p.title) {
			unmapped++
		}
	}
	if unmapped > 0 {
		out.Skipped = append(out.Skipped, SkippedGroup{Kind: "pages", Count: unmapped,
			Reason: "Pages outside the mapped databases (hub pages, module pages) were not imported"})
	}

	// ---- grade parity: recompute each class's grade and compare with the exported % Grade ----
	scheme := grades.DefaultScheme("")
	for _, c := range out.Classes {
		var items []grades.GradeItem
		for _, asg := range out.Assignments {
			if asg.ClassRef != c.Ref {
				continue
			}
			it := grades.GradeItem{ID: asg.Ref}
			if asg.Weight != nil {
				w := numDec(*asg.Weight)
				it.Weight = &w
			}
			if asg.Score != nil {
				it.Score = grades.PercentScore(numDec(asg.Score.Percent))
			}
			items = append(items, it)
		}
		res := grades.ComputeGrade(scheme, items)
		exportedRaw := jsTrim(classExported[c.Ref])
		exported := ParsePercent(exportedRaw)
		rec := res.PercentRaw
		v := ValidationRow{ClassName: c.Name}
		switch {
		case exported == nil && rec == nil:
			v.Status = "both-empty"
		case exported == nil:
			v.Status, v.Recomputed = "recomputed-only", strp(rec.String())
		case rec == nil:
			v.Status, v.Exported = "exported-only", exportedRaw
		default:
			diff := rec.Sub(numDec(*exported)).Abs()
			diffFraction := rec.Sub(numDec(*exported * 100)).Abs() // exports as fractions (0.84)
			best := diffFraction
			if diff.Lt(diffFraction) {
				best = diff
			}
			v.Exported, v.Recomputed, v.Diff = exportedRaw, strp(rec.String()), best.String()
			v.Status = "mismatch"
			if best.Lte(grades.MustParse("0.01")) {
				v.Status = "ok"
			}
		}
		out.Validation = append(out.Validation, v)
	}
	return out
}
