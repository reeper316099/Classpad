package server

import (
	"sort"
	"strings"
	"sync"

	"github.com/reeper316099/classpad/internal/jsonstore"
	"github.com/reeper316099/classpad/internal/jsv"
	"github.com/reeper316099/classpad/internal/schema"
)

// RepoSpec describes a collection stored as `{ schemaVersion, items }` JSON files.
type RepoSpec struct {
	Name     string
	Schema   *schema.Object
	Location string // a directory (one file per group) or a single .json file
	FileFor  func(e *jsv.Obj) string
	// BeforeCreate runs on a draft before validation (assign slugs, defaults).
	BeforeCreate func(d *jsv.Obj) *jsv.Obj
	// Validate runs on the validated entity before it is written (references).
	Validate func(e *jsv.Obj) error
}

// Repo is an in-memory collection persisted to JSON files; each change rewrites only the affected
// files, in one atomic batch.
type Repo struct {
	store *jsonstore.Store
	bus   *Bus
	spec  RepoSpec

	mu    sync.Mutex // serializes writes (the TypeScript queue)
	rw    sync.RWMutex
	order []string // insertion order of ids (Map order)
	items map[string]*jsv.Obj
	files map[string]string
}

func NewRepo(store *jsonstore.Store, bus *Bus, spec RepoSpec) *Repo {
	return &Repo{store: store, bus: bus, spec: spec, items: map[string]*jsv.Obj{}, files: map[string]string{}}
}

func (r *Repo) Name() string           { return r.spec.Name }
func (r *Repo) Schema() *schema.Object { return r.spec.Schema }
func (r *Repo) isFile() bool           { return strings.HasSuffix(r.spec.Location, ".json") }

// Owns says whether a data file belongs to this collection.
func (r *Repo) Owns(rel string) bool {
	if r.isFile() {
		return rel == r.spec.Location
	}
	return strings.HasPrefix(rel, r.spec.Location+"/") && strings.HasSuffix(rel, ".json")
}

func (r *Repo) fileSchema() schema.Schema {
	return schema.Obj(schema.F("schemaVersion", schema.Number()), schema.F("items", schema.Array(r.spec.Schema)))
}

// ValidateText checks a hand-edited file.
func (r *Repo) ValidateText(text string) error {
	v, err := jsv.Parse(text)
	if err != nil {
		return err
	}
	_, err = schema.Parse(r.fileSchema(), v)
	return err
}

func (r *Repo) validator() jsonstore.Validate {
	return func(v any) (any, error) {
		return schema.Parse(r.fileSchema(), toJSV(v))
	}
}

// toJSV turns jsonstore's maps into ordered objects (keys sorted, as in the file).
func toJSV(v any) any {
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		o := jsv.NewObj()
		for _, k := range keys {
			o.Set(k, toJSV(x[k]))
		}
		return o
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = toJSV(e)
		}
		return out
	}
	return v
}

// Load reads every file.
func (r *Repo) Load() error {
	r.rw.Lock()
	r.order, r.items, r.files = nil, map[string]*jsv.Obj{}, map[string]string{}
	r.rw.Unlock()
	var rels []string
	if r.isFile() {
		rels = []string{r.spec.Location}
	} else {
		var err error
		if rels, err = r.store.List(r.spec.Location, ".json", true); err != nil {
			return err
		}
	}
	for _, rel := range rels {
		if err := r.loadFile(rel); err != nil {
			return err
		}
	}
	return nil
}

func (r *Repo) loadFile(rel string) error {
	doc, err := r.store.ReadJSON(rel, jsonstore.ReadOptions{
		Validate: r.validator(),
		Fallback: func() any { return jsv.O("schemaVersion", 1.0, "items", []any{}) },
	})
	if err != nil {
		return err
	}
	r.rw.Lock()
	defer r.rw.Unlock()
	r.dropFile(rel)
	o := toJSV(doc).(*jsv.Obj)
	for _, it := range o.Arr("items") {
		e := it.(*jsv.Obj)
		id := e.Str("id")
		if _, ok := r.items[id]; !ok {
			r.order = append(r.order, id)
		}
		r.items[id] = e
		r.files[id] = rel
	}
	return nil
}

func (r *Repo) dropFile(rel string) {
	for id, f := range r.files {
		if f == rel {
			delete(r.items, id)
			delete(r.files, id)
		}
	}
	r.compact()
}

func (r *Repo) compact() {
	out := r.order[:0]
	for _, id := range r.order {
		if _, ok := r.items[id]; ok {
			out = append(out, id)
		}
	}
	r.order = out
}

// ReloadFile reloads one file after a hand edit. It reports whether the file belongs here.
func (r *Repo) ReloadFile(rel string) (bool, error) {
	if !r.Owns(rel) {
		return false, nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if ok, err := r.store.Exists(rel); err != nil {
		return true, err
	} else if !ok {
		r.rw.Lock()
		r.dropFile(rel)
		r.rw.Unlock()
		return true, nil
	}
	return true, r.loadFile(rel)
}

// List returns the entities in insertion order.
func (r *Repo) List() []*jsv.Obj {
	r.rw.RLock()
	defer r.rw.RUnlock()
	out := make([]*jsv.Obj, 0, len(r.order))
	for _, id := range r.order {
		out = append(out, r.items[id])
	}
	return out
}

func (r *Repo) Get(id string) *jsv.Obj {
	r.rw.RLock()
	defer r.rw.RUnlock()
	return r.items[id]
}

// commit writes the changed files atomically, then swaps the changes into memory.
func (r *Repo) commit(put []*jsv.Obj, del []string) error {
	r.rw.RLock()
	items := make(map[string]*jsv.Obj, len(r.items))
	files := make(map[string]string, len(r.files))
	order := append([]string(nil), r.order...)
	for k, v := range r.items {
		items[k] = v
	}
	for k, v := range r.files {
		files[k] = v
	}
	r.rw.RUnlock()
	dirty := map[string]bool{}
	var dirtyOrder []string
	mark := func(f string) {
		if !dirty[f] {
			dirty[f] = true
			dirtyOrder = append(dirtyOrder, f)
		}
	}
	for _, id := range del {
		if f, ok := files[id]; ok {
			mark(f)
		}
		delete(items, id)
		delete(files, id)
	}
	for _, e := range put {
		id := e.Str("id")
		if old, ok := files[id]; ok {
			mark(old)
		}
		f := r.spec.FileFor(e)
		mark(f)
		if _, ok := items[id]; !ok {
			order = append(order, id)
		}
		items[id] = e
		files[id] = f
	}
	var ops []jsonstore.Op
	for _, f := range dirtyOrder {
		var in []*jsv.Obj
		for _, id := range order {
			if e, ok := items[id]; ok && files[id] == f {
				in = append(in, e)
			}
		}
		if len(in) == 0 && !r.isFile() {
			ops = append(ops, jsonstore.Op{Type: "remove", Rel: f})
			continue
		}
		sort.SliceStable(in, func(i, j int) bool { return localeCompare(in[i].Str("id"), in[j].Str("id")) < 0 })
		list := make([]any, len(in))
		for i, e := range in {
			list[i] = e
		}
		text, err := jsonstore.StableStringify(jsv.O("schemaVersion", 1.0, "items", list))
		if err != nil {
			return err
		}
		ops = append(ops, jsonstore.Op{Type: "write", Rel: f, Text: text})
	}
	if err := r.store.Batch(ops); err != nil {
		return err
	}
	r.rw.Lock()
	r.items, r.files, r.order = items, files, order
	r.compact()
	r.rw.Unlock()
	return nil
}

func (r *Repo) parse(v *jsv.Obj) (*jsv.Obj, error) { return schema.ParseObj(r.spec.Schema, v) }

// Create validates and stores a new entity.
func (r *Repo) Create(input *jsv.Obj) (*jsv.Obj, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := nowISO()
	draft := input.Clone()
	if r.spec.BeforeCreate != nil {
		draft = r.spec.BeforeCreate(draft)
	}
	draft.Set("id", NewID()).Set("createdAt", now).Set("updatedAt", now)
	e, err := r.parse(draft)
	if err != nil {
		return nil, err
	}
	if r.spec.Validate != nil {
		if err := r.spec.Validate(e); err != nil {
			return nil, err
		}
	}
	if err := r.commit([]*jsv.Obj{e}, nil); err != nil {
		return nil, err
	}
	r.bus.Publish("created", r.Name(), e.Str("id"), "")
	return e, nil
}

// Update merges a patch (Undefined values clear fields) and validates the result.
func (r *Repo) Update(id string, patch *jsv.Obj) (*jsv.Obj, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	cur := r.Get(id)
	if cur == nil {
		return nil, notFound(r.Name(), id)
	}
	next := jsv.Merge(cur, patch)
	next.Set("id", cur.Get("id")).Set("createdAt", cur.Get("createdAt")).Set("updatedAt", nowISO())
	e, err := r.parse(next)
	if err != nil {
		return nil, err
	}
	if r.spec.Validate != nil {
		if err := r.spec.Validate(e); err != nil {
			return nil, err
		}
	}
	if err := r.commit([]*jsv.Obj{e}, nil); err != nil {
		return nil, err
	}
	r.bus.Publish("updated", r.Name(), id, "")
	return e, nil
}

// Put inserts or replaces a whole entity (import, undo, restore), keeping id and timestamps.
func (r *Repo) Put(entity *jsv.Obj) (*jsv.Obj, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, err := r.parse(entity)
	if err != nil {
		return nil, err
	}
	if r.spec.Validate != nil {
		if err := r.spec.Validate(e); err != nil {
			return nil, err
		}
	}
	existed := r.Get(e.Str("id")) != nil
	if err := r.commit([]*jsv.Obj{e}, nil); err != nil {
		return nil, err
	}
	kind := "created"
	if existed {
		kind = "updated"
	}
	r.bus.Publish(kind, r.Name(), e.Str("id"), "")
	return e, nil
}

func (r *Repo) Delete(id string) error { return r.DeleteMany([]string{id}) }

// DeleteMany removes entities (a single missing id is "not found").
func (r *Repo) DeleteMany(ids []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	var present []string
	for _, id := range ids {
		if r.Get(id) != nil {
			present = append(present, id)
		}
	}
	if len(present) == 0 {
		if len(ids) == 1 {
			return notFound(r.Name(), ids[0])
		}
		return nil
	}
	if err := r.commit(nil, present); err != nil {
		return err
	}
	for _, id := range present {
		r.bus.Publish("deleted", r.Name(), id, "")
	}
	return nil
}

// PatchMany applies a patch to many entities in one write.
func (r *Repo) PatchMany(ids []string, patch func(e *jsv.Obj) *jsv.Obj) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := nowISO()
	var puts []*jsv.Obj
	for _, id := range ids {
		cur := r.Get(id)
		if cur == nil {
			continue
		}
		next := jsv.Merge(cur, patch(cur))
		next.Set("id", cur.Get("id")).Set("createdAt", cur.Get("createdAt")).Set("updatedAt", now)
		e, err := r.parse(next)
		if err != nil {
			return err
		}
		puts = append(puts, e)
	}
	if len(puts) > 0 {
		if err := r.commit(puts, nil); err != nil {
			return err
		}
	}
	for _, p := range puts {
		r.bus.Publish("updated", r.Name(), p.Str("id"), "")
	}
	return nil
}
