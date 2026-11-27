package frontmatter

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"testing"

	"github.com/reeper316099/classpad/internal/jsv"
)

// What the TypeScript stringifyFrontmatter writes (scripts/frontmatter-parity.mjs), byte for byte.
func TestParityWithYamlPackage(t *testing.T) {
	path := "testdata/parity.json.gz"
	if p := os.Getenv("FRONTMATTER_PARITY_FILE"); p != "" {
		path = p
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	z, _ := gzip.NewReader(f)
	b, _ := io.ReadAll(z)
	var cases []struct {
		Data    json.RawMessage `json:"data"`
		Content string          `json:"content"`
		Want    string          `json:"want"`
	}
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	fails := 0
	for i, c := range cases {
		v, err := jsv.Parse(string(c.Data))
		if err != nil {
			t.Fatal(err)
		}
		if got := Stringify(c.Content, v.(*jsv.Obj)); got != c.Want {
			t.Errorf("case %d %s\n go: %q\n ts: %q", i, c.Data, got, c.Want)
			if fails++; fails > 10 {
				t.FailNow()
			}
		}
	}
	t.Logf("%d front matter cases match", len(cases))
}
