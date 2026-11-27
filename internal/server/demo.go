package server

import (
	"fmt"
	"strings"
	"time"

	"github.com/reeper316099/classpad/internal/jsv"
)

const demoRef = "demo:"

func isoDay(t time.Time) string { return ISO(t)[:10] }

func addDaysMs(t time.Time, n int) time.Time { return t.Add(time.Duration(n) * 24 * time.Hour) }

func lorem(n int) string {
	return strings.Join(strings.Fields("lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor")[:n], " ")
}

// HasDemo is whether the demo data is present.
func (c *Context) HasDemo() bool {
	for _, s := range c.Semesters.List() {
		if strings.HasPrefix(optStr(s, "importRef"), demoRef) {
			return true
		}
	}
	return false
}

// spread is `{ ...base, ...extra }` (later keys keep the earlier position).
func spread(base *jsv.Obj, extra *jsv.Obj) *jsv.Obj {
	out := base.Clone()
	for _, k := range extra.Keys() {
		out.Set(k, extra.Get(k))
	}
	return out
}

// LoadDemo creates a small, entirely invented semester: five classes using all three grading
// schemes, about forty assignments (past ones graded), notes with math, tasks, readings and study
// sessions. Dates are relative to now so the dashboard always looks alive.
func (c *Context) LoadDemo(now time.Time) (*jsv.Obj, error) {
	if c.HasDemo() {
		return jsv.O("alreadyLoaded", true), nil
	}
	var firstErr error
	must := func(o *jsv.Obj, err error) *jsv.Obj {
		if err != nil && firstErr == nil {
			firstErr = err
		}
		if o == nil {
			return jsv.O("id", "")
		}
		return o
	}
	sem := must(c.Semesters.Create(jsv.O(
		"name", "Demo Term", "start", isoDay(addDaysMs(now, -63)), "end", isoDay(addDaysMs(now, 56)),
		"isCurrent", true, "importRef", demoRef+"semester",
		"goals", []any{"Keep a steady study rhythm", "Finish every reading before lectures", "Ask for help early"},
	)))
	if firstErr != nil {
		return nil, firstErr
	}

	schemes := append([]any{}, c.Config.Schemes()...)
	var base *jsv.Obj
	has := false
	for _, s := range schemes {
		o := s.(*jsv.Obj)
		if o.Str("id") == "default" && base == nil {
			base = o
		}
		if o.Str("id") == "demo-categories" {
			has = true
		}
	}
	if !has && base != nil {
		schemes = append(schemes, spread(base, jsv.O(
			"id", "demo-categories", "name", "Demo: categories", "mode", "category_weights",
			"categories", []any{
				jsv.O("id", "quiz", "name", "Quizzes", "weight", 20.0, "dropLowest", 1.0, "countMode", "mean"),
				jsv.O("id", "hw", "name", "Homework", "weight", 30.0, "countMode", "pooled"),
				jsv.O("id", "exam", "name", "Exams", "weight", 50.0, "countMode", "mean"),
			},
		)))
	}
	if _, err := c.Config.PutSchemes(schemes); err != nil {
		return nil, err
	}

	meet := func(day, start, end string) *jsv.Obj { return jsv.O("day", day, "start", start, "end", end) }
	mk := func(name, code, color string, extra *jsv.Obj) string {
		return must(c.Classes.Create(spread(jsv.O("semesterId", sem.Str("id"), "name", name, "code", code, "color", color,
			"importRef", demoRef+"class:"+code), extra))).Str("id")
	}
	c1 := mk("Intro to Lorem Studies", "LOR 101", "#6366f1", jsv.O("credits", 4.0, "studyTargetHours", 5.0, "type", "core",
		"delivery", "in_person", "location", "Hall A-12", "honorsLevel", "ap", "instructor", "Prof. Placeholder",
		"meetings", []any{meet("mon", "09:15", "10:30"), meet("wed", "09:15", "10:30")}))
	c2 := mk("Ipsum Methods", "IPS 210", "#ec4899", jsv.O("credits", 3.0, "studyTargetHours", 4.0, "type", "gen_ed",
		"delivery", "hybrid", "gradingSchemeId", "demo-categories", "instructor", "Dr. Sample",
		"meetings", []any{meet("tue", "11:00", "12:15"), meet("thu", "11:00", "12:15")}))
	c3 := mk("Dolor Lab Practice", "DOL 150", "#10b981", jsv.O("credits", 3.0, "studyTargetHours", 3.0, "type", "elective",
		"delivery", "in_person", "gradingSchemeId", "points", "location", "Lab 3",
		"meetings", []any{meet("fri", "13:00", "15:50")}))
	c4 := mk("Amet Writing Seminar", "AME 220", "#f59e0b", jsv.O("credits", 3.0, "type", "gen_ed", "delivery", "online",
		"meetings", []any{meet("tue", "15:30", "16:45")}))
	c5 := mk("Sit Studio Hour", "SIT 099", "#06b6d4", jsv.O("credits", 1.0, "passFail", true, "includeInGpa", false,
		"delivery", "in_person", "meetings", []any{meet("thu", "17:00", "18:30")}))
	if firstErr != nil {
		return nil, firstErr
	}

	asg := func(classID, title string, dayOffset int, extra *jsv.Obj) {
		status := "not_started"
		if truthy(extra.Get("score")) {
			status = "complete"
		}
		must(c.Assignments.Create(spread(jsv.O("classId", classID, "title", title, "due", isoDay(addDaysMs(now, dayOffset)),
			"importRef", demoRef+"asg:"+classID+":"+title, "status", status), extra)))
	}
	pct := func(p float64) *jsv.Obj { return jsv.O("percent", p) }
	pts := func(e, p float64) *jsv.Obj { return jsv.O("earned", e, "possible", p) }
	types := func(ts ...string) []any { return strList(ts) }

	// LOR 101: assignment weights, one extra-credit item
	lor := []struct {
		t    string
		d    int
		w, s float64
		ty   []string
	}{
		{"Reading response 1", -56, 8, 92, []string{"essay"}},
		{"Reading response 2", -42, 8, 85, []string{"essay"}},
		{"Midterm exam", -21, 25, 78, []string{"exam"}},
		{"Group presentation", -7, 12, 90, []string{"presentation", "group_project"}},
		{"Reading response 3", 6, 8, 0, []string{"essay"}},
		{"Final project draft", 25, 12, 0, []string{"project"}},
		{"Final exam", 50, 21, 0, []string{"exam"}},
	}
	for _, x := range lor {
		prio := "mid"
		if strings.Contains(x.t, "exam") {
			prio = "important"
		}
		e := jsv.O("weight", x.w, "type", types(x.ty...), "priority", prio)
		if x.s != 0 {
			e.Set("score", pct(x.s))
		}
		asg(c1, x.t, x.d, e)
	}
	asg(c1, "Bonus: attend colloquium", 30, jsv.O("weight", 3.0, "extraCredit", true, "type", types("in_class"), "priority", "low"))

	// IPS 210: category weights with drop-lowest
	for i, q := range [][2]float64{{-49, 70}, {-35, 90}, {-28, 100}, {-14, 85}} {
		asg(c2, fmt.Sprintf("Quiz %d", i+1), int(q[0]), jsv.O("categoryId", "quiz", "score", pct(q[1]), "type", types("quiz"), "pointsPossible", 20.0))
	}
	asg(c2, "Quiz 5", 9, jsv.O("categoryId", "quiz", "type", types("quiz"), "pointsPossible", 20.0))
	for i, h := range [][2]float64{{-52, 46}, {-38, 41}, {-24, 48}} {
		asg(c2, fmt.Sprintf("Homework %d", i+1), int(h[0]), jsv.O("categoryId", "hw", "score", pts(h[1], 50), "pointsPossible", 50.0, "type", types("homework")))
	}
	asg(c2, "Homework 4", 4, jsv.O("categoryId", "hw", "pointsPossible", 50.0, "type", types("homework"), "priority", "important"))
	asg(c2, "Midterm", -18, jsv.O("categoryId", "exam", "score", pct(82), "type", types("exam"), "priority", "important"))
	asg(c2, "Final", 52, jsv.O("categoryId", "exam", "type", types("exam"), "priority", "important"))

	// DOL 150: total points
	for i, l := range [][3]float64{{-50, 18, 20}, {-43, 22, 25}, {-36, 27, 30}, {-22, 36, 40}, {-8, 19, 20}} {
		asg(c3, fmt.Sprintf("Lab %d", i+1), int(l[0]), jsv.O("score", pts(l[1], l[2]), "pointsPossible", l[2], "type", types("lab")))
	}
	asg(c3, "Lab 6", 5, jsv.O("pointsPossible", 30.0, "type", types("lab")))
	asg(c3, "Lab practical", 33, jsv.O("pointsPossible", 100.0, "type", types("exam"), "priority", "important"))

	// AME 220: assignment weights, mostly upcoming
	asg(c4, "Personal essay", -30, jsv.O("weight", 25.0, "score", pct(88), "type", types("essay")))
	asg(c4, "Peer review", 2, jsv.O("weight", 15.0, "type", types("in_class")))
	asg(c4, "Research essay", 18, jsv.O("weight", 30.0, "type", types("essay"), "priority", "important"))
	asg(c4, "Portfolio", 54, jsv.O("weight", 30.0, "type", types("project")))

	// a few more small items so the lists feel lived-in
	asg(c1, "Discussion post 1", -35, jsv.O("weight", 2.0, "score", pct(100), "type", types("in_class")))
	asg(c1, "Discussion post 2", -14, jsv.O("weight", 2.0, "score", pct(95), "type", types("in_class")))
	asg(c1, "Discussion post 3", 12, jsv.O("weight", 2.0, "type", types("in_class")))
	asg(c2, "Quiz 6", 30, jsv.O("categoryId", "quiz", "type", types("quiz"), "pointsPossible", 20.0))
	asg(c2, "Homework 5", 15, jsv.O("categoryId", "hw", "pointsPossible", 50.0, "type", types("homework")))
	asg(c2, "Homework 6", 28, jsv.O("categoryId", "hw", "pointsPossible", 50.0, "type", types("homework")))
	asg(c3, "Lab 7", 19, jsv.O("pointsPossible", 30.0, "type", types("lab")))
	asg(c3, "Lab 8", 40, jsv.O("pointsPossible", 30.0, "type", types("lab")))
	asg(c4, "Reading journal", -18, jsv.O("weight", 0.0, "type", types("homework"), "status", "complete"))
	asg(c4, "Annotated bibliography", 32, jsv.O("weight", 0.0, "type", types("homework")))

	// SIT 099: pass/fail
	asg(c5, "Studio participation", -10, jsv.O("weight", 100.0, "score", pct(100)))

	// notes with math
	note := func(title, classID, markdown string, tags []string, date int) {
		must(c.Notes.Create(jsv.O("title", title, "classId", classID, "markdown", markdown, "tags", strList(tags),
			"date", isoDay(addDaysMs(now, date)), "importRef", demoRef+"note:"+title)))
	}
	note("Lecture 3: Lorem foundations", c1,
		"# Lorem foundations\n\n"+lorem(10)+".\n\n## Key equation\n\n$$ E = mc^2 $$\n\n- [ ] Review the proof\n- [x] Read chapter 2\n\nSee also [[Ipsum sampling notes]].\n",
		[]string{"lecture", "exam1"}, -20)
	note("Ipsum sampling notes", c2,
		"# Sampling\n\nThe sample mean is $\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i$.\n\n| Term | Meaning |\n| --- | --- |\n| $n$ | sample size |\n| $\\bar{x}$ | sample mean |\n\n```python\nmean = sum(xs) / len(xs)\n```\n",
		[]string{"lecture"}, -12)
	note("Lab 5 write-up", c3, "# Lab 5\n\n"+lorem(12)+".\n\n> **Remember:** label every axis.\n", []string{"lab"}, -8)

	// tasks and readings
	task := func(title string, classID any, date int, extra *jsv.Obj) {
		must(c.Tasks.Create(spread(jsv.O("title", title, "classId", classID, "date", isoDay(addDaysMs(now, date)),
			"importRef", demoRef+"task:"+title), extra)))
	}
	task("Outline final project", c1, 8, jsv.O("priority", "high", "targetHours", 3.0, "assignmentId", jsv.Undefined))
	task("Review quiz errors", c2, 1, jsv.O("priority", "medium", "targetHours", 1.5))
	task("Finish Lab 6 prep", c3, 3, jsv.O("priority", "medium", "targetHours", 2.0, "actualHours", 0.5))
	task("Email study group", jsv.Undefined, 0, jsv.O("priority", "low", "done", true))
	task("Draft research essay intro", c4, 10, jsv.O("priority", "high", "targetHours", 4.0))
	task("Midterm retrospective", c1, -20, jsv.O("priority", "medium", "targetHours", 2.0, "actualHours", 2.5, "done", true))
	must(c.Readings.Create(jsv.O("title", "Foundations of Lorem", "classId", c1, "status", "reading", "format", "library",
		"totalPages", 240.0, "pagesRead", 96.0, "importRef", demoRef+"reading:1")))
	must(c.Readings.Create(jsv.O("title", "A Short Ipsum Anthology", "classId", c2, "status", "complete", "format", "digital",
		"totalPages", 120.0, "pagesRead", 120.0, "importRef", demoRef+"reading:2")))

	// study sessions over the last three weeks (local time, 25 to 90 minutes)
	plan := []struct {
		off, hour int
		classID   string
		mins      int
	}{
		{0, 16, c1, 50}, {-1, 19, c2, 45}, {-1, 15, c1, 25}, {-2, 18, c3, 60}, {-3, 20, c1, 90}, {-4, 14, c2, 30},
		{-5, 17, c4, 40}, {-6, 11, c1, 75}, {-7, 16, c2, 50}, {-8, 19, c3, 45}, {-9, 15, c1, 25}, {-10, 18, c2, 60},
		{-12, 16, c1, 50}, {-14, 17, c3, 40}, {-15, 19, c2, 55}, {-17, 15, c1, 70}, {-19, 18, c4, 35},
	}
	local := now.In(time.Local)
	for i, p := range plan {
		st := time.Date(local.Year(), local.Month(), local.Day()+p.off, p.hour, 0, 0, 0, time.Local)
		kind := "pomodoro"
		if i%3 == 0 {
			kind = "manual"
		}
		must(c.Study.Create(jsv.O("start", ISO(st), "end", ISO(st.Add(time.Duration(p.mins)*time.Minute)),
			"minutes", float64(p.mins), "classId", p.classID, "kind", kind, "importRef", fmt.Sprintf("%sstudy:%d", demoRef, i))))
	}
	if firstErr != nil {
		return nil, firstErr
	}
	return jsv.O("alreadyLoaded", false, "semesterId", sem.Str("id")), nil
}

// ClearDemo removes everything the demo created (matched by importRef); the user's own data stays.
func (c *Context) ClearDemo() error {
	mine := func(xs []*jsv.Obj) []string {
		out := []string{}
		for _, x := range xs {
			if strings.HasPrefix(optStr(x, "importRef"), demoRef) {
				out = append(out, x.Str("id"))
			}
		}
		return out
	}
	if _, err := c.Store.Backup("pre-clear-demo", 20); err != nil {
		return err
	}
	for _, id := range mine(c.Notes.List()) {
		if err := c.Notes.Delete(id); err != nil {
			return err
		}
	}
	if err := c.Study.DeleteMany(mine(c.Study.List())); err != nil {
		return err
	}
	for _, r := range []*Repo{c.Tasks, c.Readings, c.Assignments, c.Classes, c.Semesters} {
		if err := r.DeleteMany(mine(r.List())); err != nil {
			return err
		}
	}
	var keep []any
	for _, s := range c.Config.Schemes() {
		if s.(*jsv.Obj).Str("id") != "demo-categories" {
			keep = append(keep, s)
		}
	}
	if keep == nil {
		keep = []any{}
	}
	_, err := c.Config.PutSchemes(keep)
	return err
}
