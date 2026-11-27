package grades

import "fmt"

func applyCurveAndClamp(p Dec, s Scheme) (Dec, []Step) {
	var steps []Step
	if c := s.Curve; c != nil {
		switch c.Kind {
		case "flat":
			add := dOr(c.Add, Zero)
			p = p.Add(add)
			steps = append(steps, Step{Kind: "curve", Label: "Curve: add " + f6(add) + " points", Value: f6(p)})
		case "scale_to_max":
			if m := dOr(c.Max, Zero); m.Gt(Zero) {
				p = p.Mul(Hundred).Quo(m)
				steps = append(steps, Step{Kind: "curve", Label: "Curve: scale so " + f6(m) + " becomes 100", Value: f6(p)})
			}
		}
	}
	if s.MaxScore != nil && p.Gt(*s.MaxScore) {
		p = *s.MaxScore
		steps = append(steps, Step{Kind: "cap", Label: "Capped at " + f6(p), Value: f6(p)})
	}
	return p, steps
}

// ComputeGrade works out the current grade for a class, with the full step-by-step breakdown.
func ComputeGrade(s Scheme, items []GradeItem) GradeResult {
	warnings := []string{}
	prep := prepare(items, s, &warnings)
	var c core
	switch s.Mode {
	case "assignment_weights":
		c = assignmentWeights(prep, s)
	case "category_weights":
		c = categoryWeights(prep, s)
	default:
		c = pointsScheme(prep, s)
	}
	warnings = append(warnings, c.warnings...)
	if c.percent == nil {
		return GradeResult{Status: "none", Summary: "No graded work yet", Steps: []Step{}, Warnings: warnings}
	}
	raw, adj := applyCurveAndClamp(*c.percent, s)
	steps := append(append([]Step{}, c.steps...), adj...)
	rounded := RoundTo(raw, s.Rounding.Mode, s.Rounding.Decimals)
	how := "truncate"
	if s.Rounding.Mode == "half_up" {
		how = "half up"
	}
	steps = append(steps, Step{
		Kind:    "rounding",
		Label:   fmt.Sprintf("Round to %d dp (%s)", s.Rounding.Decimals, how),
		Formula: format(&raw, 10) + " → " + f6(rounded),
		Value:   f6(rounded),
	})
	lookup, on := raw, "raw"
	if s.Rounding.LetterOn == "rounded" {
		lookup, on = rounded, "rounded"
	}
	r := GradeResult{Status: "graded", PercentRaw: &raw, PercentRounded: &rounded, Warnings: warnings}
	if pf := s.PassFail; pf != nil {
		passed := lookup.Gte(pf.Threshold)
		letter := "NP"
		if passed {
			letter = "P"
		}
		r.Letter, r.Passed = &letter, &passed
		steps = append(steps, Step{Kind: "letter", Label: "Pass/fail threshold " + f6(pf.Threshold), Value: letter})
	} else {
		cut, next := letterFor(lookup, s.Scale)
		r.Letter = strp(cut.Letter)
		r.GPAPoints = cut.GPA
		note := ""
		if next != nil {
			toNext := next.Min.Sub(lookup)
			r.NextLetter, r.PointsToNextLetter = strp(next.Letter), &toNext
			note = f6(toNext) + " points to " + next.Letter
		}
		steps = append(steps, Step{
			Kind:  "letter",
			Label: fmt.Sprintf("Letter lookup on %s percent (≥ %s)", on, f6(cut.Min)),
			Value: cut.Letter,
			Note:  note,
		})
	}
	r.Steps = steps
	return r
}

// WhatIfResult compares the real grade with one where some scores are replaced.
type WhatIfResult struct {
	Actual       GradeResult `json:"actual"`
	Hypothetical GradeResult `json:"hypothetical"`
	// Delta is hypothetical − actual (raw percent); nil if either side has no grade.
	Delta *Dec `json:"delta"`
}

// WhatIf overlays hypothetical scores (a nil score means ungraded). The items are not changed.
func WhatIf(s Scheme, items []GradeItem, overrides map[string]*ScoreInput) WhatIfResult {
	actual := ComputeGrade(s, items)
	hypo := make([]GradeItem, len(items))
	for k, i := range items {
		if sc, ok := overrides[i.ID]; ok {
			i.Score = sc
		}
		hypo[k] = i
	}
	h := ComputeGrade(s, hypo)
	var delta *Dec
	if actual.PercentRaw != nil && h.PercentRaw != nil {
		delta = ptr(h.PercentRaw.Sub(*actual.PercentRaw))
	}
	return WhatIfResult{Actual: actual, Hypothetical: h, Delta: delta}
}

// PercentScore is a score of p percent.
func PercentScore(p Dec) *ScoreInput { return &ScoreInput{Kind: KindPercent, Percent: &p} }
