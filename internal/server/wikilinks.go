package server

import (
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/reeper316099/classpad/internal/jsv"
)

func isLineTerm(r rune) bool { return r == '\n' || r == '\r' || r == 0x2028 || r == 0x2029 }

// atLineStart is the multiline ^ of a JavaScript regex.
func atLineStart(s string, i int) bool {
	if i == 0 {
		return true
	}
	r, _ := utf8.DecodeLastRuneInString(s[:i])
	return isLineTerm(r)
}

// atLineEnd is the multiline $ of a JavaScript regex.
func atLineEnd(s string, i int) bool {
	if i == len(s) {
		return true
	}
	r, _ := utf8.DecodeRuneInString(s[i:])
	return isLineTerm(r)
}

// replaceFences is s.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, fn); RE2 has no
// backreferences, so the match is done by hand with the same (lazy, leftmost) semantics.
func replaceFences(s string, fn func(string) string) string {
	var b strings.Builder
	last := 0
	for p := 0; p < len(s); {
		if end, ok := fenceAt(s, p); ok {
			b.WriteString(s[last:p])
			b.WriteString(fn(s[p:end]))
			last, p = end, end
			continue
		}
		// the next candidate is the next line start
		q := p
		for q < len(s) {
			r, n := utf8.DecodeRuneInString(s[q:])
			q += n
			if isLineTerm(r) {
				break
			}
		}
		p = q
	}
	if last == 0 {
		return s
	}
	b.WriteString(s[last:])
	return b.String()
}

func fenceAt(s string, p int) (int, bool) {
	if !atLineStart(s, p) || !(strings.HasPrefix(s[p:], "```") || strings.HasPrefix(s[p:], "~~~")) {
		return 0, false
	}
	fence := s[p : p+3]
	nl := strings.IndexByte(s[p+3:], '\n')
	if nl < 0 {
		return 0, false
	}
	for q := p + 3 + nl + 1; q <= len(s); q++ {
		if !atLineStart(s, q) || !strings.HasPrefix(s[q:], fence) {
			continue
		}
		k := q + 3
		for k < len(s) && (s[k] == ' ' || s[k] == '\t') {
			k++
		}
		if atLineEnd(s, k) {
			return k, true
		}
	}
	return 0, false
}

// WikiLink is a [[Title]], [[Title|alias]] or [[Title#Heading]] link; Index is in UTF-16 units.
type WikiLink struct {
	Raw     string
	Target  string
	Heading *string
	Alias   *string
	Index   int
}

var (
	reWikiLink   = regexp.MustCompile(`\[\[([^\[\]|#\n]+?)(?:#([^\[\]|\n]+?))?(?:\|([^\[\]\n]+?))?\]\]`)
	reInlineCode = regexp.MustCompile("`[^`\\n]*`")
)

// blankKeepUTF16 is s.replace(/[^\n]/g, ' '): one space per UTF-16 unit, so indices stay aligned.
func blankKeepUTF16(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '\n':
			b.WriteByte('\n')
		case r >= 0x10000:
			b.WriteString("  ")
		default:
			b.WriteByte(' ')
		}
	}
	return b.String()
}

func maskCode(md string) string {
	return reInlineCode.ReplaceAllStringFunc(replaceFences(md, blankKeepUTF16), blankKeepUTF16)
}

// ExtractWikiLinks finds the links outside code.
func ExtractWikiLinks(md string) []WikiLink {
	masked := maskCode(md)
	var out []WikiLink
	for _, m := range reWikiLink.FindAllStringSubmatchIndex(masked, -1) {
		l := WikiLink{Raw: masked[m[0]:m[1]], Target: jsTrim(masked[m[2]:m[3]]), Index: utf16Len(masked[:m[0]])}
		if m[4] >= 0 {
			h := jsTrim(masked[m[4]:m[5]])
			l.Heading = &h
		}
		if m[6] >= 0 {
			a := jsTrim(masked[m[6]:m[7]])
			l.Alias = &a
		}
		out = append(out, l)
	}
	return out
}

// NormalizeTitle is normalizeTitle: no accents, lowercase, single spaces, trimmed.
func NormalizeTitle(s string) string { return jsTrim(collapseSpace(jsLower(stripMarks(s)))) }

// ResolveLink finds the note a [[link]] points at: same-class notes win ties, then the most
// recently edited.
func ResolveLink(notes []*jsv.Obj, target, fromClassID string) *jsv.Obj {
	want := NormalizeTitle(target)
	var matches []*jsv.Obj
	for _, n := range notes {
		if NormalizeTitle(n.Str("title")) == want {
			matches = append(matches, n)
		}
	}
	same := func(n *jsv.Obj) int {
		if fromClassID != "" && optStr(n, "classId") == fromClassID {
			return 1
		}
		return 0
	}
	sort.SliceStable(matches, func(i, j int) bool {
		a, b := matches[i], matches[j]
		if d := same(b) - same(a); d != 0 {
			return d < 0
		}
		return localeCompare(b.Str("updatedAt"), a.Str("updatedAt")) < 0
	})
	if len(matches) == 0 {
		return nil
	}
	return matches[0]
}

// BacklinksFor lists the notes whose [[links]] resolve to note (never the note itself).
func BacklinksFor(notes []*jsv.Obj, note *jsv.Obj) []any {
	type row struct {
		title string
		o     *jsv.Obj
	}
	var rows []row
	for _, other := range notes {
		if other.Str("id") == note.Str("id") {
			continue
		}
		md := other.Str("markdown")
		for _, link := range ExtractWikiLinks(md) {
			r := ResolveLink(notes, link.Target, optStr(other, "classId"))
			if r == nil || r.Str("id") != note.Str("id") {
				continue
			}
			from := max(0, link.Index-50)
			snippet := jsTrim(collapseSpace(utf16Slice(md, from, link.Index+utf16Len(link.Raw)+50)))
			o := jsv.O("id", other.Get("id"), "title", other.Get("title"))
			copyDefined(o, other, "classId")
			rows = append(rows, row{other.Str("title"), o.Set("snippet", snippet)})
			break
		}
	}
	sort.SliceStable(rows, func(i, j int) bool { return localeCompare(rows[i].title, rows[j].title) < 0 })
	out := make([]any, len(rows))
	for i, r := range rows {
		out[i] = r.o
	}
	return out
}
