package server

import (
	"fmt"
	"math"
	"net/http"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/reeper316099/classpad/internal/importers"
	"github.com/reeper316099/classpad/internal/jsonstore"
	"github.com/reeper316099/classpad/internal/jsv"
	. "github.com/reeper316099/classpad/internal/schema"
)

// collection is what the CRUD routes need.
type collection interface {
	Name() string
	List() []*jsv.Obj
	Get(id string) *jsv.Obj
	Create(input *jsv.Obj) (*jsv.Obj, error)
	Update(id string, patch *jsv.Obj) (*jsv.Obj, error)
	Delete(id string) error
}

var (
	idParams = Obj(F("id", String().Min(1).Max(64)))
	paging   = Obj(
		F("limit", Default(Coerce().Int().Min(1).Max(1000), func() any { return 100.0 })),
		F("offset", Default(Coerce().Int().Min(0), func() any { return 0.0 })),
		F("sort", Optional(String().Max(40))),
		F("order", Default(Enum("asc", "desc"), func() any { return "asc" })),
	)
	scoreInput = Union(
		Obj(F("kind", Literal("percent")), F("percent", Number())),
		Obj(F("kind", Literal("points")), F("earned", Number()), F("possible", Optional(Number()))),
		Obj(F("kind", Literal("letter")), F("letter", String().Min(1).Max(5))),
	)
	anyRecord = Record(Unknown())
	day       = String().Regex(regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`), `/^\d{4}-\d{2}-\d{2}$/`)
	weekStart = Default(Enum("mon", "sun"), func() any { return "mon" })
	pass      = String().Min(1).Max(500)
)

func parse(s Schema, v any) (*jsv.Obj, error) { return ParseObj(s, v) }

func (q *request) paramID() (string, error) {
	p := jsv.NewObj()
	for k, v := range q.params {
		p.Set(k, v)
	}
	o, err := parse(idParams, p)
	if err != nil {
		return "", err
	}
	return o.Str("id"), nil
}

// bodyOr is `r.body ?? {}`.
func (q *request) bodyOr() any {
	if q.body == Missing || q.body == nil {
		return jsv.NewObj()
	}
	return q.body
}

// nullsToUndefined: PATCH treats null as "clear this field".
func nullsToUndefined(b *jsv.Obj) *jsv.Obj {
	out := jsv.NewObj()
	for _, k := range b.Keys() {
		v := b.Get(k)
		if v == nil {
			v = jsv.Undefined
		}
		out.Set(k, v)
	}
	return out
}

var reDigits = regexp.MustCompile(`\d+`)

// numericKey makes localeCompare behave like { numeric: true }: runs of digits are padded so they
// compare by value.
func numericKey(s string) string {
	if !strings.ContainsAny(s, "0123456789") {
		return s
	}
	pad := func(s string) string {
		return reDigits.ReplaceAllStringFunc(s, func(d string) string {
			d = strings.TrimLeft(d, "0")
			if d == "" {
				d = "0"
			}
			if len(d) < 40 {
				d = strings.Repeat("0", 40-len(d)) + d
			}
			return d
		})
	}
	return pad(s)
}

// localeCompareNumeric is localeCompare with { numeric: true }.
func localeCompareNumeric(a, b string) int { return localeCompare(numericKey(a), numericKey(b)) }

// applyList filters (any other query key is an equality filter; from/to bound `start`), sorts and pages.
func applyList(items []*jsv.Obj, query *jsv.Obj) (any, error) {
	p, err := parse(paging, query)
	if err != nil {
		return nil, err
	}
	limit, offset := int(p.Num("limit")), int(p.Num("offset"))
	sortKey, order := optStr(p, "sort"), p.Str("order")
	var filters [][2]any
	for _, k := range query.Keys() {
		switch k {
		case "limit", "offset", "sort", "order":
			continue
		}
		filters = append(filters, [2]any{k, query.Get(k)})
	}
	out := []*jsv.Obj{}
	for _, it := range items {
		keep := true
		for _, f := range filters {
			k, v := f[0].(string), jsString(f[1])
			if start, ok := it.Get("start").(string); ok && (k == "from" || k == "to") {
				d := utf16Slice(start, 0, 10)
				if k == "from" {
					keep = d >= v
				} else {
					keep = d <= v
				}
			} else if arr, ok := it.Get(k).([]any); ok {
				found := false
				for _, x := range arr {
					found = found || jsString(x) == v
				}
				keep = found
			} else {
				keep = cell(it.Get(k)) == v
			}
			if !keep {
				break
			}
		}
		if keep {
			out = append(out, it)
		}
	}
	if sortKey != "" {
		var present, missing []*jsv.Obj
		for _, it := range out {
			if defined(it.Get(sortKey)) {
				present = append(present, it)
			} else {
				missing = append(missing, it)
			}
		}
		dir := 1
		if order == "desc" {
			dir = -1
		}
		keys := make(map[*jsv.Obj]string, len(present)) // each key once, not once per comparison
		for _, it := range present {
			keys[it] = numericKey(jsString(it.Get(sortKey)))
		}
		sort.SliceStable(present, func(i, j int) bool {
			return localeCompare(keys[present[i]], keys[present[j]])*dir < 0
		})
		if dir == 1 {
			out = append(present, missing...)
		} else {
			// the comparator puts every missing value first, later ones before earlier ones
			rev := make([]*jsv.Obj, 0, len(out))
			for i := len(missing) - 1; i >= 0; i-- {
				rev = append(rev, missing[i])
			}
			out = append(rev, present...)
		}
	}
	end := min(offset+limit, len(out))
	page := []*jsv.Obj{}
	if offset < len(out) {
		page = out[offset:end]
	}
	return jsv.O("items", listAny(page), "total", float64(len(out)), "limit", float64(limit), "offset", float64(offset)), nil
}

type crudHooks struct {
	omit   []string
	after  func(e *jsv.Obj, kind string) error
	remove func(id string) error
}

func (a *App) crud(path string, col collection, h crudHooks) {
	strip := func(b *jsv.Obj) *jsv.Obj {
		b = b.Clone()
		for _, k := range append([]string{"id", "createdAt", "updatedAt"}, h.omit...) {
			b.Delete(k)
		}
		return b
	}
	a.add("GET", path, func(q *request) (any, error) { return applyList(col.List(), q.query) })
	a.add("GET", path+"/:id", func(q *request) (any, error) {
		id, err := q.paramID()
		if err != nil {
			return nil, err
		}
		if e := col.Get(id); e != nil {
			return e, nil
		}
		return nil, notFound(col.Name(), id)
	})
	a.add("POST", path, func(q *request) (any, error) {
		b, err := parse(anyRecord, q.body)
		if err != nil {
			return nil, err
		}
		e, err := col.Create(nullsToUndefined(strip(b)))
		if err != nil {
			return nil, err
		}
		if h.after != nil {
			if err := h.after(e, "create"); err != nil {
				return nil, err
			}
		}
		return e, nil
	})
	a.add("PATCH", path+"/:id", func(q *request) (any, error) {
		id, err := q.paramID()
		if err != nil {
			return nil, err
		}
		b, err := parse(anyRecord, q.body)
		if err != nil {
			return nil, err
		}
		e, err := col.Update(id, nullsToUndefined(strip(b)))
		if err != nil {
			return nil, err
		}
		if h.after != nil {
			if err := h.after(e, "update"); err != nil {
				return nil, err
			}
		}
		return e, nil
	})
	a.add("DELETE", path+"/:id", func(q *request) (any, error) {
		id, err := q.paramID()
		if err != nil {
			return nil, err
		}
		if col.Get(id) == nil {
			return nil, notFound(col.Name(), id)
		}
		if h.remove != nil {
			err = h.remove(id)
		} else {
			err = col.Delete(id)
		}
		if err != nil {
			return nil, err
		}
		return jsv.Undefined, nil
	})
}

func idsWhere(list []*jsv.Obj, keep func(*jsv.Obj) bool) []string {
	out := []string{}
	for _, e := range list {
		if keep(e) {
			out = append(out, e.Str("id"))
		}
	}
	return out
}

func isNewCard(c *jsv.Obj) bool {
	s := c.ObjAt("srs")
	return s.Num("reps") == 0 && s.Num("lapses") == 0
}

func (a *App) registerRoutes() {
	ctx := a.Ctx
	store := ctx.Store

	// cascades: removing a parent never leaves dangling children
	removeClass := func(id string, backedUp bool) error {
		asg := idsWhere(ctx.Assignments.List(), func(x *jsv.Obj) bool { return x.Str("classId") == id })
		if len(asg) > 1 && !backedUp {
			if _, err := store.Backup("pre-bulk-delete", 20); err != nil {
				return err
			}
		}
		if err := ctx.Assignments.DeleteMany(asg); err != nil {
			return err
		}
		clear := func(k string) func(*jsv.Obj) *jsv.Obj {
			return func(*jsv.Obj) *jsv.Obj { return jsv.O(k, jsv.Undefined) }
		}
		if err := ctx.Tasks.PatchMany(idsWhere(ctx.Tasks.List(), func(x *jsv.Obj) bool { return x.Str("classId") == id }), clear("classId")); err != nil {
			return err
		}
		if err := ctx.Readings.PatchMany(idsWhere(ctx.Readings.List(), func(x *jsv.Obj) bool { return x.Str("classId") == id }), clear("classId")); err != nil {
			return err
		}
		for _, n := range ctx.Notes.List() {
			if optStr(n, "classId") == id {
				if _, err := ctx.Notes.Update(n.Str("id"), jsv.O("classId", jsv.Undefined)); err != nil {
					return err
				}
			}
		}
		return ctx.Classes.Delete(id)
	}
	removeAssignment := func(id string) error {
		if err := ctx.Tasks.PatchMany(idsWhere(ctx.Tasks.List(), func(x *jsv.Obj) bool { return optStr(x, "assignmentId") == id }),
			func(*jsv.Obj) *jsv.Obj { return jsv.O("assignmentId", jsv.Undefined) }); err != nil {
			return err
		}
		for _, n := range ctx.Notes.List() {
			ids := n.Strings("assignmentIds")
			keep, has := []any{}, false
			for _, x := range ids {
				if x == id {
					has = true
				} else {
					keep = append(keep, x)
				}
			}
			if has {
				if _, err := ctx.Notes.Update(n.Str("id"), jsv.O("assignmentIds", keep)); err != nil {
					return err
				}
			}
		}
		return ctx.Assignments.Delete(id)
	}

	a.crud("/semesters", ctx.Semesters, crudHooks{omit: []string{"slug"}, remove: func(id string) error {
		if _, err := store.Backup("pre-bulk-delete", 20); err != nil {
			return err
		}
		for _, c := range ctx.Classes.List() {
			if c.Str("semesterId") == id {
				if err := removeClass(c.Str("id"), true); err != nil {
					return err
				}
			}
		}
		return ctx.Semesters.Delete(id)
	}})
	a.crud("/classes", ctx.Classes, crudHooks{omit: []string{"slug"},
		after: func(c *jsv.Obj, kind string) error {
			if kind != "update" {
				return nil
			}
			return ctx.Assignments.PatchMany(idsWhere(ctx.Assignments.List(), func(x *jsv.Obj) bool { return x.Str("classId") == c.Str("id") }),
				func(*jsv.Obj) *jsv.Obj { return jsv.NewObj() })
		},
		remove: func(id string) error { return removeClass(id, false) },
	})
	a.crud("/assignments", ctx.Assignments, crudHooks{remove: removeAssignment})
	a.crud("/tasks", ctx.Tasks, crudHooks{})
	a.crud("/readings", ctx.Readings, crudHooks{})
	a.crud("/notes", ctx.Notes, crudHooks{remove: func(id string) error {
		// a deleted note takes its generated flashcards with it
		if err := ctx.Notes.Delete(id); err != nil {
			return err
		}
		return ctx.Cards.DeleteMany(idsWhere(ctx.Cards.List(), func(c *jsv.Obj) bool { return optStr(c, "noteId") == id }))
	}})

	// ---- optional modules ----
	a.crud("/journal", ctx.Journal, crudHooks{})
	a.crud("/contacts", ctx.Contacts, crudHooks{})
	a.crud("/activities", ctx.Activities, crudHooks{})
	a.crud("/jobs", ctx.Jobs, crudHooks{})
	a.crud("/admissions", ctx.Admissions, crudHooks{})
	a.crud("/budget", ctx.Budget, crudHooks{})
	a.crud("/flashcards", ctx.Cards, crudHooks{})

	// flashcards from {{c1::cloze}} text in a note: create new, drop stale, keep the rest (and progress)
	a.add("POST", "/flashcards/sync-note/:id", func(q *request) (any, error) {
		id, err := q.paramID()
		if err != nil {
			return nil, err
		}
		n := ctx.Notes.Get(id)
		if n == nil {
			return nil, notFound("notes", id)
		}
		want := ExtractClozeCards(n.Str("markdown"))
		var have []*jsv.Obj
		for _, c := range ctx.Cards.List() {
			if optStr(c, "noteId") == id && defined(c.Get("cloze")) {
				have = append(have, c)
			}
		}
		var fresh []ClozeCard
		for _, w := range want {
			found := false
			for _, h := range have {
				found = found || optStr(h, "sourceKey") == w.SourceKey
			}
			if !found {
				fresh = append(fresh, w)
			}
		}
		stale := []string{}
		for _, h := range have {
			found := false
			for _, w := range want {
				found = found || optStr(h, "sourceKey") == w.SourceKey
			}
			if !found {
				stale = append(stale, h.Str("id"))
			}
		}
		for _, w := range fresh {
			if _, err := ctx.Cards.Create(jsv.O("noteId", id, "classId", n.GetU("classId"), "front", w.Front, "back", w.Back,
				"cloze", w.Cloze, "sourceKey", w.SourceKey)); err != nil {
				return nil, err
			}
		}
		if err := ctx.Cards.DeleteMany(stale); err != nil {
			return nil, err
		}
		return jsv.O("created", float64(len(fresh)), "removed", float64(len(stale)), "kept", float64(len(have)-len(stale))), nil
	})

	queueQuery := Obj(
		F("limit", Default(Coerce().Int().Min(1).Max(200), func() any { return 30.0 })),
		F("newLimit", Default(Coerce().Int().Min(0).Max(100), func() any { return 10.0 })),
		F("classId", Optional(String().Max(64))),
		F("noteId", Optional(String().Max(64))),
	)
	a.add("GET", "/study/queue", func(q *request) (any, error) {
		o, err := parse(queueQuery, q.query)
		if err != nil {
			return nil, err
		}
		now := Now()
		classID, noteID := optStr(o, "classId"), optStr(o, "noteId")
		var pool, review, fresh []*jsv.Obj
		for _, c := range ctx.Cards.List() {
			if (classID == "" || optStr(c, "classId") == classID) && (noteID == "" || optStr(c, "noteId") == noteID) {
				pool = append(pool, c)
			}
		}
		for _, c := range pool {
			if isNewCard(c) {
				fresh = append(fresh, c)
			} else if IsDue(c.ObjAt("srs"), now) {
				review = append(review, c)
			}
		}
		by := func(list []*jsv.Obj, key func(*jsv.Obj) string) {
			sort.SliceStable(list, func(i, j int) bool {
				if r := localeCompare(key(list[i]), key(list[j])); r != 0 {
					return r < 0
				}
				return localeCompare(list[i].Str("id"), list[j].Str("id")) < 0
			})
		}
		by(review, func(c *jsv.Obj) string { return c.ObjAt("srs").Str("dueAt") })
		by(fresh, func(c *jsv.Obj) string { return c.Str("createdAt") })
		limit, newLimit := int(o.Num("limit")), int(o.Num("newLimit"))
		cards := append(append([]*jsv.Obj{}, review[:min(limit, len(review))]...), fresh[:min(newLimit, len(fresh))]...)
		cards = cards[:min(limit, len(cards))]
		return jsv.O("cards", listAny(cards), "counts", jsv.O("due", float64(len(review)), "new", float64(len(fresh)), "total", float64(len(pool)))), nil
	})
	a.add("GET", "/study/decks", func(q *request) (any, error) {
		now := Now()
		var order []string
		decks := map[string]*jsv.Obj{}
		for _, c := range ctx.Cards.List() {
			k := optStr(c, "classId")
			d := decks[k]
			if d == nil {
				var cls any = nil
				if defined(c.Get("classId")) {
					cls = c.Get("classId")
				}
				d = jsv.O("classId", cls, "total", 0.0, "due", 0.0, "new", 0.0)
				decks[k] = d
				order = append(order, k)
			}
			d.Set("total", d.Num("total")+1)
			if isNewCard(c) {
				d.Set("new", d.Num("new")+1)
			} else if IsDue(c.ObjAt("srs"), now) {
				d.Set("due", d.Num("due")+1)
			}
		}
		out := []any{}
		for _, k := range order {
			out = append(out, decks[k])
		}
		return out, nil
	})
	answer := Obj(F("cardId", String().Min(1).Max(64)), F("rating", Enum("again", "hard", "good", "easy")))
	a.add("POST", "/study/answer", func(q *request) (any, error) {
		b, err := parse(answer, q.body)
		if err != nil {
			return nil, err
		}
		c := ctx.Cards.Get(b.Str("cardId"))
		if c == nil {
			return nil, notFound("flashcards", b.Str("cardId"))
		}
		return ctx.Cards.Update(b.Str("cardId"), jsv.O("srs", Schedule(c.ObjAt("srs"), b.Str("rating"), Now())))
	})

	// study sessions: the fixed routes win over /:id
	timer := Obj(
		F("classId", Optional(String().Max(64))),
		F("taskId", Optional(String().Max(64))),
		F("assignmentId", Optional(String().Max(64))),
		F("kind", Default(Enum("pomodoro", "manual"), func() any { return "pomodoro" })),
	)
	a.add("GET", "/study-sessions/active", func(q *request) (any, error) {
		if s := ctx.Study.Active(); s != nil {
			return s, nil
		}
		return nil, nil
	})
	a.add("POST", "/study-sessions/start", func(q *request) (any, error) {
		b, err := parse(timer, q.body)
		if err != nil {
			return nil, err
		}
		return ctx.Study.StartTimer(b)
	})
	stopBody := Obj(F("at", Optional(String().Datetime())))
	a.add("POST", "/study-sessions/stop", func(q *request) (any, error) {
		b, err := parse(stopBody, q.bodyOr())
		if err != nil {
			return nil, err
		}
		at := Now()
		if s := optStr(b, "at"); s != "" {
			if ms, ok := jsDateParse(s); ok {
				at = time.UnixMilli(int64(math.Min(ms, float64(Now().UnixMilli()))))
			} else {
				return nil, apiErr(500, "INTERNAL", "Invalid time value") // new Date(NaN) throws on use
			}
		}
		s, err := ctx.Study.StopTimer(at)
		if err != nil {
			return nil, err
		}
		var session any = nil
		if s != nil {
			session = s
		}
		return jsv.O("session", session), nil
	})
	a.crud("/study-sessions", ctx.Study, crudHooks{})

	// ---- planner and stats ----
	a.add("GET", "/agenda", func(q *request) (any, error) {
		o, err := parse(Obj(F("from", day), F("to", day)), q.query)
		if err != nil {
			return nil, err
		}
		return ctx.Agenda(o.Str("from"), o.Str("to"))
	})
	a.add("GET", "/timetable", func(q *request) (any, error) {
		o, err := parse(Obj(F("week", day), F("weekStart", weekStart)), q.query)
		if err != nil {
			return nil, err
		}
		return ctx.Timetable(o.Str("week"), o.Str("weekStart"))
	})
	a.add("GET", "/deadlines", func(q *request) (any, error) { return ctx.Deadlines(Now()), nil })
	a.add("GET", "/stats/overview", func(q *request) (any, error) {
		o, err := parse(Obj(F("weekStart", weekStart)), q.query)
		if err != nil {
			return nil, err
		}
		return ctx.Stats(Now(), o.Str("weekStart")), nil
	})

	// ---- grades and GPA ----
	a.add("GET", "/grades/class/:id", func(q *request) (any, error) {
		id, err := q.paramID()
		if err != nil {
			return nil, err
		}
		return ctx.Grading.ClassGrade(id)
	})
	whatIf := Obj(F("classId", String()), F("overrides", Record(Nullable(scoreInput))))
	a.add("POST", "/grades/what-if", func(q *request) (any, error) {
		b, err := parse(whatIf, q.body)
		if err != nil {
			return nil, err
		}
		return ctx.Grading.WhatIf(b.Str("classId"), b.ObjAt("overrides"))
	})
	needed := Obj(
		F("classId", String()),
		F("target", Union(Number(), Obj(F("letter", String())))),
		F("remainingIds", Optional(Array(String()))),
		F("maxPerItem", Optional(Number())),
		F("perItem", Optional(Bool())),
		F("assume", Optional(Number())),
	)
	a.add("POST", "/grades/needed", func(q *request) (any, error) {
		b, err := parse(needed, q.body)
		if err != nil {
			return nil, err
		}
		classID := b.Str("classId")
		b.Delete("classId")
		return ctx.Grading.Needed(classID, b)
	})
	a.add("GET", "/grades/semester/:id", func(q *request) (any, error) {
		id, err := q.paramID()
		if err != nil {
			return nil, err
		}
		return ctx.Grading.Semester(id)
	})
	a.add("GET", "/gpa", func(q *request) (any, error) {
		o, err := parse(Obj(F("scaleId", Optional(String())), F("semesterId", Optional(String()))), q.query)
		if err != nil {
			return nil, err
		}
		return ctx.Grading.Gpa(optStr(o, "scaleId"), optStr(o, "semesterId")), nil
	})
	plan := Obj(
		F("targetGpa", Number().Min(0)),
		F("plannedCredits", Number().Positive()),
		F("weighted", Optional(Bool())),
		F("scaleId", Optional(String())),
	)
	a.add("POST", "/gpa/plan", func(q *request) (any, error) {
		b, err := parse(plan, q.body)
		if err != nil {
			return nil, err
		}
		return ctx.Grading.Plan(PlanOptions{TargetGpa: b.Num("targetGpa"), PlannedCredits: b.Num("plannedCredits"),
			Weighted: b.Bool("weighted"), ScaleID: optStr(b, "scaleId")}), nil
	})
	a.add("GET", "/grading-schemes", func(q *request) (any, error) { return ctx.Config.Schemes(), nil })
	a.add("PUT", "/grading-schemes", func(q *request) (any, error) {
		v, err := Parse(Array(GradingScheme), q.body)
		if err != nil {
			return nil, err
		}
		return ctx.Config.PutSchemes(v)
	})
	a.add("PUT", "/grading-schemes/:id", func(q *request) (any, error) {
		p := jsv.NewObj()
		for k, v := range q.params {
			p.Set(k, v)
		}
		po, err := parse(Obj(F("id", String().Min(1).Max(80))), p)
		if err != nil {
			return nil, err
		}
		id := po.Str("id")
		body, err := parse(GradingScheme, q.body)
		if err != nil {
			return nil, err
		}
		if body.Str("id") != id {
			return nil, apiErr(422, "BAD_REFERENCE", "The scheme id must match the URL")
		}
		cur := ctx.Config.Schemes()
		next := make([]any, 0, len(cur)+1)
		replaced := false
		for _, s := range cur {
			if s.(*jsv.Obj).Str("id") == id {
				next = append(next, body)
				replaced = true
			} else {
				next = append(next, s)
			}
		}
		if !replaced {
			next = append(next, body)
		}
		if _, err := ctx.Config.PutSchemes(next); err != nil {
			return nil, err
		}
		return body, nil
	})
	a.add("GET", "/gpa-scales", func(q *request) (any, error) { return ctx.Config.Scales(), nil })
	a.add("PUT", "/gpa-scales", func(q *request) (any, error) {
		v, err := Parse(Array(GpaScale), q.body)
		if err != nil {
			return nil, err
		}
		return ctx.Config.PutScales(v)
	})

	// ---- search, activity, events, health ----
	searchQuery := Obj(F("q", String().Max(500)), F("limit", Default(Coerce().Int().Min(1).Max(200), func() any { return 50.0 })))
	a.add("GET", "/search", func(q *request) (any, error) {
		o, err := parse(searchQuery, q.query)
		if err != nil {
			return nil, err
		}
		classes := func(term string) map[string]bool {
			out := map[string]bool{}
			for _, c := range ctx.Classes.List() {
				if strings.Contains(jsLower(c.Str("name")+" "+optStr(c, "code")), term) {
					out[c.Str("id")] = true
				}
			}
			return out
		}
		hits := ctx.Search.Search(o.Str("q"), classes, int(o.Num("limit")), Now())
		return jsv.O("query", o.Get("q"), "hits", jsv.FromGo(hits)), nil
	})
	a.add("GET", "/activity", func(q *request) (any, error) { return jsv.FromGo(ctx.Bus.Recent(50)), nil })
	a.add("GET", "/health", func(q *request) (any, error) { return jsv.O("ok", true, "app", AppName), nil })
	a.add("GET", "/events", a.events)

	// ---- note links and templates ----
	resolveQuery := Obj(F("title", String().Min(1).Max(300)), F("classId", Optional(String().Max(64))))
	a.add("GET", "/notes/resolve", func(q *request) (any, error) {
		o, err := parse(resolveQuery, q.query)
		if err != nil {
			return nil, err
		}
		n := ResolveLink(ctx.Notes.List(), o.Str("title"), optStr(o, "classId"))
		if n == nil {
			return nil, nil
		}
		return jsv.O("id", n.Get("id"), "title", n.Get("title"), "classId", n.GetU("classId")), nil
	})
	a.add("GET", "/notes/:id/backlinks", func(q *request) (any, error) {
		id, err := q.paramID()
		if err != nil {
			return nil, err
		}
		n := ctx.Notes.Get(id)
		if n == nil {
			return nil, notFound("notes", id)
		}
		return BacklinksFor(ctx.Notes.List(), n), nil
	})
	tplBody := Obj(F("name", String().Min(1).Max(80)), F("markdown", String().Max(200_000)))
	a.add("GET", "/templates/notes", func(q *request) (any, error) { return a.templates.List() })
	a.add("POST", "/templates/notes", func(q *request) (any, error) {
		b, err := parse(tplBody, q.body)
		if err != nil {
			return nil, err
		}
		return a.templates.Save(b.Str("name"), b.Str("markdown"), "")
	})
	a.add("PUT", "/templates/notes/:id", func(q *request) (any, error) {
		b, err := parse(tplBody, q.body)
		if err != nil {
			return nil, err
		}
		id, err := q.paramID()
		if err != nil {
			return nil, err
		}
		return a.templates.Save(b.Str("name"), b.Str("markdown"), id)
	})
	a.add("DELETE", "/templates/notes/:id", func(q *request) (any, error) {
		id, err := q.paramID()
		if err != nil {
			return nil, err
		}
		if err := a.templates.Remove(id); err != nil {
			return nil, err
		}
		return jsv.Undefined, nil
	})

	// ---- app lock and encryption at rest ----
	lock := a.Lock
	a.add("GET", "/lock/status", func(q *request) (any, error) { return lock.Status(), nil })
	a.add("POST", "/lock/unlock", func(q *request) (any, error) {
		b, err := parse(Obj(F("passphrase", pass)), q.body)
		if err != nil {
			return nil, err
		}
		return lock.Unlock(b.Str("passphrase"))
	})
	a.add("POST", "/lock/lock", func(q *request) (any, error) { return lock.Lock() })
	minutes := Optional(Number().Int().Min(0).Max(1440))
	setup := Obj(
		F("passphrase", pass),
		F("current", Optional(pass)),
		F("collections", Optional(Array(String().Max(40)).Max(20))),
		F("autoLockMinutes", minutes),
		F("lockOnHide", Optional(Bool())),
	)
	a.add("POST", "/lock/setup", func(q *request) (any, error) {
		b, err := parse(setup, q.body)
		if err != nil {
			return nil, err
		}
		o := LockSetup{Passphrase: b.Str("passphrase"), Current: b.StrP("current"), AutoLockMinutes: b.NumP("autoLockMinutes")}
		if b.Has("collections") {
			o.Collections = b.Strings("collections")
			if o.Collections == nil {
				o.Collections = []string{}
			}
		}
		if v, ok := b.Get("lockOnHide").(bool); ok {
			o.LockOnHide = &v
		}
		return lock.Setup(o)
	})
	a.add("POST", "/lock/collections", func(q *request) (any, error) {
		b, err := parse(Obj(F("collections", Array(String().Max(40)).Max(20)), F("passphrase", Optional(pass))), q.body)
		if err != nil {
			return nil, err
		}
		cols := b.Strings("collections")
		if cols == nil {
			cols = []string{}
		}
		return lock.SetCollections(cols, b.StrP("passphrase"))
	})
	a.add("PATCH", "/lock/settings", func(q *request) (any, error) {
		b, err := parse(Obj(F("autoLockMinutes", minutes), F("lockOnHide", Optional(Bool()))), q.body)
		if err != nil {
			return nil, err
		}
		var onHide *bool
		if v, ok := b.Get("lockOnHide").(bool); ok {
			onHide = &v
		}
		return lock.UpdateSettings(b.NumP("autoLockMinutes"), onHide)
	})
	a.add("POST", "/lock/disable", func(q *request) (any, error) {
		b, err := parse(Obj(F("passphrase", pass)), q.body)
		if err != nil {
			return nil, err
		}
		return lock.Disable(b.Str("passphrase"))
	})

	// ---- settings, demo data, about ----
	a.add("GET", "/settings", func(q *request) (any, error) {
		text, ok, err := store.ReadText(settingsPath)
		if err == nil && ok {
			if v, perr := jsv.Parse(text); perr == nil {
				return v, nil
			}
		}
		v, err := store.ReadJSON(settingsPath, jsonstore.ReadOptions{Fallback: func() any { return map[string]any{} }})
		if err != nil {
			return nil, err
		}
		return toJSV(v), nil
	})
	a.add("PUT", "/settings", func(q *request) (any, error) {
		b, err := parse(anyRecord, q.body)
		if err != nil {
			return nil, err
		}
		if utf16Len(jsv.Stringify(b, "")) > 100_000 {
			return nil, apiErr(413, "TOO_LARGE", "settings too large")
		}
		if err := store.WriteJSON(settingsPath, b, nil); err != nil {
			return nil, err
		}
		return b, nil
	})
	a.add("GET", "/about", func(q *request) (any, error) {
		return jsv.O("app", AppName, "demoLoaded", ctx.HasDemo(), "counts", jsv.O(
			"semesters", float64(len(ctx.Semesters.List())), "classes", float64(len(ctx.Classes.List())),
			"assignments", float64(len(ctx.Assignments.List())), "notes", float64(len(ctx.Notes.List())))), nil
	})
	a.add("POST", "/demo/load", func(q *request) (any, error) { return ctx.LoadDemo(Now()) })
	a.add("DELETE", "/demo", func(q *request) (any, error) {
		if err := ctx.ClearDemo(); err != nil {
			return nil, err
		}
		return jsv.Undefined, nil
	})

	// ---- attachments ----
	a.add("GET", "/attachments", func(q *request) (any, error) { return applyList(ctx.Attachments.List(), q.query) })
	a.add("GET", "/attachments/:id", func(q *request) (any, error) {
		id, err := q.paramID()
		if err != nil {
			return nil, err
		}
		if x := ctx.Attachments.Get(id); x != nil {
			return x, nil
		}
		return nil, notFound("attachment", id)
	})
	upload := Obj(F("filename", String().Min(1).Max(255)), F("dataBase64", String().Min(1)))
	a.add("POST", "/attachments", func(q *request) (any, error) {
		b, err := parse(upload, q.body)
		if err != nil {
			return nil, err
		}
		rec, _, err := a.atts.Add(b.Str("filename"), unb64(b.Str("dataBase64")))
		return rec, err
	})
	a.add("DELETE", "/attachments/:id", func(q *request) (any, error) {
		id, err := q.paramID()
		if err != nil {
			return nil, err
		}
		x := ctx.Attachments.Get(id)
		if x == nil {
			return nil, notFound("attachment", id)
		}
		if err := a.atts.Remove(x); err != nil {
			return nil, err
		}
		return jsv.Undefined, nil
	})
	a.add("GET", "/attachments/:id/file", func(q *request) (any, error) {
		id, err := q.paramID()
		if err != nil {
			return nil, err
		}
		x := ctx.Attachments.Get(id)
		if x == nil {
			return nil, notFound("attachment", id)
		}
		data, err := a.atts.Read(x)
		if err != nil {
			return nil, err
		}
		safe := IsInlineSafe(x.Str("mime"))
		h := q.w.Header()
		disp := "attachment"
		if safe {
			h.Set("Content-Type", x.Str("mime"))
			disp = "inline"
		} else {
			h.Set("Content-Type", "application/octet-stream")
		}
		h.Set("Content-Disposition", disp+"; filename*=UTF-8''"+encodeURIComponent(x.Str("filename")))
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
		h.Set("Content-Length", strconv.Itoa(len(data)))
		q.w.WriteHeader(200)
		if q.r.Method != http.MethodHead {
			q.w.Write(data)
		}
		return handled, nil
	})

	// ---- import and export ----
	kinds := Enum("notion", "csv", "ics", "markdown", "json")
	csvCollection := Optional(Enum(CSVCollections...))
	icsAs := Optional(Enum("tasks", "assignments"))
	className := Optional(String().Max(200))
	pluginID := Optional(String().Regex(regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,38}$`), `/^[a-z0-9][a-z0-9-]{1,38}$/`))
	previewBody := Obj(
		F("kind", kinds), F("collection", csvCollection), F("text", Optional(String())),
		F("dataBase64", Optional(String())), F("icsAs", icsAs), F("className", className),
		F("dropTooltips", Optional(Bool())), F("pluginId", pluginID),
	)
	previewQuery := Obj(F("kind", kinds), F("collection", csvCollection), F("icsAs", icsAs), F("className", className), F("pluginId", pluginID))
	preview := a.add("POST", "/import/preview", func(q *request) (any, error) {
		if data, ok := q.body.([]byte); ok {
			o, err := parse(previewQuery, q.query)
			if err != nil {
				return nil, err
			}
			return a.imports.Preview(PreviewInput{Kind: o.Str("kind"), Data: data, Collection: optStr(o, "collection"),
				IcsAs: optStr(o, "icsAs"), ClassName: optStr(o, "className"), PluginID: optStr(o, "pluginId")})
		}
		b, err := parse(previewBody, q.body)
		if err != nil {
			return nil, err
		}
		in := PreviewInput{Kind: b.Str("kind"), Text: b.StrP("text"), Collection: optStr(b, "collection"),
			IcsAs: optStr(b, "icsAs"), ClassName: optStr(b, "className"), PluginID: optStr(b, "pluginId")}
		if s := optStr(b, "dataBase64"); s != "" {
			in.Data = unb64(s)
		}
		if v, ok := b.Get("dropTooltips").(bool); ok {
			in.DropTooltips = &v
		}
		return a.imports.Preview(in)
	})
	preview.bodyLimit = importBodyLimit
	commit := Obj(F("previewId", String().Min(1).Max(64)), F("strategy", Default(Enum(Strategies...), func() any { return "update_empty" })))
	a.add("POST", "/import/commit", func(q *request) (any, error) {
		b, err := parse(commit, q.body)
		if err != nil {
			return nil, err
		}
		return a.imports.Commit(b.Str("previewId"), b.Str("strategy"))
	})
	a.add("POST", "/import/undo/:id", func(q *request) (any, error) {
		id, err := q.paramID()
		if err != nil {
			return nil, err
		}
		return a.imports.Undo(id)
	})
	a.add("GET", "/import/history", func(q *request) (any, error) { return a.imports.History() })
	collParam := func(q *request) (string, error) {
		p := jsv.NewObj()
		for k, v := range q.params {
			p.Set(k, v)
		}
		o, err := parse(Obj(F("collection", Enum(CSVCollections...))), p)
		if err != nil {
			return "", err
		}
		return o.Str("collection"), nil
	}
	a.add("GET", "/import/templates/:collection", func(q *request) (any, error) {
		c, err := collParam(q)
		if err != nil {
			return nil, err
		}
		return download(q, "text/csv; charset=utf-8", c+"-template.csv", []byte(importers.CSVTemplate(c)))
	})
	a.add("GET", "/export/csv/:collection", func(q *request) (any, error) {
		c, err := collParam(q)
		if err != nil {
			return nil, err
		}
		return download(q, "text/csv; charset=utf-8", c+".csv", []byte(ctx.ExportCSV(c)))
	})
	a.add("GET", "/export/gradebook", func(q *request) (any, error) {
		return download(q, "text/csv; charset=utf-8", "gradebook.csv", []byte(ctx.ExportGradebook()))
	})
	a.add("GET", "/plugins", func(q *request) (any, error) {
		l, err := ListPlugins(store)
		if err != nil {
			return nil, err
		}
		return l.JSON().Set("folder", filepath.Join(a.opts.DataDir, "plugins")), nil
	})
	syncBody := Obj(F("dir", String().Min(1).Max(1024)), F("acknowledgePlaintext", Optional(Bool())))
	a.add("POST", "/sync/export", func(q *request) (any, error) {
		b, err := parse(syncBody, q.body)
		if err != nil {
			return nil, err
		}
		if len(lock.Status().Arr("encryptedCollections")) > 0 && !b.Bool("acknowledgePlaintext") {
			return nil, apiErr(409, "NEEDS_ACK", "Some of your data is encrypted at rest. Exported files are NOT encrypted. Confirm to export anyway.")
		}
		return ctx.SyncToFolder(a.opts.DataDir, b.Str("dir"))
	})
	a.add("GET", "/export/ics", func(q *request) (any, error) {
		o, err := parse(Obj(F("kind", Default(Enum("deadlines", "timetable", "all"), func() any { return "all" }))), q.query)
		if err != nil {
			return nil, err
		}
		k := o.Str("kind")
		return download(q, "text/calendar; charset=utf-8", "classpad-"+k+".ics", []byte(ctx.ExportICS(k)))
	})
	a.add("GET", "/export/json", func(q *request) (any, error) {
		return download(q, "application/json", "classpad-backup.json", []byte(jsv.Stringify(ctx.ExportJSON(), "  ")))
	})
	a.add("GET", "/export/markdown", func(q *request) (any, error) {
		z, err := ctx.ExportMarkdownVault()
		if err != nil {
			return nil, err
		}
		return download(q, "application/zip", "classpad-notes.zip", z)
	})
	a.add("GET", "/export/report", func(q *request) (any, error) {
		o, err := parse(Obj(F("hide", Default(Enum("0", "1"), func() any { return "0" }))), q.query)
		if err != nil {
			return nil, err
		}
		body := []byte(ctx.GradeReportHTML(o.Str("hide") == "1"))
		h := q.w.Header()
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Length", strconv.Itoa(len(body)))
		q.w.WriteHeader(200)
		if q.r.Method != http.MethodHead {
			q.w.Write(body)
		}
		return handled, nil
	})
}

// events is the live-update stream (server-sent events).
func (a *App) events(q *request) (any, error) {
	w := q.w
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	w.WriteHeader(200)
	fl, _ := w.(http.Flusher)
	flush := func() {
		if fl != nil {
			fl.Flush()
		}
	}
	msgs := make(chan string, 64)
	off := a.Ctx.Bus.On(func(ev Event) {
		select {
		case msgs <- "data: " + jsv.Stringify(jsv.FromGo(ev), "") + "\n\n":
		default: // a stalled client misses events rather than blocking writers
		}
	})
	defer off()
	fmt.Fprint(w, ": connected\n\n")
	flush()
	beat := time.NewTicker(25 * time.Second)
	defer beat.Stop()
	for {
		select {
		case m := <-msgs:
			if _, err := fmt.Fprint(w, m); err != nil {
				return handled, nil
			}
			flush()
		case <-beat.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return handled, nil
			}
			flush()
		case <-q.r.Context().Done():
			return handled, nil
		case <-a.closing:
			return handled, nil
		}
	}
}
