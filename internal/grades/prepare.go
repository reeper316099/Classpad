package grades

import "fmt"

func prepare(items []GradeItem, s Scheme, warnings *[]string) []prepared {
	warn := func(f string, a ...any) { *warnings = append(*warnings, fmt.Sprintf(f, a...)) }
	out := make([]prepared, 0, len(items))
	for _, it := range items {
		title := it.ID
		if it.Title != nil {
			title = *it.Title
		}
		inactive := it.Excused || it.Dropped
		var percent, earned *Dec
		possible := dOr(it.Possible, Hundred)
		if sc := it.Score; sc != nil && !inactive {
			switch sc.Kind {
			case KindPercent:
				percent = ptr(dOr(sc.Percent, Zero))
			case KindPoints:
				p := sc.Possible
				if p == nil {
					p = it.Possible
				}
				if p == nil {
					warn("\"%s\": points score has no possible points; assumed 100.", title)
				}
				possible = dOr(p, Hundred)
				if possible.Lte(Zero) {
					warn("\"%s\": possible points must be positive; item ignored.", title)
				} else {
					earned = ptr(dOr(sc.Earned, Zero))
					percent = ptr(earned.Quo(possible).Mul(Hundred))
				}
			default:
				if lp := LetterToPercent(sc.Letter, s.Scale); lp != nil {
					percent = lp
				} else {
					warn("\"%s\": unknown letter \"%s\"; item ignored.", title, sc.Letter)
				}
			}
		}
		raw := percent
		penalty := Zero
		if percent != nil {
			if it.LatePenalty != nil {
				penalty = *it.LatePenalty
			} else if it.LateDays != nil && !it.LateDays.IsZero() && s.LatePolicy != nil {
				penalty = s.LatePolicy.PerDayPercent.Mul(*it.LateDays)
				if m := s.LatePolicy.MaxPercent; m != nil && !penalty.Lt(*m) {
					penalty = *m
				}
			}
			if penalty.Gt(Zero) {
				adj := percent.Sub(penalty)
				if adj.Lt(Zero) {
					adj = Zero
				}
				percent = &adj
				earned = nil
			}
		}
		if percent != nil && earned == nil {
			earned = ptr(percent.Mul(possible).Quo(Hundred))
		}
		extra := it.ExtraCredit
		if extra && !s.ExtraCreditAllowed {
			warn("\"%s\": extra credit is not allowed in this scheme; item ignored.", title)
			percent, earned = nil, nil
		}
		out = append(out, prepared{
			id: it.ID, title: title, categoryID: it.CategoryID, weight: it.Weight,
			percent: percent, rawPercent: raw, earned: earned, possible: possible,
			penalty: penalty, extra: extra, inactive: inactive,
		})
	}
	return out
}

func penaltyNote(p prepared) string {
	if p.penalty.Gt(Zero) {
		return fmt.Sprintf("late penalty −%s (from %s)", f6(p.penalty), fp(p.rawPercent))
	}
	return ""
}
