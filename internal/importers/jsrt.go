package importers

import (
	"errors"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// Helpers that behave like the JavaScript built-ins the TypeScript importers use, so both give the
// same result for the same file.

// jsSpaceClass is JavaScript's \s (WhiteSpace and LineTerminator), for use inside [...].
const jsSpaceClass = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// jsTrim is String.prototype.trim.
func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// jsRe compiles a JavaScript regexp source (no flags other than an optional "(?i)" prefix) as Go:
// \s and \S become JavaScript's whitespace, and "." stops at all four JavaScript line terminators.
func jsRe(src string) *regexp.Regexp {
	var b strings.Builder
	inClass := false
	for i := 0; i < len(src); i++ {
		c := src[i]
		switch {
		case c == '\\' && i+1 < len(src):
			n := src[i+1]
			i++
			switch {
			case n == 's' && inClass:
				b.WriteString(jsSpaceClass)
			case n == 's':
				b.WriteString("[" + jsSpaceClass + "]")
			case n == 'S' && !inClass:
				b.WriteString("[^" + jsSpaceClass + "]")
			default:
				b.WriteByte('\\')
				b.WriteByte(n)
			}
		case c == '[' && !inClass:
			inClass = true
			b.WriteByte(c)
			if i+1 < len(src) && src[i+1] == '^' {
				b.WriteByte('^')
				i++
			}
			if i+1 < len(src) && src[i+1] == ']' { // a literal ] first in the class
				b.WriteString(`\]`)
				i++
			}
		case c == ']' && inClass:
			inClass = false
			b.WriteByte(c)
		case c == '.' && !inClass:
			b.WriteString(`[^\n\r\x{2028}\x{2029}]`)
		default:
			b.WriteByte(c)
		}
	}
	return regexp.MustCompile(b.String())
}

// jsNumber is Number(string): NaN when it isn't a number.
func jsNumber(s string) float64 {
	s = jsTrim(s)
	if s == "" {
		return 0
	}
	switch s {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			n, err := strconv.ParseUint(s[2:], base, 64)
			if err != nil {
				// Too big for 64 bits but valid digits: JavaScript still reads it (as a float).
				if f, ok := bigIntFloat(s[2:], base); ok {
					return f
				}
				return math.NaN()
			}
			return float64(n)
		}
	}
	if !jsDecimal.MatchString(s) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return math.NaN()
	}
	return f // overflow gives ±Inf, like JavaScript
}

var jsDecimal = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

func bigIntFloat(digits string, base int) (float64, bool) {
	f := 0.0
	for _, c := range digits {
		d, err := strconv.ParseUint(string(c), base, 8)
		if err != nil {
			return 0, false
		}
		f = f*float64(base) + float64(d)
	}
	return f, true
}

func isFinite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// decodeURIComponent fails like JavaScript's on a bad escape or bytes that aren't UTF-8.
func decodeURIComponent(s string) (string, bool) {
	if !strings.Contains(s, "%") {
		return s, true
	}
	out, err := url.PathUnescape(s)
	if err != nil || !utf8.ValidString(out) {
		return s, false
	}
	return out, true
}

// encodeURI escapes everything except letters, digits and ;,/?:@&=+$-_.!~*'()#
func encodeURI(s string) string {
	const keep = ";,/?:@&=+$-_.!~*'()#"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < 0x80 && (c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte(keep, c) >= 0) {
			b.WriteByte(c)
			continue
		}
		const hex = "0123456789ABCDEF"
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0xF])
	}
	return b.String()
}

// utf16Less orders strings by UTF-16 code units, like Array.prototype.sort.
func utf16Less(a, b string) bool {
	n := min(len(a), len(b))
	i := 0
	for i < n && a[i] == b[i] {
		i++
	}
	if i == n {
		return len(a) < len(b)
	}
	for i > 0 && !utf8.RuneStart(a[i]) {
		i--
	}
	ra, _ := utf8.DecodeRuneInString(a[i:])
	rb, _ := utf8.DecodeRuneInString(b[i:])
	return utf16Key(ra) < utf16Key(rb)
}

func utf16Key(r rune) uint32 {
	if r < 0x10000 {
		return uint32(r) << 16
	}
	r -= 0x10000
	return uint32(0xD800+(r>>10))<<16 | uint32(0xDC00+(r&0x3FF))
}

// utf16Len is a JavaScript string's length.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// jsSlice is s.slice(0, n) for a JavaScript string (n in UTF-16 units).
func jsSlice(s string, n int) string {
	units := 0
	for i, r := range s {
		w := utf16.RuneLen(r)
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}

func isLetter(r rune) bool { return unicode.IsLetter(r) }

// padStart2 is String(n).padStart(2, '0').
func padStart2(n int) string {
	s := strconv.Itoa(n)
	if len(s) < 2 {
		return "0" + s
	}
	return s
}

func decodeRune(s string) (rune, int) { return utf8.DecodeRuneInString(s) }
