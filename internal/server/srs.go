package server

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/reeper316099/classpad/internal/jsv"
)

// MaxIntervalDays: a card is never scheduled more than 100 years out.
const MaxIntervalDays = 36_500

func NewSrs(now time.Time) *jsv.Obj {
	return jsv.O("ease", 2.5, "intervalDays", 0.0, "dueAt", ISO(now), "reps", 0.0, "lapses", 0.0)
}

func addMs(t time.Time, ms float64) time.Time { return t.Add(time.Duration(ms) * time.Millisecond) }

// Schedule is the SM-2 style schedule(): again, hard, good or easy.
func Schedule(s *jsv.Obj, rating string, now time.Time) *jsv.Obj {
	clampEase := func(e float64) float64 { return math.Min(3.5, math.Max(1.3, jsRound(e*100)/100)) }
	ease, interval, reps := s.Num("ease"), s.Num("intervalDays"), s.Num("reps")
	if rating == "again" {
		return s.Clone().
			Set("ease", clampEase(ease-0.2)).
			Set("intervalDays", 0.0).
			Set("dueAt", ISO(addMs(now, 10*60_000))).
			Set("reps", 0.0).
			Set("lapses", s.Num("lapses")+1)
	}
	var days float64
	switch rating {
	case "hard":
		days = 1
		if reps != 0 {
			days = math.Max(1, jsRound(interval*1.2))
		}
		ease -= 0.15
	case "good":
		switch reps {
		case 0:
			days = 1
		case 1:
			days = 3
		default:
			days = math.Max(interval+1, jsRound(interval*s.Num("ease")))
		}
	default:
		days = 3
		if reps != 0 {
			days = math.Max(interval+2, jsRound(interval*s.Num("ease")*1.3))
		}
		ease += 0.15
	}
	days = math.Min(days, MaxIntervalDays)
	return jsv.O("ease", clampEase(ease), "intervalDays", days, "dueAt", ISO(addMs(now, days*86_400_000)),
		"reps", reps+1, "lapses", s.Num("lapses"))
}

func IsDue(s *jsv.Obj, now time.Time) bool {
	t, ok := parseJSDate(s.Str("dueAt"))
	return ok && !t.After(now)
}

// HashText is the small djb2 hash used for change detection, over UTF-16 units.
func HashText(s string) string {
	h := int32(5381)
	for _, u := range utf16.Encode([]rune(s)) {
		h = (h << 5) + h + int32(u)
	}
	return strconv.FormatUint(uint64(uint32(h)), 36)
}

type ClozeCard struct {
	Cloze     float64
	Front     string
	Back      string
	SourceKey string
}

var (
	reCloze      = regexp.MustCompile(`\{\{c(\d+)::([\s\S]*?)(?:::([^}]*?))?\}\}`)
	reBlankLines = regexp.MustCompile(`\n{2,}`)
)

// replaceCloze is block.replace(CLOZE, fn) with the groups (hint is nil when absent).
func replaceCloze(block string, fn func(k, body string, hint *string) string) string {
	var b strings.Builder
	last := 0
	for _, m := range reCloze.FindAllStringSubmatchIndex(block, -1) {
		b.WriteString(block[last:m[0]])
		var hint *string
		if m[6] >= 0 {
			h := block[m[6]:m[7]]
			hint = &h
		}
		b.WriteString(fn(block[m[2]:m[3]], block[m[4]:m[5]], hint))
		last = m[1]
	}
	b.WriteString(block[last:])
	return b.String()
}

func jsNumber(s string) float64 {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return math.Inf(1) // only digits get here; ParseFloat fails only on overflow
	}
	return f
}

// ExtractClozeCards gives one card per cloze number in each paragraph (code fences are skipped).
func ExtractClozeCards(markdown string) []ClozeCard {
	text := replaceFences(markdown, func(m string) string { return strings.ReplaceAll(m, "{{", "{ {") })
	var out []ClozeCard
	for _, block := range reBlankLines.Split(text, -1) {
		seen := map[float64]bool{}
		var nums []float64
		for _, m := range reCloze.FindAllStringSubmatch(block, -1) {
			if n := jsNumber(m[1]); !seen[n] {
				seen[n] = true
				nums = append(nums, n)
			}
		}
		sort.Float64s(nums)
		for _, n := range nums {
			front := replaceCloze(block, func(k, body string, hint *string) string {
				if jsNumber(k) == n {
					if hint != nil && *hint != "" {
						return "[" + jsTrim(*hint) + "]"
					}
					return "[…]"
				}
				return body
			})
			back := replaceCloze(block, func(_, body string, _ *string) string { return body })
			out = append(out, ClozeCard{
				Cloze:     n,
				Front:     jsTrim(front),
				Back:      jsTrim(back),
				SourceKey: jsonNum(n) + ":" + HashText(jsTrim(block)),
			})
		}
	}
	return out
}

func jsonNum(f float64) string { return jsString(f) }
