package core

import (
	"strings"

	"github.com/reeper316099/classpad/internal/editor/doc"
	"github.com/reeper316099/classpad/internal/editor/markdown"
)

// Fragment returns the selection as blocks (partial first/last text, whole blocks between), flattened.
func (s *State) Fragment() []*doc.Node {
	sel := s.Sel.Normalized()
	if sel.Collapsed() {
		return nil
	}
	var out []*doc.Node
	for _, f := range s.flatten() {
		if f.p.Compare(sel.Start.Path) < 0 || f.p.Compare(sel.End.Path) > 0 {
			continue
		}
		c := &doc.Node{ID: doc.NewID(), Type: f.n.Type, Attrs: f.n.Clone().Attrs}
		if doc.HasText(f.n.Type) {
			from, to := 0, f.n.Delta.Len()
			if f.p.Equal(sel.Start.Path) {
				from = sel.Start.Offset
			}
			if f.p.Equal(sel.End.Path) {
				to = sel.End.Offset
			}
			c.Delta = f.n.Delta.Slice(from, to)
		}
		out = append(out, c)
	}
	return out
}

// Copy returns the selection as Markdown and as plain text for the clipboard.
func (s *State) Copy() (md, plain string) {
	frag := s.Fragment()
	if len(frag) == 0 {
		return "", ""
	}
	if len(frag) == 1 && doc.HasText(frag[0].Type) {
		return markdown.RenderInline(frag[0].Delta), frag[0].Delta.Text()
	}
	md = strings.TrimSuffix(markdown.Encode(doc.New(frag...)), "\n")
	var lines []string
	for _, n := range frag {
		lines = append(lines, n.Delta.Text())
	}
	return md, strings.Join(lines, "\n")
}

// Paste inserts Markdown (or plain text) at the caret. A single paragraph goes inline into the current
// block; several blocks split the current block around them.
func (s *State) Paste(md string, plain bool) {
	t := s.tx()
	if !s.Sel.Collapsed() {
		s.deleteSelection(t)
	}
	p := s.Sel.Start.Path
	cur := s.Doc.NodeAt(p)
	off := s.Sel.Start.Offset
	if cur == nil {
		s.commit(t, "edit")
		return
	}
	if cur.Type == doc.Code || plain {
		text := strings.ReplaceAll(md, "\r\n", "\n")
		if cur.Type != doc.Code && strings.Contains(text, "\n") {
			// plain text with lines: one paragraph per line
			var blocks []*doc.Node
			for _, l := range strings.Split(text, "\n") {
				blocks = append(blocks, doc.Text(doc.Paragraph, l, nil))
			}
			s.pasteBlocks(t, p, off, blocks)
			return
		}
		t.InsertText(p, off, text, nil)
		t.SetSelection(doc.Caret(p, off+doc.Len16(text)))
		s.commit(t, "edit")
		return
	}
	blocks := markdown.Decode(md).Root.Children
	if len(blocks) == 1 && blocks[0].Type == doc.Paragraph && len(blocks[0].Children) == 0 {
		d := blocks[0].Delta
		t.ApplyText(p, doc.Delta{}.Retain(off, nil).Concat(d))
		t.SetSelection(doc.Caret(p, off+d.Len()))
		s.commit(t, "edit")
		return
	}
	s.pasteBlocks(t, p, off, blocks)
}

func (s *State) pasteBlocks(t *doc.Transaction, p doc.Path, off int, blocks []*doc.Node) {
	cur := s.Doc.NodeAt(p)
	for i, b := range blocks {
		blocks[i] = b.Copy()
	}
	at := p.Next()
	if cur.Type == doc.Paragraph && cur.Delta.Len() == 0 && len(cur.Children) == 0 {
		t.DeleteNodes(p, 1)
		at = p
	} else if off < cur.Delta.Len() {
		rest := cur.Delta.Slice(off, cur.Delta.Len())
		t.DeleteText(p, off, cur.Delta.Len()-off)
		t.InsertNodes(p.Next(), doc.NewNode(cur.Type, cur.Clone().Attrs, rest))
	} else if off == 0 && cur.Delta.Len() > 0 {
		at = p
	}
	t.InsertNodes(at, blocks...)
	// caret at the end of the last pasted text block
	last := at.Clone()
	last[len(last)-1] += len(blocks) - 1
	if n := s.Doc.NodeAt(last); n != nil && doc.HasText(n.Type) {
		t.SetSelection(doc.Caret(last, n.Delta.Len()))
	} else if q, ok := s.nextText(last); ok {
		t.SetSelection(doc.Caret(q, 0))
	}
	s.commit(t, "edit")
}
