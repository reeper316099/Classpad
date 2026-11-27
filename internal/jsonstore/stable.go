package jsonstore

import (
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// StableStringify writes a value as deterministic pretty JSON, byte for byte what the TypeScript
// store writes (JSON.stringify of the value with sorted keys, 2-space indent, trailing newline):
// keys in the order a JavaScript object keeps them (array-index keys by number, then the rest
// sorted by UTF-16 code units), numbers in JavaScript's format, and only the escapes
// JSON.stringify uses. Values are what ParseJSON returns (or anything encoding/json can turn
// into that).
func StableStringify(v any) (string, error) {
	norm, err := normalize(v)
	if err != nil {
		return "", err
	}
	w := writer{buf: make([]byte, 0, 4096)}
	w.value(norm, 0)
	w.buf = append(w.buf, '\n')
	return string(w.buf), nil
}

// normalize turns Go values (structs, typed maps and slices) into the plain JSON shapes.
func normalize(v any) (any, error) {
	if plainJSON(v) {
		return v, nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return ParseJSON(string(b))
}

// plainJSON reports whether v is already made only of the shapes ParseJSON returns.
func plainJSON(v any) bool {
	switch x := v.(type) {
	case nil, bool, float64, string:
		return true
	case map[string]any:
		for _, e := range x {
			if !plainJSON(e) {
				return false
			}
		}
		return true
	case []any:
		for _, e := range x {
			if !plainJSON(e) {
				return false
			}
		}
		return true
	}
	return false
}

type writer struct{ buf []byte }

const spaces = "                                                                "

func (w *writer) indent(n int) {
	w.buf = append(w.buf, '\n')
	for n > len(spaces) {
		w.buf = append(w.buf, spaces...)
		n -= len(spaces)
	}
	w.buf = append(w.buf, spaces[:n]...)
}

func (w *writer) value(v any, depth int) {
	switch x := v.(type) {
	case nil:
		w.buf = append(w.buf, "null"...)
	case bool:
		w.buf = strconv.AppendBool(w.buf, x)
	case float64:
		w.buf = appendJSNumber(w.buf, x)
	case string:
		w.str(x)
	case []any:
		if len(x) == 0 {
			w.buf = append(w.buf, "[]"...)
			return
		}
		w.buf = append(w.buf, '[')
		for i, e := range x {
			if i > 0 {
				w.buf = append(w.buf, ',')
			}
			w.indent(2 * (depth + 1))
			w.value(e, depth+1)
		}
		w.indent(2 * depth)
		w.buf = append(w.buf, ']')
	case map[string]any:
		if len(x) == 0 {
			w.buf = append(w.buf, "{}"...)
			return
		}
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return keyLess(keys[i], keys[j]) })
		w.buf = append(w.buf, '{')
		for i, k := range keys {
			if i > 0 {
				w.buf = append(w.buf, ',')
			}
			w.indent(2 * (depth + 1))
			w.str(k)
			w.buf = append(w.buf, ':', ' ')
			w.value(x[k], depth+1)
		}
		w.indent(2 * depth)
		w.buf = append(w.buf, '}')
	default:
		panic("jsonstore: not a JSON value")
	}
}

// keyLess is the order JSON.stringify writes the keys of a sorted object in: JavaScript objects
// list array-index keys ("0", "7", "42") first, by number, then the other keys in the order they
// were added, which the TypeScript store makes sorted (UTF-16 order).
func keyLess(a, b string) bool {
	ia, aIdx := arrayIndex(a)
	ib, bIdx := arrayIndex(b)
	switch {
	case aIdx && bIdx:
		return ia < ib
	case aIdx != bIdx:
		return aIdx
	}
	return utf16Less(a, b)
}

// arrayIndex reports whether k is a canonical array index (0 … 2³²−2, no leading zeros).
func arrayIndex(k string) (uint64, bool) {
	if k == "" || k[0] < '0' || k[0] > '9' || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return 0, false
	}
	var n uint64
	for i := 0; i < len(k); i++ {
		c := k[i]
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + uint64(c-'0')
	}
	return n, n < 1<<32-1
}

// utf16Less orders strings by UTF-16 code units, like JavaScript's default sort. It differs from
// byte order only for characters above U+FFFF against U+E000–U+FFFF.
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

// utf16Key packs a character's first and second UTF-16 code units for comparison.
func utf16Key(r rune) uint32 {
	if r < 0x10000 {
		return uint32(r) << 16
	}
	r -= 0x10000
	return uint32(0xD800+(r>>10))<<16 | uint32(0xDC00+(r&0x3FF))
}

// str quotes like JSON.stringify: escapes ", \ and control characters only.
func (w *writer) str(s string) {
	w.buf = append(w.buf, '"')
	start := 0
	for i := 0; i < len(s); {
		c := s[i]
		if c >= 0x80 {
			r, size := utf8.DecodeRuneInString(s[i:])
			if r == utf8.RuneError && size == 1 {
				// Not UTF-8 (can't come from JavaScript): write the replacement character.
				w.buf = append(w.buf, s[start:i]...)
				w.buf = append(w.buf, "�"...)
				start = i + 1
			}
			i += size
			continue
		}
		if c >= 0x20 && c != '"' && c != '\\' {
			i++
			continue
		}
		w.buf = append(w.buf, s[start:i]...)
		switch c {
		case '"':
			w.buf = append(w.buf, '\\', '"')
		case '\\':
			w.buf = append(w.buf, '\\', '\\')
		case '\b':
			w.buf = append(w.buf, '\\', 'b')
		case '\f':
			w.buf = append(w.buf, '\\', 'f')
		case '\n':
			w.buf = append(w.buf, '\\', 'n')
		case '\r':
			w.buf = append(w.buf, '\\', 'r')
		case '\t':
			w.buf = append(w.buf, '\\', 't')
		default:
			const hex = "0123456789abcdef"
			w.buf = append(w.buf, '\\', 'u', '0', '0', hex[c>>4], hex[c&0xF])
		}
		i++
		start = i
	}
	w.buf = append(w.buf, s[start:]...)
	w.buf = append(w.buf, '"')
}

// JSNumber formats a number exactly as JavaScript's String(n) does.
func JSNumber(f float64) string { return string(appendJSNumber(nil, f)) }

func appendJSNumber(b []byte, f float64) []byte {
	switch a := math.Abs(f); {
	case math.IsNaN(f) || math.IsInf(f, 0):
		return append(b, "null"...)
	case f == 0:
		return append(b, '0') // also -0
	case a >= 1e-6 && a < 1e21:
		// Plain decimal notation with the shortest digits that round-trip, as JavaScript.
		return strconv.AppendFloat(b, f, 'f', -1, 64)
	}
	// Exponent notation: d.ddde±n, shortest digits.
	s := strconv.FormatFloat(f, 'e', -1, 64) // -d.ddde-07
	mant, exp, _ := strings.Cut(s, "e")
	b = append(b, mant...)
	b = append(b, 'e', exp[0])
	return append(b, strings.TrimLeft(exp[1:], "0")...)
}

// jsonErrorLine is the 1-based line of a JSON error, if known.
func jsonErrorLine(text string, err error) int {
	var off int
	var pe *ParseError
	var se *json.SyntaxError
	var ue *json.UnmarshalTypeError
	switch {
	case errors.As(err, &pe):
		off = pe.Pos
	case errors.As(err, &se):
		off = int(se.Offset)
	case errors.As(err, &ue):
		off = int(ue.Offset)
	default:
		return 0
	}
	return strings.Count(text[:min(max(off, 0), len(text))], "\n") + 1
}
