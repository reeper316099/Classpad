// Package jsv holds JSON values the way JavaScript does: objects keep their key order, numbers are
// float64, and Stringify writes exactly what JSON.stringify writes. The API server uses it so its
// responses and files match the TypeScript server's.
package jsv

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/reeper316099/classpad/internal/jsonstore"
)

// Obj is a JSON object that keeps insertion order (like a JavaScript object with string keys).
type Obj struct {
	keys []string
	m    map[string]any
}

func NewObj() *Obj { return &Obj{m: map[string]any{}} }

// O builds an object from key, value pairs.
func O(kv ...any) *Obj {
	o := NewObj()
	for i := 0; i+1 < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

func (o *Obj) Keys() []string { return o.keys }
func (o *Obj) Len() int       { return len(o.keys) }

func (o *Obj) Get(k string) any {
	if o == nil {
		return nil
	}
	return o.m[k]
}

// GetU is Get with absent keys read as Undefined (a JavaScript property read).
func (o *Obj) GetU(k string) any {
	if o == nil {
		return Undefined
	}
	if v, ok := o.m[k]; ok {
		return v
	}
	return Undefined
}

func (o *Obj) Has(k string) bool {
	if o == nil {
		return false
	}
	_, ok := o.m[k]
	return ok
}

// Set adds or replaces a key; a replaced key keeps its place.
func (o *Obj) Set(k string, v any) *Obj {
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.m[k] = v
	return o
}

func (o *Obj) Delete(k string) {
	if _, ok := o.m[k]; !ok {
		return
	}
	delete(o.m, k)
	for i, x := range o.keys {
		if x == k {
			o.keys = append(o.keys[:i:i], o.keys[i+1:]...)
			break
		}
	}
}

// Clone is a shallow copy.
func (o *Obj) Clone() *Obj {
	c := &Obj{keys: append([]string(nil), o.keys...), m: make(map[string]any, len(o.m))}
	for k, v := range o.m {
		c.m[k] = v
	}
	return c
}

// Deep copies nested objects and arrays (structuredClone).
func Deep(v any) any {
	switch x := v.(type) {
	case *Obj:
		c := &Obj{keys: append([]string(nil), x.keys...), m: make(map[string]any, len(x.m))}
		for k, e := range x.m {
			c.m[k] = Deep(e)
		}
		return c
	case []any:
		c := make([]any, len(x))
		for i, e := range x {
			c[i] = Deep(e)
		}
		return c
	}
	return v
}

// Str, Num, Bool, Arr and ObjAt read typed fields (zero values when missing or of another type).
func (o *Obj) Str(k string) string  { s, _ := o.Get(k).(string); return s }
func (o *Obj) Num(k string) float64 { f, _ := o.Get(k).(float64); return f }
func (o *Obj) Bool(k string) bool   { b, _ := o.Get(k).(bool); return b }
func (o *Obj) Arr(k string) []any   { a, _ := o.Get(k).([]any); return a }
func (o *Obj) ObjAt(k string) *Obj  { x, _ := o.Get(k).(*Obj); return x }
func (o *Obj) NumP(k string) *float64 {
	if f, ok := o.Get(k).(float64); ok {
		return &f
	}
	return nil
}

// StrP is the string field, or nil when missing.
func (o *Obj) StrP(k string) *string {
	if s, ok := o.Get(k).(string); ok {
		return &s
	}
	return nil
}

// Strings reads an array of strings.
func (o *Obj) Strings(k string) []string {
	out := []string{}
	for _, e := range o.Arr(k) {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// Iterface for the jsonstore writer: an ordered object.
func (o *Obj) MarshalJSON() ([]byte, error) { return []byte(Stringify(o, "")), nil }

// Parse reads JSON keeping object key order (numbers become float64).
func Parse(text string) (any, error) {
	// Strict JSON.parse rules (and its error positions) first, then one ordered pass.
	if _, err := jsonstore.ParseJSON(text); err != nil {
		return nil, err
	}
	return readValid(text)
}

// FromGo converts a Go value (structs, maps, slices) to jsv values through encoding/json,
// keeping struct field order.
func FromGo(v any) any {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	out, err := readValid(string(b)) // encoding/json writes valid JSON: no need to check it again
	if err != nil {
		panic(err)
	}
	return out
}

// Stringify is JSON.stringify(v, null, indent) for jsv values (and plain Go maps, slices, numbers).
func Stringify(v any, indent string) string {
	var b strings.Builder
	write(&b, v, indent, "")
	return b.String()
}

func write(b *strings.Builder, v any, indent, cur string) {
	nl := func(level string) {
		if indent != "" {
			b.WriteByte('\n')
			b.WriteString(level)
		}
	}
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(x))
	case float64:
		b.WriteString(jsonstore.JSNumber(x))
	case int:
		b.WriteString(strconv.Itoa(x))
	case string:
		writeString(b, x)
	case []string:
		a := make([]any, len(x))
		for i, s := range x {
			a[i] = s
		}
		write(b, a, indent, cur)
	case []any:
		if len(x) == 0 {
			b.WriteString("[]")
			return
		}
		inner := cur + indent
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			nl(inner)
			if e == Undefined {
				e = nil // JSON.stringify writes undefined array items as null
			}
			write(b, e, indent, inner)
		}
		nl(cur)
		b.WriteByte(']')
	case *Obj:
		if x == nil {
			b.WriteString("null")
			return
		}
		writeObj(b, x.keys, func(k string) any { return x.m[k] }, indent, cur)
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		writeObj(b, keys, func(k string) any { return x[k] }, indent, cur)
	case json.Marshaler:
		raw, err := x.MarshalJSON()
		if err != nil {
			panic(err)
		}
		pv, err := Parse(string(raw))
		if err != nil {
			panic(err)
		}
		write(b, pv, indent, cur)
	default:
		write(b, FromGo(v), indent, cur)
	}
}

func writeObj(b *strings.Builder, keys []string, get func(string) any, indent, cur string) {
	inner := cur + indent
	first := true
	b.WriteByte('{')
	for _, k := range orderKeys(keys) {
		v := get(k)
		if v == Undefined {
			continue
		}
		if !first {
			b.WriteByte(',')
		}
		first = false
		if indent != "" {
			b.WriteByte('\n')
			b.WriteString(inner)
		}
		writeString(b, k)
		b.WriteByte(':')
		if indent != "" {
			b.WriteByte(' ')
		}
		write(b, v, indent, inner)
	}
	if !first && indent != "" {
		b.WriteByte('\n')
		b.WriteString(cur)
	}
	b.WriteByte('}')
}

// orderKeys puts array-index keys first, by number, as JavaScript objects do.
func orderKeys(keys []string) []string {
	var idx []string
	for _, k := range keys {
		if isIndex(k) {
			idx = append(idx, k)
		}
	}
	if len(idx) == 0 {
		return keys
	}
	sort.Slice(idx, func(i, j int) bool {
		a, _ := strconv.ParseUint(idx[i], 10, 64)
		c, _ := strconv.ParseUint(idx[j], 10, 64)
		return a < c
	})
	out := idx
	for _, k := range keys {
		if !isIndex(k) {
			out = append(out, k)
		}
	}
	return out
}

func isIndex(k string) bool {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return false
	}
	var n uint64
	for i := 0; i < len(k); i++ {
		if k[i] < '0' || k[i] > '9' {
			return false // checked by hand: a failed ParseUint allocates its error
		}
		n = n*10 + uint64(k[i]-'0')
	}
	return n < 1<<32-1
}

func writeString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for i := 0; i < len(s); {
		c := s[i]
		if c >= 0x80 {
			r, size := utf8.DecodeRuneInString(s[i:])
			if r == utf8.RuneError && size == 1 {
				b.WriteString("�")
			} else {
				b.WriteString(s[i : i+size])
			}
			i += size
			continue
		}
		switch c {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if c < 0x20 {
				fmt.Fprintf(b, `\u%04x`, c)
			} else {
				b.WriteByte(c)
			}
		}
		i++
	}
	b.WriteByte('"')
}

type undefined struct{}

// Undefined is JavaScript's undefined: a key set to it is left out when written, and it clears a
// field when merged as a patch.
var Undefined = &undefined{}

// Merge is {...a, ...b} where b's Undefined values remove the key.
func Merge(objs ...*Obj) *Obj {
	out := NewObj()
	for _, o := range objs {
		if o == nil {
			continue
		}
		for _, k := range o.keys {
			v := o.m[k]
			out.Set(k, v)
		}
	}
	return out
}

// Truthy is JavaScript truthiness.
func Truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return v != Undefined
}

// Equal compares JSON values (objects ignore key order).
func Equal(a, b any) bool {
	return Stringify(canon(a), "") == Stringify(canon(b), "")
}

func canon(v any) any {
	switch x := v.(type) {
	case *Obj:
		m := map[string]any{}
		for _, k := range x.keys {
			if x.m[k] != Undefined {
				m[k] = canon(x.m[k])
			}
		}
		return m
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = canon(e)
		}
		return out
	}
	return v
}
