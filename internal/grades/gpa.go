package grades

import (
	"fmt"
	"sort"
	"strings"
)

type GradePoint struct {
	Letter string `json:"letter"`
	GPA    Dec    `json:"gpa"`
}

type GpaScale struct {
	Points []GradePoint `json:"points"`
	// WeightedBonus is added to passing grades (points > 0) in weighted GPA, by honors level.
	WeightedBonus map[string]Dec `json:"weightedBonus"`
}

type GpaCourse struct {
	ID          string  `json:"id"`
	Name        *string `json:"name,omitempty"`
	SemesterID  *string `json:"semesterId,omitempty"`
	Credits     *Dec    `json:"credits,omitempty"`
	Letter      string  `json:"letter,omitempty"`
	HonorsLevel string  `json:"honorsLevel,omitempty"`
	PassFail    bool    `json:"passFail,omitempty"`
	// IncludeInGpa: nil means yes.
	IncludeInGpa *bool `json:"includeInGpa,omitempty"`
	// CourseKey: courses sharing a key are attempts at the same course (for the repeat rule).
	CourseKey string `json:"courseKey,omitempty"`
	// TermIndex orders attempts in time (higher is later).
	TermIndex float64 `json:"termIndex,omitempty"`
}

// Repeat rules for retaken courses.
const (
	RepeatNone          = "none"
	RepeatReplaceLatest = "replace_latest"
	RepeatKeepBest      = "keep_best"
)

type GpaOptions struct {
	Weighted   bool            `json:"weighted"`
	RepeatRule string          `json:"repeatRule,omitempty"`
	Rounding   *RoundingConfig `json:"rounding,omitempty"`
}

type TranscriptRow struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	SemesterID    *string `json:"semesterId,omitempty"`
	Letter        string  `json:"letter"`
	Credits       Dec     `json:"credits"`
	Points        Dec     `json:"points"`
	QualityPoints Dec     `json:"qualityPoints"`
}

type GpaResult struct {
	GPA           *Dec            `json:"gpa"`
	Rounded       *Dec            `json:"rounded"`
	Credits       Dec             `json:"credits"`
	QualityPoints Dec             `json:"qualityPoints"`
	Rows          []TranscriptRow `json:"rows"`
	Steps         []Step          `json:"steps"`
	Warnings      []string        `json:"warnings"`
}

// GradePoints is the grade points for a letter on a scale, or nil if the scale doesn't have it.
func GradePoints(letter string, s GpaScale) *Dec {
	want := strings.ToLower(strings.TrimSpace(letter))
	for _, p := range s.Points {
		if strings.ToLower(p.Letter) == want {
			return ptr(p.GPA)
		}
	}
	return nil
}

// ComputeGpa works out a GPA from courses' letters and credits.
func ComputeGpa(courses []GpaCourse, scale GpaScale, o GpaOptions) GpaResult {
	warnings := []string{}
	steps := []Step{}
	list := courses
	rule := o.RepeatRule
	if rule == "" {
		rule = RepeatNone
	}
	if rule != RepeatNone {
		var keys []string
		groups := map[string][]GpaCourse{}
		var rest []GpaCourse
		for _, c := range courses {
			if c.CourseKey == "" {
				rest = append(rest, c)
				continue
			}
			if _, ok := groups[c.CourseKey]; !ok {
				keys = append(keys, c.CourseKey)
			}
			groups[c.CourseKey] = append(groups[c.CourseKey], c)
		}
		pointsOf := func(c GpaCourse) Dec {
			if c.Letter == "" {
				return Zero
			}
			return dOr(GradePoints(c.Letter, scale), Zero)
		}
		for _, key := range keys {
			g := groups[key]
			if len(g) == 1 {
				rest = append(rest, g[0])
				continue
			}
			sorted := append([]GpaCourse(nil), g...)
			sort.SliceStable(sorted, func(a, b int) bool {
				x, y := sorted[a], sorted[b]
				if rule == RepeatReplaceLatest {
					if x.TermIndex != y.TermIndex {
						return x.TermIndex > y.TermIndex
					}
				} else if k := pointsOf(y).Cmp(pointsOf(x)); k != 0 {
					return k < 0
				}
				return compareIDs(x.ID, y.ID) < 0
			})
			rest = append(rest, sorted[0])
			warnings = append(warnings, fmt.Sprintf("Repeated course \"%s\": %d earlier attempt(s) excluded (%s).", key, len(g)-1, rule))
		}
		list = rest
	}
	rows := []TranscriptRow{}
	for _, c := range list {
		name := c.ID
		if c.Name != nil {
			name = *c.Name
		}
		if (c.IncludeInGpa != nil && !*c.IncludeInGpa) || c.PassFail {
			continue
		}
		if c.Credits == nil || c.Credits.Lte(Zero) {
			warnings = append(warnings, fmt.Sprintf("\"%s\" has no credits; excluded from GPA.", name))
			continue
		}
		if c.Letter == "" {
			continue
		}
		base := GradePoints(c.Letter, scale)
		if base == nil {
			warnings = append(warnings, fmt.Sprintf("\"%s\": letter \"%s\" not in GPA scale; excluded.", name, c.Letter))
			continue
		}
		pts := *base
		if o.Weighted && base.Gt(Zero) {
			level := c.HonorsLevel
			if level == "" {
				level = "regular"
			}
			if bonus, ok := scale.WeightedBonus[level]; ok {
				pts = pts.Add(bonus)
			}
		}
		rows = append(rows, TranscriptRow{
			ID: c.ID, Name: name, SemesterID: c.SemesterID, Letter: c.Letter,
			Credits: *c.Credits, Points: pts, QualityPoints: pts.Mul(*c.Credits),
		})
	}
	if len(rows) == 0 {
		return GpaResult{Rows: rows, Steps: steps, Warnings: warnings}
	}
	Q, C := Zero, Zero
	terms := make([]Term, 0, len(rows))
	for _, r := range rows {
		Q = Q.Add(r.QualityPoints)
		C = C.Add(r.Credits)
		terms = append(terms, Term{
			Label: fmt.Sprintf("%s (%s)", r.Name, r.Letter), Score: f6(r.Points),
			Weight: f6(r.Credits), Product: f6(r.QualityPoints),
		})
	}
	weighted := ""
	if o.Weighted {
		weighted = ", weighted"
	}
	steps = append(steps, Step{Kind: "terms", Label: "Quality points (grade points × credits" + weighted + ")", Terms: terms})
	gpa := Q.Quo(C)
	steps = append(steps, Step{Kind: "result", Label: "GPA", Formula: f6(Q) + " ÷ " + f6(C), Value: f6(gpa)})
	var rounded Dec
	if o.Rounding != nil {
		rounded = RoundTo(gpa, o.Rounding.Mode, o.Rounding.Decimals)
	} else {
		rounded = RoundTo(gpa, "half_up", 2)
	}
	return GpaResult{GPA: &gpa, Rounded: &rounded, Credits: C, QualityPoints: Q, Rows: rows, Steps: steps, Warnings: warnings}
}

type SemesterGpa struct {
	SemesterID string    `json:"semesterId"`
	Unweighted GpaResult `json:"unweighted"`
	Weighted   GpaResult `json:"weighted"`
}

type GpaPair struct {
	Unweighted GpaResult `json:"unweighted"`
	Weighted   GpaResult `json:"weighted"`
}

type GpaReport struct {
	Semesters  []SemesterGpa `json:"semesters"`
	Cumulative GpaPair       `json:"cumulative"`
}

// GpaReportFor gives per-semester and cumulative GPA, weighted and unweighted. o.Weighted is
// ignored.
func GpaReportFor(courses []GpaCourse, scale GpaScale, o GpaOptions) GpaReport {
	both := func(cs []GpaCourse) GpaPair {
		u, w := o, o
		u.Weighted, w.Weighted = false, true
		return GpaPair{Unweighted: ComputeGpa(cs, scale, u), Weighted: ComputeGpa(cs, scale, w)}
	}
	sem := func(c GpaCourse) string {
		if c.SemesterID == nil {
			return ""
		}
		return *c.SemesterID
	}
	var ids []string
	seen := map[string]bool{}
	for _, c := range courses {
		if id := sem(c); !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	r := GpaReport{Semesters: []SemesterGpa{}, Cumulative: both(courses)}
	for _, id := range ids {
		var cs []GpaCourse
		for _, c := range courses {
			if sem(c) == id {
				cs = append(cs, c)
			}
		}
		p := both(cs)
		r.Semesters = append(r.Semesters, SemesterGpa{SemesterID: id, Unweighted: p.Unweighted, Weighted: p.Weighted})
	}
	return r
}

type PlanInput struct {
	CurrentQualityPoints Dec `json:"currentQualityPoints"`
	CurrentCredits       Dec `json:"currentCredits"`
	PlannedCredits       Dec `json:"plannedCredits"`
	TargetGpa            Dec `json:"targetGpa"`
	MaxGpa               Dec `json:"maxGpa"`
}

type PlanResult struct {
	RequiredGpa *Dec   `json:"requiredGpa"`
	Feasibility string `json:"feasibility"`
	Steps       []Step `json:"steps"`
}

// PlanGpa: what GPA is needed over the planned credits to reach the target cumulative GPA?
func PlanGpa(in PlanInput) PlanResult {
	Q, C, n, T, M := in.CurrentQualityPoints, in.CurrentCredits, in.PlannedCredits, in.TargetGpa, in.MaxGpa
	if n.Lte(Zero) {
		return PlanResult{Feasibility: Impossible, Steps: []Step{{Kind: "note", Label: "No planned credits"}}}
	}
	req := T.Mul(C.Add(n)).Sub(Q).Quo(n)
	steps := []Step{{
		Kind:    "result",
		Label:   "Required average over planned credits",
		Formula: fmt.Sprintf("(%s × (%s + %s) − %s) ÷ %s", f6(T), f6(C), f6(n), f6(Q), f6(n)),
		Value:   f6(req),
	}}
	f := Achievable
	if req.Lte(Zero) {
		f = Secured
	} else if req.Gt(M) {
		f = Impossible
	}
	return PlanResult{RequiredGpa: &req, Feasibility: f, Steps: steps}
}
