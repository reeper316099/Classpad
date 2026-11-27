package importers

import (
	"fmt"
	"strings"
)

// CSV collections a plain CSV file can be imported into.
var CSVCollections = []string{"semesters", "classes", "assignments", "tasks", "readings"}

type csvTemplateDef struct{ headers, example []string }

var csvTemplates = map[string]csvTemplateDef{
	"semesters": {[]string{"name", "start", "end"}, []string{"Autumn Term", "2031-09-01", "2031-12-12"}},
	"classes": {
		[]string{"name", "semester", "code", "credits", "type", "delivery", "days", "times", "location", "instructor"},
		[]string{"Intro Course", "Autumn Term", "ABC 101", "3", "core", "in_person", "Mon, Wed", "9:15a-10:30a", "Hall 1", ""},
	},
	"assignments": {
		[]string{"title", "class", "due", "weight", "score", "points_possible", "status", "priority", "type", "link", "notes"},
		[]string{"Essay 1", "Intro Course", "2031-10-01", "20", "", "", "not_started", "mid", "essay", "", ""},
	},
	"tasks": {
		[]string{"title", "class", "date", "priority", "done", "target_hours", "actual_hours"},
		[]string{"Read chapter 2", "Intro Course", "2031-09-20", "medium", "no", "2", ""},
	},
	"readings": {
		[]string{"title", "class", "status", "format", "total_pages", "pages_read", "date_read"},
		[]string{"Sample Book", "", "reading", "library", "200", "40", ""},
	},
}

// CSVTemplate is an example CSV for a collection: the header row and one sample row.
func CSVTemplate(collection string) string {
	t := csvTemplates[collection]
	row := map[string]string{}
	for i, h := range t.headers {
		row[h] = t.example[i]
	}
	return ToCSV(t.headers, []map[string]string{row})
}

var csvAliases = map[string]string{
	"assignment": "title", "name": "title", "course": "class", "due date": "due", "date": "due",
	"grade": "score", "final grade": "score", "points possible": "points_possible",
	"total points": "points_possible", "note": "notes", "quick notes": "notes",
	"target hrs": "target_hours", "actual hrs": "actual_hours", "target (hrs)": "target_hours",
	"actual (hrs)": "actual_hours", "total pages": "total_pages", "pages read": "pages_read",
	"date read": "date_read", "professor": "instructor", "teacher": "instructor",
}

var spaceRun = jsRe(`\s+`)

func canonHeader(h, collection string) string {
	k := spaceRun.ReplaceAllString(strings.ToLower(jsTrim(h)), " ")
	if collection == "tasks" && (k == "date" || k == "due") {
		return "date"
	}
	if (collection == "classes" || collection == "semesters" || collection == "readings") &&
		(k == "name" || k == "class" || (k == "semester" && collection == "semesters")) {
		if collection == "readings" {
			return "title"
		}
		return "name"
	}
	if collection == "readings" && k == "title" {
		return "title"
	}
	if a, ok := csvAliases[k]; ok {
		return a
	}
	return strings.ReplaceAll(k, " ", "_")
}

// NameRef refers to an entity that may already exist, matched by name when the import is saved.
func NameRef(kind, name string) string { return "name:" + kind + ":" + NormTitle(name) }

// refSet hands out unique references: ref, then ref#2, ref#3… (the TypeScript loop restarts at #2
// every time, which is quadratic for many duplicates; this remembers where each one got to).
type refSet struct {
	seen map[string]bool
	next map[string]int
}

func newRefSet() *refSet { return &refSet{seen: map[string]bool{}, next: map[string]int{}} }

func (r *refSet) unique(ref string) string {
	if !r.seen[ref] {
		r.seen[ref] = true
		return ref
	}
	root := hashSuffix.ReplaceAllString(ref, "")
	n := max(r.next[ref], 2)
	for r.seen[fmt.Sprintf("%s#%d", root, n)] {
		n++
	}
	out := fmt.Sprintf("%s#%d", root, n)
	r.next[ref] = n + 1
	r.seen[out] = true
	return out
}

var (
	hashSuffix  = jsRe(`#\d+$`)
	numericCell = jsRe(`^-?\d+(\.\d+)?$`)
)

// PreviewCSV reads a CSV file of one collection.
func PreviewCSV(text, collection string) *ImportPreview {
	out := emptyPreview("csv")
	t := ParseCSV(text)
	fields := make([]string, len(t.Fields))
	for i, f := range t.Fields {
		fields[i] = canonHeader(f, collection)
	}
	known := map[string]bool{}
	for _, h := range csvTemplates[collection].headers {
		known[h] = true
	}
	for i, f := range fields {
		if !known[f] {
			out.warn("COLUMN", fmt.Sprintf(`Column "%s" is not recognized and was ignored`, t.Fields[i]), "")
		}
	}
	col := func(r Row, name string) string {
		for i := range t.Fields {
			if fields[i] == name {
				return jsTrim(r.Get(t.Fields[i]))
			}
		}
		return ""
	}
	required := "name"
	if collection == "assignments" || collection == "tasks" || collection == "readings" {
		required = "title"
	}
	hasRequired := false
	for _, f := range fields {
		hasRequired = hasRequired || f == required
	}
	if !hasRequired {
		out.warn("MISSING_COLUMN", fmt.Sprintf(`Missing required column "%s"`, required), "")
		return out
	}
	seen := newRefSet()
	for i, r := range t.Rows {
		key := col(r, required)
		where := fmt.Sprintf("row %d", i+2)
		if key == "" {
			out.warn("EMPTY_ROW", "Row has no title/name; skipped", where)
			continue
		}
		mk := func(kind, scope string) string {
			ref := "csv:" + kind + ":" + NormTitle(key)
			if scope != "" {
				ref += "@" + NormTitle(scope)
			}
			return seen.unique(ref)
		}
		date := func(c string) *ParsedDate {
			d := ParseNotionDate(c)
			if d == nil && c != "" {
				out.warn("DATE", fmt.Sprintf(`Unreadable date "%s"`, c), where)
			}
			return d
		}
		cls := col(r, "class")
		classRef := ""
		if cls != "" {
			classRef = NameRef("class", cls)
		}
		switch collection {
		case "semesters":
			s, e := date(col(r, "start")), date(col(r, "end"))
			sem := DraftSemester{Ref: mk("semester", ""), Name: key, Goals: []string{}}
			if s != nil {
				sem.Start = jsSlice(s.Start, 10)
			}
			if e != nil {
				sem.End = jsSlice(e.Start, 10)
			}
			out.Semesters = append(out.Semesters, sem)
		case "classes":
			days, times := ParseDays(col(r, "days")), col(r, "times")
			meetings, tw := ParseTimes(times, days)
			for _, w := range tw {
				out.warn("TIMES", w, where)
			}
			c := DraftClass{
				Ref: mk("class", ""), Name: key, Code: col(r, "code"), Credits: ParseNumber(col(r, "credits")),
				Type: SlugOption(col(r, "type")), Location: col(r, "location"),
				Instructor: col(r, "instructor"), Meetings: meetings, RawTimes: times, Color: "#6366f1",
			}
			if sem := col(r, "semester"); sem != "" {
				c.SemesterRef = NameRef("semester", sem)
			}
			if d := SlugOption(col(r, "delivery")); d == "in_person" || d == "online" || d == "hybrid" {
				c.Delivery = d
			}
			out.Classes = append(out.Classes, c)
		case "assignments":
			d := date(col(r, "due"))
			pri := NormalizePriority(col(r, "priority"))
			status, known := NormalizeAssignmentStatus(col(r, "status"))
			if !known {
				out.warn("OPTION", fmt.Sprintf(`Unknown status "%s"; set to Not started`, col(r, "status")), where)
			}
			score := ParsePercent(col(r, "score"))
			pp := ParseNumber(col(r, "points_possible"))
			a := DraftAssignment{
				Ref: mk("assignment", cls), Title: key, ClassRef: classRef, Type: []string{},
				Status: status, Weight: ParsePercent(col(r, "weight")), Link: col(r, "link"),
				QuickNotes: col(r, "notes"), FilePaths: []string{},
			}
			for _, x := range SplitMulti(col(r, "type")) {
				if s := SlugOption(x); s != "" {
					a.Type = append(a.Type, s)
				}
			}
			if pri != nil {
				a.Priority, a.PriorityLabel = pri.Value, pri.Label
			}
			if d != nil {
				a.Due = FormatInterval(d)
			}
			if score != nil {
				v := *score
				if pp != nil && *pp > 0 && numericCell.MatchString(col(r, "score")) {
					v = v / *pp * 100
				}
				a.Score = &PercentScore{v}
			}
			out.Assignments = append(out.Assignments, a)
		case "tasks":
			d := date(col(r, "date"))
			tk := DraftTask{
				Ref: mk("task", cls), Title: key, ClassRef: classRef, Priority: NormalizeTaskPriority(col(r, "priority")),
				Done: ParseBool(col(r, "done")), TargetHours: ParseNumber(col(r, "target_hours")),
				ActualHours: ParseNumber(col(r, "actual_hours")),
			}
			if tk.Priority == "" {
				tk.Priority = "medium"
			}
			if d != nil {
				tk.Date = FormatInterval(d)
			}
			out.Tasks = append(out.Tasks, tk)
		default:
			status, _ := NormalizeReadingStatus(col(r, "status"))
			d := date(col(r, "date_read"))
			rd := DraftReading{
				Ref: mk("reading", ""), Title: key, ClassRef: classRef, Status: status,
				Format: SlugOption(col(r, "format")), TotalPages: ParseNumber(col(r, "total_pages")),
				PagesRead: ParseNumber(col(r, "pages_read")),
			}
			if d != nil {
				rd.DateRead = jsSlice(d.Start, 10)
			}
			out.Readings = append(out.Readings, rd)
		}
	}
	return out
}
