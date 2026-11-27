package grades

import (
	"sort"
	"strings"
	"unicode"
)

func cutoff(letter string, min, gpa string) LetterCutoff {
	return LetterCutoff{Letter: letter, Min: MustParse(min), GPA: ptr(MustParse(gpa))}
}

// DefaultLetterScale is the default (editable) scale. The lowest entry catches everything below.
func DefaultLetterScale() LetterScale {
	return LetterScale{Cutoffs: []LetterCutoff{
		cutoff("A", "93", "4"),
		cutoff("A-", "90", "3.7"),
		cutoff("B+", "87", "3.3"),
		cutoff("B", "83", "3"),
		cutoff("B-", "80", "2.7"),
		cutoff("C+", "77", "2.3"),
		cutoff("C", "73", "2"),
		cutoff("C-", "70", "1.7"),
		cutoff("D+", "67", "1.3"),
		cutoff("D", "63", "1"),
		cutoff("D-", "60", "0.7"),
		cutoff("F", "0", "0"),
	}}
}

// sortedCutoffs returns the cutoffs highest first (stable, like Array.prototype.sort).
func sortedCutoffs(s LetterScale) []LetterCutoff {
	out := append([]LetterCutoff(nil), s.Cutoffs...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Min.Gt(out[j].Min) })
	return out
}

// letterFor finds the letter for a percent and the next letter up (nil at the top).
func letterFor(percent Dec, s LetterScale) (LetterCutoff, *LetterCutoff) {
	sorted := sortedCutoffs(s)
	for i, c := range sorted {
		if percent.Gte(c.Min) {
			if i > 0 {
				return c, &sorted[i-1]
			}
			return c, nil
		}
	}
	last := sorted[len(sorted)-1]
	if len(sorted) > 1 {
		return last, &sorted[len(sorted)-2]
	}
	return last, nil
}

// LetterToPercent is the percent a letter stands for when entered as a score: its lowest percent.
func LetterToPercent(letter string, s LetterScale) *Dec {
	want := strings.ToLower(strings.TrimSpace(letter))
	for _, c := range s.Cutoffs {
		if strings.ToLower(c.Letter) == want {
			return ptr(c.Min)
		}
	}
	return nil
}

// RoundTo rounds to cfg's decimals: "truncate" cuts, anything else rounds half up.
func RoundTo(v Dec, mode string, decimals int) Dec {
	if mode == "truncate" {
		return v.RoundDP(decimals, RoundDown)
	}
	return v.RoundDP(decimals, RoundHalfUp)
}

// DefaultRounding: two decimals, half up, letter looked up on the raw percent.
func DefaultRounding() RoundingConfig {
	return RoundingConfig{Mode: "half_up", Decimals: 2, LetterOn: "raw"}
}

// DefaultScheme is a fresh scheme of the given mode with the default scale and rounding.
func DefaultScheme(mode string) Scheme {
	if mode == "" {
		mode = "assignment_weights"
	}
	return Scheme{
		Mode:                    mode,
		Scale:                   DefaultLetterScale(),
		Rounding:                DefaultRounding(),
		NormalizeOverGradedOnly: true,
		ExtraCreditAllowed:      true,
	}
}

// compareIDs breaks ties between items the way JavaScript's localeCompare does for ids: letters
// compare without regard to case first (digits before letters, punctuation before both), then a
// lowercase letter comes before the same letter in uppercase.
func compareIDs(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	for i := 0; i < len(ra) && i < len(rb); i++ {
		if k := cmpRune(collateKey(ra[i]), collateKey(rb[i])); k != 0 {
			return k
		}
	}
	if k := len(ra) - len(rb); k != 0 {
		return cmpRune(rune(k), 0)
	}
	for i := range ra {
		if ra[i] != rb[i] {
			// Same letter, different case: lowercase first.
			if unicode.IsLower(ra[i]) {
				return -1
			}
			return 1
		}
	}
	return 0
}

// collateKey orders punctuation and symbols, then digits, then letters (case folded).
func collateKey(r rune) rune {
	switch {
	case unicode.IsLetter(r):
		return 0x200000 + unicode.ToLower(r)
	case unicode.IsDigit(r):
		return 0x100000 + r
	}
	return r
}

func cmpRune(a, b rune) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}
