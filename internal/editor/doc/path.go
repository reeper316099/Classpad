package doc

// Path addresses a block by child indexes from the page root: [2, 0] is the first child of the third block.
type Path []int

func (p Path) Clone() Path { return append(Path(nil), p...) }

func (p Path) Equal(q Path) bool {
	if len(p) != len(q) {
		return false
	}
	for i := range p {
		if p[i] != q[i] {
			return false
		}
	}
	return true
}

// Compare orders paths in document order (a parent comes before its children).
func (p Path) Compare(q Path) int {
	for i := 0; i < len(p) && i < len(q); i++ {
		if p[i] != q[i] {
			if p[i] < q[i] {
				return -1
			}
			return 1
		}
	}
	return len(p) - len(q)
}

func (p Path) Parent() Path {
	if len(p) == 0 {
		return nil
	}
	return p[:len(p)-1].Clone()
}

func (p Path) Last() int { return p[len(p)-1] }

// Next is the following sibling's path.
func (p Path) Next() Path {
	q := p.Clone()
	q[len(q)-1]++
	return q
}

// Prev is the previous sibling's path (callers check Last() > 0).
func (p Path) Prev() Path {
	q := p.Clone()
	q[len(q)-1]--
	return q
}

// Child is the path of this block's i-th child.
func (p Path) Child(i int) Path { return append(p.Clone(), i) }

// IsAncestorOf reports whether q lies inside p.
func (p Path) IsAncestorOf(q Path) bool {
	if len(p) >= len(q) {
		return false
	}
	for i := range p {
		if p[i] != q[i] {
			return false
		}
	}
	return true
}

// AfterInsert shifts p for nodes inserted at at (AppFlowy's transformPath).
func (p Path) AfterInsert(at Path, count int) Path {
	return shift(p, at, count)
}

// AfterDelete shifts p for nodes deleted at at; ok is false when p was inside what was deleted.
func (p Path) AfterDelete(at Path, count int) (Path, bool) {
	if len(p) >= len(at) {
		d := len(at) - 1
		if p[:d].Compare(at[:d]) == 0 && p[d] >= at[d] && p[d] < at[d]+count {
			return nil, false
		}
	}
	return shift(p, at, -count), true
}

func shift(p, at Path, delta int) Path {
	if len(at) == 0 || len(p) < len(at) {
		return p
	}
	d := len(at) - 1
	if Path(p[:d]).Compare(at[:d]) != 0 || p[d] < at[d] {
		return p
	}
	q := p.Clone()
	q[d] += delta
	return q
}
