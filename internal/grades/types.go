// Package grades is Classpad's grade and GPA engine: current grade with a step-by-step breakdown,
// what-if, the score needed for a target, sensitivity, projection, and GPA. It is a port of the
// TypeScript engine in packages/grades and gives the same results digit for digit (exact decimals,
// 40 significant digits, the same steps and warnings). The JSON shapes match too.
package grades

import (
	"encoding/json"
	"fmt"
)

// Score kinds.
const (
	KindPercent = "percent"
	KindPoints  = "points"
	KindLetter  = "letter"
)

// ScoreInput is a score as entered: a percent, points earned (out of possible), or a letter.
type ScoreInput struct {
	Kind     string `json:"kind"`
	Percent  *Dec   `json:"percent,omitempty"`
	Earned   *Dec   `json:"earned,omitempty"`
	Possible *Dec   `json:"possible,omitempty"`
	Letter   string `json:"letter,omitempty"`
}

// GradeItem is one assignment.
type GradeItem struct {
	ID          string      `json:"id"`
	Title       *string     `json:"title,omitempty"`
	CategoryID  string      `json:"categoryId,omitempty"`
	Weight      *Dec        `json:"weight,omitempty"` // percent weight (assignment_weights mode)
	Possible    *Dec        `json:"pointsPossible,omitempty"`
	Score       *ScoreInput `json:"score,omitempty"`
	ExtraCredit bool        `json:"extraCredit,omitempty"`
	Excused     bool        `json:"excused,omitempty"`
	Dropped     bool        `json:"dropped,omitempty"` // manually dropped
	// LatePenalty is percentage points taken off this item's score.
	LatePenalty *Dec `json:"latePenalty,omitempty"`
	LateDays    *Dec `json:"lateDays,omitempty"`
}

// Category is a weighted group of assignments (category_weights mode).
type Category struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Weight     Dec    `json:"weight"`
	DropLowest int    `json:"dropLowest,omitempty"`
	CountMode  string `json:"countMode,omitempty"` // "pooled" (default) or "mean"
}

type LetterCutoff struct {
	Letter string `json:"letter"`
	Min    Dec    `json:"min"`
	GPA    *Dec   `json:"gpa,omitempty"`
}

type LetterScale struct {
	Cutoffs []LetterCutoff `json:"cutoffs"`
}

type RoundingConfig struct {
	Mode     string `json:"mode"` // "half_up" or "truncate"
	Decimals int    `json:"decimals"`
	LetterOn string `json:"letterOn"` // look the letter up on the "raw" or "rounded" percent
}

type Curve struct {
	Kind string `json:"kind"` // "flat" or "scale_to_max"
	Add  *Dec   `json:"add,omitempty"`
	Max  *Dec   `json:"max,omitempty"`
}

type LatePolicy struct {
	PerDayPercent Dec  `json:"perDayPercent"`
	MaxPercent    *Dec `json:"maxPercent,omitempty"`
}

type PassFail struct {
	Threshold Dec `json:"threshold"`
}

// Scheme is how a class is graded.
type Scheme struct {
	Mode       string         `json:"mode"` // assignment_weights, category_weights or points
	Categories []Category     `json:"categories,omitempty"`
	Scale      LetterScale    `json:"scale"`
	Rounding   RoundingConfig `json:"rounding"`
	// NormalizeOverGradedOnly: only graded work counts in the denominator (the default).
	NormalizeOverGradedOnly bool `json:"normalizeOverGradedOnly"`
	ExtraCreditAllowed      bool `json:"extraCreditAllowed"`
	// ExtraCreditCapPercent caps extra credit in points mode, as a percent of possible points.
	ExtraCreditCapPercent *Dec        `json:"extraCreditCapPercent,omitempty"`
	LatePolicy            *LatePolicy `json:"latePolicy,omitempty"`
	Curve                 *Curve      `json:"curve,omitempty"`
	MaxScore              *Dec        `json:"maxScore,omitempty"` // clamp the final percent
	PassFail              *PassFail   `json:"passFail,omitempty"` // P/NP letter, no GPA points
}

type Term struct {
	Label   string `json:"label"`
	Score   string `json:"score,omitempty"`
	Weight  string `json:"weight,omitempty"`
	Product string `json:"product,omitempty"`
	Note    string `json:"note,omitempty"`
}

// Step is one line of the "how was this calculated" breakdown.
type Step struct {
	Kind    string `json:"kind"`
	Label   string `json:"label"`
	Formula string `json:"formula,omitempty"`
	Terms   []Term `json:"terms,omitempty"`
	Value   string `json:"value,omitempty"`
	Note    string `json:"note,omitempty"`
}

type GradeResult struct {
	Status             string   `json:"status"` // "graded" or "none"
	Summary            string   `json:"summary,omitempty"`
	PercentRaw         *Dec     `json:"percentRaw"`
	PercentRounded     *Dec     `json:"percentRounded"`
	Letter             *string  `json:"letter"`
	GPAPoints          *Dec     `json:"gpaPoints"`
	Passed             *bool    `json:"passed,omitempty"`
	NextLetter         *string  `json:"nextLetter"`
	PointsToNextLetter *Dec     `json:"pointsToNextLetter"`
	Steps              []Step   `json:"steps"`
	Warnings           []string `json:"warnings"`
}

// prepared is an item normalized for the schemes.
type prepared struct {
	id         string
	title      string
	categoryID string
	weight     *Dec
	percent    *Dec // after the late penalty; nil = not graded
	rawPercent *Dec
	earned     *Dec
	possible   Dec
	penalty    Dec
	extra      bool
	inactive   bool // excused or dropped
}

type core struct {
	percent  *Dec
	steps    []Step
	warnings []string
}

// ScoreTarget is what neededScore aims for: a percent, or a letter's cutoff.
type ScoreTarget struct {
	Percent *Dec
	Letter  string
}

// UnmarshalJSON accepts 90, "90" or {"letter": "A"}.
func (t *ScoreTarget) UnmarshalJSON(b []byte) error {
	var l struct {
		Letter *string `json:"letter"`
	}
	if len(b) > 0 && b[0] == '{' {
		if err := json.Unmarshal(b, &l); err != nil {
			return err
		}
		if l.Letter == nil {
			return fmt.Errorf("grades: target needs a percent or a letter")
		}
		*t = ScoreTarget{Letter: *l.Letter}
		return nil
	}
	var d Dec
	if err := d.UnmarshalJSON(b); err != nil {
		return err
	}
	*t = ScoreTarget{Percent: &d}
	return nil
}

func (t ScoreTarget) MarshalJSON() ([]byte, error) {
	if t.Percent != nil {
		return json.Marshal(t.Percent)
	}
	return json.Marshal(map[string]string{"letter": t.Letter})
}

func strp(s string) *string { return &s }
func boolp(b bool) *bool    { return &b }
