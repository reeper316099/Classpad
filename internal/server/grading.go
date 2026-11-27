package server

import (
	"encoding/json"
	"math"
	"sort"
	"sync"

	"github.com/reeper316099/classpad/internal/grades"
	"github.com/reeper316099/classpad/internal/jsonstore"
	"github.com/reeper316099/classpad/internal/jsv"
)

// copyDefined copies the keys that are set (and not undefined) from src to dst.
func copyDefined(dst, src *jsv.Obj, keys ...string) {
	for _, k := range keys {
		if v := src.Get(k); src.Has(k) && v != jsv.Undefined {
			dst.Set(k, v)
		}
	}
}

// fromJSON decodes a jsv value into an engine struct (the engine's JSON tags match the TypeScript
// shapes, and Dec accepts JSON numbers exactly as decimal.js reads a JS number).
func fromJSON(v any, out any) error { return json.Unmarshal([]byte(jsv.Stringify(v, "")), out) }

func decNum(f float64) grades.Dec { return grades.MustParse(jsonstore.JSNumber(f)) }

// ToEngineScheme is toEngineScheme: a stored grading scheme in the engine's form.
func ToEngineScheme(s *jsv.Obj, cls *jsv.Obj) grades.Scheme {
	o := jsv.O("mode", s.Get("mode"))
	copyDefined(o, s, "categories")
	sc := s.ObjAt("scale")
	o.Set("scale", jsv.O("cutoffs", sc.Get("cutoffs")))
	r := jsv.NewObj()
	if sc.Has("roundingMode") {
		r.Set("mode", sc.Get("roundingMode"))
	}
	copyDefined(r, sc, "decimals", "letterOn")
	o.Set("rounding", r)
	copyDefined(o, s, "normalizeOverGradedOnly", "extraCreditAllowed", "extraCreditCapPercent", "latePolicy", "curve", "maxScore")
	if cls != nil && cls.Bool("passFail") {
		o.Set("passFail", jsv.O("threshold", 60.0))
	}
	var out grades.Scheme
	if err := fromJSON(o, &out); err != nil {
		panic(err) // the scheme passed the schema, so this is a bug
	}
	return out
}

// ToGradeItem is toGradeItem: an assignment as an engine item.
func ToGradeItem(a *jsv.Obj) grades.GradeItem {
	o := jsv.O("id", a.Get("id"))
	copyDefined(o, a, "title", "categoryId", "weight", "pointsPossible")
	if s := a.ObjAt("score"); s != nil {
		if s.Has("percent") {
			o.Set("score", jsv.O("kind", "percent", "percent", s.Get("percent")))
		} else {
			sc := jsv.O("kind", "points")
			copyDefined(sc, s, "earned", "possible")
			o.Set("score", sc)
		}
	}
	copyDefined(o, a, "extraCredit", "excused", "dropped", "latePenalty")
	var out grades.GradeItem
	if err := fromJSON(o, &out); err != nil {
		panic(err)
	}
	return out
}

// toEngineScale reads a stored GPA scale.
func toEngineScale(s *jsv.Obj) grades.GpaScale {
	var out grades.GpaScale
	if err := fromJSON(jsv.O("points", s.Get("points"), "weightedBonus", s.Get("weightedBonus")), &out); err != nil {
		panic(err)
	}
	return out
}

type GradingDeps struct {
	Config      *Config
	Classes     func() []*jsv.Obj
	Semesters   func() []*jsv.Obj
	Assignments func() []*jsv.Obj
}

type GradingService struct {
	d GradingDeps

	// items caches each assignment's engine form. Stored entities are never changed in place (an edit
	// stores a new object), so the object itself is the key; each pass keeps only what is still listed.
	mu    sync.Mutex
	items map[*jsv.Obj]grades.GradeItem
}

func NewGradingService(d GradingDeps) *GradingService { return &GradingService{d: d} }

type gradeCtx struct {
	cls    *jsv.Obj
	scheme grades.Scheme
	items  []grades.GradeItem
}

// itemsByClass groups the assignments once per request (the TypeScript filters per class).
func (g *GradingService) itemsByClass() map[string][]grades.GradeItem {
	out := map[string][]grades.GradeItem{}
	g.mu.Lock()
	defer g.mu.Unlock()
	list := g.d.Assignments()
	next := make(map[*jsv.Obj]grades.GradeItem, len(list))
	for _, a := range list {
		item, ok := g.items[a]
		if !ok {
			item = ToGradeItem(a)
		}
		next[a] = item
		id := a.Str("classId")
		out[id] = append(out[id], item)
	}
	g.items = next
	return out
}

func (g *GradingService) cls(id string) (*jsv.Obj, error) {
	for _, c := range g.d.Classes() {
		if c.Str("id") == id {
			return c, nil
		}
	}
	return nil, notFound("class", id)
}

func (g *GradingService) ctxFor(c *jsv.Obj, items map[string][]grades.GradeItem) gradeCtx {
	return gradeCtx{cls: c, scheme: ToEngineScheme(g.d.Config.Scheme(c.Str("gradingSchemeId")), c), items: items[c.Str("id")]}
}

func (g *GradingService) ctx(id string) (gradeCtx, error) {
	c, err := g.cls(id)
	if err != nil {
		return gradeCtx{}, err
	}
	return g.ctxFor(c, g.itemsByClass()), nil
}

func nonNilItems(items []grades.GradeItem) []grades.GradeItem {
	if items == nil {
		return []grades.GradeItem{}
	}
	return items
}

func (g *GradingService) ClassGrade(id string) (any, error) {
	c, err := g.ctx(id)
	if err != nil {
		return nil, err
	}
	items := nonNilItems(c.items)
	var proj any = nil
	if p := grades.Project(c.scheme, items); p != nil {
		proj = jsv.FromGo(p)
	}
	return jsv.O(
		"classId", id,
		"name", c.cls.Get("name"),
		"grade", jsv.FromGo(grades.ComputeGrade(c.scheme, items)),
		"sensitivity", jsv.FromGo(grades.Sensitivity(c.scheme, items, false)),
		"projection", proj,
	), nil
}

// WhatIf takes overrides as {assignmentId: ScoreInput | null}.
func (g *GradingService) WhatIf(id string, overrides *jsv.Obj) (any, error) {
	c, err := g.ctx(id)
	if err != nil {
		return nil, err
	}
	ov := map[string]*grades.ScoreInput{}
	if err := fromJSON(overrides, &ov); err != nil {
		return nil, apiErr(422, "VALIDATION", err.Error())
	}
	return jsv.FromGo(grades.WhatIf(c.scheme, nonNilItems(c.items), ov)), nil
}

// Needed takes the body without classId: target, remainingIds, maxPerItem, perItem, assume.
func (g *GradingService) Needed(id string, opts *jsv.Obj) (any, error) {
	c, err := g.ctx(id)
	if err != nil {
		return nil, err
	}
	var o grades.NeededOptions
	if err := fromJSON(opts, &o); err != nil {
		return nil, apiErr(422, "VALIDATION", err.Error())
	}
	r, err := grades.NeededScore(c.scheme, nonNilItems(c.items), o)
	if err != nil {
		return nil, err // like the TypeScript, an unknown letter is an internal error
	}
	return jsv.FromGo(r), nil
}

// semestersByStart is [...semesters].sort((a, b) => key(a).localeCompare(key(b))).
func semestersBy(list []*jsv.Obj, key func(s *jsv.Obj) string) []*jsv.Obj {
	out := append([]*jsv.Obj(nil), list...)
	sort.SliceStable(out, func(i, j int) bool { return localeCompare(key(out[i]), key(out[j])) < 0 })
	return out
}

// course is a GPA course with the response shape the TypeScript returns.
type course struct {
	engine grades.GpaCourse
	view   *jsv.Obj
}

func (g *GradingService) courses(semesterID string) []course {
	order := map[string]int{}
	for i, s := range semestersBy(g.d.Semesters(), func(s *jsv.Obj) string { return s.Str("start") }) {
		order[s.Str("id")] = i
	}
	items := g.itemsByClass()
	var out []course
	for _, c := range g.d.Classes() {
		if c.Bool("archived") || (semesterID != "" && c.Str("semesterId") != semesterID) {
			continue
		}
		ctx := g.ctxFor(c, items)
		gr := grades.ComputeGrade(ctx.scheme, nonNilItems(ctx.items))
		var letter any = nil
		if gr.Letter != nil {
			letter = *gr.Letter
		}
		var credits any = nil
		if c.Has("credits") && c.Get("credits") != jsv.Undefined {
			credits = c.Get("credits")
		}
		view := jsv.O(
			"id", c.Get("id"),
			"name", c.Get("name"),
			"semesterId", c.Get("semesterId"),
			"credits", credits,
			"letter", letter,
			"honorsLevel", jsString(c.Get("honorsLevel")),
			"passFail", c.Get("passFail"),
			"includeInGpa", c.Get("includeInGpa"),
		)
		copyDefined(view, jsv.O("courseKey", c.Get("code")), "courseKey")
		view.Set("termIndex", float64(order[c.Str("semesterId")]))
		var e grades.GpaCourse
		if err := fromJSON(view, &e); err != nil {
			panic(err)
		}
		out = append(out, course{engine: e, view: view})
	}
	return out
}

func engineCourses(cs []course) []grades.GpaCourse {
	out := make([]grades.GpaCourse, len(cs))
	for i, c := range cs {
		out[i] = c.engine
	}
	return out
}

func (g *GradingService) Semester(id string) (any, error) {
	var sem *jsv.Obj
	for _, s := range g.d.Semesters() {
		if s.Str("id") == id {
			sem = s
			break
		}
	}
	if sem == nil {
		return nil, notFound("semester", id)
	}
	items := g.itemsByClass()
	results := []any{}
	sum, n := grades.NewInt(0), 0
	for _, c := range g.d.Classes() {
		if c.Str("semesterId") != id || c.Bool("archived") {
			continue
		}
		ctx := g.ctxFor(c, items)
		gr := grades.ComputeGrade(ctx.scheme, nonNilItems(ctx.items))
		if gr.PercentRaw != nil {
			sum = sum.Add(*gr.PercentRaw)
			n++
		}
		var credits any = nil
		if c.Has("credits") && c.Get("credits") != jsv.Undefined {
			credits = c.Get("credits")
		}
		results = append(results, jsv.O("classId", c.Get("id"), "name", c.Get("name"), "credits", credits, "grade", jsv.FromGo(gr)))
	}
	var average any = nil
	if n > 0 {
		average = sum.Quo(grades.NewInt(int64(n))).String()
	}
	scale := toEngineScale(g.d.Config.Scale(sem.Str("gpaScaleId")))
	gpa := grades.ComputeGpa(engineCourses(g.courses(id)), scale, grades.GpaOptions{})
	return jsv.O(
		"semesterId", id,
		"name", sem.Get("name"),
		"classes", results,
		"averageGrade", average,
		"averageNote", "Plain average of class percents (graded classes only)",
		"gpa", jsv.FromGo(gpa),
	), nil
}

func (g *GradingService) Gpa(scaleID, semesterID string) any {
	stored := g.d.Config.Scale(scaleID)
	scale := toEngineScale(stored)
	cs := g.courses(semesterID)
	ordered := semestersBy(g.d.Semesters(), func(s *jsv.Obj) string {
		if s.Has("start") && s.Get("start") != jsv.Undefined {
			return s.Str("start")
		}
		return s.Str("createdAt")
	})
	progress := []any{}
	upTo := map[string]bool{}
	for _, s := range ordered {
		upTo[s.Str("id")] = true
		var subset []grades.GpaCourse
		for _, c := range cs {
			if sid := c.view.Str("semesterId"); sid != "" && upTo[sid] {
				subset = append(subset, c.engine)
			}
		}
		u := grades.ComputeGpa(subset, scale, grades.GpaOptions{})
		w := grades.ComputeGpa(subset, scale, grades.GpaOptions{Weighted: true})
		progress = append(progress, jsv.O("semesterId", s.Get("id"), "name", s.Get("name"),
			"unweighted", decOrNull(u.GPA), "weighted", decOrNull(w.GPA)))
	}
	report := jsv.FromGo(grades.GpaReportFor(engineCourses(cs), scale, grades.GpaOptions{})).(*jsv.Obj)
	views := []any{}
	for _, c := range cs {
		views = append(views, c.view)
	}
	out := jsv.O("scaleId", stored.Get("id"))
	for _, k := range report.Keys() {
		out.Set(k, report.Get(k))
	}
	return out.Set("courses", views).Set("progress", progress)
}

func decOrNull(d *grades.Dec) any {
	if d == nil {
		return nil
	}
	return d.String()
}

type PlanOptions struct {
	TargetGpa      float64
	PlannedCredits float64
	Weighted       bool
	ScaleID        string
}

func (g *GradingService) Plan(o PlanOptions) any {
	stored := g.d.Config.Scale(o.ScaleID)
	scale := toEngineScale(stored)
	cur := grades.ComputeGpa(engineCourses(g.courses("")), scale, grades.GpaOptions{Weighted: o.Weighted})
	maxBase := math.Inf(-1)
	for _, p := range stored.Arr("points") {
		maxBase = math.Max(maxBase, p.(*jsv.Obj).Num("gpa"))
	}
	maxBonus := 0.0
	if o.Weighted {
		wb := stored.ObjAt("weightedBonus")
		for _, k := range wb.Keys() {
			maxBonus = math.Max(maxBonus, wb.Num(k))
		}
	}
	plan := grades.PlanGpa(grades.PlanInput{
		CurrentQualityPoints: cur.QualityPoints,
		CurrentCredits:       cur.Credits,
		PlannedCredits:       decNum(o.PlannedCredits),
		TargetGpa:            decNum(o.TargetGpa),
		MaxGpa:               decNum(maxBase + maxBonus),
	})
	return jsv.O("current", jsv.FromGo(cur), "plan", jsv.FromGo(plan))
}
