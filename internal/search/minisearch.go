// Package search is the server's full-text search: a port of the parts of MiniSearch 7 the
// TypeScript server uses (prefix and fuzzy search, BM25+ scoring, field boosts), including its
// radix tree and iteration order, so results and scores come out the same.
package search

import (
	"math"
	"strings"
	"unicode"
	"unicode/utf16"
)

// ---------------- UTF-16 keys ----------------

// MiniSearch works on JavaScript strings (UTF-16 code units). A u16 holds the units in a Go string
// (two bytes each) so the radix tree can slice and compare them the same way.
type u16 string

func toU16(s string) u16 {
	units := utf16.Encode([]rune(s))
	b := make([]byte, 2*len(units))
	for i, u := range units {
		b[2*i], b[2*i+1] = byte(u>>8), byte(u)
	}
	return u16(b)
}

func (k u16) len() int        { return len(k) / 2 }
func (k u16) at(i int) uint16 { return uint16(k[2*i])<<8 | uint16(k[2*i+1]) }
func (k u16) slice(a, b int) u16 {
	return k[2*a : 2*b]
}

func (k u16) String() string {
	units := make([]uint16, k.len())
	for i := range units {
		units[i] = k.at(i)
	}
	return string(utf16.Decode(units))
}

// ---------------- radix tree (SearchableMap) ----------------

const leaf = u16("")

// node is a Map of edge label to child (or, under leaf, the value): insertion order kept.
type node struct {
	keys     []u16
	children map[u16]*node
	value    *termData // under the leaf key
	hasValue bool
}

func newNode() *node { return &node{children: map[u16]*node{}} }

func (n *node) has(k u16) bool {
	if k == leaf {
		return n.hasValue
	}
	_, ok := n.children[k]
	return ok
}

func (n *node) setChild(k u16, c *node) {
	if _, ok := n.children[k]; !ok {
		n.keys = append(n.keys, k)
	}
	n.children[k] = c
}

func (n *node) setValue(v *termData) {
	if !n.hasValue {
		n.keys = append(n.keys, leaf)
	}
	n.value, n.hasValue = v, true
}

func (n *node) del(k u16) {
	if k == leaf {
		if !n.hasValue {
			return
		}
		n.value, n.hasValue = nil, false
	} else {
		if _, ok := n.children[k]; !ok {
			return
		}
		delete(n.children, k)
	}
	for i, x := range n.keys {
		if x == k {
			n.keys = append(n.keys[:i:i], n.keys[i+1:]...)
			break
		}
	}
}

func (n *node) size() int { return len(n.keys) }

func createPath(n *node, key u16) *node {
	pos := 0
	for pos < key.len() {
		found := false
		for _, k := range n.keys {
			if k == leaf || key.at(pos) != k.at(0) {
				continue
			}
			l := min(key.len()-pos, k.len())
			offset := 1
			for offset < l && key.at(pos+offset) == k.at(offset) {
				offset++
			}
			child := n.children[k]
			if offset == k.len() {
				n = child
			} else {
				inter := newNode()
				inter.setChild(k.slice(offset, k.len()), child)
				n.setChild(key.slice(pos, pos+offset), inter)
				n.del(k)
				n = inter
			}
			pos += offset
			found = true
			break
		}
		if !found {
			child := newNode()
			n.setChild(key.slice(pos, key.len()), child)
			return child
		}
	}
	return n
}

func lookup(n *node, key u16) *node {
	for key.len() > 0 && n != nil {
		var next *node
		for _, k := range n.keys {
			if k != leaf && strings.HasPrefix(string(key), string(k)) {
				next, key = n.children[k], key[len(k):]
				break
			}
		}
		if next == nil {
			return nil
		}
		n = next
	}
	return n
}

type step struct {
	n *node
	k u16
}

func trackDown(n *node, key u16) (*node, []step) {
	var path []step
	for key.len() > 0 && n != nil {
		var next *node
		var nk u16
		for _, k := range n.keys {
			if k != leaf && strings.HasPrefix(string(key), string(k)) {
				next, nk = n.children[k], k
				break
			}
		}
		if next == nil {
			path = append(path, step{n, key})
			return nil, path
		}
		path = append(path, step{n, nk})
		n, key = next, key[len(nk):]
	}
	return n, path
}

func removeKey(tree *node, key u16) {
	n, path := trackDown(tree, key)
	if n == nil {
		return
	}
	n.del(leaf)
	if n.size() == 0 {
		cleanup(path)
	} else if n.size() == 1 {
		k := n.keys[0]
		mergeNode(path, k, n.children[k])
	}
}

func cleanup(path []step) {
	if len(path) == 0 {
		return
	}
	last := path[len(path)-1]
	last.n.del(last.k)
	if last.n.size() == 0 {
		cleanup(path[:len(path)-1])
	} else if last.n.size() == 1 {
		k := last.n.keys[0]
		if k != leaf {
			mergeNode(path[:len(path)-1], k, last.n.children[k])
		}
	}
}

func mergeNode(path []step, key u16, child *node) {
	if len(path) == 0 {
		return
	}
	last := path[len(path)-1]
	last.n.setChild(last.k+key, child)
	last.n.del(last.k)
}

// entries walks a (sub)tree the way MiniSearch's TreeIterator does: each node's keys from the last
// inserted to the first.
func entries(root *node, prefix u16, fn func(term u16, v *termData)) {
	var walk func(n *node, acc u16)
	walk = func(n *node, acc u16) {
		keys := append([]u16(nil), n.keys...)
		for i := len(keys) - 1; i >= 0; i-- {
			k := keys[i]
			if k == leaf {
				if n.hasValue {
					fn(prefix+acc, n.value)
				}
				continue
			}
			if c, ok := n.children[k]; ok {
				walk(c, acc+k)
			}
		}
	}
	walk(root, "")
}

// atPrefix returns the subtree of terms starting with prefix (and the prefix it stands for).
func atPrefix(tree *node, prefix u16) (*node, u16) {
	n, path := trackDown(tree, prefix)
	if n == nil {
		last := path[len(path)-1]
		for _, k := range last.n.keys {
			if k != leaf && strings.HasPrefix(string(k), string(last.k)) {
				sub := newNode()
				sub.setChild(k[len(last.k):], last.n.children[k])
				return sub, prefix
			}
		}
		return nil, prefix
	}
	return n, prefix
}

type fuzzyHit struct {
	term     u16
	data     *termData
	distance int
}

// fuzzyGet finds terms within maxDistance edits (Levenshtein), in MiniSearch's order.
func fuzzyGet(tree *node, query u16, maxDistance int) []fuzzyHit {
	n := query.len() + 1
	m := n + maxDistance
	matrix := make([]int, m*n)
	for i := range matrix {
		matrix[i] = maxDistance + 1
	}
	for j := 0; j < n; j++ {
		matrix[j] = j
	}
	for i := 1; i < m; i++ {
		matrix[i*n] = i
	}
	var out []fuzzyHit
	index := map[u16]int{}
	var recurse func(nd *node, mRow int, prefix u16)
	recurse = func(nd *node, mRow int, prefix u16) {
		offset := mRow * n
	keys:
		for _, key := range append([]u16(nil), nd.keys...) {
			if key == leaf {
				// Past the matrix JavaScript reads undefined, which never counts as a match.
				if offset-1 >= len(matrix) {
					continue
				}
				if d := matrix[offset-1]; d <= maxDistance {
					hit := fuzzyHit{prefix, nd.value, d}
					if i, ok := index[prefix]; ok {
						out[i] = hit // Map.set on an existing key keeps its place
					} else {
						index[prefix] = len(out)
						out = append(out, hit)
					}
				}
				continue
			}
			i := mRow
			for pos := 0; pos < key.len(); pos, i = pos+1, i+1 {
				if i >= m {
					continue // beyond the matrix (a Uint8Array): reads give undefined and nothing stops the walk
				}
				ch := key.at(pos)
				this, prev := n*i, n*i-n
				minD := matrix[this]
				jmin, jmax := max(0, i-maxDistance-1), min(n-1, i+maxDistance)
				for j := jmin; j < jmax; j++ {
					diff := 0
					if ch != query.at(j) {
						diff = 1
					}
					d := min(matrix[prev+j]+diff, matrix[prev+j+1]+1, matrix[this+j]+1)
					matrix[this+j+1] = d
					if d < minD {
						minD = d
					}
				}
				if minD > maxDistance {
					continue keys
				}
			}
			recurse(nd.children[key], i, prefix+key)
		}
	}
	recurse(tree, 1, "")
	return out
}

// ---------------- the index ----------------

// termData: field id → (short document id → term frequency), both in insertion order.
type termData struct {
	fields []int
	byF    map[int]*freqs
}

type freqs struct {
	docs []int
	f    map[int]int
}

func (t *termData) get(field int) *freqs { return t.byF[field] }

func (t *termData) delField(field int) {
	if _, ok := t.byF[field]; !ok {
		return
	}
	delete(t.byF, field)
	for i, x := range t.fields {
		if x == field {
			t.fields = append(t.fields[:i:i], t.fields[i+1:]...)
			break
		}
	}
}

func (f *freqs) del(doc int) {
	if _, ok := f.f[doc]; !ok {
		return
	}
	delete(f.f, doc)
	for i, x := range f.docs {
		if x == doc {
			f.docs = append(f.docs[:i:i], f.docs[i+1:]...)
			break
		}
	}
}

// MiniSearch indexes documents by fields.
type MiniSearch struct {
	fields       []string
	fieldIDs     map[string]int
	tree         *node
	docCount     int
	nextID       int
	ids          map[int]string // short id → id (documentIds)
	idOrder      []int
	shortOf      map[string]int
	fieldLength  map[int][]int
	avgFieldLen  []float64
	stored       map[int]map[string]any
	storeFields  []string
	dirt         int
	extract      func(doc any, field string) (string, bool)
	extractStore func(doc any, field string) (any, bool)
}

func NewMiniSearch(fields, storeFields []string, extract func(any, string) (string, bool), extractStore func(any, string) (any, bool)) *MiniSearch {
	ms := &MiniSearch{fields: fields, storeFields: storeFields, extract: extract, extractStore: extractStore}
	ms.fieldIDs = map[string]int{}
	for i, f := range fields {
		ms.fieldIDs[f] = i
	}
	ms.RemoveAll()
	return ms
}

func (ms *MiniSearch) RemoveAll() {
	ms.tree = newNode()
	ms.docCount, ms.nextID, ms.dirt = 0, 0, 0
	ms.ids, ms.shortOf = map[int]string{}, map[string]int{}
	ms.idOrder = nil
	ms.fieldLength = map[int][]int{}
	ms.avgFieldLen = make([]float64, len(ms.fields))
	ms.stored = map[int]map[string]any{}
}

func isSeparator(r rune) bool {
	return r == '\n' || r == '\r' || unicode.In(r, unicode.Z, unicode.P)
}

// tokenize is text.split(/[\n\r\p{Z}\p{P}]+/u): empty pieces at the ends are kept.
func tokenize(text string) []string {
	var out []string
	cur := strings.Builder{}
	inSep := false
	for _, r := range text {
		if isSeparator(r) {
			if !inSep {
				out = append(out, cur.String())
				cur.Reset()
				inSep = true
			}
			continue
		}
		inSep = false
		cur.WriteRune(r)
	}
	out = append(out, cur.String())
	return out
}

// jsLower is String.prototype.toLowerCase for the cases Go's ToLower differs on.
func jsLower(s string) string {
	if !strings.ContainsAny(s, "İΣ") {
		return strings.ToLower(s)
	}
	rs := []rune(s)
	var b strings.Builder
	for i, r := range rs {
		switch r {
		case 'İ':
			b.WriteString("i̇")
		case 'Σ':
			// final sigma: after a letter and not before one
			if i > 0 && unicode.IsLetter(rs[i-1]) && (i+1 == len(rs) || !unicode.IsLetter(rs[i+1])) {
				b.WriteRune('ς')
			} else {
				b.WriteRune('σ')
			}
		default:
			b.WriteString(strings.ToLower(string(r)))
		}
	}
	return b.String()
}

func (ms *MiniSearch) Has(id string) bool { _, ok := ms.shortOf[id]; return ok }

// Add indexes a document (its id must be new).
func (ms *MiniSearch) Add(id string, doc any) {
	short := ms.nextID
	ms.shortOf[id] = short
	ms.ids[short] = id
	ms.idOrder = append(ms.idOrder, short)
	ms.docCount++
	ms.nextID++
	if len(ms.storeFields) > 0 {
		st := map[string]any{}
		for _, f := range ms.storeFields {
			if v, ok := ms.extractStore(doc, f); ok {
				st[f] = v
			}
		}
		ms.stored[short] = st
	}
	for _, field := range ms.fields {
		text, ok := ms.extract(doc, field)
		if !ok {
			continue
		}
		tokens := tokenize(text)
		fid := ms.fieldIDs[field]
		unique := map[string]bool{}
		for _, t := range tokens {
			unique[t] = true
		}
		ms.addFieldLength(short, fid, ms.docCount-1, len(unique))
		for _, t := range tokens {
			if p := jsLower(t); p != "" {
				ms.addTerm(fid, short, toU16(p))
			}
		}
	}
}

func (ms *MiniSearch) addFieldLength(doc, fid, count, length int) {
	fl := ms.fieldLength[doc]
	for len(fl) <= fid {
		fl = append(fl, -1)
	}
	fl[fid] = length
	ms.fieldLength[doc] = fl
	ms.avgFieldLen[fid] = (ms.avgFieldLen[fid]*float64(count) + float64(length)) / float64(count+1)
}

func (ms *MiniSearch) removeFieldLength(fid, count, length int) {
	if count == 1 {
		ms.avgFieldLen[fid] = 0
		return
	}
	ms.avgFieldLen[fid] = (ms.avgFieldLen[fid]*float64(count) - float64(length)) / float64(count-1)
}

func (ms *MiniSearch) addTerm(fid, doc int, term u16) {
	n := createPath(ms.tree, term)
	if !n.hasValue {
		n.setValue(&termData{byF: map[int]*freqs{}})
	}
	td := n.value
	fr := td.byF[fid]
	if fr == nil {
		fr = &freqs{f: map[int]int{}}
		td.byF[fid] = fr
		td.fields = append(td.fields, fid)
	}
	if _, ok := fr.f[doc]; !ok {
		fr.docs = append(fr.docs, doc)
	}
	fr.f[doc]++
}

func (ms *MiniSearch) removeTerm(fid, doc int, term u16) {
	n := lookup(ms.tree, term)
	if n == nil || !n.hasValue {
		return
	}
	td := n.value
	fr := td.byF[fid]
	if fr == nil {
		return
	}
	if c, ok := fr.f[doc]; !ok {
		return
	} else if c <= 1 {
		if len(fr.docs) <= 1 {
			td.delField(fid)
		} else {
			fr.del(doc)
		}
	} else {
		fr.f[doc] = c - 1
	}
	if len(td.fields) == 0 {
		removeKey(ms.tree, term)
	}
}

// Discard removes a document; its terms are cleaned up lazily (and by vacuuming), as in MiniSearch.
func (ms *MiniSearch) Discard(id string) {
	short, ok := ms.shortOf[id]
	if !ok {
		return
	}
	delete(ms.shortOf, id)
	delete(ms.ids, short)
	for i, x := range ms.idOrder {
		if x == short {
			ms.idOrder = append(ms.idOrder[:i:i], ms.idOrder[i+1:]...)
			break
		}
	}
	delete(ms.stored, short)
	for fid, l := range ms.fieldLength[short] {
		if l >= 0 {
			ms.removeFieldLength(fid, ms.docCount, l)
		}
	}
	delete(ms.fieldLength, short)
	ms.docCount--
	ms.dirt++
	ms.maybeVacuum()
}

// maybeVacuum: MiniSearch vacuums once 20 documents and 10% of the index are stale. It runs
// asynchronously there; here it finishes at once.
func (ms *MiniSearch) maybeVacuum() {
	factor := float64(ms.dirt) / float64(1+ms.docCount+ms.dirt)
	if ms.dirt < 20 || factor < 0.1 {
		return
	}
	var terms []u16
	entries(ms.tree, "", func(t u16, _ *termData) { terms = append(terms, t) })
	for _, t := range terms {
		n := lookup(ms.tree, t)
		if n == nil || !n.hasValue {
			continue
		}
		td := n.value
		for _, fid := range append([]int(nil), td.fields...) {
			fr := td.byF[fid]
			for _, doc := range append([]int(nil), fr.docs...) {
				if _, live := ms.ids[doc]; live {
					continue
				}
				if len(fr.docs) <= 1 {
					td.delField(fid)
				} else {
					fr.del(doc)
				}
			}
		}
		if len(td.fields) == 0 {
			removeKey(ms.tree, t)
		}
	}
	ms.dirt = 0
}

// Result is one search hit.
type Result struct {
	ID     string
	Score  float64
	Stored map[string]any
}

type rawResult struct {
	score float64
	terms []u16
	match []u16
}

type rawResults struct {
	order []int
	m     map[int]*rawResult
}

// SearchOptions: prefix and fuzzy matching, field boosts.
type SearchOptions struct {
	Prefix bool
	Fuzzy  float64
	Boost  map[string]float64
	Filter func(Result) bool
}

func bm25(termFreq, matching, total int, fieldLength, avg float64) float64 {
	const k, b, d = 1.2, 0.7, 0.5
	idf := math.Log(1 + (float64(total)-float64(matching)+0.5)/(float64(matching)+0.5))
	tf := float64(termFreq)
	return idf * (d + tf*(k+1)/(tf+k*(1-b+b*fieldLength/avg)))
}

func addUnique(list []u16, t u16) []u16 {
	for _, x := range list {
		if x == t {
			return list
		}
	}
	return append(list, t)
}

func (ms *MiniSearch) termResults(source, derived u16, weight float64, data *termData, o SearchOptions, res *rawResults) {
	if data == nil {
		return
	}
	for _, field := range ms.fields {
		boost := o.Boost[field]
		if boost == 0 {
			boost = 1
		}
		fid := ms.fieldIDs[field]
		fr := data.get(fid)
		if fr == nil {
			continue
		}
		matching := len(fr.docs)
		avg := ms.avgFieldLen[fid]
		for _, doc := range append([]int(nil), fr.docs...) {
			if _, live := ms.ids[doc]; !live {
				ms.removeTerm(fid, doc, derived)
				matching--
				continue
			}
			tf := fr.f[doc]
			fl := float64(ms.fieldLength[doc][fid])
			score := weight * boost * bm25(tf, matching, ms.docCount, fl, avg)
			if r := res.m[doc]; r != nil {
				r.score += score
				r.terms = addUnique(r.terms, source)
				r.match = addUnique(r.match, derived)
			} else {
				res.m[doc] = &rawResult{score: score, terms: []u16{source}, match: []u16{derived}}
				res.order = append(res.order, doc)
			}
		}
	}
}

func (ms *MiniSearch) querySpec(term u16, o SearchOptions) *rawResults {
	res := &rawResults{m: map[int]*rawResult{}}
	var data *termData
	if n := lookup(ms.tree, term); n != nil && n.hasValue {
		data = n.value
	}
	ms.termResults(term, term, 1, data, o, res)
	type match struct {
		term u16
		data *termData
	}
	var prefixHits []match
	if o.Prefix {
		if sub, _ := atPrefix(ms.tree, term); sub != nil {
			entries(sub, term, func(t u16, d *termData) { prefixHits = append(prefixHits, match{t, d}) })
		}
	}
	var fuzzy []fuzzyHit
	if o.Fuzzy > 0 {
		maxD := min(6, int(math.Floor(float64(term.len())*o.Fuzzy+0.5)))
		if maxD > 0 {
			fuzzy = fuzzyGet(ms.tree, term, maxD)
		}
	}
	dropFuzzy := map[u16]bool{}
	for _, h := range prefixHits {
		dist := h.term.len() - term.len()
		if dist == 0 {
			continue
		}
		dropFuzzy[h.term] = true
		w := 0.375 * float64(h.term.len()) / (float64(h.term.len()) + 0.3*float64(dist))
		ms.termResults(term, h.term, w, h.data, o, res)
	}
	for _, h := range fuzzy {
		if dropFuzzy[h.term] || h.distance == 0 {
			continue
		}
		w := 0.45 * float64(h.term.len()) / float64(h.term.len()+h.distance)
		ms.termResults(term, h.term, w, h.data, o, res)
	}
	return res
}

// Search runs a query: each term is matched exactly, by prefix and fuzzily, and the per-term
// results are combined with OR, as MiniSearch does.
func (ms *MiniSearch) Search(query string, o SearchOptions) []Result {
	var all *rawResults
	for _, t := range tokenize(query) {
		p := jsLower(t)
		if p == "" {
			continue
		}
		r := ms.querySpec(toU16(p), o)
		if all == nil {
			all = r
			continue
		}
		for _, doc := range r.order {
			b := r.m[doc]
			if a := all.m[doc]; a == nil {
				all.m[doc] = b
				all.order = append(all.order, doc)
			} else {
				a.score += b.score
				for _, m := range b.match {
					a.match = addUnique(a.match, m)
				}
				for _, t := range b.terms {
					a.terms = addUnique(a.terms, t)
				}
			}
		}
	}
	if all == nil {
		return nil
	}
	var out []Result
	for _, doc := range all.order {
		r := all.m[doc]
		q := len(r.terms)
		if q == 0 {
			q = 1
		}
		res := Result{ID: ms.ids[doc], Score: r.score * float64(q), Stored: ms.stored[doc]}
		if o.Filter == nil || o.Filter(res) {
			out = append(out, res)
		}
	}
	// stable sort by score, highest first
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Score > out[j-1].Score; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}
