package server

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/reeper316099/classpad/internal/jsonstore"
	"github.com/reeper316099/classpad/internal/jsv"
	"golang.org/x/text/unicode/norm"
)

// stripMarks is s.normalize('NFKD').replace(/[̀-ͯ]/g, ”).
func stripMarks(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 0x300 && r <= 0x36f {
			return -1
		}
		return r
	}, norm.NFKD.String(s))
}

// jsLower is String.prototype.toLowerCase (Go's ToLower differs for İ and final Σ).
func jsLower(s string) string {
	if !strings.ContainsAny(s, "İΣ") {
		return strings.ToLower(s)
	}
	rs := []rune(s)
	var b strings.Builder
	for i, r := range rs {
		switch r {
		case 'İ':
			b.WriteString("i̇")
		case 'Σ':
			if i > 0 && unicode.IsLetter(rs[i-1]) && (i+1 == len(rs) || !unicode.IsLetter(rs[i+1])) {
				b.WriteRune('ς')
			} else {
				b.WriteRune('σ')
			}
		default:
			b.WriteString(strings.ToLower(string(r)))
		}
	}
	return b.String()
}

func jsLowerASCIIOnly(s string) string { return jsLower(s) }

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// collapseSpace is .replace(/\s+/g, ' ').
func collapseSpace(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		if isJSSpace(r) {
			if !space {
				b.WriteByte(' ')
			}
			space = true
			continue
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}

// utf16Slice is s.slice(from, to) on a JavaScript string.
func utf16Slice(s string, from, to int) string {
	u := utf16.Encode([]rune(s))
	from, to = clamp(from, 0, len(u)), clamp(to, 0, len(u))
	if to < from {
		return ""
	}
	return string(utf16.Decode(u[from:to]))
}

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

func clamp(n, lo, hi int) int { return min(max(n, lo), hi) }

// slice10 is s.slice(0, 10) (dates are ASCII).
func slice10(s string) string {
	if len(s) > 10 {
		return s[:10]
	}
	return s
}

// localeCompare approximates String.prototype.localeCompare (ICU root collation) for the text the
// server sorts: letters compare without case first, digits before letters, punctuation first;
// then lowercase before uppercase.
func localeCompare(a, b string) int {
	if a == b {
		return 0
	}
	sa, sb := a, b
	if !isASCII(a) {
		sa = stripMarks(a)
	}
	if !isASCII(b) {
		sb = stripMarks(b)
	}
	// primary: collation keys, compared as they are read (no key slices: sorting calls this a lot)
	i, j := 0, 0
	for i < len(sa) && j < len(sb) {
		ra, na := utf8.DecodeRuneInString(sa[i:])
		rb, nb := utf8.DecodeRuneInString(sb[j:])
		if ka, kb := collationKey(ra), collationKey(rb); ka != kb {
			if ka < kb {
				return -1
			}
			return 1
		}
		i, j = i+na, j+nb
	}
	if i < len(sa) {
		return 1
	}
	if j < len(sb) {
		return -1
	}
	// tie on letters: lowercase first, then accents, then code points
	i, j = 0, 0
	for i < len(a) && j < len(b) {
		ra, na := utf8.DecodeRuneInString(a[i:])
		rb, nb := utf8.DecodeRuneInString(b[j:])
		if ra != rb {
			if unicode.IsLower(ra) && unicode.IsUpper(rb) {
				return -1
			}
			if unicode.IsUpper(ra) && unicode.IsLower(rb) {
				return 1
			}
			if ra < rb {
				return -1
			}
			return 1
		}
		i, j = i+na, j+nb
	}
	switch {
	case i < len(a):
		return 1
	case j < len(b):
		return -1
	}
	return 0
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

func collationKey(r rune) int {
	switch {
	case unicode.IsLetter(r):
		return 0x300000 + int(unicode.ToLower(r))
	case unicode.IsDigit(r):
		return 0x200000 + int(r)
	case unicode.IsSpace(r):
		return 0x100000 + int(r)
	}
	return 0x180000 + int(r)
}

// jsString is String(v) for JSON values.
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		switch {
		case math.IsNaN(x):
			return "NaN"
		case math.IsInf(x, 1):
			return "Infinity"
		case math.IsInf(x, -1):
			return "-Infinity"
		}
		return jsonstore.JSNumber(x)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil && e != jsv.Undefined {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	case *jsv.Obj, map[string]any:
		return "[object Object]"
	}
	if v == jsv.Undefined {
		return "undefined"
	}
	return fmt.Sprint(v)
}

// jsRound is Math.round.
func jsRound(f float64) float64 { return math.Floor(f + 0.5) }

var isoDateTime = regexp.MustCompile(`^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$`)

// parseJSDate is Date.parse for ISO 8601 strings: date-only forms are UTC, date-times without an
// offset are local time. Other forms are not supported (ok is false).
func parseJSDate(s string) (time.Time, bool) {
	m := isoDateTime.FindStringSubmatch(s)
	if m == nil {
		return time.Time{}, false
	}
	num := func(x string, def int) int {
		if x == "" {
			return def
		}
		n, _ := strconv.Atoi(x)
		return n
	}
	y, mo, d := num(m[1], 0), num(m[2], 1), num(m[3], 1)
	h, mi, sec := num(m[4], 0), num(m[5], 0), num(m[6], 0)
	ms := 0
	if m[7] != "" {
		frac := (m[7] + "000")[:3]
		ms = num(frac, 0)
	}
	if mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59 || sec > 59 || (h == 24 && (mi > 0 || sec > 0 || ms > 0)) {
		return time.Time{}, false
	}
	loc := time.UTC
	if m[4] != "" && m[8] == "" {
		loc = time.Local
	}
	t := time.Date(y, time.Month(mo), d, h, mi, sec, ms*1e6, loc)
	if m[8] != "" && m[8] != "Z" {
		sign := 1
		if m[8][0] == '-' {
			sign = -1
		}
		oh, om := num(m[8][1:3], 0), num(m[8][4:6], 0)
		t = t.Add(-time.Duration(sign*(oh*60+om)) * time.Minute)
	}
	return t, true
}
