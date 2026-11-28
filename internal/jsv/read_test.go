package jsv

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"testing"

	"github.com/reeper316099/classpad/internal/jsonstore"
)

// readOrdered is the previous reader (encoding/json's tokens); readValid must give the same values.
func readOrdered(d *json.Decoder) (any, error) {
	tok, err := d.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			o := NewObj()
			for d.More() {
				kt, err := d.Token()
				if err != nil {
					return nil, err
				}
				v, err := readOrdered(d)
				if err != nil {
					return nil, err
				}
				o.Set(kt.(string), v) // a repeated key keeps its first place and its last value, as in JSON.parse
			}
			_, err := d.Token()
			return o, err
		case '[':
			a := []any{}
			for d.More() {
				v, err := readOrdered(d)
				if err != nil {
					return nil, err
				}
				a = append(a, v)
			}
			_, err := d.Token()
			return a, err
		}
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil {
			if ne, ok := err.(*strconv.NumError); ok && ne.Err == strconv.ErrRange {
				return f, nil
			}
			return nil, err
		}
		return f, nil
	case string, bool, nil:
		return t, nil
	}
	return nil, fmt.Errorf("jsv: unexpected token %v", tok)
}

func viaTokens(text string) (any, error) {
	d := json.NewDecoder(strings.NewReader(text))
	d.UseNumber()
	return readOrdered(d)
}

func same(a, b any) bool {
	switch x := a.(type) {
	case float64:
		y, ok := b.(float64)
		return ok && (x == y || (math.IsNaN(x) && math.IsNaN(y))) && math.Signbit(x) == math.Signbit(y)
	}
	return Stringify(a, "") == Stringify(b, "") && fmt.Sprintf("%T", a) == fmt.Sprintf("%T", b)
}

var readCases = []string{
	`{}`, `[]`, `0`, `-0`, `1e400`, `-1e400`, `1.5e-320`, `123456789012345678901234567890`,
	`"plain"`, `"esc \" \\ \/ \b \f \n \r \t"`, `"\u00e9\u4e2d\ud83d\ude00"`,
	`"lone \ud83d end"`, `"low \ude00 first"`, `"pair reversed \ude00\ud83d"`, `"\ud83d\u0041"`,
	"\"bad utf8 \xff\xfe ok\"", "\"cut \xe2\x82 euro \xe2\x82\xac\"",
	`{"b":1,"a":2,"b":3}`, `{"1":"x","a":[1,{"z":null,"y":true}],"0":false}`,
	` [ 1 , 2 , [ ] , { } , "x" ] `, `{"":""}`, `[1.0,2.50,-3e2,0.1]`,
}

func TestReadValidMatchesTokenReader(t *testing.T) {
	for _, c := range readCases {
		checkRead(t, c)
	}
}

func checkRead(t *testing.T, c string) {
	t.Helper()
	if _, err := jsonstore.ParseJSON(c); err != nil {
		return // only valid JSON reaches readValid
	}
	want, werr := viaTokens(c)
	got, gerr := readValid(c)
	if (werr == nil) != (gerr == nil) {
		t.Fatalf("%q: error %v, want %v", c, gerr, werr)
	}
	if werr == nil && !same(got, want) {
		t.Fatalf("%q:\n got %s\nwant %s", c, Stringify(got, ""), Stringify(want, ""))
	}
}

func FuzzReadValid(f *testing.F) {
	for _, c := range readCases {
		f.Add(c)
	}
	f.Fuzz(func(t *testing.T, s string) { checkRead(t, s) })
}

func BenchmarkFromGo(b *testing.B) {
	type row struct {
		ID     string   `json:"id"`
		Name   string   `json:"name"`
		Score  float64  `json:"score"`
		Tags   []string `json:"tags"`
		Nested struct {
			A, B int
		} `json:"nested"`
	}
	rows := make([]row, 200)
	for i := range rows {
		rows[i] = row{ID: strconv.Itoa(i), Name: "Row é " + strconv.Itoa(i), Score: float64(i) / 3, Tags: []string{"a", "b"}}
	}
	b.ResetTimer()
	for range b.N {
		FromGo(rows)
	}
}
