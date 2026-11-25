package core

import (
	"github.com/reeper316099/classpad/internal/editor/doc"
)

type flat struct {
	n *doc.Node
	p doc.Path
}

func (s *State) flatten() []flat {
	var out []flat
	s.Doc.Walk(func(n *doc.Node, p doc.Path) bool {
		out = append(out, flat{n, p})
		return true
	})
	return out
}

func (s *State) path(id string) doc.Path {
	p, _ := s.Doc.PathOf(id)
	return p
}

// prevText / nextText find the neighbouring text block in document order.
func (s *State) prevText(p doc.Path) (doc.Path, bool) {
	var last doc.Path
	found := false
	for _, q := range s.Doc.TextPaths() {
		if q.Compare(p) >= 0 {
			break
		}
		last, found = q, true
	}
	return last, found
}

func (s *State) nextText(p doc.Path) (doc.Path, bool) {
	for _, q := range s.Doc.TextPaths() {
		if q.Compare(p) > 0 {
			return q, true
		}
	}
	return nil, false
}

// prevBlock / nextBlock are the neighbouring blocks of any type in document order.
func (s *State) prevBlock(p doc.Path) (*doc.Node, doc.Path) {
	var n *doc.Node
	var q doc.Path
	for _, f := range s.flatten() {
		if f.p.Compare(p) >= 0 {
			break
		}
		if !f.p.IsAncestorOf(p) {
			n, q = f.n, f.p
		}
	}
	return n, q
}

func (s *State) nextBlock(p doc.Path) (*doc.Node, doc.Path) {
	for _, f := range s.flatten() {
		if f.p.Compare(p) > 0 && !p.IsAncestorOf(f.p) {
			return f.n, f.p
		}
	}
	return nil, nil
}

// deleteSelection removes the selected content into t: the first block keeps its text before the
// selection plus the last block's text after it; whole blocks in between are removed, and blocks nested
// under removed ones that lie after the selection are kept (moved after the first block).
func (s *State) deleteSelection(t *doc.Transaction) {
	sel := s.Sel.Normalized()
	if sel.Collapsed() {
		return
	}
	if sel.SingleBlock() {
		t.DeleteText(sel.Start.Path, sel.Start.Offset, sel.End.Offset-sel.Start.Offset)
		s.Sel = doc.Caret(sel.Start.Path, sel.Start.Offset)
		t.SetSelection(s.Sel)
		return
	}
	a := s.Doc.NodeAt(sel.Start.Path)
	b := s.Doc.NodeAt(sel.End.Path)
	if a == nil || b == nil {
		return
	}
	tail := b.Delta.Slice(sel.End.Offset, b.Delta.Len())
	all := s.flatten()
	ia, ib := -1, -1
	for i, f := range all {
		if f.n == a {
			ia = i
		}
		if f.n == b {
			ib = i
		}
	}
	deleted := map[string]bool{}
	var top []string
	for _, f := range all[ia+1 : ib+1] {
		if f.p.IsAncestorOf(sel.Start.Path) {
			continue
		}
		parentID := ""
		if pn := s.Doc.NodeAt(f.p.Parent()); pn != nil {
			parentID = pn.ID
		}
		if !deleted[parentID] {
			top = append(top, f.n.ID)
		}
		deleted[f.n.ID] = true
	}
	var survivors []*doc.Node
	for _, f := range all[ib+1:] {
		if pn := s.Doc.NodeAt(f.p.Parent()); pn != nil && deleted[pn.ID] && !deleted[f.n.ID] {
			survivors = append(survivors, f.n.Clone())
			deleted[f.n.ID] = true // its own children move with it
		}
	}
	for i := len(top) - 1; i >= 0; i-- {
		if p := s.path(top[i]); p != nil {
			t.DeleteNodes(p, 1)
		}
	}
	ap := s.path(a.ID)
	t.ReplaceText(ap, sel.Start.Offset, a.Delta.Len()-sel.Start.Offset, tail)
	if len(survivors) > 0 {
		t.InsertNodes(ap.Next(), survivors...)
	}
	s.Sel = doc.Caret(ap, sel.Start.Offset)
	t.SetSelection(s.Sel)
}

// DeleteSelection is the command form (Backspace/Delete/Cut with a range selected).
func (s *State) DeleteSelection() {
	t := s.tx()
	s.deleteSelection(t)
	s.commit(t, "edit")
}

func continues(typ string) bool {
	switch typ {
	case doc.Bulleted, doc.Numbered, doc.Todo:
		return true
	}
	return false
}

// InsertNewline is Enter, following AppFlowy: split the block, continue lists, leave empty lists, add a
// line inside code.
func (s *State) InsertNewline() {
	t := s.tx()
	if !s.Sel.Collapsed() {
		s.deleteSelection(t)
	}
	p := s.Sel.Start.Path
	n := s.Doc.NodeAt(p)
	off := s.Sel.Start.Offset
	if n == nil || !doc.HasText(n.Type) {
		s.commit(t, "edit")
		return
	}
	text := n.Delta.Text()
	if n.Type == doc.Code {
		// two empty lines at the end leave the code block
		if off == n.Delta.Len() && len(text) >= 2 && text[len(text)-2:] == "\n\n" {
			t.DeleteText(p, off-2, 2)
			t.InsertNodes(p.Next(), doc.Text(doc.Paragraph, "", nil))
			t.SetSelection(doc.Caret(p.Next(), 0))
		} else {
			t.InsertText(p, off, "\n", nil)
			t.SetSelection(doc.Caret(p, off+1))
		}
		s.commit(t, "edit")
		return
	}
	if m := reFenceLine.FindStringSubmatch(text); m != nil && n.Type == doc.Paragraph && off == n.Delta.Len() {
		// "```python" + Enter starts a code block in that language
		t.DeleteText(p, 0, n.Delta.Len())
		t.SetType(p, doc.Code, doc.Attrs{doc.AttrLanguage: m[1]})
		t.SetSelection(doc.Caret(p, 0))
		s.commit(t, "edit")
		return
	}
	if n.Delta.Len() == 0 && n.Type != doc.Paragraph && len(n.Children) == 0 {
		s.commit(t, "edit")
		if len(p) > 1 && continues(n.Type) {
			s.Outdent()
		} else {
			s.TurnInto(doc.Paragraph, nil)
		}
		return
	}
	if n.Delta.Len() == 0 && n.Type == doc.Paragraph && len(p) > 1 {
		// an empty paragraph nested in a list or toggle steps out, like an empty list item
		s.commit(t, "edit")
		s.Outdent()
		return
	}
	newType, newAttrs := doc.Paragraph, doc.Attrs(nil)
	if continues(n.Type) {
		newType = n.Type
		if n.Type == doc.Todo {
			newAttrs = doc.Attrs{doc.AttrChecked: false}
		}
	}
	if off == 0 && n.Delta.Len() > 0 {
		// at the start: push the block down with an empty one of the same kind above it
		t.InsertNodes(p, doc.NewNode(newType, newAttrs, nil))
		t.SetSelection(doc.Caret(p.Next(), 0))
		s.commit(t, "edit")
		return
	}
	rest := n.Delta.Slice(off, n.Delta.Len())
	t.DeleteText(p, off, n.Delta.Len()-off)
	var target doc.Path
	switch {
	case n.Type == doc.Toggle && !n.Bool(doc.AttrCollapse):
		// an open toggle's title: the new line is its first child
		target = p.Child(0)
		t.InsertNodes(target, doc.NewNode(doc.Paragraph, nil, rest))
	case n.Type == doc.Toggle:
		target = p.Next()
		t.InsertNodes(target, doc.NewNode(doc.Toggle, doc.Attrs{doc.AttrLevel: n.Int(doc.AttrLevel, 0), doc.AttrCollapse: true}, rest))
	case len(n.Children) > 0 && doc.CanHaveChildren(n.Type):
		target = p.Child(0)
		t.InsertNodes(target, doc.NewNode(newType, newAttrs, rest))
	default:
		target = p.Next()
		t.InsertNodes(target, doc.NewNode(newType, newAttrs, rest))
	}
	t.SetSelection(doc.Caret(target, 0))
	s.commit(t, "edit")
}

// InsertSoftBreak is Shift+Enter: a line break inside the block.
func (s *State) InsertSoftBreak() {
	n, _ := s.caretNode()
	if n == nil || n.Type == doc.Heading {
		return
	}
	s.InsertText("\n")
}

// liftChildren moves a block's children out to follow it (when it becomes a type that can't hold them).
func liftChildren(t *doc.Transaction, n *doc.Node, p doc.Path) {
	if len(n.Children) == 0 {
		return
	}
	kids := make([]*doc.Node, len(n.Children))
	for i, c := range n.Children {
		kids[i] = c.Clone()
	}
	t.DeleteNodes(p.Child(0), len(kids))
	t.InsertNodes(p.Next(), kids...)
}

// DeleteBackward is Backspace with a caret.
func (s *State) DeleteBackward() {
	if !s.Sel.Collapsed() {
		s.DeleteSelection()
		return
	}
	n, p := s.caretNode()
	if n == nil {
		return
	}
	off := s.Sel.Start.Offset
	t := s.tx()
	if off > 0 {
		text := n.Delta.Slice(0, off).Text()
		r := []rune(text)
		w := doc.Len16(string(r[len(r)-1]))
		t.DeleteText(p, off-w, w)
		t.SetSelection(doc.Caret(p, off-w))
		s.commit(t, "type")
		return
	}
	// at the start of a block
	if n.Type != doc.Paragraph && n.Type != doc.Code {
		s.TurnInto(doc.Paragraph, nil)
		return
	}
	if n.Type == doc.Code && n.Delta.Len() > 0 {
		return
	}
	if len(p) > 1 && p.Last() == 0 {
		// first child: join the parent's text (a line under a bullet goes back into the bullet)
		if parent := s.Doc.NodeAt(p.Parent()); parent != nil && doc.HasText(parent.Type) && parent.Type != doc.Code {
			s.mergeInto(t, p.Parent(), p)
			s.commit(t, "edit")
		} else {
			s.Outdent()
		}
		return
	}
	prev, pp := s.prevBlock(p)
	if prev == nil {
		if n.Type == doc.Code {
			s.TurnInto(doc.Paragraph, nil)
		}
		return
	}
	if !doc.HasText(prev.Type) {
		// the block above is a divider, image, equation or table: remove it
		t.DeleteNodes(pp, 1)
		t.SetSelection(doc.Caret(s.Doc.TextPaths()[0], 0))
		if np := s.path(n.ID); np != nil {
			t.SetSelection(doc.Caret(np, 0))
		}
		s.commit(t, "edit")
		return
	}
	s.mergeInto(t, pp, p)
	s.commit(t, "edit")
}

// mergeInto appends block q's text to block p (q follows p) and deletes q; q's children move to p, or
// after p when p can't hold children.
func (s *State) mergeInto(t *doc.Transaction, p, q doc.Path) {
	a, b := s.Doc.NodeAt(p), s.Doc.NodeAt(q)
	if a == nil || b == nil {
		return
	}
	join := a.Delta.Len()
	aID := a.ID
	text := b.Delta.Clone()
	if a.Type == doc.Code {
		text = doc.Delta{}.Insert(b.Delta.Text(), nil)
	}
	kids := make([]*doc.Node, len(b.Children))
	for i, c := range b.Children {
		kids[i] = c.Clone()
	}
	t.DeleteNodes(q, 1)
	ap := s.path(aID)
	t.ApplyText(ap, doc.Delta{}.Retain(join, nil).Concat(text))
	if len(kids) > 0 {
		if ap.IsAncestorOf(q) {
			t.InsertNodes(q, kids...) // into the parent where q was
		} else if doc.CanHaveChildren(a.Type) {
			t.InsertNodes(ap.Child(len(s.Doc.NodeAt(ap).Children)), kids...)
		} else {
			t.InsertNodes(ap.Next(), kids...)
		}
	}
	t.SetSelection(doc.Caret(ap, join))
}

// DeleteForward is the Delete key with a caret.
func (s *State) DeleteForward() {
	if !s.Sel.Collapsed() {
		s.DeleteSelection()
		return
	}
	n, p := s.caretNode()
	if n == nil {
		return
	}
	off := s.Sel.Start.Offset
	t := s.tx()
	if off < n.Delta.Len() {
		r := []rune(n.Delta.Slice(off, n.Delta.Len()).Text())
		w := doc.Len16(string(r[0]))
		t.DeleteText(p, off, w)
		t.SetSelection(doc.Caret(p, off))
		s.commit(t, "type")
		return
	}
	next, np := s.nextBlock(p)
	if len(n.Children) > 0 {
		next, np = n.Children[0], p.Child(0)
	}
	if next == nil {
		return
	}
	if !doc.HasText(next.Type) {
		t.DeleteNodes(np, 1)
		t.SetSelection(doc.Caret(p, off))
	} else {
		s.mergeInto(t, p, np)
	}
	s.commit(t, "edit")
}

// topSelected returns the top-most selected blocks' ids, in order.
func (s *State) topSelected() []string {
	var ids []string
	for _, p := range s.SelectedPaths() {
		if n := s.Doc.NodeAt(p); n != nil {
			ids = append(ids, n.ID)
		}
	}
	return ids
}

// selectionByIDs remembers the selection by block id so it can be restored after blocks move.
type idSel struct {
	startID, endID   string
	startOff, endOff int
}

func (s *State) saveSel() idSel {
	a, b := s.Doc.NodeAt(s.Sel.Start.Path), s.Doc.NodeAt(s.Sel.End.Path)
	out := idSel{startOff: s.Sel.Start.Offset, endOff: s.Sel.End.Offset}
	if a != nil {
		out.startID = a.ID
	}
	if b != nil {
		out.endID = b.ID
	}
	return out
}

func (s *State) restoreSel(t *doc.Transaction, x idSel) {
	ps, pe := s.path(x.startID), s.path(x.endID)
	if ps == nil || pe == nil {
		return
	}
	t.SetSelection(doc.Selection{Start: doc.Position{Path: ps, Offset: x.startOff}, End: doc.Position{Path: pe, Offset: x.endOff}})
}

// Indent is Tab: each selected block becomes the last child of the block above it.
func (s *State) Indent() {
	saved := s.saveSel()
	t := s.tx()
	for _, id := range s.topSelected() {
		p := s.path(id)
		if p == nil || p.Last() == 0 {
			continue
		}
		prev := s.Doc.NodeAt(p.Prev())
		if !doc.CanHaveChildren(prev.Type) {
			continue
		}
		n := s.Doc.NodeAt(p).Clone()
		t.DeleteNodes(p, 1)
		pp := s.path(prev.ID)
		t.InsertNodes(pp.Child(len(s.Doc.NodeAt(pp).Children)), n)
	}
	s.restoreSel(t, saved)
	s.commit(t, "edit")
}

// Outdent is Shift+Tab: the block moves out to follow its parent; the siblings below it come along as its
// children so nothing changes order (Notion's behaviour), when it can hold children.
func (s *State) Outdent() {
	saved := s.saveSel()
	t := s.tx()
	ids := s.topSelected()
	for i := len(ids) - 1; i >= 0; i-- {
		p := s.path(ids[i])
		if p == nil || len(p) < 2 {
			continue
		}
		parent := s.Doc.NodeAt(p.Parent())
		n := s.Doc.NodeAt(p).Clone()
		var after []*doc.Node
		if doc.CanHaveChildren(n.Type) {
			for _, c := range parent.Children[p.Last()+1:] {
				after = append(after, c.Clone())
			}
		}
		t.DeleteNodes(p, 1+len(after))
		n.Children = append(n.Children, after...)
		t.InsertNodes(s.path(parent.ID).Next(), n)
	}
	s.restoreSel(t, saved)
	s.commit(t, "edit")
}

// TurnInto changes the selected blocks' type, keeping their text (AppFlowy's "Turn into").
func (s *State) TurnInto(typ string, attrs doc.Attrs) {
	saved := s.saveSel()
	t := s.tx()
	for _, id := range s.topSelected() {
		p := s.path(id)
		n := s.Doc.NodeAt(p)
		if n == nil {
			continue
		}
		a := attrs
		if typ == doc.Todo && a == nil {
			a = doc.Attrs{doc.AttrChecked: false}
		}
		if typ == doc.Toggle && a == nil {
			a = doc.Attrs{doc.AttrLevel: 0}
		}
		if typ == doc.Callout && a == nil {
			a = doc.Attrs{doc.AttrIcon: "💡"}
		}
		if typ == doc.Code {
			plain := n.Delta.Text()
			t.ApplyText(p, doc.Delta{}.Delete(n.Delta.Len()).Insert(plain, nil))
		}
		if !doc.HasText(typ) {
			t.ApplyText(p, doc.Delta{}.Delete(n.Delta.Len()))
		}
		if !doc.CanHaveChildren(typ) {
			liftChildren(t, s.Doc.NodeAt(p), p)
		}
		t.SetType(p, typ, a)
	}
	s.restoreSel(t, saved)
	s.commit(t, "edit")
}

// InsertBlock adds a block below the caret's block, or replaces the caret's block when it is an empty
// paragraph (picking from the slash menu).
func (s *State) InsertBlock(n *doc.Node) {
	t := s.tx()
	cur, p := s.caretNode()
	if cur == nil {
		return
	}
	target := p.Next()
	if cur.Type == doc.Paragraph && cur.Delta.Len() == 0 && len(cur.Children) == 0 {
		t.DeleteNodes(p, 1)
		target = p
	}
	t.InsertNodes(target, n)
	if doc.HasText(n.Type) {
		t.SetSelection(doc.Caret(target, n.Delta.Len()))
	} else {
		next := target.Next()
		if m := s.Doc.NodeAt(next); m == nil || !doc.HasText(m.Type) {
			t.InsertNodes(next, doc.Text(doc.Paragraph, "", nil))
		}
		t.SetSelection(doc.Caret(next, 0))
	}
	s.commit(t, "edit")
}

// ApplySlash removes the typed "/query" before the caret and inserts or converts to the chosen block.
func (s *State) ApplySlash(queryLen int, n *doc.Node) {
	cur, p := s.caretNode()
	if cur == nil {
		return
	}
	off := s.Sel.End.Offset
	from := max(0, off-queryLen)
	t := s.tx()
	t.DeleteText(p, from, off-from)
	t.SetSelection(doc.Caret(p, from))
	s.commit(t, "edit")
	cur = s.Doc.NodeAt(p)
	if doc.HasText(n.Type) && cur.Delta.Len() > 0 && cur.Type == doc.Paragraph && n.Delta.Len() == 0 {
		// "/heading" typed into a line with text: turn that line into the block, as AppFlowy does
		s.TurnInto(n.Type, n.Attrs)
		return
	}
	s.InsertBlock(n)
}

// SetAttrs updates attributes of one block (check a to-do, fold a toggle, set a code language…).
func (s *State) SetAttrs(p doc.Path, attrs doc.Attrs) {
	t := s.tx()
	t.UpdateNode(p, "", attrs)
	t.SetSelection(s.Sel)
	s.commit(t, "attrs")
}

// ToggleTodo is Mod+Enter: check or uncheck the selected to-dos.
func (s *State) ToggleTodo() {
	t := s.tx()
	for _, p := range s.SelectedPaths() {
		if n := s.Doc.NodeAt(p); n != nil && n.Type == doc.Todo {
			t.UpdateNode(p, "", doc.Attrs{doc.AttrChecked: !n.Bool(doc.AttrChecked)})
		}
	}
	t.SetSelection(s.Sel)
	s.commit(t, "attrs")
}

// MoveBlock drags block id before/after/inside target.
func (s *State) MoveBlock(id, target, where string) {
	if id == target {
		return
	}
	p, q := s.path(id), s.path(target)
	if p == nil || q == nil || p.IsAncestorOf(q) {
		return
	}
	saved := s.saveSel()
	t := s.tx()
	n := s.Doc.NodeAt(p).Clone()
	t.DeleteNodes(p, 1)
	q = s.path(target)
	switch where {
	case "before":
		t.InsertNodes(q, n)
	case "inside":
		tn := s.Doc.NodeAt(q)
		if !doc.CanHaveChildren(tn.Type) {
			t.InsertNodes(q.Next(), n)
		} else {
			t.InsertNodes(q.Child(0), n)
		}
	default:
		t.InsertNodes(q.Next(), n)
	}
	s.restoreSel(t, saved)
	s.commit(t, "move")
}

// MoveUp / MoveDown swap the caret's block with its sibling (Mod+Shift+Arrow).
func (s *State) MoveUp()   { s.moveBy(-1) }
func (s *State) MoveDown() { s.moveBy(1) }

func (s *State) moveBy(dir int) {
	_, p := s.caretNode()
	if p == nil {
		return
	}
	parent := s.Doc.NodeAt(p.Parent())
	i := p.Last() + dir
	if i < 0 || i >= len(parent.Children) {
		return
	}
	other := parent.Children[i].ID
	me := s.Doc.NodeAt(p).ID
	if dir < 0 {
		s.MoveBlock(me, other, "before")
	} else {
		s.MoveBlock(me, other, "after")
	}
}

// Duplicate copies a block (with its children) below itself.
func (s *State) Duplicate(id string) {
	p := s.path(id)
	if p == nil {
		return
	}
	t := s.tx()
	c := s.Doc.NodeAt(p).Copy()
	t.InsertNodes(p.Next(), c)
	if doc.HasText(c.Type) {
		t.SetSelection(doc.Caret(p.Next(), c.Delta.Len()))
	}
	s.commit(t, "edit")
}

// DeleteBlock removes a block and its children; the page always keeps one paragraph.
func (s *State) DeleteBlock(id string) {
	p := s.path(id)
	if p == nil {
		return
	}
	t := s.tx()
	t.DeleteNodes(p, 1)
	if len(s.Doc.Root.Children) == 0 {
		t.InsertNodes(doc.Path{0}, doc.Text(doc.Paragraph, "", nil))
	}
	if q, ok := s.prevText(p); ok {
		t.SetSelection(doc.Caret(q, s.Doc.NodeAt(q).Delta.Len()))
	} else if ps := s.Doc.TextPaths(); len(ps) > 0 {
		t.SetSelection(doc.Caret(ps[0], 0))
	}
	s.commit(t, "edit")
}

// SelectAll selects the caret's block first and the whole page on a second press (AppFlowy).
func (s *State) SelectAll() {
	n, p := s.caretNode()
	ps := s.Doc.TextPaths()
	if len(ps) == 0 {
		return
	}
	sel := s.Sel.Normalized()
	whole := doc.Selection{Start: doc.Position{Path: p, Offset: 0}, End: doc.Position{Path: p, Offset: n.Delta.Len()}}
	if n != nil && !(sel.Start.Equal(whole.Start) && sel.End.Equal(whole.End)) && sel.SingleBlock() && n.Delta.Len() > 0 {
		s.SetSelection(whole)
		return
	}
	last := ps[len(ps)-1]
	s.SetSelection(doc.Selection{
		Start: doc.Position{Path: ps[0], Offset: 0},
		End:   doc.Position{Path: last, Offset: s.Doc.NodeAt(last).Delta.Len()},
	})
}
