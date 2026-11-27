// Package schema validates and normalizes JSON values the way the TypeScript server's zod 4
// schemas do: unknown object keys are dropped, defaults filled in, keys come out in schema order,
// and failures produce the same issues (path and message) in the same order.
package schema

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/reeper316099/classpad/internal/jsonstore"
	"github.com/reeper316099/classpad/internal/jsv"
)

// Issue is one validation problem.
type Issue struct {
	Path    []any // string keys and int indexes
	Message string
	// abort: zod stops checking a union option on this kind of issue (wrong type, bad option).
	abort bool
}

// PathString joins the path with dots, as the API reports it.
func (i Issue) PathString() string {
	parts := make([]string, len(i.Path))
	for k, p := range i.Path {
		parts[k] = fmt.Sprint(p)
	}
	return strings.Join(parts, ".")
}

// Error is a failed parse.
type Error struct{ Issues []Issue }

func (e *Error) Error() string {
	var b strings.Builder
	for i, is := range e.Issues {
		if i > 0 {
			b.WriteString("; ")
		}
		if p := is.PathString(); p != "" {
			b.WriteString(p + ": ")
		}
		b.WriteString(is.Message)
	}
	return b.String()
}

// Missing is an absent value (JavaScript undefined).
var Missing = jsv.Undefined

// Schema checks a value and returns its normalized form.
type Schema interface {
	parse(v any, c *ctx) any
}

type ctx struct {
	path   []any
	issues []Issue
}

func (c *ctx) add(msg string, abort bool) {
	c.issues = append(c.issues, Issue{Path: append([]any(nil), c.path...), Message: msg, abort: abort})
}

func (c *ctx) at(k any, f func()) {
	c.path = append(c.path, k)
	f()
	c.path = c.path[:len(c.path)-1]
}

// Parse validates v.
func Parse(s Schema, v any) (any, error) {
	c := &ctx{}
	out := s.parse(v, c)
	if len(c.issues) > 0 {
		return nil, &Error{Issues: c.issues}
	}
	return out, nil
}

// MustObj parses and returns the object.
func ParseObj(s Schema, v any) (*jsv.Obj, error) {
	out, err := Parse(s, v)
	if err != nil {
		return nil, err
	}
	o, _ := out.(*jsv.Obj)
	return o, nil
}

func received(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case float64:
		if math.IsNaN(x) {
			return "NaN"
		}
		return "number"
	case bool:
		return "boolean"
	case []any:
		return "array"
	case *jsv.Obj, map[string]any:
		return "object"
	}
	if v == Missing {
		return "undefined"
	}
	return "unknown"
}

func num(f float64) string { return jsonstore.JSNumber(f) }

func typeIssue(c *ctx, want string, v any) {
	c.add(fmt.Sprintf("Invalid input: expected %s, received %s", want, received(v)), true)
}

// ---------------- strings ----------------

type Str struct {
	min, max  *int
	re        *regexp.Regexp
	reSrc     string
	datetime  bool
	reMessage string
}

func String() *Str { return &Str{} }

func (s *Str) Min(n int) *Str { s.min = &n; return s }
func (s *Str) Max(n int) *Str { s.max = &n; return s }

// Regex: src is the pattern as JavaScript prints it (for the message), re the Go equivalent.
func (s *Str) Regex(re *regexp.Regexp, src string) *Str {
	s.re, s.reSrc = re, src
	return s
}

// RegexMsg uses a custom message, like z.string().regex(re, 'message').
func (s *Str) RegexMsg(re *regexp.Regexp, msg string) *Str {
	s.re, s.reMessage = re, msg
	return s
}

// Datetime is z.string().datetime({ offset: true }).
func (s *Str) Datetime() *Str { s.datetime = true; return s }

var isoDatetime = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$`)

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// lengthChecks runs min/max length checks the way zod 4 does: on anything with a length (it still
// checks an array given where a string was expected, and words the issue by what it got).
func lengthChecks(c *ctx, v any, min, max *int) {
	var n int
	var what, unit string
	switch x := v.(type) {
	case string:
		n, what, unit = utf16Len(x), "string", "characters"
	case []any:
		n, what, unit = len(x), "array", "items"
	default:
		return
	}
	if min != nil && n < *min {
		c.add(fmt.Sprintf("Too small: expected %s to have >=%d %s", what, *min, unit), false)
	}
	if max != nil && n > *max {
		c.add(fmt.Sprintf("Too big: expected %s to have <=%d %s", what, *max, unit), false)
	}
}

func (s *Str) parse(v any, c *ctx) any {
	str, ok := v.(string)
	if !ok {
		typeIssue(c, "string", v)
		lengthChecks(c, v, s.min, s.max)
		return v
	}
	lengthChecks(c, str, s.min, s.max)
	if s.re != nil && !s.re.MatchString(str) {
		if s.reMessage != "" {
			c.add(s.reMessage, false)
		} else {
			c.add("Invalid string: must match pattern "+s.reSrc, false)
		}
	}
	if s.datetime && !isoDatetime.MatchString(str) {
		c.add("Invalid ISO datetime", false)
	}
	return str
}

// ---------------- numbers ----------------

type Num struct {
	min, max        *float64
	gt              bool // positive(): > min
	int             bool
	coerce          bool
	minSet, maxSet  bool
	exclusiveMinVal float64
}

func Number() *Num { return &Num{} }

// Coerce is z.coerce.number(): Number(input) first.
func Coerce() *Num { return &Num{coerce: true} }

func (n *Num) Min(f float64) *Num { n.min = &f; return n }
func (n *Num) Max(f float64) *Num { n.max = &f; return n }
func (n *Num) Int() *Num          { n.int = true; return n }
func (n *Num) Nonnegative() *Num  { return n.Min(0) }
func (n *Num) Positive() *Num     { n.gt = true; n.exclusiveMinVal = 0; return n }

func (n *Num) parse(v any, c *ctx) any {
	if n.coerce {
		v = coerceNumber(v)
	}
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		typeIssue(c, "number", v)
		return v
	}
	if n.int && f != math.Trunc(f) {
		c.add("Invalid input: expected int, received number", true)
		return f
	}
	if n.gt && !(f > n.exclusiveMinVal) {
		c.add("Too small: expected number to be >"+num(n.exclusiveMinVal), false)
	}
	if n.min != nil && f < *n.min {
		c.add("Too small: expected number to be >="+num(*n.min), false)
	}
	if n.max != nil && f > *n.max {
		c.add("Too big: expected number to be <="+num(*n.max), false)
	}
	return f
}

// coerceNumber is Number(v).
func coerceNumber(v any) any {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		return jsNumber(x)
	case bool:
		if x {
			return 1.0
		}
		return 0.0
	case nil:
		return 0.0
	}
	return math.NaN()
}

var jsDecimal = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

func jsNumber(s string) float64 {
	s = strings.TrimFunc(s, func(r rune) bool {
		return strings.ContainsRune("\t\n\v\f\r       　\uFEFF", r) || (r >= 0x2000 && r <= 0x200a)
	})
	if s == "" {
		return 0
	}
	switch s {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(s) > 2 && s[0] == '0' && strings.ContainsRune("xXoObB", rune(s[1])) {
		base := map[byte]int{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[s[1]]
		if u, err := strconv.ParseUint(s[2:], base, 64); err == nil {
			return float64(u)
		}
		return math.NaN()
	}
	if !jsDecimal.MatchString(s) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && f == 0 && !strings.Contains(err.Error(), "range") {
		return math.NaN()
	}
	return f
}

// ---------------- simple types ----------------

type boolean struct{}

func Bool() Schema { return boolean{} }

func (boolean) parse(v any, c *ctx) any {
	if _, ok := v.(bool); !ok {
		typeIssue(c, "boolean", v)
	}
	return v
}

type unknown struct{}

// Unknown accepts anything (z.unknown()).
func Unknown() Schema { return unknown{} }

func (unknown) parse(v any, c *ctx) any { return v }

type literal struct{ want any }

func Literal(v any) Schema { return literal{v} }

func (l literal) parse(v any, c *ctx) any {
	if v != l.want {
		w := fmt.Sprint(l.want)
		if s, ok := l.want.(string); ok {
			w = strconv.Quote(s)
		} else if f, ok := l.want.(float64); ok {
			w = num(f)
		}
		c.add("Invalid input: expected "+w, true)
	}
	return v
}

type enum struct{ options []string }

func Enum(options ...string) Schema { return enum{options} }

func (e enum) parse(v any, c *ctx) any {
	s, ok := v.(string)
	if ok {
		for _, o := range e.options {
			if o == s {
				return s
			}
		}
	}
	q := make([]string, len(e.options))
	for i, o := range e.options {
		q[i] = strconv.Quote(o)
	}
	c.add("Invalid option: expected one of "+strings.Join(q, "|"), true)
	return v
}

// ---------------- wrappers ----------------

type optional struct{ inner Schema }

// Optional accepts a missing value (not null).
func Optional(s Schema) Schema { return optional{s} }

func (o optional) parse(v any, c *ctx) any {
	if v == Missing {
		return Missing
	}
	return o.inner.parse(v, c)
}

type nullable struct{ inner Schema }

func Nullable(s Schema) Schema { return nullable{s} }

func (n nullable) parse(v any, c *ctx) any {
	if v == nil {
		return nil
	}
	return n.inner.parse(v, c)
}

type withDefault struct {
	inner   Schema
	value   func() any
	prefill bool // prefault: the default goes through the schema
}

// Default fills in a missing value (zod 4: the default is used as is).
func Default(s Schema, value func() any) Schema { return withDefault{s, value, false} }

// Prefault fills in a missing value and then validates it (zod 4 .prefault()).
func Prefault(s Schema, value func() any) Schema { return withDefault{s, value, true} }

func (d withDefault) parse(v any, c *ctx) any {
	if v == Missing {
		if d.prefill {
			return d.inner.parse(d.value(), c)
		}
		return d.value()
	}
	return d.inner.parse(v, c)
}

type refine struct {
	inner Schema
	ok    func(any) bool
	msg   string
}

// Refine adds a check that runs when the value is otherwise valid.
func Refine(s Schema, ok func(any) bool, msg string) Schema { return refine{s, ok, msg} }

func (r refine) parse(v any, c *ctx) any {
	before := len(c.issues)
	out := r.inner.parse(v, c)
	aborted := false
	for _, is := range c.issues[before:] {
		aborted = aborted || is.abort
	}
	// zod 4 still runs a refinement after non-fatal issues (a too-short field), not after a wrong type
	if !aborted && !r.ok(out) {
		c.add(r.msg, false)
	}
	return out
}

type transform struct {
	inner Schema
	fn    func(any) any
}

// Transform changes a valid value.
func Transform(s Schema, fn func(any) any) Schema { return transform{s, fn} }

func (t transform) parse(v any, c *ctx) any {
	before := len(c.issues)
	out := t.inner.parse(v, c)
	if len(c.issues) == before {
		return t.fn(out)
	}
	return out
}

// ---------------- arrays, records, unions ----------------

type array struct {
	elem     Schema
	min, max *int
}

func Array(elem Schema) *array { return &array{elem: elem} }

func (a *array) Min(n int) *array { a.min = &n; return a }
func (a *array) Max(n int) *array { a.max = &n; return a }

func (a *array) parse(v any, c *ctx) any {
	in, ok := v.([]any)
	if !ok {
		typeIssue(c, "array", v)
		lengthChecks(c, v, a.min, a.max)
		return v
	}
	out := make([]any, len(in))
	for i, e := range in {
		c.at(i, func() {
			if e == Missing {
				e = nil // an undefined array item is read as null
			}
			out[i] = a.elem.parse(e, c)
		})
	}
	lengthChecks(c, in, a.min, a.max)
	return out
}

type record struct{ value Schema }

// Record is z.record(z.string(), value).
func Record(value Schema) Schema { return record{value} }

func (r record) parse(v any, c *ctx) any {
	in, ok := v.(*jsv.Obj)
	if !ok {
		typeIssue(c, "record", v)
		return v
	}
	out := jsv.NewObj()
	for _, k := range in.Keys() {
		e := in.Get(k)
		if e == Missing {
			continue
		}
		c.at(k, func() { out.Set(k, r.value.parse(e, c)) })
	}
	return out
}

type union struct{ options []Schema }

func Union(options ...Schema) Schema { return union{options} }

func (u union) parse(v any, c *ctx) any {
	type result struct {
		out     any
		issues  []Issue
		aborted bool
	}
	var results []result
	for _, o := range u.options {
		sub := &ctx{path: append([]any(nil), c.path...)}
		out := o.parse(v, sub)
		if len(sub.issues) == 0 {
			return out
		}
		ab := false
		for _, is := range sub.issues {
			ab = ab || is.abort
		}
		results = append(results, result{out, sub.issues, ab})
	}
	var live []result
	for _, r := range results {
		if !r.aborted {
			live = append(live, r)
		}
	}
	if len(live) == 1 {
		c.issues = append(c.issues, live[0].issues...)
		return live[0].out
	}
	c.add("Invalid input", true)
	return v
}

// ---------------- objects ----------------

// Field is one key of an object schema.
type Field struct {
	Name   string
	Schema Schema
}

type Object struct {
	fields []Field
}

// Obj is z.object({...}) with unknown keys stripped.
func Obj(fields ...Field) *Object { return &Object{fields: fields} }

// F is a field.
func F(name string, s Schema) Field { return Field{name, s} }

// Omit is schema.omit({...}).
func (o *Object) Omit(names ...string) *Object {
	drop := map[string]bool{}
	for _, n := range names {
		drop[n] = true
	}
	var fs []Field
	for _, f := range o.fields {
		if !drop[f.Name] {
			fs = append(fs, f)
		}
	}
	return &Object{fields: fs}
}

// Extend adds or replaces fields.
func (o *Object) Extend(fields ...Field) *Object {
	fs := append([]Field(nil), o.fields...)
	for _, nf := range fields {
		replaced := false
		for i := range fs {
			if fs[i].Name == nf.Name {
				fs[i] = nf
				replaced = true
			}
		}
		if !replaced {
			fs = append(fs, nf)
		}
	}
	return &Object{fields: fs}
}

// Fields lists the keys.
func (o *Object) Fields() []Field { return o.fields }

func (o *Object) parse(v any, c *ctx) any {
	in, ok := v.(*jsv.Obj)
	if !ok {
		typeIssue(c, "object", v)
		return v
	}
	out := jsv.NewObj()
	for _, f := range o.fields {
		var e any = Missing
		if in.Has(f.Name) {
			e = in.Get(f.Name)
		}
		c.at(f.Name, func() {
			r := f.Schema.parse(e, c)
			if r != Missing {
				out.Set(f.Name, r)
			}
		})
	}
	return out
}
