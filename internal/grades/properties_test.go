package grades

import (
	"fmt"
	"math/rand/v2"
	"testing"
)

// Ports of packages/grades/src/properties.test.ts: rules that must hold for any input.

const runs = 300

func randItems(r *rand.Rand) []GradeItem {
	n := 1 + r.IntN(8)
	out := make([]GradeItem, n)
	for i := range out {
		out[i] = GradeItem{ID: fmt.Sprintf("i%d", i), Weight: ptr(decInt(1 + r.IntN(60))), Score: PercentScore(decInt(r.IntN(101)))}
	}
	return out
}

func propCatScheme() Scheme {
	s := DefaultScheme("category_weights")
	s.Categories = []Category{
		{ID: "q", Name: "Q", Weight: NewInt(30), DropLowest: 1, CountMode: "mean"},
		{ID: "e", Name: "E", Weight: NewInt(70), CountMode: "pooled"},
	}
	return s
}

func TestMonotonicInEachScore(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	s := DefaultScheme("")
	for range runs {
		lo := randItems(r)
		i := r.IntN(len(lo))
		hi := append([]GradeItem(nil), lo...)
		bump := decInt(r.IntN(101))
		if bump.Lt(*lo[i].Score.Percent) {
			bump = *lo[i].Score.Percent
		}
		hi[i].Score = PercentScore(bump)
		if ComputeGrade(s, hi).PercentRaw.Lt(*ComputeGrade(s, lo).PercentRaw) {
			t.Fatal("raising a score lowered the grade")
		}
	}
}

func TestInvariantUnderWeightScaling(t *testing.T) {
	r := rand.New(rand.NewPCG(3, 4))
	s := DefaultScheme("")
	for range runs {
		xs := randItems(r)
		k := decInt(1 + r.IntN(9))
		ys := append([]GradeItem(nil), xs...)
		for i := range ys {
			ys[i].Weight = ptr(ys[i].Weight.Mul(k))
		}
		if !ComputeGrade(s, xs).PercentRaw.Eq(*ComputeGrade(s, ys).PercentRaw) {
			t.Fatal("scaling every weight changed the grade")
		}
	}
}

func TestExcusedNeverCounts(t *testing.T) {
	r := rand.New(rand.NewPCG(5, 6))
	s := DefaultScheme("")
	for range runs {
		base := randItems(r)
		extra := randItems(r)
		for i := range extra {
			extra[i].ID = fmt.Sprintf("x%d", i)
			extra[i].Excused = true
		}
		if !ComputeGrade(s, base).PercentRaw.Eq(*ComputeGrade(s, append(append([]GradeItem(nil), base...), extra...)).PercentRaw) {
			t.Fatal("an excused item changed the grade")
		}
	}
}

func TestDropLowestOrderIndependent(t *testing.T) {
	r := rand.New(rand.NewPCG(7, 8))
	s := propCatScheme()
	for range runs {
		n := 2 + r.IntN(9)
		its := make([]GradeItem, n)
		for i := range its {
			poss := decInt(1 + r.IntN(50))
			earned := decInt(r.IntN(101)).Mul(poss).Quo(Hundred)
			its[i] = GradeItem{ID: fmt.Sprintf("i%d", i), CategoryID: []string{"q", "e"}[r.IntN(2)], Possible: &poss,
				Score: &ScoreInput{Kind: KindPoints, Earned: &earned}}
		}
		shuffled := append([]GradeItem(nil), its...)
		r.Shuffle(len(shuffled), func(a, b int) { shuffled[a], shuffled[b] = shuffled[b], shuffled[a] })
		a, b := ComputeGrade(s, its).PercentRaw, ComputeGrade(s, shuffled).PercentRaw
		if (a == nil) != (b == nil) || (a != nil && !a.Eq(*b)) {
			t.Fatal("drop-lowest depends on item order")
		}
	}
}

func TestSolverRoundTrip(t *testing.T) {
	r := rand.New(rand.NewPCG(9, 10))
	s := DefaultScheme("")
	tiny := MustParse("1e-20")
	hits := 0
	for range runs {
		its := append(randItems(r), GradeItem{ID: "final", Weight: ptr(decInt(1 + r.IntN(60)))})
		target := decInt(1 + r.IntN(100))
		n := needed(t, s, its, NeededOptions{Target: ScoreTarget{Percent: &target}})
		if n.Feasibility != Achievable {
			continue
		}
		hits++
		its[len(its)-1].Score = PercentScore(*n.Required)
		if got := ComputeGrade(s, its).PercentRaw; got.Sub(target).Abs().Gte(tiny) {
			t.Fatalf("needed %s for %s but got %s", n.Required, target, got)
		}
	}
	if hits == 0 {
		t.Fatal("no achievable cases")
	}
	cs := propCatScheme()
	base := []GradeItem{
		{ID: "q1", CategoryID: "q", Score: pct("70")},
		{ID: "q2", CategoryID: "q", Score: pct("90")},
		{ID: "q3", CategoryID: "q"},
		{ID: "e1", CategoryID: "e", Possible: d("100"), Score: pts("80")},
	}
	for tg := 76; tg <= 90; tg++ {
		target := decInt(tg)
		n := needed(t, cs, base, NeededOptions{Target: ScoreTarget{Percent: &target}})
		if n.Feasibility != Achievable {
			continue
		}
		filled := append([]GradeItem(nil), base...)
		filled[2].Score = PercentScore(*n.Required)
		if got := ComputeGrade(cs, filled).PercentRaw; got.Sub(target).Abs().Gte(tiny) {
			t.Fatalf("drop-lowest: needed %s for %s but got %s", n.Required, target, got)
		}
	}
}

func TestJunkNeverBreaks(t *testing.T) {
	r := rand.New(rand.NewPCG(11, 12))
	for range runs {
		its := make([]GradeItem, r.IntN(9))
		for i := range its {
			it := GradeItem{ID: fmt.Sprintf("i%d", i), Excused: r.IntN(2) == 0}
			if r.IntN(2) == 0 {
				it.Weight = ptr(decInt(r.IntN(101)))
			}
			switch r.IntN(3) {
			case 0:
				it.Score = PercentScore(decInt(r.IntN(351) - 50))
			case 1:
				it.Score = &ScoreInput{Kind: KindPoints, Earned: ptr(decInt(r.IntN(51))), Possible: ptr(decInt(r.IntN(51)))}
			}
			its[i] = it
		}
		for _, s := range []Scheme{DefaultScheme(""), DefaultScheme("points"), propCatScheme()} {
			g := ComputeGrade(s, its)
			if g.Status == "none" && g.Summary != "No graded work yet" {
				t.Fatal(g.Summary)
			}
		}
	}
}
