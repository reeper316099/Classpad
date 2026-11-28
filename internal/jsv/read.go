package jsv

import (
	"errors"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

// readValid reads JSON that is already known to be valid (checked by jsonstore.ParseJSON, or written
// by encoding/json) in one pass, keeping object key order. It gives exactly what the token reader
// in encoding/json gives: numbers as float64 (out of range becomes ±Inf), invalid UTF-8 and lone
// surrogates as U+FFFD, and a repeated key keeps its first place and its last value.
func readValid(s string) (any, error) {
	r := reader{s: s}
	r.space()
	v, err := r.value()
	if err != nil {
		return nil, err
	}
	r.space()
	if r.i != len(r.s) {
		return nil, errInvalid
	}
	return v, nil
}

var errInvalid = errors.New("jsv: invalid JSON")

type reader struct {
	s string
	i int
}

func (r *reader) space() {
	for r.i < len(r.s) {
		switch r.s[r.i] {
		case ' ', '\t', '\n', '\r':
			r.i++
		default:
			return
		}
	}
}

func (r *reader) value() (any, error) {
	if r.i >= len(r.s) {
		return nil, errInvalid
	}
	switch c := r.s[r.i]; {
	case c == '{':
		r.i++
		o := NewObj()
		r.space()
		if r.i < len(r.s) && r.s[r.i] == '}' {
			r.i++
			return o, nil
		}
		for {
			r.space()
			if r.i >= len(r.s) || r.s[r.i] != '"' {
				return nil, errInvalid
			}
			k, err := r.str()
			if err != nil {
				return nil, err
			}
			r.space()
			if r.i >= len(r.s) || r.s[r.i] != ':' {
				return nil, errInvalid
			}
			r.i++
			r.space()
			v, err := r.value()
			if err != nil {
				return nil, err
			}
			o.Set(k, v)
			r.space()
			if r.i >= len(r.s) {
				return nil, errInvalid
			}
			if r.s[r.i] == ',' {
				r.i++
				continue
			}
			if r.s[r.i] == '}' {
				r.i++
				return o, nil
			}
			return nil, errInvalid
		}
	case c == '[':
		r.i++
		a := []any{}
		r.space()
		if r.i < len(r.s) && r.s[r.i] == ']' {
			r.i++
			return a, nil
		}
		for {
			r.space()
			v, err := r.value()
			if err != nil {
				return nil, err
			}
			a = append(a, v)
			r.space()
			if r.i >= len(r.s) {
				return nil, errInvalid
			}
			if r.s[r.i] == ',' {
				r.i++
				continue
			}
			if r.s[r.i] == ']' {
				r.i++
				return a, nil
			}
			return nil, errInvalid
		}
	case c == '"':
		return r.str()
	case c == 't' && r.lit("true"):
		return true, nil
	case c == 'f' && r.lit("false"):
		return false, nil
	case c == 'n' && r.lit("null"):
		return nil, nil
	case c == '-' || (c >= '0' && c <= '9'):
		start := r.i
		for r.i < len(r.s) {
			switch b := r.s[r.i]; {
			case b >= '0' && b <= '9', b == '-', b == '+', b == '.', b == 'e', b == 'E':
				r.i++
				continue
			}
			break
		}
		f, err := strconv.ParseFloat(r.s[start:r.i], 64)
		if err != nil {
			if ne, ok := err.(*strconv.NumError); ok && ne.Err == strconv.ErrRange {
				return f, nil
			}
			return nil, err
		}
		return f, nil
	}
	return nil, errInvalid
}

func (r *reader) lit(word string) bool {
	if len(r.s)-r.i >= len(word) && r.s[r.i:r.i+len(word)] == word {
		r.i += len(word)
		return true
	}
	return false
}

func hex4(s string) (rune, bool) {
	if len(s) < 4 {
		return 0, false
	}
	var v rune
	for i := 0; i < 4; i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			v = v<<4 | rune(c-'0')
		case c >= 'a' && c <= 'f':
			v = v<<4 | rune(c-'a'+10)
		case c >= 'A' && c <= 'F':
			v = v<<4 | rune(c-'A'+10)
		default:
			return 0, false
		}
	}
	return v, true
}

// str reads a string at r.i (the opening quote).
func (r *reader) str() (string, error) {
	r.i++
	start := r.i
	// fast path: no escapes and plain ASCII
	for r.i < len(r.s) {
		c := r.s[r.i]
		if c == '"' {
			out := r.s[start:r.i]
			r.i++
			return out, nil
		}
		if c == '\\' || c >= utf8.RuneSelf || c < 0x20 {
			break
		}
		r.i++
	}
	buf := make([]byte, 0, r.i-start+16)
	buf = append(buf, r.s[start:r.i]...)
	for r.i < len(r.s) {
		c := r.s[r.i]
		switch {
		case c == '"':
			r.i++
			return string(buf), nil
		case c == '\\':
			if r.i+1 >= len(r.s) {
				return "", errInvalid
			}
			e := r.s[r.i+1]
			r.i += 2
			switch e {
			case '"', '\\', '/':
				buf = append(buf, e)
			case 'b':
				buf = append(buf, '\b')
			case 'f':
				buf = append(buf, '\f')
			case 'n':
				buf = append(buf, '\n')
			case 'r':
				buf = append(buf, '\r')
			case 't':
				buf = append(buf, '\t')
			case 'u':
				u, ok := hex4(r.s[r.i:])
				if !ok {
					return "", errInvalid
				}
				r.i += 4
				if utf16.IsSurrogate(u) {
					// a pair makes one character; a lone half becomes U+FFFD
					if r.i+6 <= len(r.s) && r.s[r.i] == '\\' && r.s[r.i+1] == 'u' {
						if u2, ok := hex4(r.s[r.i+2:]); ok {
							if d := utf16.DecodeRune(u, u2); d != utf8.RuneError {
								buf = utf8.AppendRune(buf, d)
								r.i += 6
								continue
							}
						}
					}
					u = utf8.RuneError
				}
				buf = utf8.AppendRune(buf, u)
			default:
				return "", errInvalid
			}
		case c < utf8.RuneSelf:
			buf = append(buf, c)
			r.i++
		default:
			ch, size := utf8.DecodeRuneInString(r.s[r.i:])
			buf = utf8.AppendRune(buf, ch) // invalid UTF-8 becomes U+FFFD, byte by byte
			r.i += size
		}
	}
	return "", errInvalid
}
