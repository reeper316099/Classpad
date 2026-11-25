package doc

import (
	"crypto/rand"
	"encoding/hex"
	"maps"
)

// Block types. The names follow AppFlowy's.
const (
	Page         = "page"
	Paragraph    = "paragraph"
	Heading      = "heading"       // level 1–6
	Todo         = "todo_list"     // checked
	Bulleted     = "bulleted_list" //
	Numbered     = "numbered_list" // number: the first item's number
	Quote        = "quote"
	Callout      = "callout" // icon
	Code         = "code"    // language
	Divider      = "divider"
	Toggle       = "toggle_list" // level 0–3 (toggle heading), collapsed
	MathBlock    = "math_equation"
	Table        = "table" // rows: [][]string of cell Markdown
	Image        = "image" // url, alt
	Raw          = "raw"   // Markdown the editor does not model, kept verbatim (text)
	AttrLevel    = "level"
	AttrChecked  = "checked"
	AttrNumber   = "number"
	AttrIcon     = "icon"
	AttrLanguage = "language"
	AttrFormula  = "formula"
	AttrRows     = "rows"
	AttrURL      = "url"
	AttrAlt      = "alt"
	AttrText     = "text"
	AttrCollapse = "collapsed"
)

// HasText reports whether a block type holds editable rich text (a Delta).
func HasText(t string) bool {
	switch t {
	case Paragraph, Heading, Todo, Bulleted, Numbered, Quote, Callout, Code, Toggle:
		return true
	}
	return false
}

// CanHaveChildren reports whether a block can nest other blocks (Tab indents into it).
func CanHaveChildren(t string) bool {
	switch t {
	case Page, Todo, Bulleted, Numbered, Toggle:
		return true
	}
	return false
}

// Node is one block. Text blocks keep their content in Delta.
type Node struct {
	ID       string  `json:"id"`
	Type     string  `json:"type"`
	Attrs    Attrs   `json:"data,omitempty"`
	Delta    Delta   `json:"delta,omitempty"`
	Children []*Node `json:"children,omitempty"`
}

func NewID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// NewNode makes a block with a fresh id.
func NewNode(t string, attrs Attrs, text Delta, children ...*Node) *Node {
	return &Node{ID: NewID(), Type: t, Attrs: attrs, Delta: text, Children: children}
}

// Text makes a block holding plain text.
func Text(t string, s string, attrs Attrs) *Node {
	var d Delta
	if s != "" {
		d = d.Insert(s, nil)
	}
	return NewNode(t, attrs, d)
}

// Clone deep-copies a node, keeping ids.
func (n *Node) Clone() *Node {
	c := &Node{ID: n.ID, Type: n.Type, Attrs: cloneAnyAttrs(n.Attrs), Delta: n.Delta.Clone()}
	for _, ch := range n.Children {
		c.Children = append(c.Children, ch.Clone())
	}
	return c
}

// Copy deep-copies with fresh ids (duplicate, paste).
func (n *Node) Copy() *Node {
	c := n.Clone()
	var walk func(*Node)
	walk = func(x *Node) {
		x.ID = NewID()
		for _, ch := range x.Children {
			walk(ch)
		}
	}
	walk(c)
	return c
}

func cloneAnyAttrs(a Attrs) Attrs {
	if a == nil {
		return nil
	}
	out := maps.Clone(a)
	for k, v := range out {
		if rows, ok := v.([][]string); ok {
			cp := make([][]string, len(rows))
			for i, r := range rows {
				cp[i] = append([]string(nil), r...)
			}
			out[k] = cp
		}
	}
	return out
}

// Attr reads an attribute with a fallback.
func (n *Node) Attr(k string) any {
	if n.Attrs == nil {
		return nil
	}
	return n.Attrs[k]
}

func (n *Node) Int(k string, def int) int {
	switch v := n.Attr(k).(type) {
	case int:
		return v
	case float64:
		return int(v)
	}
	return def
}

func (n *Node) Bool(k string) bool { b, _ := n.Attr(k).(bool); return b }

func (n *Node) String(k string) string { s, _ := n.Attr(k).(string); return s }

// Rows reads a table's cells, whether they came from Go or from JSON.
func (n *Node) Rows() [][]string {
	switch v := n.Attr(AttrRows).(type) {
	case [][]string:
		return v
	case []any:
		out := make([][]string, 0, len(v))
		for _, r := range v {
			var row []string
			if cells, ok := r.([]any); ok {
				for _, c := range cells {
					s, _ := c.(string)
					row = append(row, s)
				}
			}
			out = append(out, row)
		}
		return out
	}
	return nil
}
