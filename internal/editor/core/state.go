// Package core is the editor's behaviour, ported from AppFlowy Editor: an EditorState holding the block
// document, the selection and undo history, and the commands keys, menus and the toolbar run.
package core

import (
	"time"

	"github.com/reeper316099/classpad/internal/editor/doc"
	"github.com/reeper316099/classpad/internal/editor/markdown"
)

type entry struct {
	undo, redo    []doc.Operation
	before, after doc.Selection
	kind          string
	at            time.Time
}

// State is one open note.
type State struct {
	Doc     *doc.Document
	Sel     doc.Selection
	pending doc.Attrs // marks toggled with a collapsed caret, applied to the next typed text
	undo    []entry
	redo    []entry
	dirty   bool
	now     func() time.Time
	// what the page has already been sent (see View)
	sent     map[string]snap
	lastTree string
}

const historyLimit = 500

// New opens Markdown as a block document with the caret at the start.
func New(md string) *State {
	s := &State{Doc: markdown.Decode(md), now: time.Now}
	s.Sel = doc.Caret(s.firstTextPath(), 0)
	return s
}

// Markdown encodes the current document.
func (s *State) Markdown() string { return markdown.Encode(s.Doc) }

// Dirty reports (and clears) whether the document changed since the last call.
func (s *State) Dirty() bool {
	d := s.dirty
	s.dirty = false
	return d
}

func (s *State) CanUndo() bool { return len(s.undo) > 0 }
func (s *State) CanRedo() bool { return len(s.redo) > 0 }

func (s *State) firstTextPath() doc.Path {
	if ps := s.Doc.TextPaths(); len(ps) > 0 {
		return ps[0]
	}
	return doc.Path{0}
}

func (s *State) tx() *doc.Transaction { return doc.NewTransaction(s.Doc, s.Sel) }

// commit records a transaction in the undo history. Consecutive typing within a second merges into one step.
func (s *State) commit(t *doc.Transaction, kind string) {
	if t.Err() != nil {
		// a failed step leaves earlier operations applied; roll them back so the document stays consistent
		for _, op := range t.Inverse() {
			_ = op.Apply(s.Doc)
		}
		return
	}
	if t.HasAfter {
		s.Sel = t.After
	}
	if len(t.Ops) == 0 {
		return
	}
	s.dirty = true
	s.redo = nil
	now := s.now()
	if n := len(s.undo); n > 0 && kind == "type" && s.undo[n-1].kind == "type" && now.Sub(s.undo[n-1].at) < time.Second {
		last := &s.undo[n-1]
		last.undo = append(t.Inverse(), last.undo...)
		last.redo = append(last.redo, t.Ops...)
		last.after = s.Sel
		last.at = now
		return
	}
	s.undo = append(s.undo, entry{undo: t.Inverse(), redo: t.Ops, before: t.Before, after: s.Sel, kind: kind, at: now})
	if len(s.undo) > historyLimit {
		s.undo = s.undo[1:]
	}
}

func (s *State) Undo() {
	n := len(s.undo)
	if n == 0 {
		return
	}
	e := s.undo[n-1]
	s.undo = s.undo[:n-1]
	for _, op := range e.undo {
		_ = op.Apply(s.Doc)
	}
	s.Sel = s.clampSel(e.before)
	s.redo = append(s.redo, e)
	s.dirty = true
}

func (s *State) Redo() {
	n := len(s.redo)
	if n == 0 {
		return
	}
	e := s.redo[n-1]
	s.redo = s.redo[:n-1]
	for _, op := range e.redo {
		_ = op.Apply(s.Doc)
	}
	s.Sel = s.clampSel(e.after)
	e.kind = "redo"
	s.undo = append(s.undo, e)
	s.dirty = true
}

// SetSelection moves the caret (clamped to real positions) and forgets pending marks.
func (s *State) SetSelection(sel doc.Selection) {
	s.Sel = s.clampSel(sel)
	s.pending = nil
	if n := len(s.undo); n > 0 {
		s.undo[n-1].kind = "" // moving the caret ends a typing run
	}
}

func (s *State) clampPos(p doc.Position) doc.Position {
	n := s.Doc.NodeAt(p.Path)
	if n == nil || len(p.Path) == 0 {
		return doc.Position{Path: s.firstTextPath(), Offset: 0}
	}
	if p.Offset < 0 {
		p.Offset = 0
	}
	if l := n.Delta.Len(); p.Offset > l {
		p.Offset = l
	}
	return doc.Position{Path: p.Path.Clone(), Offset: p.Offset}
}

func (s *State) clampSel(sel doc.Selection) doc.Selection {
	return doc.Selection{Start: s.clampPos(sel.Start), End: s.clampPos(sel.End)}
}

// node returns the block at the caret.
func (s *State) caretNode() (*doc.Node, doc.Path) {
	p := s.Sel.End.Path
	return s.Doc.NodeAt(p), p
}

// SelectedPaths lists the blocks the selection touches (top-most only), in order.
func (s *State) SelectedPaths() []doc.Path {
	sel := s.Sel.Normalized()
	var out []doc.Path
	s.Doc.Walk(func(n *doc.Node, p doc.Path) bool {
		if p.Compare(sel.Start.Path) >= 0 && p.Compare(sel.End.Path) <= 0 {
			for _, q := range out {
				if q.IsAncestorOf(p) {
					return true
				}
			}
			out = append(out, p)
		}
		return true
	})
	if len(out) == 0 {
		out = []doc.Path{sel.Start.Path}
	}
	return out
}
