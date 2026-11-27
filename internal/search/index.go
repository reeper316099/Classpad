package search

import (
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
)

// Doc is one searchable item (packages/server search.ts SearchDoc).
type Doc struct {
	ID      string
	Kind    string // note, assignment, task, reading
	Title   string
	Body    string
	ClassID string
	Tags    []string
	Types   []string
	Due     string
}

// Hit is what the API returns per result.
type Hit struct {
	Snippet *string `json:"snippet,omitempty"`
	ID      string  `json:"id"`
	Kind    string  `json:"kind"`
	Title   string  `json:"title"`
	ClassID string  `json:"classId,omitempty"`
	Score   float64 `json:"score"`
}

// Index is the search index: a MiniSearch over title, body and tags plus the documents.
type Index struct {
	ms    *MiniSearch
	order []string
	docs  map[string]Doc
}

func NewIndex() *Index {
	extract := func(d any, field string) (string, bool) {
		doc := d.(Doc)
		switch field {
		case "title":
			return doc.Title, true
		case "body":
			return doc.Body, true
		case "tags":
			return strings.Join(doc.Tags, " "), true
		}
		return "", false
	}
	store := func(d any, field string) (any, bool) {
		doc := d.(Doc)
		switch field {
		case "kind":
			return doc.Kind, true
		case "title":
			return doc.Title, true
		case "classId":
			return doc.ClassID, doc.ClassID != ""
		}
		return nil, false
	}
	return &Index{
		ms:   NewMiniSearch([]string{"title", "body", "tags"}, []string{"kind", "title", "classId"}, extract, store),
		docs: map[string]Doc{},
	}
}

func (x *Index) Size() int { return len(x.docs) }

// Rebuild replaces everything.
func (x *Index) Rebuild(docs []Doc) {
	x.ms.RemoveAll()
	x.docs, x.order = map[string]Doc{}, nil
	for _, d := range docs {
		x.ms.Add(d.ID, d)
	}
	for _, d := range docs {
		x.setDoc(d)
	}
}

func (x *Index) setDoc(d Doc) {
	if _, ok := x.docs[d.ID]; !ok {
		x.order = append(x.order, d.ID)
	}
	x.docs[d.ID] = d
}

// Upsert adds or replaces one document.
func (x *Index) Upsert(d Doc) {
	if _, ok := x.docs[d.ID]; ok {
		x.ms.Discard(d.ID)
	}
	x.ms.Add(d.ID, d)
	x.setDoc(d)
}

// Remove drops a document.
func (x *Index) Remove(id string) {
	if _, ok := x.docs[id]; !ok {
		return
	}
	delete(x.docs, id)
	for i, o := range x.order {
		if o == id {
			x.order = append(x.order[:i:i], x.order[i+1:]...)
			break
		}
	}
	x.ms.Discard(id)
}

var operators = regexp.MustCompile(`(?i)\b(class|type|tag|due):("[^"]*"|[^\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+)`)

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// ParseQuery splits operators (class: type: tag: due:) from the free text.
func ParseQuery(q string) (string, map[string][]string) {
	ops := map[string][]string{}
	text := operators.ReplaceAllStringFunc(q, func(m string) string {
		sub := operators.FindStringSubmatch(m)
		k := strings.ToLower(sub[1])
		v := sub[2]
		v = strings.TrimPrefix(v, `"`)
		v = strings.TrimSuffix(v, `"`)
		ops[k] = append(ops[k], jsLower(v))
		return " "
	})
	return jsTrim(text), ops
}

// Search finds documents. classMatches resolves a class: value to class ids.
func (x *Index) Search(q string, classMatches func(term string) map[string]bool, limit int, now time.Time) []Hit {
	text, ops := ParseQuery(q)
	var classSets []map[string]bool
	for _, c := range ops["class"] {
		classSets = append(classSets, classMatches(c))
	}
	day := func(t time.Time) string { return t.UTC().Format("2006-01-02") }
	today, week, tomorrow := day(now), day(now.Add(7*24*time.Hour)), day(now.Add(24*time.Hour))
	ok := func(d Doc) bool {
		for _, s := range classSets {
			if d.ClassID == "" || !s[d.ClassID] {
				return false
			}
		}
		for _, t := range ops["type"] {
			hit := d.Kind == t
			for _, x := range d.Types {
				hit = hit || jsLower(x) == t
			}
			if !hit {
				return false
			}
		}
		for _, t := range ops["tag"] {
			want := strings.TrimPrefix(t, "#")
			hit := false
			for _, x := range d.Tags {
				hit = hit || jsLower(x) == want
			}
			if !hit {
				return false
			}
		}
		for _, t := range ops["due"] {
			due := d.Due
			if len(due) > 10 {
				due = due[:10]
			}
			if due == "" {
				return false
			}
			var bad bool
			switch t {
			case "today":
				bad = due != today
			case "tomorrow":
				bad = due != tomorrow
			case "week":
				bad = due < today || due > week
			case "overdue":
				bad = due >= today
			default:
				bad = due != t
			}
			if bad {
				return false
			}
		}
		return true
	}
	hits := []Hit{}
	if text == "" {
		for _, id := range x.order {
			if len(hits) >= limit {
				break
			}
			d := x.docs[id]
			if ok(d) {
				hits = append(hits, Hit{ID: d.ID, Kind: d.Kind, Title: d.Title, ClassID: d.ClassID, Score: 0})
			}
		}
		return hits
	}
	var terms []string
	for _, t := range strings.FieldsFunc(jsLower(text), isJSSpace) {
		terms = append(terms, t)
	}
	results := x.ms.Search(text, SearchOptions{
		Prefix: true, Fuzzy: 0.15, Boost: map[string]float64{"title": 3, "tags": 2},
		Filter: func(r Result) bool { return ok(x.docs[r.ID]) },
	})
	for i, r := range results {
		if i >= limit {
			break
		}
		h := Hit{ID: r.ID, Score: r.Score}
		h.Kind, _ = r.Stored["kind"].(string)
		h.Title, _ = r.Stored["title"].(string)
		h.ClassID, _ = r.Stored["classId"].(string)
		h.Snippet = snippet(x.docs[r.ID].Body, terms)
		hits = append(hits, h)
	}
	return hits
}

// snippet is the text around the first matched term (positions in UTF-16 units, like JavaScript).
func snippet(body string, terms []string) *string {
	if body == "" {
		return nil
	}
	b16 := utf16.Encode([]rune(body))
	lower := utf16.Encode([]rune(jsLower(body)))
	at := -1
	for _, t := range terms {
		if i := indexU16(lower, utf16.Encode([]rune(t))); i >= 0 && (at < 0 || i < at) {
			at = i
		}
	}
	if at < 0 {
		return nil
	}
	from := max(0, at-50)
	to := min(len(b16), at+90)
	// .replace(/\s+/g, ' ').trim()
	piece := strings.Join(strings.FieldsFunc(string(utf16.Decode(b16[from:to])), isJSSpace), " ")
	if from > 0 {
		piece = "…" + piece
	}
	return &piece
}

func indexU16(s, sub []uint16) int {
	if len(sub) == 0 {
		return 0
	}
outer:
	for i := 0; i+len(sub) <= len(s); i++ {
		for j := range sub {
			if s[i+j] != sub[j] {
				continue outer
			}
		}
		return i
	}
	return -1
}
