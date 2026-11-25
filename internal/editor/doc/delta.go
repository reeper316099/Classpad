package doc

import (
	"encoding/json"
	"maps"
	"sort"
	"strings"
)

// Attrs are inline formatting (bold, italic, code, strikethrough, underline, href, wiki, formula) or
// block attributes (level, checked, language…). A nil value in a change means "remove this attribute".
type Attrs map[string]any

// Op is one step of a Delta, as in AppFlowy (and Quill): insert text, retain (skip) characters, or delete
// characters. A document's text is a Delta of inserts only; a change to it may use all three.
type Op struct {
	Insert string `json:"insert,omitempty"`
	Retain int    `json:"retain,omitempty"`
	Delete int    `json:"delete,omitempty"`
	Attrs  Attrs  `json:"attributes,omitempty"`
}

func (o Op) Len() int {
	switch {
	case o.Delete > 0:
		return o.Delete
	case o.Retain > 0:
		return o.Retain
	default:
		return Len16(o.Insert)
	}
}

// Delta is a list of ops. The zero value is empty text.
type Delta []Op

// Embed is the single placeholder character an inline embed (an inline equation) occupies.
const Embed = "￼"

func cloneAttrs(a Attrs) Attrs {
	if len(a) == 0 {
		return nil
	}
	return maps.Clone(a)
}

func AttrsEqual(a, b Attrs) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		w, ok := b[k]
		if !ok || !valueEqual(v, w) {
			return false
		}
	}
	return true
}

func valueEqual(a, b any) bool {
	if a == b {
		return true
	}
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

// push appends an op, merging it with the previous one when they are of the same kind and formatting.
func (d Delta) push(o Op) Delta {
	if o.Len() == 0 {
		return d
	}
	if n := len(d); n > 0 {
		last := &d[n-1]
		switch {
		case o.Delete > 0 && last.Delete > 0:
			last.Delete += o.Delete
			return d
		case o.Retain > 0 && last.Retain > 0 && AttrsEqual(o.Attrs, last.Attrs):
			last.Retain += o.Retain
			return d
		case o.Insert != "" && last.Insert != "" && AttrsEqual(o.Attrs, last.Attrs) &&
			o.Insert != Embed && last.Insert != Embed:
			last.Insert += o.Insert
			return d
		}
	}
	o.Attrs = cloneAttrs(o.Attrs)
	return append(d, o)
}

// Insert / Retain / Delete build a change delta fluently.
func (d Delta) Insert(text string, a Attrs) Delta { return d.push(Op{Insert: text, Attrs: a}) }
func (d Delta) Retain(n int, a Attrs) Delta       { return d.push(Op{Retain: n, Attrs: a}) }
func (d Delta) Delete(n int) Delta                { return d.push(Op{Delete: n}) }

// Len is the text length in UTF-16 units (inserts only).
func (d Delta) Len() int {
	n := 0
	for _, o := range d {
		if o.Insert != "" {
			n += Len16(o.Insert)
		}
	}
	return n
}

// Text is the plain text of a document delta.
func (d Delta) Text() string {
	var b strings.Builder
	for _, o := range d {
		b.WriteString(o.Insert)
	}
	return b.String()
}

func (d Delta) Clone() Delta {
	if d == nil {
		return nil
	}
	out := make(Delta, len(d))
	for i, o := range d {
		o.Attrs = cloneAttrs(o.Attrs)
		out[i] = o
	}
	return out
}

// iterator walks a delta op by op, handing out pieces of at most n units.
type iterator struct {
	ops    Delta
	i, off int
}

func (it *iterator) hasNext() bool { return it.i < len(it.ops) }

func (it *iterator) peekLen() int {
	if !it.hasNext() {
		return 1 << 30
	}
	return it.ops[it.i].Len() - it.off
}

func (it *iterator) peekKind() string {
	if !it.hasNext() {
		return "retain"
	}
	o := it.ops[it.i]
	switch {
	case o.Delete > 0:
		return "delete"
	case o.Retain > 0:
		return "retain"
	}
	return "insert"
}

func (it *iterator) next(n int) Op {
	if !it.hasNext() {
		return Op{Retain: n}
	}
	o := it.ops[it.i]
	rem := o.Len() - it.off
	if n >= rem {
		n = rem
	}
	var out Op
	switch {
	case o.Delete > 0:
		out = Op{Delete: n}
	case o.Retain > 0:
		out = Op{Retain: n, Attrs: o.Attrs}
	default:
		out = Op{Insert: Slice16(o.Insert, it.off, it.off+n), Attrs: o.Attrs}
	}
	it.off += n
	if it.off >= o.Len() {
		it.i++
		it.off = 0
	}
	return out
}

func composeAttrs(base, change Attrs, keepNil bool) Attrs {
	out := Attrs{}
	maps.Copy(out, base)
	for k, v := range change {
		if v == nil && !keepNil {
			delete(out, k)
		} else {
			out[k] = v
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// Compose applies change on top of d (both may be change deltas).
func (d Delta) Compose(change Delta) Delta {
	a, b := &iterator{ops: d}, &iterator{ops: change}
	var out Delta
	for a.hasNext() || b.hasNext() {
		switch {
		case b.peekKind() == "insert" && b.hasNext():
			out = out.push(b.next(b.peekLen()))
		case a.peekKind() == "delete" && a.hasNext():
			out = out.push(a.next(a.peekLen()))
		default:
			n := min(a.peekLen(), b.peekLen())
			x, y := a.next(n), b.next(n)
			if y.Retain > 0 {
				if x.Retain > 0 {
					out = out.push(Op{Retain: n, Attrs: composeAttrs(x.Attrs, y.Attrs, true)})
				} else {
					out = out.push(Op{Insert: x.Insert, Attrs: composeAttrs(x.Attrs, y.Attrs, false)})
				}
			} else if y.Delete > 0 && x.Retain > 0 {
				out = out.push(y)
			}
			// insert followed by delete cancels out
		}
	}
	return out.chop()
}

// chop drops a trailing plain retain, which changes nothing.
func (d Delta) chop() Delta {
	if n := len(d); n > 0 && d[n-1].Retain > 0 && len(d[n-1].Attrs) == 0 {
		return d[:n-1]
	}
	return d
}

// Invert returns the change that undoes change when applied after it to base.
func (change Delta) Invert(base Delta) Delta {
	var inv Delta
	it := &iterator{ops: base}
	for _, o := range change {
		switch {
		case o.Insert != "":
			inv = inv.Delete(o.Len())
		case o.Retain > 0 && len(o.Attrs) == 0:
			inv = inv.Retain(o.Retain, nil)
			it.skip(o.Retain)
		default:
			n := o.Len()
			for n > 0 {
				p := it.next(n)
				n -= p.Len()
				if o.Delete > 0 {
					inv = inv.push(Op{Insert: p.Insert, Attrs: p.Attrs})
				} else {
					undo := Attrs{}
					for k := range o.Attrs {
						if v, ok := p.Attrs[k]; ok {
							undo[k] = v
						} else {
							undo[k] = nil
						}
					}
					inv = inv.push(Op{Retain: p.Len(), Attrs: undo})
				}
			}
		}
	}
	return inv.chop()
}

func (it *iterator) skip(n int) {
	for n > 0 && it.hasNext() {
		n -= it.next(n).Len()
	}
}

// Slice returns the document delta between two offsets.
func (d Delta) Slice(from, to int) Delta {
	it := &iterator{ops: d}
	it.skip(from)
	var out Delta
	for n := to - from; n > 0 && it.hasNext(); {
		p := it.next(n)
		n -= p.Len()
		out = out.push(p)
	}
	return out
}

// Concat joins two document deltas.
func (d Delta) Concat(e Delta) Delta {
	out := d.Clone()
	for _, o := range e {
		out = out.push(o)
	}
	return out
}

// AttrsAt is the formatting of the character before offset (what typed text inherits).
func (d Delta) AttrsAt(offset int) Attrs {
	pos := 0
	var last Attrs
	for _, o := range d {
		l := o.Len()
		if offset > pos && offset <= pos+l {
			return o.Attrs
		}
		pos += l
		last = o.Attrs
	}
	if offset == 0 {
		return nil
	}
	return last
}

// CommonAttrs returns the formatting shared by every character in [from, to), e.g. to show a toolbar
// button as active.
func (d Delta) CommonAttrs(from, to int) Attrs {
	s := d.Slice(from, to)
	if len(s) == 0 {
		return nil
	}
	out := cloneAttrs(s[0].Attrs)
	for _, o := range s[1:] {
		for k, v := range out {
			if w, ok := o.Attrs[k]; !ok || !valueEqual(v, w) {
				delete(out, k)
			}
		}
	}
	return out
}

// SortedKeys gives deterministic attribute order (for encoding).
func SortedKeys(a Attrs) []string {
	keys := make([]string, 0, len(a))
	for k := range a {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
