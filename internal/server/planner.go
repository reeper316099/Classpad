package server

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/reeper316099/classpad/internal/grades"
	"github.com/reeper316099/classpad/internal/jsv"
)

func pad2(n int) string { return fmt.Sprintf("%02d", n) }

// LocalDate is YYYY-MM-DD in local time (the year is not padded, as in the TypeScript).
func LocalDate(t time.Time) string {
	t = t.Local()
	return strconv.Itoa(t.Year()) + "-" + pad2(int(t.Month())) + "-" + pad2(t.Day())
}

var weekdays = []string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}

// parseLocalDate is new Date(y, m - 1, d) from the first ten characters (ok is false for NaN).
func parseLocalDate(s string) (time.Time, bool) {
	parts := strings.Split(slice10(s), "-")
	nums := make([]float64, 3)
	for i := range nums {
		if i >= len(parts) {
			return time.Time{}, false
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(parts[i]), 64)
		if err != nil && parts[i] != "" {
			return time.Time{}, false
		}
		nums[i] = f
	}
	y := int(nums[0])
	if y >= 0 && y <= 99 {
		y += 1900 // the two-digit year rule of the Date constructor
	}
	return time.Date(y, time.Month(int(nums[1])), int(nums[2]), 0, 0, 0, 0, time.Local), true
}

// AddDays adds n calendar days to a YYYY-MM-DD date.
func AddDays(s string, n int) string {
	t, _ := parseLocalDate(s)
	return LocalDate(time.Date(t.Year(), t.Month(), t.Day()+n, 0, 0, 0, 0, time.Local))
}

func dayDiff(a, b string) int {
	ta, _ := parseLocalDate(a)
	tb, _ := parseLocalDate(b)
	return int(jsRound(float64(ta.Sub(tb).Milliseconds()) / 86_400_000))
}

var reDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func isDate(s string) bool {
	if !reDate.MatchString(s) {
		return false
	}
	_, ok := parseLocalDate(s)
	return ok
}

func WeekStartOf(date, startDay string) string {
	t, _ := parseLocalDate(date)
	dow := int(t.Weekday())
	back := dow
	if startDay != "sun" {
		back = (dow + 6) % 7
	}
	return AddDays(date, -back)
}

func validation(msg string) *APIError { return apiErr(422, "VALIDATION", msg) }

// setOpt sets k from src[sk] when it is present.
func setOpt(dst *jsv.Obj, k string, src *jsv.Obj, sk string) {
	if src.Has(sk) && src.Get(sk) != jsv.Undefined {
		dst.Set(k, src.Get(sk))
	}
}

func splitRange(s string) (string, string, bool) {
	parts := strings.Split(s, "/")
	if len(parts) > 1 {
		return parts[0], parts[1], true
	}
	return parts[0], "", false
}

type agendaItem struct {
	o            *jsv.Obj
	start, title string
	allDay       bool
	kind         string
}

func (c *Context) agendaItems(from, to string) ([]agendaItem, error) {
	if !isDate(from) || !isDate(to) {
		return nil, validation("from and to must be YYYY-MM-DD")
	}
	if to < from {
		return nil, validation("to is before from")
	}
	if dayDiff(to, from) > 400 {
		return nil, validation("range is limited to 400 days")
	}
	var out []agendaItem
	inRange := func(d string) bool { return d >= from && d <= to }
	add := func(kind string, o *jsv.Obj, start string, allDay bool) {
		out = append(out, agendaItem{o: o, start: start, title: o.Str("title"), allDay: allDay, kind: kind})
	}

	for _, a := range c.Assignments.List() {
		due := optStr(a, "due")
		if due == "" || a.Bool("excused") {
			continue
		}
		s, e, hasEnd := splitRange(due)
		if !inRange(slice10(s)) {
			continue
		}
		o := jsv.O("kind", "deadline", "id", a.Get("id"), "title", a.Get("title"))
		setOpt(o, "classId", a, "classId")
		o.Set("start", s)
		if hasEnd {
			o.Set("end", e)
		}
		allDay := !strings.Contains(s, "T")
		o.Set("allDay", allDay).Set("done", a.Str("status") == "complete")
		setOpt(o, "weight", a, "weight")
		setOpt(o, "priority", a, "priority")
		add("deadline", o, s, allDay)
	}
	for _, t := range c.Tasks.List() {
		date := optStr(t, "date")
		if date == "" {
			continue
		}
		s, e, hasEnd := splitRange(date)
		if !inRange(slice10(s)) {
			continue
		}
		o := jsv.O("kind", "task", "id", t.Get("id"), "title", t.Get("title"))
		setOpt(o, "classId", t, "classId")
		o.Set("start", s)
		if hasEnd {
			o.Set("end", e)
		}
		allDay := !strings.Contains(s, "T")
		o.Set("allDay", allDay)
		setOpt(o, "done", t, "done")
		setOpt(o, "priority", t, "priority")
		add("task", o, s, allDay)
	}
	// class meetings, bounded by the class's own dates or its semester
	for _, cl := range c.Classes.List() {
		meetings := cl.Arr("meetings")
		if cl.Bool("archived") || len(meetings) == 0 {
			continue
		}
		sem := c.Semesters.Get(cl.Str("semesterId"))
		bound := func(k string) string {
			if d := cl.ObjAt("dates"); d != nil {
				if v, ok := d.Get(k).(string); ok {
					return v
				}
			}
			if sem != nil {
				return optStr(sem, k)
			}
			return ""
		}
		lo, hi := bound("start"), bound("end")
		for d := from; d <= to; d = AddDays(d, 1) {
			if (lo != "" && d < lo) || (hi != "" && d > hi) {
				continue
			}
			t, _ := parseLocalDate(d)
			dow := weekdays[t.Weekday()]
			for _, mv := range meetings {
				m := mv.(*jsv.Obj)
				if m.Str("day") != dow {
					continue
				}
				start := d + "T" + m.Str("start")
				o := jsv.O("kind", "class", "id", cl.Str("id")+":"+d+":"+m.Str("start"), "title", cl.Get("name"))
				o.Set("classId", cl.Get("id")).Set("start", start).Set("end", d+"T"+m.Str("end")).Set("allDay", false)
				if m.Has("location") {
					setOpt(o, "location", m, "location")
				} else {
					setOpt(o, "location", cl, "location")
				}
				add("class", o, start, false)
			}
		}
	}
	for _, s := range c.Study.List() {
		st, ok := parseJSDate(s.Str("start"))
		if !ok {
			continue // Invalid Date: localDate gives "NaN-NaN-NaN", never in range
		}
		d := LocalDate(st)
		if !inRange(d) {
			continue
		}
		lt := st.Local()
		start := d + "T" + pad2(lt.Hour()) + ":" + pad2(lt.Minute())
		o := jsv.O("kind", "study", "id", s.Get("id"), "title", "Study session")
		setOpt(o, "classId", s, "classId")
		o.Set("start", start).Set("allDay", false).Set("minutes", s.Get("minutes"))
		add("study", o, start, false)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if k := localeCompare(slice10(a.start), slice10(b.start)); k != 0 {
			return k < 0
		}
		if a.allDay != b.allDay {
			return a.allDay
		}
		if k := localeCompare(a.start, b.start); k != 0 {
			return k < 0
		}
		return localeCompare(a.title, b.title) < 0
	})
	return out, nil
}

func (c *Context) Agenda(from, to string) ([]any, error) {
	items, err := c.agendaItems(from, to)
	if err != nil {
		return nil, err
	}
	out := make([]any, len(items))
	for i, it := range items {
		out[i] = it.o
	}
	return out, nil
}

func (c *Context) Timetable(week, startDay string) (any, error) {
	if !isDate(week) {
		return nil, validation("week must be YYYY-MM-DD")
	}
	ws := WeekStartOf(week, startDay)
	we := AddDays(ws, 6)
	items, err := c.agendaItems(ws, we)
	if err != nil {
		return nil, err
	}
	days := []any{}
	for i := range 7 {
		date := AddDays(ws, i)
		day := []any{}
		for _, it := range items {
			if it.kind != "study" && slice10(it.start) == date {
				day = append(day, it.o)
			}
		}
		days = append(days, jsv.O("date", date, "items", day))
	}
	return jsv.O("weekStart", ws, "weekEnd", we, "days", days), nil
}

func openDeadline(a *jsv.Obj) bool {
	return optStr(a, "due") != "" && a.Str("status") != "complete" && !a.Bool("excused") && !a.Bool("dropped")
}

func dueDate(a *jsv.Obj) string { s, _, _ := splitRange(a.Str("due")); return slice10(s) }

func (c *Context) Deadlines(now time.Time) []any {
	today := LocalDate(now)
	type row struct {
		due string
		o   *jsv.Obj
	}
	var rows []row
	for _, a := range c.Assignments.List() {
		if !openDeadline(a) {
			continue
		}
		days := dayDiff(dueDate(a), today)
		urgency := "later"
		switch {
		case days < 0:
			urgency = "overdue"
		case days == 0:
			urgency = "today"
		case days <= 6:
			urgency = "soon"
		}
		o := jsv.O("id", a.Get("id"), "title", a.Get("title"), "classId", a.Get("classId"), "due", a.Get("due"))
		setOpt(o, "weight", a, "weight")
		setOpt(o, "priority", a, "priority")
		o.Set("days", float64(days)).Set("urgency", urgency)
		rows = append(rows, row{a.Str("due"), o})
	}
	sort.SliceStable(rows, func(i, j int) bool { return localeCompare(rows[i].due, rows[j].due) < 0 })
	out := make([]any, len(rows))
	for i, r := range rows {
		out[i] = r.o
	}
	return out
}

// itemLoad: heavier exams and high-weight items count more.
func itemLoad(a *jsv.Obj) float64 {
	n := 1 + a.Num("weight")/20
	for _, t := range a.Strings("type") {
		if t == "exam" || t == "project" || t == "presentation" {
			n += 1.5
			break
		}
	}
	if a.Str("priority") == "important" {
		n += 0.5
	}
	return n
}

func LoadLevel(score float64) string {
	switch {
	case score < 3:
		return "light"
	case score < 6:
		return "normal"
	}
	return "heavy"
}

func (c *Context) Stats(now time.Time, startDay string) any {
	today := LocalDate(now)
	ws := WeekStartOf(today, startDay)
	we := AddDays(ws, 6)
	var classes []*jsv.Obj
	for _, cl := range c.Classes.List() {
		if !cl.Bool("archived") {
			classes = append(classes, cl)
		}
	}

	type sess struct {
		classID string
		date    string
		minutes float64
	}
	var sessions []sess
	for _, s := range c.Study.List() {
		d := "NaN-NaN-NaN"
		if t, ok := parseJSDate(s.Str("start")); ok {
			d = LocalDate(t)
		}
		sessions = append(sessions, sess{optStr(s, "classId"), d, s.Num("minutes")})
	}
	inWeek := func(d string) bool { return d >= ws && d <= we }
	perClass := []any{}
	total := 0.0
	for _, cl := range classes {
		m := 0.0
		for _, s := range sessions {
			if s.classID == cl.Str("id") && inWeek(s.date) {
				m += s.minutes
			}
		}
		total += m
		perClass = append(perClass, jsv.O("classId", cl.Get("id"), "minutes", m, "targetMinutes", jsRound(cl.Num("studyTargetHours")*60)))
	}
	unassigned := 0.0
	for _, s := range sessions {
		if s.classID == "" && inWeek(s.date) {
			unassigned += s.minutes
		}
	}
	daily := []any{}
	byDate := map[string]float64{}
	had := map[string]bool{}
	for _, s := range sessions {
		byDate[s.date] += s.minutes
		if s.minutes > 0 {
			had[s.date] = true
		}
	}
	for i := range 14 {
		date := AddDays(today, i-13)
		daily = append(daily, jsv.O("date", date, "minutes", byDate[date]))
	}
	streak := 0
	d := today
	if !had[today] {
		d = AddDays(today, -1)
	}
	for ; had[d]; d = AddDays(d, -1) {
		streak++
	}

	var open []*jsv.Obj
	for _, a := range c.Assignments.List() {
		if openDeadline(a) {
			open = append(open, a)
		}
	}
	tasks := c.Tasks.List()
	workload := []any{}
	for w := range 8 {
		wks := AddDays(ws, w*7)
		wke := AddDays(wks, 6)
		score, count := 0.0, 0
		for _, a := range open {
			if dd := dueDate(a); dd >= wks && dd <= wke {
				score += itemLoad(a)
				count++
			}
		}
		hours := 0.0
		for _, t := range tasks {
			date := optStr(t, "date")
			if t.Bool("done") || date == "" {
				continue
			}
			if d := slice10(date); d >= wks && d <= wke {
				hours += t.Num("targetHours")
			}
		}
		score += hours * 0.5
		workload = append(workload, jsv.O("weekStart", wks, "deadlines", float64(count), "taskHours", hours,
			"score", jsRound(score*10)/10, "load", LoadLevel(score)))
	}

	// grade trend per class: the running grade after each graded item, oldest to newest
	trends := jsv.NewObj()
	all := c.Assignments.List()
	for _, cl := range classes {
		scheme := ToEngineScheme(c.Config.Scheme(cl.Str("gradingSchemeId")), cl)
		type g struct {
			a   *jsv.Obj
			due string
		}
		var graded []g
		for _, a := range all {
			if a.Str("classId") != cl.Str("id") || a.ObjAt("score") == nil || a.Bool("excused") || a.Bool("dropped") {
				continue
			}
			due := slice10(a.Str("updatedAt"))
			if v, ok := a.Get("due").(string); ok {
				due = slice10(v)
			}
			graded = append(graded, g{a, due})
		}
		sort.SliceStable(graded, func(i, j int) bool {
			if k := localeCompare(graded[i].due, graded[j].due); k != 0 {
				return k < 0
			}
			return localeCompare(graded[i].a.Str("title"), graded[j].a.Str("title")) < 0
		})
		items := make([]grades.GradeItem, len(graded))
		for i, x := range graded {
			items[i] = ToGradeItem(x.a)
		}
		pts := []any{}
		for i := 1; i <= len(items); i++ {
			if r := grades.ComputeGrade(scheme, items[:i]).PercentRaw; r != nil {
				pts = append(pts, r.RoundDP(2, grades.RoundHalfUp).Float64())
			}
		}
		if len(pts) > 12 {
			pts = pts[len(pts)-12:]
		}
		trends.Set(cl.Str("id"), pts)
	}
	return jsv.O(
		"today", today, "weekStart", ws, "weekEnd", we,
		"study", jsv.O("perClass", perClass, "unassignedMinutes", unassigned,
			"totalWeekMinutes", total+unassigned, "daily", daily, "streakDays", float64(streak)),
		"workload", workload,
		"trends", trends,
	)
}
