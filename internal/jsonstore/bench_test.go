package jsonstore

import (
	"fmt"
	"strings"
	"testing"
)

// The same work as scripts/jsonstore-bench.mjs times in the TypeScript store.

// benchDoc is 2,000 synthetic assignment-like records (about 600 KB of JSON).
func benchDoc() map[string]any {
	items := make([]any, 2000)
	for i := range items {
		var score any
		if i%4 != 0 {
			score = map[string]any{"earned": float64(i % 50), "possible": 50.0}
		}
		items[i] = map[string]any{
			"id":     fmt.Sprintf("A%05d", i),
			"title":  fmt.Sprintf("Assignment %d", i),
			"points": float64((i*7)%100) + 0.5,
			"done":   i%3 == 0,
			"tags":   []any{"homework", fmt.Sprintf("week %d", i%15)},
			"notes":  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.",
			"score":  score,
		}
	}
	return map[string]any{"schemaVersion": 1.0, "items": items}
}

func benchStore(b *testing.B) *Store {
	s, err := Open(b.TempDir(), true)
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { s.Close() })
	for i := range 200 {
		if err := s.WriteText(fmt.Sprintf("data/notes/note-%d.md", i), fmt.Sprintf("# Note %d\n\n%s\n", i, strings.Repeat("Some text. ", 40))); err != nil {
			b.Fatal(err)
		}
	}
	if err := s.WriteJSON("data/items.json", benchDoc(), nil); err != nil {
		b.Fatal(err)
	}
	return s
}

func BenchmarkStringify(b *testing.B) {
	doc := benchDoc()
	for b.Loop() {
		if _, err := StableStringify(doc); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkWriteJSON(b *testing.B) {
	s, doc := benchStore(b), benchDoc()
	for b.Loop() {
		if err := s.WriteJSON("data/items.json", doc, nil); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkReadJSON(b *testing.B) {
	s := benchStore(b)
	for b.Loop() {
		if _, err := s.ReadJSON("data/items.json", ReadOptions{}); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkEncryptedWriteRead(b *testing.B) {
	s, doc := benchStore(b), benchDoc()
	key, _ := DeriveKey("bench passphrase", make([]byte, 16))
	for b.Loop() {
		s.SetCrypto(&Crypto{Key: key, ShouldEncrypt: func(string) bool { return true }})
		if err := s.WriteJSON("data/secret.json", doc, nil); err != nil {
			b.Fatal(err)
		}
		if _, err := s.ReadJSON("data/secret.json", ReadOptions{}); err != nil {
			b.Fatal(err)
		}
		s.SetCrypto(nil)
	}
}

func BenchmarkBackup(b *testing.B) {
	s := benchStore(b)
	for b.Loop() {
		if _, err := s.Backup("bench", 3); err != nil {
			b.Fatal(err)
		}
	}
}

func TestBenchDocMatchesScript(t *testing.T) {
	text, err := StableStringify(benchDoc())
	must(t, err)
	if len(text) < 500_000 {
		t.Fatal(len(text))
	}
}
