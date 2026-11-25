package doc

import "fmt"

// Document is the block tree under an invisible page root.
type Document struct {
	Root *Node `json:"document"`
}

func New(blocks ...*Node) *Document {
	return &Document{Root: &Node{ID: "root", Type: Page, Children: blocks}}
}

// NodeAt returns the block at p, or nil.
func (d *Document) NodeAt(p Path) *Node {
	n := d.Root
	for _, i := range p {
		if i < 0 || i >= len(n.Children) {
			return nil
		}
		n = n.Children[i]
	}
	return n
}

// PathOf finds a block by id.
func (d *Document) PathOf(id string) (Path, bool) {
	var walk func(n *Node, p Path) (Path, bool)
	walk = func(n *Node, p Path) (Path, bool) {
		for i, c := range n.Children {
			q := p.Child(i)
			if c.ID == id {
				return q, true
			}
			if r, ok := walk(c, q); ok {
				return r, true
			}
		}
		return nil, false
	}
	return walk(d.Root, Path{})
}

func (d *Document) insert(at Path, nodes []*Node) error {
	parent := d.NodeAt(at.Parent())
	if parent == nil || len(at) == 0 {
		return fmt.Errorf("insert: no parent for %v", at)
	}
	i := at.Last()
	if i < 0 || i > len(parent.Children) {
		return fmt.Errorf("insert: index %d out of range", i)
	}
	kids := make([]*Node, 0, len(parent.Children)+len(nodes))
	kids = append(kids, parent.Children[:i]...)
	kids = append(kids, nodes...)
	kids = append(kids, parent.Children[i:]...)
	parent.Children = kids
	return nil
}

func (d *Document) remove(at Path, count int) ([]*Node, error) {
	parent := d.NodeAt(at.Parent())
	if parent == nil || len(at) == 0 {
		return nil, fmt.Errorf("delete: no parent for %v", at)
	}
	i := at.Last()
	if i < 0 || i+count > len(parent.Children) {
		return nil, fmt.Errorf("delete: range out of bounds at %v", at)
	}
	gone := append([]*Node(nil), parent.Children[i:i+count]...)
	parent.Children = append(parent.Children[:i:i], parent.Children[i+count:]...)
	return gone, nil
}

// Walk visits every block in document order with its path; returning false skips its children.
func (d *Document) Walk(fn func(n *Node, p Path) bool) {
	var walk func(n *Node, p Path)
	walk = func(n *Node, p Path) {
		for i, c := range n.Children {
			q := p.Child(i)
			if fn(c, q) {
				walk(c, q)
			}
		}
	}
	walk(d.Root, Path{})
}

// TextPaths lists the paths of blocks that hold text, in document order (caret movement, select all).
func (d *Document) TextPaths() []Path {
	var out []Path
	d.Walk(func(n *Node, p Path) bool {
		if HasText(n.Type) {
			out = append(out, p)
		}
		return true
	})
	return out
}

// Clone deep-copies the document.
func (d *Document) Clone() *Document { return &Document{Root: d.Root.Clone()} }
