package doc

// Operation is an invertible change to a document, as in AppFlowy: insert or delete blocks, update a
// block's type/attributes, or change a block's text with a Delta.
type Operation interface {
	Apply(d *Document) error
	Invert() Operation
	At() Path
}

type InsertOp struct {
	Path  Path
	Nodes []*Node
}

type DeleteOp struct {
	Path  Path
	Nodes []*Node
}

// UpdateOp replaces a block's type and attributes (both kept for undo).
type UpdateOp struct {
	Path            Path
	Type, OldType   string
	Attrs, OldAttrs Attrs
}

type TextOp struct {
	Path            Path
	Delta, Inverted Delta
}

func (o *InsertOp) At() Path { return o.Path }
func (o *DeleteOp) At() Path { return o.Path }
func (o *UpdateOp) At() Path { return o.Path }
func (o *TextOp) At() Path   { return o.Path }

func cloneNodes(ns []*Node) []*Node {
	out := make([]*Node, len(ns))
	for i, n := range ns {
		out[i] = n.Clone()
	}
	return out
}

func (o *InsertOp) Apply(d *Document) error { return d.insert(o.Path, cloneNodes(o.Nodes)) }
func (o *InsertOp) Invert() Operation       { return &DeleteOp{Path: o.Path, Nodes: o.Nodes} }

func (o *DeleteOp) Apply(d *Document) error {
	_, err := d.remove(o.Path, len(o.Nodes))
	return err
}
func (o *DeleteOp) Invert() Operation { return &InsertOp{Path: o.Path, Nodes: o.Nodes} }

func (o *UpdateOp) Apply(d *Document) error {
	n := d.NodeAt(o.Path)
	if n == nil {
		return errNoNode(o.Path)
	}
	n.Type = o.Type
	n.Attrs = cloneAnyAttrs(o.Attrs)
	if !HasText(n.Type) {
		n.Delta = nil
	}
	return nil
}
func (o *UpdateOp) Invert() Operation {
	return &UpdateOp{Path: o.Path, Type: o.OldType, OldType: o.Type, Attrs: o.OldAttrs, OldAttrs: o.Attrs}
}

func (o *TextOp) Apply(d *Document) error {
	n := d.NodeAt(o.Path)
	if n == nil {
		return errNoNode(o.Path)
	}
	n.Delta = n.Delta.Compose(o.Delta)
	return nil
}
func (o *TextOp) Invert() Operation {
	return &TextOp{Path: o.Path, Delta: o.Inverted, Inverted: o.Delta}
}

type pathError struct{ p Path }

func (e pathError) Error() string { return "no block at path" }

func errNoNode(p Path) error { return pathError{p} }
