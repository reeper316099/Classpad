package doc

// Position is a caret: a block path and a UTF-16 offset into its text.
type Position struct {
	Path   Path `json:"path"`
	Offset int  `json:"offset"`
}

func (a Position) Compare(b Position) int {
	if c := a.Path.Compare(b.Path); c != 0 {
		return c
	}
	return a.Offset - b.Offset
}

func (a Position) Equal(b Position) bool { return a.Compare(b) == 0 }

// Selection runs from Start (anchor) to End (focus); either order is allowed.
type Selection struct {
	Start Position `json:"start"`
	End   Position `json:"end"`
}

func Caret(p Path, off int) Selection {
	return Selection{Start: Position{Path: p.Clone(), Offset: off}, End: Position{Path: p.Clone(), Offset: off}}
}

func (s Selection) Collapsed() bool { return s.Start.Equal(s.End) }

// Normalized returns the selection with Start before End.
func (s Selection) Normalized() Selection {
	if s.Start.Compare(s.End) > 0 {
		return Selection{Start: s.End, End: s.Start}
	}
	return s
}

func (s Selection) SingleBlock() bool { return s.Start.Path.Equal(s.End.Path) }
