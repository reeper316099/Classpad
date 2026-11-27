package jsonstore

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"
)

// The parser must accept exactly the strict JSON encoding/json accepts, and read the same values.
func FuzzParseJSON(f *testing.F) {
	for _, s := range []string{
		`{"a":[1,2.5e-3,-0,true,false,null,"xé\n\"\\\/"]}`, `[]`, `{}`, `"😀"`,
		`01`, `1.`, `.5`, `-`, `[1,]`, `{"a":1,}`, `{"a" 1}`, `"tab	in string"`, `1e400`, ` 7 `,
		`{"a":1,"a":2}`, `[1 2]`, `"\x"`, `nul`, `{"\u0000":0}`,
	} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		if !utf8Valid(s) {
			return // JavaScript only ever sees decoded text
		}
		got, err := ParseJSON(s)
		var want any
		werr := json.Unmarshal([]byte(s), &want)
		if werr != nil && strings.Contains(werr.Error(), "cannot unmarshal number") {
			return // out of range: encoding/json refuses, JavaScript (and we) make it Infinity
		}
		if (err == nil) != (werr == nil) {
			t.Fatalf("%q: ours %v, encoding/json %v", s, err, werr)
		}
		if err == nil && !sameJSON(got, want) {
			t.Fatalf("%q: ours %#v, encoding/json %#v", s, got, want)
		}
	})
}

func utf8Valid(s string) bool { return strings.ToValidUTF8(s, "�") == s }

func sameJSON(a, b any) bool {
	if fa, ok := a.(float64); ok {
		fb, ok := b.(float64)
		return ok && (fa == fb || (math.IsNaN(fa) && math.IsNaN(fb)))
	}
	return reflect.DeepEqual(a, b)
}

func TestParseErrorsPointAtTheProblem(t *testing.T) {
	text := "{\n  \"a\": 1,\n  oops\n}"
	_, err := ParseJSON(text)
	if jsonErrorLine(text, err) != 3 {
		t.Fatal(err)
	}
}
