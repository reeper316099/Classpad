package jsonstore

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// ParseError is a JSON syntax error at a byte position.
type ParseError struct {
	Pos int
	Msg string
}

func (e *ParseError) Error() string { return fmt.Sprintf("%s at position %d", e.Msg, e.Pos) }

// ParseJSON parses strict JSON like JSON.parse: numbers become float64, objects map[string]any
// (the last duplicate key wins), arrays []any.
func ParseJSON(text string) (any, error) {
	p := parser{s: text}
	p.ws()
	v, err := p.value()
	if err != nil {
		return nil, err
	}
	p.ws()
	if p.i < len(p.s) {
		return nil, p.fail("Unexpected non-whitespace character after JSON")
	}
	return v, nil
}

type parser struct {
	s string
	i int
}

func (p *parser) fail(msg string) error { return &ParseError{Pos: p.i, Msg: msg} }

func (p *parser) unexpected() error {
	if p.i >= len(p.s) {
		return p.fail("Unexpected end of JSON input")
	}
	r, _ := utf8.DecodeRuneInString(p.s[p.i:])
	return p.fail(fmt.Sprintf("Unexpected token '%c'", r))
}

func (p *parser) ws() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *parser) value() (any, error) {
	if p.i >= len(p.s) {
		return nil, p.unexpected()
	}
	switch c := p.s[p.i]; {
	case c == '{':
		return p.object()
	case c == '[':
		return p.array()
	case c == '"':
		return p.str()
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	case strings.HasPrefix(p.s[p.i:], "true"):
		p.i += 4
		return true, nil
	case strings.HasPrefix(p.s[p.i:], "false"):
		p.i += 5
		return false, nil
	case strings.HasPrefix(p.s[p.i:], "null"):
		p.i += 4
		return nil, nil
	}
	return nil, p.unexpected()
}

func (p *parser) object() (any, error) {
	p.i++ // {
	m := map[string]any{}
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == '}' {
		p.i++
		return m, nil
	}
	for {
		if p.i >= len(p.s) || p.s[p.i] != '"' {
			return nil, p.unexpected()
		}
		k, err := p.str()
		if err != nil {
			return nil, err
		}
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != ':' {
			return nil, p.unexpected()
		}
		p.i++
		p.ws()
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		m[k] = v
		p.ws()
		if p.i >= len(p.s) {
			return nil, p.unexpected()
		}
		switch p.s[p.i] {
		case ',':
			p.i++
			p.ws()
		case '}':
			p.i++
			return m, nil
		default:
			return nil, p.unexpected()
		}
	}
}

func (p *parser) array() (any, error) {
	p.i++ // [
	a := []any{}
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == ']' {
		p.i++
		return a, nil
	}
	for {
		p.ws()
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		a = append(a, v)
		p.ws()
		if p.i >= len(p.s) {
			return nil, p.unexpected()
		}
		switch p.s[p.i] {
		case ',':
			p.i++
		case ']':
			p.i++
			return a, nil
		default:
			return nil, p.unexpected()
		}
	}
}

func (p *parser) number() (any, error) {
	start := p.i
	digits := func() int {
		n := 0
		for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
			p.i++
			n++
		}
		return n
	}
	if p.s[p.i] == '-' {
		p.i++
	}
	if p.i < len(p.s) && p.s[p.i] == '0' {
		p.i++
	} else if digits() == 0 {
		return nil, p.unexpected()
	}
	if p.i < len(p.s) && p.s[p.i] == '.' {
		p.i++
		if digits() == 0 {
			return nil, p.unexpected()
		}
	}
	if p.i < len(p.s) && (p.s[p.i] == 'e' || p.s[p.i] == 'E') {
		p.i++
		if p.i < len(p.s) && (p.s[p.i] == '+' || p.s[p.i] == '-') {
			p.i++
		}
		if digits() == 0 {
			return nil, p.unexpected()
		}
	}
	f, err := strconv.ParseFloat(p.s[start:p.i], 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return nil, &ParseError{Pos: start, Msg: "bad number"}
	}
	return f, nil // out of range is ±Inf (written back as null), like JavaScript
}

func (p *parser) str() (string, error) {
	p.i++ // opening quote
	start := p.i
	// Fast path: no escapes.
	for p.i < len(p.s) {
		c := p.s[p.i]
		if c == '"' {
			s := p.s[start:p.i]
			p.i++
			return s, nil
		}
		if c == '\\' {
			break
		}
		if c < 0x20 {
			return "", p.fail("Bad control character in string literal")
		}
		p.i++
	}
	var b strings.Builder
	b.WriteString(p.s[start:p.i])
	for p.i < len(p.s) {
		c := p.s[p.i]
		switch {
		case c == '"':
			p.i++
			return b.String(), nil
		case c < 0x20:
			return "", p.fail("Bad control character in string literal")
		case c != '\\':
			b.WriteByte(c)
			p.i++
			continue
		}
		p.i++ // backslash
		if p.i >= len(p.s) {
			break
		}
		e := p.s[p.i]
		p.i++
		switch e {
		case '"', '\\', '/':
			b.WriteByte(e)
		case 'b':
			b.WriteByte('\b')
		case 'f':
			b.WriteByte('\f')
		case 'n':
			b.WriteByte('\n')
		case 'r':
			b.WriteByte('\r')
		case 't':
			b.WriteByte('\t')
		case 'u':
			r, ok := p.hex4()
			if !ok {
				return "", p.fail("Bad Unicode escape")
			}
			if utf16.IsSurrogate(r) && strings.HasPrefix(p.s[p.i:], `\u`) {
				save := p.i
				p.i += 2
				if r2, ok := p.hex4(); ok && utf16.DecodeRune(r, r2) != utf8.RuneError {
					r = utf16.DecodeRune(r, r2)
				} else {
					p.i = save
				}
			}
			b.WriteRune(r) // a lone surrogate can't be held in Go; it becomes U+FFFD
		default:
			p.i--
			return "", p.fail("Bad escaped character")
		}
	}
	return "", p.fail("Unterminated string in JSON")
}

func (p *parser) hex4() (rune, bool) {
	if p.i+4 > len(p.s) {
		return 0, false
	}
	n, err := strconv.ParseUint(p.s[p.i:p.i+4], 16, 32)
	if err != nil {
		return 0, false
	}
	p.i += 4
	return rune(n), true
}
