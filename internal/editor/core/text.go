package core

import (
	"maps"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/reeper316099/classpad/internal/editor/doc"
	"github.com/reeper316099/classpad/internal/editor/markdown"
)

// formatting a new character does not inherit from the one before it
var noInherit = []string{markdown.Href, markdown.Wiki, markdown.Formula}

func typingAttrs(n *doc.Node, offset int, pending doc.Attrs) doc.Attrs {
	if n.Type == doc.Code {
		return nil
	}
	a := doc.Attrs{}
	maps.Copy(a, n.Delta.AttrsAt(offset))
	for _, k := range noInherit {
		delete(a, k)
	}
	for k, v := range pending {
		if v == nil || v == false {
			delete(a, k)
		} else {
			a[k] = v
		}
	}
	if len(a) == 0 {
		return nil
	}
	return a
}

// InsertText types text at the caret, replacing any selection, then runs AppFlowy's Markdown shortcuts.
func (s *State) InsertText(text string) {
	if text == "" {
		return
	}
	t := s.tx()
	if !s.Sel.Collapsed() {
		s.deleteSelection(t)
	}
	p := s.Sel.Start.Path
	n := s.Doc.NodeAt(p)
	if n == nil || !doc.HasText(n.Type) {
		s.commit(t, "edit")
		return
	}
	off := s.Sel.Start.Offset
	t.InsertText(p, off, text, typingAttrs(n, off, s.pending))
	t.SetSelection(doc.Caret(p, off+doc.Len16(text)))
	s.commit(t, "type")
	if text == " " || len([]rune(text)) == 1 {
		s.shortcuts(text)
	}
}

var (
	reFenceLine        = regexp.MustCompile("^(?:```|~~~)([\\w+#.-]*)$")
	reNumberedShortcut = regexp.MustCompile(`^(\d{1,9})[.)]$`)
	inlineShortcuts    = []struct {
		re    *regexp.Regexp
		attr  string
		delim int
	}{
		{regexp.MustCompile(`\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$`), markdown.Bold, 2},
		{regexp.MustCompile(`__([^_\s](?:[^_]*[^_\s])?)__$`), markdown.Bold, 2},
		{regexp.MustCompile(`(?:^|[^*])\*([^*\s](?:[^*]*[^*\s])?)\*$`), markdown.Italic, 1},
		{regexp.MustCompile(`(?:^|[^\w_])_([^_\s](?:[^_]*[^_\s])?)_$`), markdown.Italic, 1},
		{regexp.MustCompile("`([^`]+)`$"), markdown.Code, 1},
		{regexp.MustCompile(`~~([^~\s](?:[^~]*[^~\s])?)~~$`), markdown.Strike, 2},
		{regexp.MustCompile(`(?:^|[^~])~([^~\s](?:[^~]*[^~\s])?)~$`), markdown.Strike, 1},
	}
	reFormulaShortcut = regexp.MustCompile(`(?:^|[^$\\])\$([^$\s](?:[^$]*[^$\s])?)\$$`)
	reLinkShortcut    = regexp.MustCompile(`\[([^\]]+)\]\(([^)\s]+)\)$`)
	reWikiShortcut    = regexp.MustCompile(`\[\[([^\[\]]+)\]\]$`)
)

// shortcuts converts Markdown typed at the start of a paragraph (block shortcuts) or closing an inline
// pair (inline shortcuts) as soon as it is complete, the way AppFlowy and Notion do.
func (s *State) shortcuts(typed string) {
	n, p := s.caretNode()
	if n == nil || n.Type == doc.Code {
		return
	}
	off := s.Sel.End.Offset
	before := n.Delta.Slice(0, off).Text()

	if typed == " " && n.Type != doc.Heading {
		prefix := strings.TrimSuffix(before, " ")
		if s.blockShortcut(n, p, prefix) {
			return
		}
	}
	if typed == "-" && before == "---" && n.Type == doc.Paragraph && n.Delta.Len() == 3 {
		s.replaceWithBlock(p, doc.NewNode(doc.Divider, nil, nil))
		return
	}
	s.inlineShortcut(n, p, before, typed)
}

func (s *State) blockShortcut(n *doc.Node, p doc.Path, prefix string) bool {
	var typ string
	var attrs doc.Attrs
	switch {
	case strings.Trim(prefix, "#") == "" && len(prefix) >= 1 && len(prefix) <= 6:
		typ, attrs = doc.Heading, doc.Attrs{doc.AttrLevel: len(prefix)}
	case prefix == "-" || prefix == "*" || prefix == "+":
		typ = doc.Bulleted
	case prefix == "[]" || prefix == "[ ]" || prefix == "-[]" || prefix == "- [ ]":
		typ, attrs = doc.Todo, doc.Attrs{doc.AttrChecked: false}
	case prefix == "[x]" || prefix == "[X]" || prefix == "- [x]":
		typ, attrs = doc.Todo, doc.Attrs{doc.AttrChecked: true}
	case prefix == ">":
		typ, attrs = doc.Toggle, doc.Attrs{doc.AttrLevel: 0, doc.AttrCollapse: false}
	case prefix == "\"" || prefix == "“":
		typ = doc.Quote
	case prefix == "```" || prefix == "~~~":
		typ, attrs = doc.Code, doc.Attrs{doc.AttrLanguage: ""}
	case prefix == "$$":
		s.replaceWithBlock(p, doc.NewNode(doc.MathBlock, doc.Attrs{doc.AttrFormula: ""}, nil))
		return true
	case reNumberedShortcut.MatchString(prefix):
		num, _ := strconv.Atoi(reNumberedShortcut.FindStringSubmatch(prefix)[1])
		typ = doc.Numbered
		if num != 1 {
			attrs = doc.Attrs{doc.AttrNumber: num}
		}
	default:
		return false
	}
	// only plain paragraphs convert, except "[] " in a bullet (a "- " that became a bullet first)
	if n.Type != doc.Paragraph && !(n.Type == doc.Bulleted && typ == doc.Todo) {
		return false
	}
	t := s.tx()
	t.DeleteText(p, 0, doc.Len16(prefix)+1)
	t.SetType(p, typ, attrs)
	t.SetSelection(doc.Caret(p, 0))
	s.commit(t, "edit")
	return true
}

func (s *State) inlineShortcut(n *doc.Node, p doc.Path, before, typed string) {
	off := s.Sel.End.Offset
	t := s.tx()
	switch typed {
	case "$":
		if m := reFormulaShortcut.FindStringSubmatchIndex(before); m != nil {
			formula := before[m[2]:m[3]]
			start := doc.Len16(before[:m[2]]) - 1
			t.ReplaceText(p, start, off-start, doc.Delta{}.Insert(doc.Embed, doc.Attrs{markdown.Formula: formula}))
			t.SetSelection(doc.Caret(p, start+1))
			s.commit(t, "edit")
		}
		return
	case ")":
		if m := reLinkShortcut.FindStringSubmatchIndex(before); m != nil {
			start := doc.Len16(before[:m[0]])
			label := doc.Len16(before[m[2]:m[3]])
			href := before[m[4]:m[5]]
			inner := n.Delta.Slice(start+1, start+1+label)
			var linked doc.Delta
			for _, o := range inner {
				linked = linked.Insert(o.Insert, withAttr(o.Attrs, markdown.Href, href))
			}
			t.ReplaceText(p, start, off-start, linked)
			t.SetSelection(doc.Caret(p, start+label))
			s.commit(t, "edit")
		}
		return
	case "]":
		if m := reWikiShortcut.FindStringSubmatchIndex(before); m != nil {
			start := doc.Len16(before[:m[0]])
			target := before[m[2]:m[3]]
			t.ReplaceText(p, start, off-start, doc.Delta{}.Insert(target, doc.Attrs{markdown.Wiki: true}))
			t.SetSelection(doc.Caret(p, start+doc.Len16(target)))
			s.commit(t, "edit")
		}
		return
	}
	for _, sc := range inlineShortcuts {
		m := sc.re.FindStringSubmatchIndex(before)
		if m == nil {
			continue
		}
		inner := before[m[2]:m[3]]
		delim := sc.delim
		// m[0] may include one guard character before the delimiter; m[2] is where the formatted text starts
		innerStart := doc.Len16(before[:m[2]])
		start := innerStart - delim
		innerLen := doc.Len16(inner)
		t.DeleteText(p, innerStart+innerLen, delim)
		t.DeleteText(p, start, delim)
		t.FormatText(p, start, innerLen, doc.Attrs{sc.attr: true})
		t.SetSelection(doc.Caret(p, start+innerLen))
		s.commit(t, "edit")
		s.pending = doc.Attrs{sc.attr: nil} // typing after the closer is plain again
		return
	}
}

func withAttr(a doc.Attrs, k string, v any) doc.Attrs {
	out := doc.Attrs{}
	maps.Copy(out, a)
	out[k] = v
	return out
}

// replaceWithBlock swaps the caret's paragraph for a non-text block and puts the caret in a paragraph after it.
func (s *State) replaceWithBlock(p doc.Path, n *doc.Node) {
	t := s.tx()
	t.DeleteNodes(p, 1)
	t.InsertNodes(p, n)
	if doc.HasText(n.Type) {
		t.SetSelection(doc.Caret(p, 0))
	} else {
		next := p.Next()
		if m := s.Doc.NodeAt(next); m == nil || !doc.HasText(m.Type) {
			t.InsertNodes(next, doc.Text(doc.Paragraph, "", nil))
		}
		t.SetSelection(doc.Caret(next, 0))
	}
	s.commit(t, "edit")
}

// SyncText replaces a block's text with what the page now shows (after IME composition, spellcheck or
// autocorrect changed the DOM directly). Only the changed middle is replaced, keeping formatting around it.
func (s *State) SyncText(p doc.Path, text string, caret int) {
	n := s.Doc.NodeAt(p)
	if n == nil || !doc.HasText(n.Type) {
		return
	}
	old := utf16.Encode([]rune(n.Delta.Text()))
	neu := utf16.Encode([]rune(text))
	pre := 0
	for pre < len(old) && pre < len(neu) && old[pre] == neu[pre] {
		pre++
	}
	suf := 0
	for suf < len(old)-pre && suf < len(neu)-pre && old[len(old)-1-suf] == neu[len(neu)-1-suf] {
		suf++
	}
	t := s.tx()
	if pre < len(old)-suf || pre < len(neu)-suf {
		mid := string(utf16.Decode(neu[pre : len(neu)-suf]))
		var ins doc.Delta
		if mid != "" {
			ins = ins.Insert(mid, typingAttrs(n, pre, nil))
		}
		t.ReplaceText(p, pre, len(old)-suf-pre, ins)
	}
	t.SetSelection(doc.Caret(p, caret))
	s.commit(t, "type")
}

// ToggleMark turns bold/italic/… on or off for the selection, or for the next typed text at a caret.
func (s *State) ToggleMark(mark string) {
	sel := s.Sel.Normalized()
	if sel.Collapsed() {
		n, _ := s.caretNode()
		if n == nil {
			return
		}
		cur := typingAttrs(n, sel.Start.Offset, s.pending)
		if s.pending == nil {
			s.pending = doc.Attrs{}
		}
		if cur[mark] != nil {
			s.pending[mark] = nil
		} else {
			s.pending[mark] = true
		}
		return
	}
	on := !s.allHave(mark)
	var v any
	if on {
		v = true
	}
	s.formatSelection(doc.Attrs{mark: v})
}

// SetLink sets (or with "" removes) a link on the selection.
func (s *State) SetLink(href string) {
	var v any
	if href != "" {
		v = href
	}
	s.formatSelection(doc.Attrs{markdown.Href: v})
}

func (s *State) allHave(mark string) bool {
	all, any := true, false
	s.eachRange(func(n *doc.Node, p doc.Path, from, to int) {
		if to <= from {
			return
		}
		any = true
		if n.Delta.CommonAttrs(from, to)[mark] == nil {
			all = false
		}
	})
	return any && all
}

// eachRange visits every text block the selection covers with the covered offsets.
func (s *State) eachRange(fn func(n *doc.Node, p doc.Path, from, to int)) {
	sel := s.Sel.Normalized()
	for _, p := range s.Doc.TextPaths() {
		if p.Compare(sel.Start.Path) < 0 || p.Compare(sel.End.Path) > 0 {
			continue
		}
		n := s.Doc.NodeAt(p)
		from, to := 0, n.Delta.Len()
		if p.Equal(sel.Start.Path) {
			from = sel.Start.Offset
		}
		if p.Equal(sel.End.Path) {
			to = sel.End.Offset
		}
		fn(n, p, from, to)
	}
}

func (s *State) formatSelection(attrs doc.Attrs) {
	t := s.tx()
	s.eachRange(func(n *doc.Node, p doc.Path, from, to int) {
		if n.Type != doc.Code {
			t.FormatText(p, from, to-from, attrs)
		}
	})
	t.SetSelection(s.Sel)
	s.commit(t, "format")
}

// InsertFormula puts an inline equation at the caret (replacing any selection).
func (s *State) InsertFormula(formula string) {
	t := s.tx()
	if !s.Sel.Collapsed() {
		s.deleteSelection(t)
	}
	p, off := s.Sel.Start.Path, s.Sel.Start.Offset
	t.InsertText(p, off, doc.Embed, doc.Attrs{markdown.Formula: formula})
	t.SetSelection(doc.Caret(p, off+1))
	s.commit(t, "edit")
}

// SetFormula edits the inline equation at offset.
func (s *State) SetFormula(p doc.Path, offset int, formula string) {
	t := s.tx()
	if strings.TrimSpace(formula) == "" {
		t.DeleteText(p, offset, 1)
	} else {
		t.FormatText(p, offset, 1, doc.Attrs{markdown.Formula: formula})
	}
	s.commit(t, "edit")
}

// ActiveMarks are the formats shared by the whole selection (toolbar state).
func (s *State) ActiveMarks() doc.Attrs {
	if s.Sel.Collapsed() {
		n, _ := s.caretNode()
		if n == nil {
			return nil
		}
		return typingAttrs(n, s.Sel.End.Offset, s.pending)
	}
	var common doc.Attrs
	first := true
	s.eachRange(func(n *doc.Node, p doc.Path, from, to int) {
		if to <= from {
			return
		}
		c := n.Delta.CommonAttrs(from, to)
		if first {
			common, first = c, false
			return
		}
		for k, v := range common {
			if c[k] != v {
				delete(common, k)
			}
		}
	})
	return common
}
