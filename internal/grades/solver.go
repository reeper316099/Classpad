package grades

import (
	"fmt"
	"sort"
	"strings"
)

// Feasibility of a target.
const (
	Achievable = "achievable"
	Secured    = "secured"
	Impossible = "impossible"
)

type NeededResult struct {
	Target Dec `json:"target"`
	// Required is the exact score needed on each remaining item (nil when out of reach and the
	// grade does not move).
	Required          *Dec            `json:"required"`
	RequiredRoundedUp *Dec            `json:"requiredRoundedUp"`
	Feasibility       string          `json:"feasibility"`
	Best              *Dec            `json:"best"`
	Worst             *Dec            `json:"worst"`
	Expected          *Dec            `json:"expected"`
	RemainingIDs      []string        `json:"remainingIds"`
	PerItem           map[string]*Dec `json:"perItem,omitempty"`
	Steps             []Step          `json:"steps"`
	Warnings          []string        `json:"warnings"`
}

type NeededOptions struct {
	Target ScoreTarget `json:"target"`
	// RemainingIDs to solve over; nil means every active, ungraded, non-extra-credit item.
	RemainingIDs []string `json:"remainingIds,omitempty"`
	// MaxPerItem is the highest score one item can get (default: the scheme's maxScore, else 100).
	MaxPerItem *Dec `json:"maxPerItem,omitempty"`
	// PerItem also solves for each item alone, with the others at Assume percent.
	PerItem bool `json:"perItem,omitempty"`
	Assume  *Dec `json:"assume,omitempty"`
}

func gradeOf(s Scheme, items []GradeItem) *Dec { return ComputeGrade(s, items).PercentRaw }

type solved struct {
	x           *Dec
	feasibility string
	best, worst *Dec
}

// solve finds the score x on the remaining items that reaches target. The final grade is
// continuous, non-decreasing and piecewise linear in x, with breakpoints only where x equals an
// existing score (where the drop-lowest order changes). Evaluating at the breakpoints and
// interpolating on the segment that crosses the target is exact; there is no guessing.
func solve(build func(Dec) *Dec, breakpoints []Dec, max, target Dec) solved {
	xs := []Dec{Zero, max}
	for _, b := range breakpoints {
		if b.Gt(Zero) && b.Lt(max) {
			xs = append(xs, b)
		}
	}
	sort.SliceStable(xs, func(i, j int) bool { return xs[i].Lt(xs[j]) })
	uniq := xs[:1]
	for _, v := range xs[1:] {
		if !v.Eq(uniq[len(uniq)-1]) {
			uniq = append(uniq, v)
		}
	}
	xs = uniq
	g := make([]Dec, len(xs))
	for k, x := range xs {
		v := build(x)
		if v == nil {
			return solved{feasibility: Impossible}
		}
		g[k] = *v
	}
	worst, best := g[0], g[len(g)-1]
	if worst.Gte(target) {
		return solved{x: ptr(Zero), feasibility: Secured, best: &best, worst: &worst}
	}
	for k := 1; k < len(xs); k++ {
		if g[k].Gte(target) {
			x0, x1, g0, g1 := xs[k-1], xs[k], g[k-1], g[k]
			x := x0.Add(target.Sub(g0).Mul(x1.Sub(x0)).Quo(g1.Sub(g0)))
			return solved{x: &x, feasibility: Achievable, best: &best, worst: &worst}
		}
	}
	// Out of reach: extend the last segment to show how far off it is.
	n := len(xs)
	slope := Zero
	if n >= 2 {
		slope = g[n-1].Sub(g[n-2]).Quo(xs[n-1].Sub(xs[n-2]))
	}
	var x *Dec
	if slope.Gt(Zero) {
		x = ptr(xs[n-1].Add(target.Sub(best).Quo(slope)))
	}
	return solved{x: x, feasibility: Impossible, best: &best, worst: &worst}
}

// withScores gives every remaining item a score (and un-excuses it).
func withScores(items []GradeItem, remaining map[string]bool, score func(id string) Dec) []GradeItem {
	out := make([]GradeItem, len(items))
	for k, i := range items {
		if remaining[i.ID] {
			i.Score = PercentScore(score(i.ID))
			i.Excused, i.Dropped = false, false
		}
		out[k] = i
	}
	return out
}

// NeededScore works out the score needed on the remaining work to reach a target percent or letter.
func NeededScore(s Scheme, items []GradeItem, o NeededOptions) (NeededResult, error) {
	warnings := []string{}
	steps := []Step{}
	prep := prepare(items, s, new([]string))
	var ids []string
	remaining := map[string]bool{}
	add := func(id string) {
		if !remaining[id] {
			remaining[id] = true
			ids = append(ids, id)
		}
	}
	if o.RemainingIDs != nil {
		for _, id := range o.RemainingIDs {
			add(id)
		}
	} else {
		for _, p := range prep {
			if !p.inactive && p.percent == nil && !p.extra {
				add(p.id)
			}
		}
	}
	max := Hundred
	if o.MaxPerItem != nil {
		max = *o.MaxPerItem
	} else if s.MaxScore != nil {
		max = *s.MaxScore
	}

	var target Dec
	if o.Target.Percent == nil {
		letter := o.Target.Letter
		var c *LetterCutoff
		for k := range s.Scale.Cutoffs {
			if strings.ToLower(s.Scale.Cutoffs[k].Letter) == strings.ToLower(letter) {
				c = &s.Scale.Cutoffs[k]
				break
			}
		}
		if c == nil {
			return NeededResult{}, fmt.Errorf("Unknown letter \"%s\"", letter)
		}
		target = c.Min
		if s.Rounding.LetterOn == "rounded" && s.Rounding.Mode == "half_up" {
			// A raw percent within half a unit below the cutoff rounds up to it.
			target = target.Sub(scaled(5, -(s.Rounding.Decimals + 1)))
		}
		steps = append(steps, Step{Kind: "target", Label: "Target " + letter, Value: format(&target, 10)})
	} else {
		target = *o.Target.Percent
		steps = append(steps, Step{Kind: "target", Label: "Target percent", Value: f6(target)})
	}

	var bps []Dec
	for _, p := range prep {
		if p.percent != nil && !remaining[p.id] {
			bps = append(bps, *p.percent)
		}
	}
	cur := gradeOf(s, items)
	var out solved
	if len(ids) > 0 {
		out = solve(func(x Dec) *Dec {
			return gradeOf(s, withScores(items, remaining, func(string) Dec { return x }))
		}, bps, max, target)
	} else {
		out = solved{feasibility: Impossible, best: cur, worst: cur}
		warnings = append(warnings, "No remaining items to solve over.")
	}
	var expected *Dec
	if cur != nil && len(ids) > 0 {
		expected = gradeOf(s, withScores(items, remaining, func(string) Dec { return *cur }))
	}

	steps = append(steps,
		Step{Kind: "solve", Label: "Worst case (all remaining at 0)", Value: fp(out.worst)},
		Step{Kind: "solve", Label: "Best case (all remaining at " + f6(max) + ")", Value: fp(out.best)})
	if expected != nil {
		steps = append(steps, Step{Kind: "solve", Label: "Expected (all remaining at current " + fp(cur) + ")", Value: fp(expected)})
	}
	label := "Score needed on each remaining item"
	switch out.feasibility {
	case Secured:
		label = "Target already secured: any score on the remaining work reaches it"
	case Impossible:
		label = "Target not reachable even with " + f6(max) + " on everything remaining"
	}
	steps = append(steps, Step{Kind: "result", Label: label, Value: fp(out.x)})

	var perItem map[string]*Dec
	if o.PerItem && len(ids) > 0 {
		perItem = map[string]*Dec{}
		assume := Zero
		if o.Assume != nil {
			assume = *o.Assume
		} else if cur != nil {
			assume = *cur
		}
		for _, id := range ids {
			r := solve(func(x Dec) *Dec {
				return gradeOf(s, withScores(items, remaining, func(other string) Dec {
					if other == id {
						return x
					}
					return assume
				}))
			}, bps, max, target)
			if r.feasibility == Impossible {
				perItem[id] = nil
			} else {
				perItem[id] = r.x
			}
		}
	}
	var up *Dec
	if out.x != nil {
		up = ptr(out.x.RoundDP(2, RoundUp))
	}
	if ids == nil {
		ids = []string{}
	}
	return NeededResult{
		Target: target, Required: out.x, RequiredRoundedUp: up, Feasibility: out.feasibility,
		Best: out.best, Worst: out.worst, Expected: expected, RemainingIDs: ids, PerItem: perItem,
		Steps: steps, Warnings: warnings,
	}, nil
}

type SensitivityRow struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	IfZero *Dec   `json:"ifZero"`
	IfFull *Dec   `json:"ifFull"`
	// Swing is ifFull − ifZero: how far this item alone can move the grade.
	Swing Dec `json:"swing"`
}

// Sensitivity ranks pending items (and graded ones too, if asked) by how much they can move the
// final grade.
func Sensitivity(s Scheme, items []GradeItem, includeGraded bool) []SensitivityRow {
	prep := prepare(items, s, new([]string))
	max := dOr(s.MaxScore, Hundred)
	rows := []SensitivityRow{}
	for _, p := range prep {
		if p.inactive || p.extra || (p.percent != nil && !includeGraded) {
			continue
		}
		at := func(x Dec) *Dec {
			out := make([]GradeItem, len(items))
			for k, i := range items {
				if i.ID == p.id {
					i.Score = PercentScore(x)
				}
				out[k] = i
			}
			return gradeOf(s, out)
		}
		lo, hi := at(Zero), at(max)
		if lo == nil || hi == nil {
			continue
		}
		rows = append(rows, SensitivityRow{ID: p.id, Title: p.title, IfZero: lo, IfFull: hi, Swing: hi.Sub(*lo)})
	}
	sort.SliceStable(rows, func(a, b int) bool {
		if k := rows[b].Swing.Cmp(rows[a].Swing); k != 0 {
			return k < 0
		}
		return compareIDs(rows[a].ID, rows[b].ID) < 0
	})
	return rows
}

type Projection struct {
	AssumedPercent Dec      `json:"assumedPercent"`
	Projected      *Dec     `json:"projected"`
	PendingIDs     []string `json:"pendingIds"`
	Note           string   `json:"note"`
}

// Project shows where the class lands if every pending item scores the current average. Nil when
// nothing is graded yet.
func Project(s Scheme, items []GradeItem) *Projection {
	cur := gradeOf(s, items)
	if cur == nil {
		return nil
	}
	pending := []string{}
	set := map[string]bool{}
	for _, p := range prepare(items, s, new([]string)) {
		if !p.inactive && p.percent == nil && !p.extra {
			pending = append(pending, p.id)
			set[p.id] = true
		}
	}
	out := make([]GradeItem, len(items))
	for k, i := range items {
		if set[i.ID] {
			i.Score = PercentScore(*cur)
		}
		out[k] = i
	}
	return &Projection{
		AssumedPercent: *cur,
		Projected:      gradeOf(s, out),
		PendingIDs:     pending,
		Note:           fmt.Sprintf("Assumes %d pending item(s) score the current average of %s%%.", len(pending), fp(cur)),
	}
}
