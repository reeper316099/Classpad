package doc

// Transaction groups operations into one undoable step. Unlike AppFlowy, each operation is applied as soon
// as it is added, so later steps can read the document as it now is; the recorded operations are inverted
// in reverse order to undo.
type Transaction struct {
	Doc           *Document
	Ops           []Operation
	Before, After Selection
	HasAfter      bool
	err           error
}

func NewTransaction(d *Document, before Selection) *Transaction {
	return &Transaction{Doc: d, Before: before}
}

func (t *Transaction) Err() error { return t.err }

func (t *Transaction) add(op Operation) {
	if t.err != nil {
		return
	}
	if err := op.Apply(t.Doc); err != nil {
		t.err = err
		return
	}
	t.Ops = append(t.Ops, op)
}

// SetSelection records where the caret goes after this step.
func (t *Transaction) SetSelection(s Selection) {
	t.After = s
	t.HasAfter = true
}

func (t *Transaction) InsertNodes(at Path, nodes ...*Node) {
	if len(nodes) == 0 {
		return
	}
	t.add(&InsertOp{Path: at.Clone(), Nodes: cloneNodes(nodes)})
}

func (t *Transaction) DeleteNodes(at Path, count int) {
	parent := t.Doc.NodeAt(at.Parent())
	if parent == nil || count <= 0 {
		return
	}
	i := at.Last()
	if i+count > len(parent.Children) {
		count = len(parent.Children) - i
	}
	t.add(&DeleteOp{Path: at.Clone(), Nodes: cloneNodes(parent.Children[i : i+count])})
}

// UpdateNode changes a block's type and merges attrs (a nil value removes the attribute).
func (t *Transaction) UpdateNode(at Path, typ string, attrs Attrs) {
	n := t.Doc.NodeAt(at)
	if n == nil {
		return
	}
	if typ == "" {
		typ = n.Type
	}
	next := composeAttrs(cloneAnyAttrs(n.Attrs), attrs, false)
	t.add(&UpdateOp{Path: at.Clone(), Type: typ, OldType: n.Type, Attrs: next, OldAttrs: cloneAnyAttrs(n.Attrs)})
}

// SetType changes the type and replaces all attributes.
func (t *Transaction) SetType(at Path, typ string, attrs Attrs) {
	n := t.Doc.NodeAt(at)
	if n == nil {
		return
	}
	t.add(&UpdateOp{Path: at.Clone(), Type: typ, OldType: n.Type, Attrs: cloneAnyAttrs(attrs), OldAttrs: cloneAnyAttrs(n.Attrs)})
}

// ApplyText composes a change delta into a block's text.
func (t *Transaction) ApplyText(at Path, change Delta) {
	n := t.Doc.NodeAt(at)
	if n == nil || len(change) == 0 {
		return
	}
	t.add(&TextOp{Path: at.Clone(), Delta: change, Inverted: change.Invert(n.Delta)})
}

func (t *Transaction) InsertText(at Path, offset int, text string, attrs Attrs) {
	t.ApplyText(at, Delta{}.Retain(offset, nil).Insert(text, attrs))
}

func (t *Transaction) DeleteText(at Path, offset, length int) {
	if length <= 0 {
		return
	}
	t.ApplyText(at, Delta{}.Retain(offset, nil).Delete(length))
}

// FormatText sets attributes on a range (nil removes one).
func (t *Transaction) FormatText(at Path, offset, length int, attrs Attrs) {
	if length <= 0 {
		return
	}
	t.ApplyText(at, Delta{}.Retain(offset, nil).Retain(length, attrs))
}

// ReplaceText deletes a range and inserts a delta in its place.
func (t *Transaction) ReplaceText(at Path, offset, length int, with Delta) {
	change := Delta{}.Retain(offset, nil).Delete(length)
	for _, o := range with {
		change = change.push(o)
	}
	t.ApplyText(at, change)
}

// Inverse returns the operations that undo this transaction, in order.
func (t *Transaction) Inverse() []Operation {
	out := make([]Operation, len(t.Ops))
	for i, op := range t.Ops {
		out[len(t.Ops)-1-i] = op.Invert()
	}
	return out
}
