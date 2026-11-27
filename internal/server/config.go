package server

import (
	"sync"

	"github.com/reeper316099/classpad/internal/grades"
	"github.com/reeper316099/classpad/internal/jsonstore"
	"github.com/reeper316099/classpad/internal/jsv"
	"github.com/reeper316099/classpad/internal/schema"
)

const (
	schemesFile  = "config/grading-schemes.json"
	scalesFile   = "config/gpa-scales.json"
	settingsPath = "config/settings.json"
)

func defaultLetterScale() *jsv.Obj {
	var cutoffs []any
	for _, c := range grades.DefaultLetterScale().Cutoffs {
		cutoffs = append(cutoffs, jsv.O("letter", c.Letter, "min", c.Min.Float64(), "gpa", c.GPA.Float64()))
	}
	return jsv.O("cutoffs", cutoffs, "roundingMode", "half_up", "decimals", 2.0, "letterOn", "raw")
}

// DefaultSchemes are the three built-in grading schemes.
func DefaultSchemes() []any {
	mk := func(id, name, mode string, cats bool) *jsv.Obj {
		o := jsv.O("id", id, "name", name, "mode", mode)
		if cats {
			o.Set("categories", []any{})
		}
		return o.Set("scale", defaultLetterScale()).Set("normalizeOverGradedOnly", true).Set("extraCreditAllowed", true)
	}
	return []any{
		mk("default", "Assignment weights", "assignment_weights", false),
		mk("categories", "Category weights", "category_weights", true),
		mk("points", "Total points", "points", false),
	}
}

// DefaultScales are the built-in GPA scales, in GPA_SCALES order.
func DefaultScales() []any {
	all := grades.GpaScales()
	var out []any
	for _, id := range []string{"standard_plus_minus", "flat_4", "plus_4_3", "five_point"} {
		s := all[id]
		var pts []any
		for _, p := range s.Points {
			pts = append(pts, jsv.O("letter", p.Letter, "gpa", p.GPA.Float64()))
		}
		bonus := jsv.NewObj()
		for _, k := range []string{"regular", "honors", "ap", "ib", "dual"} {
			bonus.Set(k, s.WeightedBonus[k].Float64())
		}
		out = append(out, jsv.O("id", id, "name", s.Name, "points", pts, "weightedBonus", bonus))
	}
	return out
}

func docSchema(item schema.Schema) schema.Schema {
	return schema.Obj(schema.F("schemaVersion", schema.Number()), schema.F("items", schema.Array(item)))
}

// Config holds the grading schemes and GPA scales.
type Config struct {
	store   *jsonstore.Store
	mu      sync.RWMutex
	schemes []any
	scales  []any
}

func NewConfig(store *jsonstore.Store) *Config { return &Config{store: store} }

func (c *Config) readDoc(rel string, item schema.Schema, def []any) ([]any, error) {
	v, err := c.store.ReadJSON(rel, jsonstore.ReadOptions{
		Validate: func(v any) (any, error) { return schema.Parse(docSchema(item), toJSV(v)) },
		Fallback: func() any { return jsv.O("schemaVersion", 1.0, "items", def) },
	})
	if err != nil {
		return nil, err
	}
	o, ok := v.(*jsv.Obj)
	if !ok {
		o = toJSV(v).(*jsv.Obj)
	}
	// defaults go through the schema too (the TypeScript writeJson validates them)
	parsed, err := schema.Parse(docSchema(item), o)
	if err != nil {
		return nil, err
	}
	return parsed.(*jsv.Obj).Arr("items"), nil
}

func (c *Config) write(rel string, items []any) error {
	return c.store.WriteJSON(rel, jsv.O("schemaVersion", 1.0, "items", items), nil)
}

// Load reads both files (writing the defaults the first time).
func (c *Config) Load() error {
	schemes, err := c.readDoc(schemesFile, schema.GradingScheme, DefaultSchemes())
	if err != nil {
		return err
	}
	scales, err := c.readDoc(scalesFile, schema.GpaScale, DefaultScales())
	if err != nil {
		return err
	}
	if err := c.write(schemesFile, schemes); err != nil {
		return err
	}
	if err := c.write(scalesFile, scales); err != nil {
		return err
	}
	c.mu.Lock()
	c.schemes, c.scales = schemes, scales
	c.mu.Unlock()
	return nil
}

func (c *Config) Schemes() []any {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.schemes
}

func (c *Config) Scales() []any {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.scales
}

func (c *Config) put(rel string, item schema.Schema, items any) ([]any, error) {
	parsed, err := schema.Parse(schema.Array(item).Min(1), items)
	if err != nil {
		return nil, err
	}
	list := parsed.([]any)
	if err := c.write(rel, list); err != nil {
		return nil, err
	}
	return list, nil
}

func (c *Config) PutSchemes(items any) ([]any, error) {
	list, err := c.put(schemesFile, schema.GradingScheme, items)
	if err == nil {
		c.mu.Lock()
		c.schemes = list
		c.mu.Unlock()
	}
	return list, err
}

func (c *Config) PutScales(items any) ([]any, error) {
	list, err := c.put(scalesFile, schema.GpaScale, items)
	if err == nil {
		c.mu.Lock()
		c.scales = list
		c.mu.Unlock()
	}
	return list, err
}

// Scheme finds a scheme by id, else "default", else the first built-in one.
func (c *Config) Scheme(id string) *jsv.Obj {
	for _, s := range c.Schemes() {
		if s.(*jsv.Obj).Str("id") == id {
			return s.(*jsv.Obj)
		}
	}
	for _, s := range c.Schemes() {
		if s.(*jsv.Obj).Str("id") == "default" {
			return s.(*jsv.Obj)
		}
	}
	return DefaultSchemes()[0].(*jsv.Obj)
}

// Scale finds a GPA scale by id, else the first.
func (c *Config) Scale(id string) *jsv.Obj {
	sc := c.Scales()
	for _, s := range sc {
		if s.(*jsv.Obj).Str("id") == id {
			return s.(*jsv.Obj)
		}
	}
	if len(sc) > 0 {
		return sc[0].(*jsv.Obj)
	}
	return DefaultScales()[0].(*jsv.Obj)
}
