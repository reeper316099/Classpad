package server

import (
	"archive/zip"
	"bytes"
	"math/big"
	"regexp"
	"sort"
	"strings"

	"github.com/reeper316099/classpad/internal/frontmatter"
	"github.com/reeper316099/classpad/internal/grades"
	"github.com/reeper316099/classpad/internal/importers"
	"github.com/reeper316099/classpad/internal/jsv"
)

var weekOrder = []string{"mon", "tue", "wed", "thu", "fri", "sat", "sun"}

var dayName = map[string]string{"mon": "Mon", "tue": "Tue", "wed": "Wed", "thu": "Thu", "fri": "Fri", "sat": "Sat", "sun": "Sun"}

func weekdayIndex(d string) int {
	for i, w := range weekOrder {
		if w == d {
			return i
		}
	}
	return -1
}

func defined(v any) bool { return v != nil && v != jsv.Undefined }

// cell is the CSV cell text: v == null ? ” : String(v).
func cell(v any) string {
	if !defined(v) {
		return ""
	}
	return jsString(v)
}

// csvRow pairs header names with values.
func csvRow(kv ...any) map[string]string {
	out := map[string]string{}
	for i := 0; i+1 < len(kv); i += 2 {
		out[kv[i].(string)] = cell(kv[i+1])
	}
	return out
}

// or is `a ?? b`.
func or(a, b any) any {
	if defined(a) {
		return a
	}
	return b
}

func nameOf(r *Repo, id string) string {
	if e := r.Get(id); e != nil {
		return e.Str("name")
	}
	return ""
}

func objs(v any) []*jsv.Obj {
	var out []*jsv.Obj
	if a, ok := v.([]any); ok {
		for _, x := range a {
			if o, ok := x.(*jsv.Obj); ok {
				out = append(out, o)
			}
		}
	}
	return out
}

var CSVCollections = []string{"semesters", "classes", "assignments", "tasks", "readings"}

func (c *Context) ExportCSV(collection string) string {
	sem := func(id string) string { return nameOf(c.Semesters, id) }
	cls := func(id string) string { return nameOf(c.Classes, id) }
	var rows []map[string]string
	switch collection {
	case "semesters":
		for _, s := range c.Semesters.List() {
			rows = append(rows, csvRow("name", s.Get("name"), "start", s.Get("start"), "end", s.Get("end")))
		}
		return importers.ToCSV([]string{"name", "start", "end"}, rows)
	case "classes":
		for _, k := range c.Classes.List() {
			meetings := objs(k.Get("meetings"))
			var days, ranges []string
			seenDay, seenRange := map[string]bool{}, map[string]bool{}
			for _, m := range meetings {
				if d := m.Str("day"); !seenDay[d] {
					seenDay[d] = true
					days = append(days, d)
				}
				if r := m.Str("start") + "-" + m.Str("end"); !seenRange[r] {
					seenRange[r] = true
					ranges = append(ranges, r)
				}
			}
			sort.SliceStable(days, func(i, j int) bool { return weekdayIndex(days[i]) < weekdayIndex(days[j]) })
			times := ""
			if len(ranges) == 1 {
				times = ranges[0]
			} else if len(ranges) > 1 {
				parts := make([]string, len(meetings))
				for i, m := range meetings {
					parts[i] = dayName[m.Str("day")] + " " + m.Str("start") + "-" + m.Str("end")
				}
				times = strings.Join(parts, "\n")
			}
			names := make([]string, len(days))
			for i, d := range days {
				names[i] = dayName[d]
			}
			rows = append(rows, csvRow("name", k.Get("name"), "semester", sem(k.Str("semesterId")), "code", k.Get("code"),
				"credits", k.Get("credits"), "type", k.Get("type"), "delivery", k.Get("delivery"), "days", strings.Join(names, ", "),
				"times", times, "location", k.Get("location"), "instructor", k.Get("instructor")))
		}
		return importers.ToCSV([]string{"name", "semester", "code", "credits", "type", "delivery", "days", "times", "location", "instructor"}, rows)
	case "assignments":
		for _, a := range c.Assignments.List() {
			var score, possible any = "", ""
			if s := a.ObjAt("score"); s != nil {
				if s.Has("percent") {
					score = jsString(s.Get("percent")) + "%"
				} else {
					score = s.Get("earned")
				}
				if s.Has("earned") {
					possible = s.Get("possible")
				}
			}
			rows = append(rows, csvRow("title", a.Get("title"), "class", cls(a.Str("classId")), "due", a.Get("due"),
				"weight", a.Get("weight"), "score", score, "points_possible", or(a.Get("pointsPossible"), possible),
				"status", a.Get("status"), "priority", a.Get("priority"), "type", strings.Join(a.Strings("type"), ", "),
				"link", a.Get("link"), "notes", a.Get("quickNotes")))
		}
		return importers.ToCSV([]string{"title", "class", "due", "weight", "score", "points_possible", "status", "priority", "type", "link", "notes"}, rows)
	case "tasks":
		for _, t := range c.Tasks.List() {
			done := "no"
			if t.Bool("done") {
				done = "yes"
			}
			rows = append(rows, csvRow("title", t.Get("title"), "class", cls(t.Str("classId")), "date", t.Get("date"),
				"priority", t.Get("priority"), "done", done, "target_hours", t.Get("targetHours"), "actual_hours", t.Get("actualHours")))
		}
		return importers.ToCSV([]string{"title", "class", "date", "priority", "done", "target_hours", "actual_hours"}, rows)
	}
	for _, r := range c.Readings.List() {
		rows = append(rows, csvRow("title", r.Get("title"), "class", cls(r.Str("classId")), "status", r.Get("status"),
			"format", r.Get("format"), "total_pages", r.Get("totalPages"), "pages_read", r.Get("pagesRead"), "date_read", r.Get("dateRead")))
	}
	return importers.ToCSV([]string{"title", "class", "status", "format", "total_pages", "pages_read", "date_read"}, rows)
}

// ExportICS writes deadlines, the weekly timetable, or both ("deadlines", "timetable", "all").
func (c *Context) ExportICS(kind string) string {
	var deadlines []importers.ICSDeadline
	var meetings []importers.ICSMeeting
	if kind != "timetable" {
		for _, a := range c.Assignments.List() {
			if due := optStr(a, "due"); due != "" {
				deadlines = append(deadlines, importers.ICSDeadline{ID: a.Str("id"), Title: a.Str("title"), Due: due,
					ClassName: nameOf(c.Classes, a.Str("classId")), Notes: optStr(a, "quickNotes")})
			}
		}
	}
	if kind != "deadlines" {
		for _, k := range c.Classes.List() {
			sem := c.Semesters.Get(k.Str("semesterId"))
			var from, until string
			if d := k.ObjAt("dates"); d != nil {
				from, until = optStr(d, "start"), optStr(d, "end")
			}
			if from == "" && sem != nil {
				from = optStr(sem, "start")
			}
			if until == "" && sem != nil {
				until = optStr(sem, "end")
			}
			if from == "" || until == "" {
				continue
			}
			for _, m := range objs(k.Get("meetings")) {
				loc := optStr(m, "location")
				if !m.Has("location") || !defined(m.Get("location")) {
					loc = optStr(k, "location")
				}
				meetings = append(meetings, importers.ICSMeeting{ClassID: k.Str("id"), ClassName: k.Str("name"), Day: m.Str("day"),
					Start: m.Str("start"), End: m.Str("end"), Location: loc, From: from, Until: until})
			}
		}
	}
	return importers.BuildICS(deadlines, meetings, Now(), "")
}

func listAny(xs []*jsv.Obj) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}

func (c *Context) ExportJSON() *jsv.Obj {
	return jsv.O(
		"format", "classpad-backup",
		"schemaVersion", 1.0,
		"exportedAt", nowISO(),
		"semesters", listAny(c.Semesters.List()),
		"classes", listAny(c.Classes.List()),
		"assignments", listAny(c.Assignments.List()),
		"tasks", listAny(c.Tasks.List()),
		"readings", listAny(c.Readings.List()),
		"notes", listAny(c.Notes.List()),
		"journal", listAny(c.Journal.List()),
		"contacts", listAny(c.Contacts.List()),
		"activities", listAny(c.Activities.List()),
		"jobs", listAny(c.Jobs.List()),
		"admissions", listAny(c.Admissions.List()),
		"budget", listAny(c.Budget.List()),
		"flashcards", listAny(c.Cards.List()),
		"attachments", listAny(c.Attachments.List()),
		"gradingSchemes", c.Config.Schemes(),
		"gpaScales", c.Config.Scales(),
	)
}

var reAttachmentRef = regexp.MustCompile(`attachment://([0-9a-f]{64}\.[a-z0-9]{1,8})`)

// ExportMarkdownVault zips the notes as Markdown with front matter, a folder per class, plus the
// attachments they reference.
func (c *Context) ExportMarkdownVault() ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name string, data []byte) error {
		w, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = w.Write(data)
		return err
	}
	taken := map[string]map[string]bool{}
	added := map[string]bool{}
	for _, n := range c.Notes.List() {
		cls := c.Classes.Get(optStr(n, "classId"))
		folder := ""
		if cls != nil {
			folder = Slugify(cls.Str("name"))
		}
		names := taken[folder]
		if names == nil {
			names = map[string]bool{}
			taken[folder] = names
		}
		file := UniqueSlug(Slugify(n.Str("title")), names)
		names[file] = true
		body := n.Str("markdown")
		up := ""
		if folder != "" {
			up = "../"
		}
		for _, m := range reAttachmentRef.FindAllStringSubmatch(body, -1) {
			hash := strings.SplitN(m[1], ".", 2)[0]
			for _, att := range c.Attachments.List() {
				if att.Str("hash") != hash {
					continue
				}
				if !added[att.Str("id")] {
					added[att.Str("id")] = true
					data, err := c.Store.ReadBinary(att.Str("path"))
					if err != nil || data == nil {
						data = []byte{}
					}
					if err := add("attachments/"+hash+"."+ExtOf(att.Str("path")), data); err != nil {
						return nil, err
					}
				}
				break
			}
		}
		body = strings.ReplaceAll(body, "attachment://", up+"attachments/")
		titles := []any{}
		for _, id := range n.Strings("assignmentIds") {
			if a := c.Assignments.Get(id); a != nil && a.Str("title") != "" {
				titles = append(titles, a.Str("title"))
			}
		}
		var className any = jsv.Undefined
		if cls != nil {
			className = cls.Get("name")
		}
		fm := jsv.O("title", n.Get("title"), "date", n.GetU("date"), "tags", n.GetU("tags"), "class", className,
			"assignments", titles, "created", n.Get("createdAt"), "updated", n.Get("updatedAt"))
		path := file + ".md"
		if folder != "" {
			path = folder + "/" + path
		}
		if err := add(path, []byte(frontmatter.Stringify(body, fm))); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ------------------------------ printable grade report ------------------------------

var htmlEsc = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")

// esc is the report's escape: String(s ?? ”) with the five HTML characters replaced.
func esc(v any) string {
	switch x := v.(type) {
	case grades.Dec:
		return htmlEsc.Replace(x.String())
	case *grades.Dec:
		if x == nil {
			return ""
		}
		return htmlEsc.Replace(x.String())
	case *string:
		if x == nil {
			return ""
		}
		return htmlEsc.Replace(*x)
	}
	if !defined(v) {
		return ""
	}
	return htmlEsc.Replace(jsString(v))
}

func stepHTML(s grades.Step) string {
	var b strings.Builder
	b.WriteString(`<div class="step"><div class="lbl">` + esc(s.Label))
	if s.Value != "" {
		b.WriteString(" <b>" + esc(s.Value) + "</b>")
	}
	if s.Formula != "" {
		b.WriteString(" <code>" + esc(s.Formula) + "</code>")
	}
	b.WriteString("</div>")
	if len(s.Terms) > 0 {
		b.WriteString("<table><tr><th>Item</th><th>Score</th><th>Weight</th><th>Product</th><th></th></tr>")
		for _, t := range s.Terms {
			b.WriteString("<tr><td>" + esc(t.Label) + "</td><td>" + esc(t.Score) + "</td><td>" + esc(t.Weight) +
				"</td><td>" + esc(t.Product) + "</td><td>" + esc(t.Note) + "</td></tr>")
		}
		b.WriteString("</table>")
	}
	if s.Note != "" {
		b.WriteString(`<div class="note">` + esc(s.Note) + "</div>")
	}
	b.WriteString("</div>")
	return b.String()
}

func (c *Context) gradeOf(cls *jsv.Obj, items map[string][]grades.GradeItem) grades.GradeResult {
	ctx := c.Grading.ctxFor(cls, items)
	return grades.ComputeGrade(ctx.scheme, nonNilItems(ctx.items))
}

func (c *Context) GradeReportHTML(hideGrades bool) string {
	sems := append([]*jsv.Obj(nil), c.Semesters.List()...)
	sort.SliceStable(sems, func(i, j int) bool { return localeCompare(optStr(sems[j], "start"), optStr(sems[i], "start")) < 0 })
	items := c.Grading.itemsByClass()
	var parts strings.Builder
	for _, s := range sems {
		parts.WriteString("<h2>" + esc(s.Get("name")) + "</h2>")
		for _, k := range c.Classes.List() {
			if k.Str("semesterId") != s.Str("id") || k.Bool("archived") {
				continue
			}
			g := c.gradeOf(k, items)
			parts.WriteString(`<section class="class"><h3>` + esc(k.Get("name")))
			if code := optStr(k, "code"); code != "" && code != k.Str("name") {
				parts.WriteString(" <small>" + esc(code) + "</small>")
			}
			parts.WriteString(`<span class="grade">`)
			if g.Status == "none" {
				parts.WriteString(esc(g.Summary))
			} else {
				parts.WriteString(esc(g.PercentRounded) + "% · " + esc(g.Letter))
			}
			parts.WriteString(`</span></h3><div class="meta">`)
			if defined(k.Get("credits")) {
				parts.WriteString(esc(k.Get("credits")) + " credits · ")
			}
			parts.WriteString("scheme: " + esc(c.Config.Scheme(k.Str("gradingSchemeId")).Get("name")) + "</div>")
			if g.Status == "graded" {
				parts.WriteString("<details open><summary>How this was calculated</summary>")
				for _, st := range g.Steps {
					parts.WriteString(stepHTML(st))
				}
				parts.WriteString("</details>")
			}
			if len(g.Warnings) > 0 {
				parts.WriteString(`<ul class="warn">`)
				for _, w := range g.Warnings {
					parts.WriteString("<li>" + esc(w) + "</li>")
				}
				parts.WriteString("</ul>")
			}
			parts.WriteString("</section>")
		}
	}
	stored := c.Config.Scale("")
	scale := toEngineScale(stored)
	var courses []grades.GpaCourse
	for _, k := range c.Classes.List() {
		if k.Bool("archived") {
			continue
		}
		g := c.gradeOf(k, items)
		var letter any = nil
		if g.Letter != nil {
			letter = *g.Letter
		}
		view := jsv.O("id", k.Get("id"), "name", k.Get("name"), "semesterId", k.Get("semesterId"),
			"credits", or(k.Get("credits"), nil), "letter", letter, "honorsLevel", jsString(k.Get("honorsLevel")),
			"passFail", k.Get("passFail"), "includeInGpa", k.Get("includeInGpa"))
		copyDefined(view, jsv.O("courseKey", k.Get("code")), "courseKey")
		var e grades.GpaCourse
		if err := fromJSON(view, &e); err != nil {
			panic(err)
		}
		courses = append(courses, e)
	}
	if courses == nil {
		courses = []grades.GpaCourse{}
	}
	rep := grades.GpaReportFor(courses, scale, grades.GpaOptions{})
	gpa2 := func(d *grades.Dec) string {
		if d == nil {
			return "—"
		}
		return d.RoundDP(2, grades.RoundHalfUp).String()
	}
	row := func(label string, r grades.GpaPair) string {
		return "<tr><td>" + esc(label) + "</td><td>" + esc(gpa2(r.Unweighted.GPA)) + "</td><td>" + esc(gpa2(r.Weighted.GPA)) +
			"</td><td>" + esc(r.Unweighted.Credits) + "</td></tr>"
	}
	var rows strings.Builder
	for _, x := range rep.Semesters {
		name := "—"
		if s := c.Semesters.Get(x.SemesterID); s != nil {
			name = s.Str("name")
		}
		rows.WriteString(row(name, grades.GpaPair{Unweighted: x.Unweighted, Weighted: x.Weighted}))
	}
	rows.WriteString(row("Cumulative", rep.Cumulative))
	transcript := `<h2>GPA</h2><table><tr><th></th><th>Unweighted</th><th>Weighted</th><th>Credits</th></tr>` + rows.String() +
		`</table><div class="note">Scale: ` + esc(stored.Get("name")) + `. Each figure is the credit-weighted average of class grade points.</div>`
	blur := ""
	if hideGrades {
		blur = ".grade,td,code,b{filter:blur(6px)}"
	}
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Grade report</title><style>
  body{font:14px/1.5 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#111}h1{margin-bottom:0}h3{display:flex;justify-content:space-between;margin:1.2rem 0 .2rem}
  .grade{font-weight:700}.meta,.note{color:#555;font-size:12px}table{border-collapse:collapse;width:100%;margin:.4rem 0}td,th{border-bottom:1px solid #ddd;text-align:left;padding:.25rem .5rem}
  .class{break-inside:avoid}.warn{color:#8a5a00}code{background:#f3f3f3;padding:0 .25rem}` + blur + `@media print{details>summary{display:none}}</style></head><body>
  <h1>Grade report</h1><div class="note">Generated ` + esc(ISO(Now())[:10]) + ` by Classpad. Print this page to save as PDF.</div>` + parts.String() + transcript + `</body></html>`
}

// decFixed is Decimal.toFixed(dp) with half-up rounding (trailing zeros kept).
func decFixed(d grades.Dec, dp int) string {
	return padFixed(d.RoundDP(dp, grades.RoundHalfUp).String(), dp)
}

func padFixed(s string, dp int) string {
	if dp == 0 {
		return s
	}
	i := strings.IndexByte(s, '.')
	if i < 0 {
		return s + "." + strings.Repeat("0", dp)
	}
	return s + strings.Repeat("0", dp-(len(s)-i-1))
}

// jsToFixed is Number.prototype.toFixed for |x| < 1e21: the exact binary value, rounded half up.
func jsToFixed(x float64, dp int) string {
	exact := new(big.Float).SetPrec(0).SetFloat64(x).Text('f', 1100)
	neg := x < 0 // (-0.001).toFixed(2) is "-0.00"; (-0).toFixed(2) is "0.00"
	exact = strings.TrimPrefix(exact, "-")
	r, ok := new(big.Rat).SetString(exact)
	if !ok {
		return jsString(x)
	}
	scale := new(big.Rat).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(dp)), nil))
	r.Mul(r, scale).Add(r, big.NewRat(1, 2))
	q := new(big.Int).Quo(r.Num(), r.Denom())
	s := q.String()
	if dp > 0 {
		if len(s) <= dp {
			s = strings.Repeat("0", dp-len(s)+1) + s
		}
		s = s[:len(s)-dp] + "." + s[len(s)-dp:]
	}
	if neg {
		s = "-" + s
	}
	return s
}

func scorePercent(a *jsv.Obj) any {
	s := a.ObjAt("score")
	if s == nil {
		return ""
	}
	if s.Has("percent") {
		return s.Get("percent")
	}
	possible := or(s.Get("possible"), a.Get("pointsPossible"))
	p, ok := possible.(float64)
	if !ok || p == 0 {
		return ""
	}
	return jsToFixed(s.Num("earned")/p*100, 2)
}

// ExportGradebook is one row per assignment with its class and the class's current grade.
func (c *Context) ExportGradebook() string {
	items := c.Grading.itemsByClass()
	type cg struct{ percent, letter string }
	gradesBy := map[string]cg{}
	for _, k := range c.Classes.List() {
		g := c.gradeOf(k, items)
		x := cg{}
		if g.PercentRaw != nil {
			x.percent = decFixed(*g.PercentRaw, 2)
		}
		if g.Letter != nil {
			x.letter = *g.Letter
		}
		gradesBy[k.Str("id")] = x
	}
	semStart := func(id string) string {
		if s := c.Semesters.Get(id); s != nil {
			return optStr(s, "start")
		}
		return ""
	}
	classes := append([]*jsv.Obj(nil), c.Classes.List()...)
	sort.SliceStable(classes, func(i, j int) bool {
		a, b := classes[i], classes[j]
		if r := localeCompare(semStart(a.Str("semesterId")), semStart(b.Str("semesterId"))); r != 0 {
			return r < 0
		}
		return localeCompare(a.Str("name"), b.Str("name")) < 0
	})
	var rows []map[string]string
	for _, k := range classes {
		var list []*jsv.Obj
		for _, a := range c.Assignments.List() {
			if a.Str("classId") == k.Str("id") {
				list = append(list, a)
			}
		}
		sort.SliceStable(list, func(i, j int) bool {
			if r := localeCompare(optStr(list[i], "due"), optStr(list[j], "due")); r != 0 {
				return r < 0
			}
			return localeCompare(list[i].Str("title"), list[j].Str("title")) < 0
		})
		g := gradesBy[k.Str("id")]
		for _, a := range list {
			rows = append(rows, csvRow("semester", nameOf(c.Semesters, k.Str("semesterId")), "class", k.Get("name"),
				"code", or(k.Get("code"), ""), "credits", or(k.Get("credits"), ""), "assignment", a.Get("title"),
				"type", strings.Join(a.Strings("type"), "; "), "due", utf16Slice(optStr(a, "due"), 0, 10),
				"weight", or(a.Get("weight"), ""), "points_possible", or(a.Get("pointsPossible"), ""),
				"score_percent", scorePercent(a), "status", a.Get("status"),
				"class_percent", g.percent, "class_letter", g.letter))
		}
	}
	return importers.ToCSV([]string{"semester", "class", "code", "credits", "assignment", "type", "due", "weight",
		"points_possible", "score_percent", "status", "class_percent", "class_letter"}, rows)
}
