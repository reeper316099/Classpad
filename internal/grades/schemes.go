package grades

import (
	"fmt"
	"sort"
	"strings"
)

// assignmentWeights: Σ(score × weight) / Σ(weight) over graded items.
func assignmentWeights(items []prepared, s Scheme) core {
	var warnings []string
	steps := []Step{}
	numer, denom, all, ecNumer := Zero, Zero, Zero, Zero
	var terms, ecTerms []Term
	graded := 0
	for _, i := range items {
		if i.inactive {
			continue
		}
		if i.weight == nil {
			if i.percent != nil {
				warnings = append(warnings, fmt.Sprintf("\"%s\" is graded but has no weight; ignored.", i.title))
			}
			continue
		}
		w := *i.weight
		if !i.extra {
			all = all.Add(w)
		}
		if i.percent == nil {
			continue
		}
		product := i.percent.Mul(w)
		if i.extra {
			ecNumer = ecNumer.Add(product)
			ecTerms = append(ecTerms, Term{Label: i.title, Score: fp(i.percent), Weight: f6(w), Product: f6(product), Note: "extra credit"})
			continue
		}
		graded++
		numer = numer.Add(product)
		denom = denom.Add(w)
		terms = append(terms, Term{Label: i.title, Score: fp(i.percent), Weight: f6(w), Product: f6(product), Note: penaltyNote(i)})
	}
	if graded == 0 {
		return core{warnings: warnings}
	}
	if !all.Eq(Hundred) {
		warnings = append(warnings, fmt.Sprintf("Weights sum to %s%%, not 100%%.", f6(all)))
	}
	steps = append(steps,
		Step{Kind: "terms", Label: "Graded items (score × weight)", Terms: terms},
		Step{Kind: "sum", Label: "Sum of score × weight", Value: f6(numer)})
	if len(ecTerms) > 0 {
		steps = append(steps, Step{Kind: "terms", Label: "Extra credit (added to the numerator only)", Terms: ecTerms})
		numer = numer.Add(ecNumer)
	}
	divisor := denom
	if !s.NormalizeOverGradedOnly {
		divisor = all
		steps = append(steps, Step{Kind: "normalize", Label: "Divide by all weights (ungraded work counts as 0)", Value: f6(divisor)})
	} else {
		steps = append(steps, Step{Kind: "normalize", Label: "Divide by the weight of graded work only", Value: f6(divisor)})
	}
	if divisor.Lte(Zero) {
		return core{warnings: warnings}
	}
	percent := numer.Quo(divisor)
	steps = append(steps, Step{Kind: "result", Label: "Grade before rounding", Formula: f6(numer) + " ÷ " + f6(divisor), Value: f6(percent)})
	return core{percent: &percent, steps: steps, warnings: warnings}
}

// categoryWeights: each category's average, weighted by the category's weight, with drop-lowest-N.
func categoryWeights(items []prepared, s Scheme) core {
	var warnings []string
	known := map[string]bool{}
	for _, c := range s.Categories {
		known[c.ID] = true
	}
	var active []prepared
	for _, i := range items {
		if i.inactive {
			continue
		}
		active = append(active, i)
		if i.percent != nil && (i.categoryID == "" || !known[i.categoryID]) {
			warnings = append(warnings, fmt.Sprintf("\"%s\" has no valid category; ignored.", i.title))
		}
	}
	var catTerms []Term
	numer, denomGraded, denomAll := Zero, Zero, Zero
	for _, c := range s.Categories {
		w := c.Weight
		denomAll = denomAll.Add(w)
		var regular, ec []prepared
		for _, i := range active {
			if i.categoryID == "" || i.categoryID != c.ID || i.percent == nil {
				continue
			}
			if i.extra {
				ec = append(ec, i)
			} else {
				regular = append(regular, i)
			}
		}
		if len(regular) == 0 {
			catTerms = append(catTerms, Term{Label: c.Name, Weight: f6(w), Note: "no graded work"})
			continue
		}
		sorted := append([]prepared(nil), regular...)
		sort.SliceStable(sorted, func(a, b int) bool {
			if k := sorted[a].percent.Cmp(*sorted[b].percent); k != 0 {
				return k < 0
			}
			return compareIDs(sorted[a].id, sorted[b].id) < 0
		})
		nDrop := min(max(c.DropLowest, 0), len(sorted)-1)
		dropped, kept := sorted[:nDrop], sorted[nDrop:]
		mean := c.CountMode == "mean"
		var avg Dec
		if mean {
			sum := Zero
			for _, i := range kept {
				sum = sum.Add(*i.percent)
			}
			ecSum := Zero
			for _, i := range ec {
				ecSum = ecSum.Add(*i.percent)
			}
			avg = sum.Add(ecSum).Quo(decInt(len(kept)))
		} else {
			e, p, ecE := Zero, Zero, Zero
			for _, i := range kept {
				e = e.Add(*i.earned)
				p = p.Add(i.possible)
			}
			for _, i := range ec {
				ecE = ecE.Add(*i.earned)
			}
			e = e.Add(ecE)
			if p.Lte(Zero) {
				avg = Zero
			} else {
				avg = e.Quo(p).Mul(Hundred)
			}
		}
		var notes []string
		if mean {
			notes = append(notes, "mean of percents")
		} else {
			notes = append(notes, "pooled points")
		}
		if len(dropped) > 0 {
			var ds []string
			for _, d := range dropped {
				ds = append(ds, fmt.Sprintf("%s (%s)", d.title, fp(d.percent)))
			}
			notes = append(notes, fmt.Sprintf("dropped lowest %d: %s", len(dropped), strings.Join(ds, ", ")))
		}
		if len(ec) > 0 {
			notes = append(notes, fmt.Sprintf("%d extra credit", len(ec)))
		}
		catTerms = append(catTerms, Term{Label: c.Name, Score: f6(avg), Weight: f6(w), Product: f6(avg.Mul(w)), Note: strings.Join(notes, "; ")})
		numer = numer.Add(avg.Mul(w))
		denomGraded = denomGraded.Add(w)
	}
	if denomGraded.Lte(Zero) {
		return core{warnings: warnings}
	}
	if !denomAll.Eq(Hundred) {
		warnings = append(warnings, fmt.Sprintf("Category weights sum to %s%%, not 100%%.", f6(denomAll)))
	}
	steps := []Step{{Kind: "terms", Label: "Category averages (average × weight)", Terms: catTerms}}
	divisor, label := denomGraded, "Divide by the weight of categories with graded work"
	if !s.NormalizeOverGradedOnly {
		divisor, label = denomAll, "Divide by all category weights (empty categories count as 0)"
	}
	steps = append(steps, Step{Kind: "normalize", Label: label, Value: f6(divisor)})
	if divisor.Lte(Zero) {
		// Only reachable with negative category weights; the TypeScript engine divides by zero here.
		return core{warnings: warnings}
	}
	percent := numer.Quo(divisor)
	steps = append(steps, Step{Kind: "result", Label: "Grade before rounding", Formula: f6(numer) + " ÷ " + f6(divisor), Value: f6(percent)})
	return core{percent: &percent, steps: steps, warnings: warnings}
}

// pointsScheme: Σ earned / Σ possible over graded work; extra credit adds to earned only.
func pointsScheme(items []prepared, s Scheme) core {
	var graded, ec []prepared
	for _, i := range items {
		if i.inactive || i.percent == nil {
			continue
		}
		if i.extra {
			ec = append(ec, i)
		} else {
			graded = append(graded, i)
		}
	}
	if len(graded) == 0 {
		return core{}
	}
	E, P := Zero, Zero
	terms := make([]Term, 0, len(graded))
	for _, i := range graded {
		E = E.Add(*i.earned)
		P = P.Add(i.possible)
		terms = append(terms, Term{Label: i.title, Score: fp(i.earned) + " / " + f6(i.possible), Note: penaltyNote(i)})
	}
	steps := []Step{
		{Kind: "terms", Label: "Graded items (earned / possible)", Terms: terms},
		{Kind: "sum", Label: "Totals", Value: f6(E) + " / " + f6(P)},
	}
	ecPts := Zero
	for _, i := range ec {
		ecPts = ecPts.Add(*i.earned)
	}
	if len(ec) > 0 {
		if s.ExtraCreditCapPercent != nil {
			cp := P.Mul(*s.ExtraCreditCapPercent).Quo(Hundred)
			if ecPts.Gt(cp) {
				steps = append(steps, Step{Kind: "cap", Label: fmt.Sprintf("Extra credit capped at %s%% of possible points", f6(*s.ExtraCreditCapPercent)), Value: f6(cp)})
				ecPts = cp
			}
		}
		steps = append(steps, Step{Kind: "extra", Label: "Extra credit (adds to earned, not to possible)", Value: f6(ecPts)})
	}
	if P.Lte(Zero) {
		return core{}
	}
	percent := E.Add(ecPts).Quo(P).Mul(Hundred)
	steps = append(steps, Step{Kind: "result", Label: "Grade before rounding",
		Formula: fmt.Sprintf("(%s + %s) ÷ %s × 100", f6(E), f6(ecPts), f6(P)), Value: f6(percent)})
	return core{percent: &percent, steps: steps}
}
