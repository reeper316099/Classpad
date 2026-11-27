package grades

import (
	"strings"
	"testing"
)

// Ports of packages/grades/src/examples.test.ts and edge.test.ts, case for case.

func d(s string) *Dec { return ptr(MustParse(s)) }

func pct(p string) *ScoreInput { return PercentScore(MustParse(p)) }

func pts(earned string) *ScoreInput { return &ScoreInput{Kind: KindPoints, Earned: d(earned)} }

func eqs(t *testing.T, what string, got *Dec, want string) {
	t.Helper()
	if got == nil {
		t.Fatalf("%s: got nil, want %s", what, want)
	}
	if got.String() != want {
		t.Fatalf("%s: got %s, want %s", what, got, want)
	}
}

func str(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func needed(t *testing.T, s Scheme, items []GradeItem, o NeededOptions) NeededResult {
	t.Helper()
	r, err := NeededScore(s, items, o)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

var exampleA = []GradeItem{
	{ID: "a", Weight: d("20"), Score: pct("90")},
	{ID: "b", Weight: d("30"), Score: pct("80")},
	{ID: "c", Weight: d("50")},
}

func TestExampleA(t *testing.T) {
	s := DefaultScheme("")
	r := ComputeGrade(s, exampleA)
	eqs(t, "grade", r.PercentRaw, "84")
	if str(r.Letter) != "B" || len(r.Steps) <= 2 {
		t.Fatalf("letter %s, %d steps", str(r.Letter), len(r.Steps))
	}
	n := needed(t, s, exampleA, NeededOptions{Target: ScoreTarget{Percent: d("90")}})
	eqs(t, "needed for 90", n.Required, "96")
	if n.Feasibility != Achievable {
		t.Fatal(n.Feasibility)
	}
	n = needed(t, s, exampleA, NeededOptions{Target: ScoreTarget{Percent: d("95")}})
	eqs(t, "needed for 95", n.Required, "106")
	eqs(t, "best", n.Best, "92")
	if n.Feasibility != Impossible {
		t.Fatal(n.Feasibility)
	}
	n = needed(t, s, exampleA, NeededOptions{Target: ScoreTarget{Letter: "A"}})
	eqs(t, "needed for A", n.Required, "102")

	w := WhatIf(s, exampleA, map[string]*ScoreInput{"c": pct("100")})
	eqs(t, "what-if", w.Hypothetical.PercentRaw, "92")
	eqs(t, "delta", w.Delta, "8")
	eqs(t, "projected", Project(s, exampleA).Projected, "84")

	sens := Sensitivity(s, exampleA, false)
	if len(sens) != 1 {
		t.Fatal(len(sens))
	}
	eqs(t, "swing", &sens[0].Swing, "50")

	s.NormalizeOverGradedOnly = false
	eqs(t, "ungraded as zero", ComputeGrade(s, exampleA).PercentRaw, "42")
}

func exampleBScheme() Scheme {
	s := DefaultScheme("category_weights")
	s.Categories = []Category{
		{ID: "q", Name: "Quizzes", Weight: MustParse("30"), DropLowest: 1, CountMode: "mean"},
		{ID: "e", Name: "Exams", Weight: MustParse("70"), CountMode: "mean"},
	}
	return s
}

func TestExampleB(t *testing.T) {
	s := exampleBScheme()
	items := []GradeItem{
		{ID: "q1", CategoryID: "q", Score: pct("70")},
		{ID: "q2", CategoryID: "q", Score: pct("90")},
		{ID: "q3", CategoryID: "q", Score: pct("100")},
		{ID: "e1", CategoryID: "e", Score: pct("80")},
	}
	r := ComputeGrade(s, items)
	eqs(t, "grade", r.PercentRaw, "84.5")
	found := false
	for _, st := range r.Steps {
		for _, tm := range st.Terms {
			found = found || strings.Contains(tm.Note, "dropped lowest 1")
		}
	}
	if !found {
		t.Fatal("no drop note")
	}
	for k := range s.Categories {
		s.Categories[k].CountMode = "pooled"
	}
	for k := range items {
		items[k].Possible = d("100")
		items[k].Score = pts(items[k].Score.Percent.String())
	}
	eqs(t, "pooled", ComputeGrade(s, items).PercentRaw, "84.5")
}

func TestExampleC(t *testing.T) {
	scale := GpaScales()["standard_plus_minus"].GpaScale
	credits := func(n string) *Dec { return d(n) }
	courses := []GpaCourse{
		{ID: "1", Credits: credits("4"), Letter: "A", HonorsLevel: "ap"},
		{ID: "2", Credits: credits("3"), Letter: "B+"},
		{ID: "3", Credits: credits("3"), Letter: "A-"},
	}
	eqs(t, "unweighted", ComputeGpa(courses, scale, GpaOptions{}).GPA, "3.7")
	eqs(t, "weighted", ComputeGpa(courses, scale, GpaOptions{Weighted: true}).GPA, "4.1")
	for i := range courses {
		s := "s2"
		if i < 2 {
			s = "s1"
		}
		courses[i].SemesterID = &s
	}
	rep := GpaReportFor(courses, scale, GpaOptions{})
	if len(rep.Semesters) != 2 {
		t.Fatal(len(rep.Semesters))
	}
	eqs(t, "cumulative", rep.Cumulative.Unweighted.GPA, "3.7")
	p := PlanGpa(PlanInput{
		CurrentQualityPoints: MustParse("37"), CurrentCredits: MustParse("10"),
		PlannedCredits: MustParse("10"), TargetGpa: MustParse("3.8"), MaxGpa: MustParse("4"),
	})
	eqs(t, "plan", p.RequiredGpa, "3.9")
	if p.Feasibility != Achievable {
		t.Fatal(p.Feasibility)
	}
}

func TestGoldenCases(t *testing.T) {
	s := DefaultScheme("")
	r := ComputeGrade(s, []GradeItem{{ID: "x", Weight: d("100")}})
	if r.Status != "none" || r.Summary != "No graded work yet" || ComputeGrade(s, nil).Status != "none" {
		t.Fatal("all-ungraded")
	}
	eqs(t, "single", ComputeGrade(s, []GradeItem{{ID: "x", Weight: d("10"), Score: pct("77")}}).PercentRaw, "77")

	r = ComputeGrade(s, []GradeItem{{ID: "x", Weight: d("10"), Score: pct("50")}, {ID: "y", Weight: d("10"), Score: pct("100")}})
	eqs(t, "weights not 100", r.PercentRaw, "75")
	if !strings.Contains(strings.Join(r.Warnings, ","), "not 100") {
		t.Fatal(r.Warnings)
	}
	r = ComputeGrade(s, []GradeItem{{ID: "x", Weight: d("10"), Score: pct("50")}, {ID: "y", Weight: d("90"), Score: pct("0"), Excused: true}})
	eqs(t, "excused", r.PercentRaw, "50")
	r = ComputeGrade(s, []GradeItem{{ID: "x", Weight: d("100"), Score: pct("90")}, {ID: "ec", Weight: d("5"), ExtraCredit: true, Score: pct("100")}})
	eqs(t, "extra credit", r.PercentRaw, "95")

	ps := DefaultScheme("points")
	ps.ExtraCreditCapPercent = d("2")
	r = ComputeGrade(ps, []GradeItem{
		{ID: "a", Possible: d("50"), Score: pts("40")},
		{ID: "b", Possible: d("50"), Score: pts("40")},
		{ID: "ec", ExtraCredit: true, Possible: d("10"), Score: pts("10")},
	})
	eqs(t, "capped extra credit", r.PercentRaw, "82")
	r = ComputeGrade(DefaultScheme("points"), []GradeItem{{ID: "a", Possible: d("100"), Score: pts("90"), LatePenalty: d("10")}})
	eqs(t, "late", r.PercentRaw, "80")

	base := []GradeItem{{ID: "x", Weight: d("100"), Score: pct("80")}}
	c := s
	c.Curve = &Curve{Kind: "flat", Add: d("5")}
	eqs(t, "flat curve", ComputeGrade(c, base).PercentRaw, "85")
	c.Curve = &Curve{Kind: "scale_to_max", Max: d("80")}
	eqs(t, "scale curve", ComputeGrade(c, base).PercentRaw, "100")
}

func TestRounding(t *testing.T) {
	at := func(p string, r RoundingConfig) GradeResult {
		s := DefaultScheme("")
		s.Rounding = r
		return ComputeGrade(s, []GradeItem{{ID: "x", Weight: d("100"), Score: pct(p)}})
	}
	if l := str(at("89.5", RoundingConfig{"half_up", 0, "rounded"}).Letter); l != "A-" {
		t.Fatal(l)
	}
	if l := str(at("89.5", RoundingConfig{"half_up", 0, "raw"}).Letter); l != "B+" {
		t.Fatal(l)
	}
	r := at("92.995", RoundingConfig{"half_up", 2, "rounded"})
	eqs(t, "half up", r.PercentRounded, "93")
	if str(r.Letter) != "A" {
		t.Fatal(str(r.Letter))
	}
	r = at("92.995", RoundingConfig{"truncate", 2, "rounded"})
	eqs(t, "truncate", r.PercentRounded, "92.99")
	if str(r.Letter) != "A-" {
		t.Fatal(str(r.Letter))
	}
	s := DefaultScheme("")
	s.Rounding = RoundingConfig{"half_up", 0, "rounded"}
	eqs(t, "rounded letter target", ptr(needed(t, s, exampleA, NeededOptions{Target: ScoreTarget{Letter: "A-"}}).Target), "89.5")
}

func TestPassFailAndTies(t *testing.T) {
	s := DefaultScheme("")
	s.PassFail = &PassFail{Threshold: MustParse("60")}
	r := ComputeGrade(s, []GradeItem{{ID: "x", Weight: d("100"), Score: pct("65")}})
	if str(r.Letter) != "P" || r.GPAPoints != nil {
		t.Fatal(str(r.Letter))
	}
	sc := DefaultScheme("category_weights")
	sc.Categories = []Category{{ID: "q", Name: "Q", Weight: MustParse("100"), DropLowest: 1, CountMode: "pooled"}}
	items := []GradeItem{
		{ID: "a", CategoryID: "q", Possible: d("10"), Score: pts("5")},
		{ID: "b", CategoryID: "q", Possible: d("100"), Score: pts("50")},
		{ID: "c", CategoryID: "q", Possible: d("100"), Score: pts("90")},
	}
	rev := []GradeItem{items[2], items[1], items[0]}
	if !ComputeGrade(sc, items).PercentRaw.Eq(*ComputeGrade(sc, rev).PercentRaw) {
		t.Fatal("drop-lowest depends on order")
	}
}

func TestRetakesAndExclusions(t *testing.T) {
	scale := GpaScales()["standard_plus_minus"].GpaScale
	cs := []GpaCourse{
		{ID: "a", Credits: d("3"), Letter: "D", CourseKey: "MATH", TermIndex: 1},
		{ID: "b", Credits: d("3"), Letter: "B", CourseKey: "MATH", TermIndex: 2},
	}
	eqs(t, "latest", ComputeGpa(cs, scale, GpaOptions{RepeatRule: RepeatReplaceLatest}).GPA, "3")
	eqs(t, "none", ComputeGpa(cs, scale, GpaOptions{}).GPA, "2")
	eqs(t, "best", ComputeGpa(cs, scale, GpaOptions{RepeatRule: RepeatKeepBest}).GPA, "3")
	g := ComputeGpa([]GpaCourse{{ID: "a", Letter: "A"}, {ID: "b", Credits: d("3"), Letter: "A", PassFail: true}},
		GpaScales()["flat_4"].GpaScale, GpaOptions{})
	if g.GPA != nil || !strings.Contains(strings.Join(g.Warnings, ","), "no credits") {
		t.Fatal(g.Warnings)
	}
}

func TestInputFormsAndEdges(t *testing.T) {
	s := DefaultScheme("")
	letter := func(l string) *ScoreInput { return &ScoreInput{Kind: KindLetter, Letter: l} }
	eqs(t, "letter", ComputeGrade(s, []GradeItem{{ID: "x", Weight: d("100"), Score: letter("b+")}}).PercentRaw, "87")
	r := ComputeGrade(s, []GradeItem{{ID: "x", Weight: d("100"), Score: letter("Z")}})
	if r.Status != "none" || !strings.Contains(strings.Join(r.Warnings, ","), "unknown letter") {
		t.Fatal(r.Warnings)
	}

	late := s
	late.LatePolicy = &LatePolicy{PerDayPercent: MustParse("5"), MaxPercent: d("20")}
	eqs(t, "late max", ComputeGrade(late, []GradeItem{{ID: "x", Weight: d("100"), Score: pct("100"), LateDays: d("10")}}).PercentRaw, "80")
	eqs(t, "late 2 days", ComputeGrade(late, []GradeItem{{ID: "x", Weight: d("100"), Score: pct("100"), LateDays: d("2")}}).PercentRaw, "90")

	r = ComputeGrade(s, []GradeItem{{ID: "x", Weight: d("100"), Score: pts("40")}})
	eqs(t, "assumed 100", r.PercentRaw, "40")
	if !strings.Contains(strings.Join(r.Warnings, ","), "assumed 100") {
		t.Fatal(r.Warnings)
	}
	r = ComputeGrade(s, []GradeItem{{ID: "x", Weight: d("100"), Score: &ScoreInput{Kind: KindPoints, Earned: d("4"), Possible: d("0")}}})
	if r.Status != "none" {
		t.Fatal(r.Status)
	}

	noEC := s
	noEC.ExtraCreditAllowed = false
	eqs(t, "no extra credit", ComputeGrade(noEC, []GradeItem{
		{ID: "x", Weight: d("100"), Score: pct("90")},
		{ID: "e", Weight: d("5"), ExtraCredit: true, Score: pct("100")},
	}).PercentRaw, "90")

	r = ComputeGrade(s, []GradeItem{{ID: "x", Score: pct("90")}, {ID: "y", Weight: d("10"), Score: pct("70")}})
	eqs(t, "no weight", r.PercentRaw, "70")
	if !strings.Contains(strings.Join(r.Warnings, ","), "no weight") {
		t.Fatal(r.Warnings)
	}
	capped := s
	capped.MaxScore = d("100")
	eqs(t, "max score", ComputeGrade(capped, []GradeItem{{ID: "x", Weight: d("100"), Score: pct("110")}}).PercentRaw, "100")

	items := []GradeItem{{ID: "a", Weight: d("50"), Score: pct("90")}, {ID: "b", Weight: d("25")}, {ID: "c", Weight: d("25")}}
	n := needed(t, s, items, NeededOptions{Target: ScoreTarget{Percent: d("85")}, PerItem: true, Assume: d("80")})
	eqs(t, "per item", n.PerItem["b"], "80")
	if needed(t, s, items, NeededOptions{Target: ScoreTarget{Percent: d("10")}}).Feasibility != Secured {
		t.Fatal("not secured")
	}
	if w := needed(t, s, items, NeededOptions{Target: ScoreTarget{Percent: d("50")}, RemainingIDs: []string{}}).Warnings; len(w) != 1 {
		t.Fatal(w)
	}
	if _, err := NeededScore(s, nil, NeededOptions{Target: ScoreTarget{Letter: "Q"}}); err == nil {
		t.Fatal("unknown letter accepted")
	}
	if len(Sensitivity(s, nil, false)) != 0 || Project(s, nil) != nil {
		t.Fatal("empty class")
	}
}

func TestDecimal(t *testing.T) {
	for _, c := range []struct {
		got  Dec
		want string
	}{
		{MustParse("1").Quo(MustParse("3")), "0.3333333333333333333333333333333333333333"},
		{MustParse("2").Quo(MustParse("3")), "0.6666666666666666666666666666666666666667"},
		{MustParse("-2").Quo(MustParse("3")), "-0.6666666666666666666666666666666666666667"},
		{MustParse("100").Quo(MustParse("7")), "14.28571428571428571428571428571428571429"},
		{MustParse("0.1").Add(MustParse("0.2")), "0.3"},
		{MustParse("1e21"), "1e+21"},
		{MustParse("123456789012345678901"), "123456789012345678901"},
		{MustParse("0.0000001"), "1e-7"},
		{MustParse("0.000001"), "0.000001"},
		{MustParse("2.50"), "2.5"},
		{MustParse("1500"), "1500"},
		{MustParse("-0.5").RoundDP(0, RoundHalfUp), "-1"},
		{MustParse("92.995").RoundDP(2, RoundDown), "92.99"},
		{MustParse("1.001").RoundDP(2, RoundUp), "1.01"},
		{MustParse("5").Sub(MustParse("5")), "0"},
	} {
		if c.got.String() != c.want {
			t.Errorf("got %s, want %s", c.got, c.want)
		}
	}
}
