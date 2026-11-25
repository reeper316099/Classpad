package core

import (
	"reflect"
	"strings"

	"github.com/reeper316099/classpad/internal/editor/doc"
)

// View is what the page draws. To keep typing cheap on long notes it is a diff: Blocks holds only blocks
// that changed since the last view, and Tree (the nesting of block ids) is sent only when blocks were
// added, removed or moved. Full views (on open) send everything.
type View struct {
	Tree    []*TreeNode       `json:"tree,omitempty"`
	Blocks  map[string]*Block `json:"blocks"`
	Sel     doc.Selection     `json:"selection"`
	Marks   doc.Attrs         `json:"marks,omitempty"`
	CanUndo bool              `json:"canUndo"`
	CanRedo bool              `json:"canRedo"`
	Full    bool              `json:"full,omitempty"`
}

type TreeNode struct {
	ID       string      `json:"id"`
	Children []*TreeNode `json:"children,omitempty"`
}

type Block struct {
	Type   string    `json:"type"`
	Data   doc.Attrs `json:"data,omitempty"`
	Delta  doc.Delta `json:"delta,omitempty"`
	Number int       `json:"number,omitempty"`
}

// snap identifies a block's content cheaply: operations replace a block's delta and attribute map rather
// than editing them in place, so unchanged pointers mean unchanged content.
type snap struct {
	typ          string
	delta, attrs uintptr
	dlen, number int
}

func ptr(v any) uintptr {
	r := reflect.ValueOf(v)
	if r.IsNil() {
		return 0
	}
	return r.Pointer()
}

// View builds the next diff (or everything when full).
func (s *State) View(full bool) View {
	v := View{Blocks: map[string]*Block{}, Sel: s.Sel, Marks: s.ActiveMarks(), CanUndo: s.CanUndo(), CanRedo: s.CanRedo(), Full: full}
	if full || s.sent == nil {
		s.sent = map[string]snap{}
		s.lastTree = ""
		v.Full = true
	}
	seen := make(map[string]bool, len(s.sent))
	var sig strings.Builder
	var build func(ns []*doc.Node) []*TreeNode
	build = func(ns []*doc.Node) []*TreeNode {
		out := make([]*TreeNode, len(ns))
		num := 0
		for i, n := range ns {
			number := 0
			if n.Type == doc.Numbered {
				if i == 0 || ns[i-1].Type != doc.Numbered {
					num = n.Int(doc.AttrNumber, 1)
				} else {
					num++
				}
				number = num
			}
			sn := snap{typ: n.Type, delta: ptr(n.Delta), dlen: len(n.Delta), attrs: ptr(n.Attrs), number: number}
			if old, ok := s.sent[n.ID]; !ok || old != sn {
				v.Blocks[n.ID] = &Block{Type: n.Type, Data: n.Attrs, Delta: n.Delta, Number: number}
				s.sent[n.ID] = sn
			}
			seen[n.ID] = true
			sig.WriteString(n.ID)
			sig.WriteByte('(')
			out[i] = &TreeNode{ID: n.ID, Children: build(n.Children)}
			sig.WriteByte(')')
		}
		return out
	}
	tree := build(s.Doc.Root.Children)
	if t := sig.String(); t != s.lastTree {
		v.Tree = tree
		s.lastTree = t
	}
	for id := range s.sent {
		if !seen[id] {
			delete(s.sent, id)
		}
	}
	return v
}
