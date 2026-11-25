package doc

import "unicode/utf16"

// Offsets in the editor are UTF-16 code units, the unit the browser's DOM selection uses, so a position the
// UI reads from the page can be used as is. These helpers convert between that and Go's UTF-8 strings.

// Len16 is the length of s in UTF-16 code units.
func Len16(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// Slice16 returns s[from:to] counted in UTF-16 code units. A cut through a surrogate pair moves outward
// to keep the character whole.
func Slice16(s string, from, to int) string {
	if from < 0 {
		from = 0
	}
	if to < from {
		to = from
	}
	start, end := len(s), len(s)
	pos := 0
	startSet := false
	for i, r := range s {
		w := utf16.RuneLen(r)
		if !startSet && pos+w > from {
			start = i
			startSet = true
		}
		if pos >= to {
			end = i
			break
		}
		pos += w
	}
	if !startSet {
		return ""
	}
	return s[start:end]
}
