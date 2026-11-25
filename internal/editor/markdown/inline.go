// Package markdown converts between Markdown and the editor's block document. Notes stay Markdown files on
// disk; the block tree exists only while a note is open, as in AppFlowy's Markdown import/export.
package markdown

import (
	"reflect"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/reeper316099/classpad/internal/editor/doc"
)

// Inline attribute names (AppFlowy's, plus wiki and formula for Classpad's [[links]] and $math$).
const (
	Bold      = "bold"
	Italic    = "italic"
	Strike    = "strikethrough"
	Underline = "underline"
	Code      = "code"
	Href      = "href"
	Wiki      = "wiki"
	Formula   = "formula"
)

// ParseInline turns one block's Markdown text into a Delta.
func ParseInline(s string) doc.Delta {
	var d doc.Delta
	parseInto(&d, s, nil)
	return d
}

func with(base doc.Attrs, k string, v any) doc.Attrs {
	out := doc.Attrs{}
	for a, b := range base {
		out[a] = b
	}
	out[k] = v
	return out
}

type emph struct {
	delim string
	attr  string
}

var emphases = []emph{{"**", Bold}, {"__", Bold}, {"~~", Strike}, {"*", Italic}, {"_", Italic}}

func isSpace(r rune) bool { return r == ' ' || r == '\t' || r == '\n' }

// parseInto appends the delta for s with base formatting.
func parseInto(d *doc.Delta, s string, base doc.Attrs) {
	var plain strings.Builder
	flush := func() {
		if plain.Len() > 0 {
			*d = d.Insert(plain.String(), base)
			plain.Reset()
		}
	}
	i := 0
	for i < len(s) {
		c := s[i]
		rest := s[i:]
		switch {
		case c == '\\' && i+1 < len(s) && strings.ContainsRune("\\`*_{}[]()#+-.!|~$<>", rune(s[i+1])):
			plain.WriteByte(s[i+1])
			i += 2
			continue
		case c == '`':
			n := run(rest, '`')
			fence := rest[:n]
			if end := strings.Index(rest[n:], fence); end >= 0 && run(rest[n+end:], '`') == n {
				body := rest[n : n+end]
				if len(body) > 2 && body[0] == ' ' && body[len(body)-1] == ' ' && strings.Trim(body, " ") != "" {
					body = body[1 : len(body)-1]
				}
				flush()
				*d = d.Insert(body, with(base, Code, true))
				i += n + end + n
				continue
			}
			plain.WriteString(fence)
			i += n
			continue
		case c == '$' && !strings.HasPrefix(rest, "$$"):
			if end := closingDollar(rest); end > 0 {
				flush()
				*d = d.Insert(doc.Embed, with(base, Formula, rest[1:end]))
				i += end + 1
				continue
			}
		case strings.HasPrefix(rest, "[["):
			if end := strings.Index(rest, "]]"); end > 2 && !strings.ContainsAny(rest[2:end], "[]\n") {
				flush()
				target := rest[2:end]
				*d = d.Insert(target, with(base, Wiki, true))
				i += end + 2
				continue
			}
		case c == '[':
			if text, href, n, ok := link(rest); ok {
				flush()
				parseInto(d, text, with(base, Href, href))
				i += n
				continue
			}
		case strings.HasPrefix(rest, "<u>"):
			if end := strings.Index(rest, "</u>"); end > 3 {
				flush()
				parseInto(d, rest[3:end], with(base, Underline, true))
				i += end + 4
				continue
			}
		}
		if e, inner, n, ok := emphasis(s, i); ok && base[e.attr] == nil {
			flush()
			parseInto(d, inner, with(base, e.attr, true))
			i += n
			continue
		}
		r, w := utf8.DecodeRuneInString(rest)
		plain.WriteRune(r)
		i += w
	}
	flush()
}

func run(s string, b byte) int {
	n := 0
	for n < len(s) && s[n] == b {
		n++
	}
	return n
}

// closingDollar finds the end of $math$: content not starting or ending with a space, not followed by a digit.
func closingDollar(s string) int {
	if len(s) < 3 || s[1] == ' ' {
		return -1
	}
	for j := 2; j < len(s); j++ {
		switch s[j] {
		case '\\':
			j++
		case '\n':
			return -1
		case '$':
			if s[j-1] == ' ' || (j+1 < len(s) && s[j+1] >= '0' && s[j+1] <= '9') {
				return -1
			}
			return j
		}
	}
	return -1
}

// link parses [text](href) at the start of s.
func link(s string) (text, href string, n int, ok bool) {
	depth := 0
	for j := 0; j < len(s); j++ {
		switch s[j] {
		case '\\':
			j++
		case '[':
			depth++
		case ']':
			depth--
			if depth == 0 {
				if j+1 < len(s) && s[j+1] == '(' {
					end := strings.IndexByte(s[j+2:], ')')
					if end < 0 {
						return "", "", 0, false
					}
					h := strings.TrimSpace(s[j+2 : j+2+end])
					if strings.ContainsAny(h, " \n") {
						return "", "", 0, false
					}
					return s[1:j], h, j + 3 + end, true
				}
				return "", "", 0, false
			}
		case '\n':
			return "", "", 0, false
		}
	}
	return "", "", 0, false
}

// emphasis matches **bold**, *italic*, _italic_, __bold__ and ~~strike~~ starting at s[i].
func emphasis(s string, i int) (emph, string, int, bool) {
	rest := s[i:]
	for _, e := range emphases {
		if !strings.HasPrefix(rest, e.delim) {
			continue
		}
		after := rest[len(e.delim):]
		if after == "" {
			continue
		}
		r, _ := utf8.DecodeRuneInString(after)
		if isSpace(r) || (len(e.delim) == 1 && strings.HasPrefix(after, e.delim)) {
			continue
		}
		if e.delim[0] == '_' && i > 0 {
			p, _ := utf8.DecodeLastRuneInString(s[:i])
			if unicode.IsLetter(p) || unicode.IsDigit(p) {
				continue
			}
		}
		// find the closer: same delimiter, preceded by a non-space, not part of a longer run
		for j := 1; j+len(e.delim) <= len(after); j++ {
			if after[j-1] == '\\' {
				continue
			}
			if after[j-1] == '`' {
				// skip code spans so `*` inside code never closes emphasis
				if k := strings.IndexByte(after[j:], '`'); k >= 0 {
					j += k
					continue
				}
			}
			if !strings.HasPrefix(after[j:], e.delim) {
				continue
			}
			pr, _ := utf8.DecodeLastRuneInString(after[:j])
			if isSpace(pr) {
				continue
			}
			if len(e.delim) == 1 && strings.HasPrefix(after[j+1:], e.delim) && e.delim != "_" {
				// "**" is a different delimiter; let `*a **b** c*` close at the single star
				if j+2 <= len(after) && (j+2 == len(after) || after[j+2] != '*') {
					continue
				}
			}
			if e.delim[0] == '_' && j+len(e.delim) < len(after) {
				nr, _ := utf8.DecodeRuneInString(after[j+len(e.delim):])
				if unicode.IsLetter(nr) || unicode.IsDigit(nr) {
					continue
				}
			}
			return e, after[:j], len(e.delim)*2 + j, true
		}
	}
	return emph{}, "", 0, false
}

// marker order: outermost first. Code is handled per run as it can't contain other formatting.
var markerOrder = []struct{ attr, open, close string }{
	{Bold, "**", "**"},
	{Italic, "*", "*"},
	{Strike, "~~", "~~"},
	{Underline, "<u>", "</u>"},
}

// RenderInline turns a Delta back into Markdown. Plain text is escaped only where it would otherwise read
// as formatting, so ordinary text such as "$5" or snake_case comes back unchanged.
func RenderInline(d doc.Delta) string {
	out := render(d, false)
	if reflect.DeepEqual(normalize(ParseInline(out)), normalize(d)) {
		return out
	}
	return render(d, true)
}

func normalize(d doc.Delta) doc.Delta {
	var out doc.Delta
	for _, o := range d {
		a := doc.Attrs{}
		for k, v := range o.Attrs {
			if v != nil && v != false {
				a[k] = v
			}
		}
		if len(a) == 0 {
			a = nil
		}
		out = out.Insert(o.Insert, a)
	}
	return out
}

func escapeText(s string) string {
	var b strings.Builder
	for _, r := range s {
		if strings.ContainsRune("\\`*_[]$~<", r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

func render(d doc.Delta, escape bool) string {
	var b strings.Builder
	var open []string // attrs currently open, outermost first
	curHref := ""
	closeTo := func(n int) {
		// move trailing spaces outside the closing markers
		s := b.String()
		trimmed := strings.TrimRight(s, " ")
		spaces := s[len(trimmed):]
		if len(open) > n {
			b.Reset()
			b.WriteString(trimmed)
			for k := len(open) - 1; k >= n; k-- {
				for _, m := range markerOrder {
					if m.attr == open[k] {
						b.WriteString(m.close)
					}
				}
			}
			b.WriteString(spaces)
			open = open[:n]
		}
	}
	closeLink := func() {
		if curHref != "" {
			closeTo(0)
			b.WriteString("](" + curHref + ")")
			curHref = ""
		}
	}
	for _, o := range d {
		text := o.Insert
		if f, ok := o.Attrs[Formula].(string); ok && text == doc.Embed {
			closeLink()
			closeTo(0)
			b.WriteString("$" + f + "$")
			continue
		}
		href, _ := o.Attrs[Href].(string)
		if href != curHref {
			closeLink()
			closeTo(0)
			if href != "" {
				b.WriteString("[")
				curHref = href
			}
		}
		var want []string
		for _, m := range markerOrder {
			if v, ok := o.Attrs[m.attr]; ok && v != nil && v != false {
				want = append(want, m.attr)
			}
		}
		// keep the longest common prefix of open markers, close the rest
		keep := 0
		for keep < len(open) && keep < len(want) && open[keep] == want[keep] {
			keep++
		}
		closeTo(keep)
		lead := ""
		if keep < len(want) {
			t := strings.TrimLeft(text, " ")
			lead, text = text[:len(text)-len(t)], t
		}
		b.WriteString(lead)
		for _, a := range want[keep:] {
			for _, m := range markerOrder {
				if m.attr == a {
					b.WriteString(m.open)
				}
			}
		}
		open = want
		switch {
		case o.Attrs[Code] == true:
			n := 1
			for strings.Contains(text, strings.Repeat("`", n)) {
				n++
			}
			f := strings.Repeat("`", n)
			if strings.HasPrefix(text, "`") || strings.HasSuffix(text, "`") {
				b.WriteString(f + " " + text + " " + f)
			} else {
				b.WriteString(f + text + f)
			}
		case o.Attrs[Wiki] == true:
			b.WriteString("[[" + text + "]]")
		case escape:
			b.WriteString(escapeText(text))
		default:
			b.WriteString(text)
		}
	}
	closeLink()
	closeTo(0)
	return b.String()
}
