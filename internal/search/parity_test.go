package search

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

type pDoc struct {
	ID      string   `json:"id"`
	Kind    string   `json:"kind"`
	Title   string   `json:"title"`
	Body    string   `json:"body"`
	ClassID string   `json:"classId"`
	Tags    []string `json:"tags"`
	Types   []string `json:"types"`
	Due     string   `json:"due"`
}

func (d pDoc) doc() Doc {
	return Doc{ID: d.ID, Kind: d.Kind, Title: d.Title, Body: d.Body, ClassID: d.ClassID, Tags: d.Tags, Types: d.Types, Due: d.Due}
}

// The TypeScript SearchIndex's hits on generated scenarios (scripts/search-parity.mjs).
func TestParityWithMiniSearch(t *testing.T) {
	path := "testdata/parity.json.gz"
	if p := os.Getenv("SEARCH_PARITY_FILE"); p != "" {
		path = p
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	z, _ := gzip.NewReader(f)
	b, _ := io.ReadAll(z)
	var cases []struct {
		Ops []struct {
			Docs []pDoc `json:"docs"`
		} `json:"ops"`
		Steps []struct {
			Op    string `json:"op"`
			Doc   pDoc   `json:"doc"`
			ID    string `json:"id"`
			Q     string `json:"q"`
			Limit int    `json:"limit"`
			Want  []Hit  `json:"want"`
		} `json:"steps"`
	}
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	names := map[string]string{"C1": "intro bio", "C2": "calculus i", "C3": "art"}
	classMatches := func(term string) map[string]bool {
		out := map[string]bool{}
		for id, n := range names {
			if strings.Contains(n, term) {
				out[id] = true
			}
		}
		return out
	}
	now := time.Date(2031, 10, 15, 12, 0, 0, 0, time.UTC)
	searches, fails := 0, 0
	for ci, c := range cases {
		x := NewIndex()
		var docs []Doc
		for _, d := range c.Ops[0].Docs {
			docs = append(docs, d.doc())
		}
		x.Rebuild(docs)
		for si, s := range c.Steps {
			switch s.Op {
			case "upsert":
				x.Upsert(s.Doc.doc())
			case "remove":
				x.Remove(s.ID)
			case "search":
				searches++
				got := x.Search(s.Q, classMatches, s.Limit, now)
				if s.Want == nil {
					s.Want = []Hit{}
				}
				if !sameHits(got, s.Want) {
					g, _ := json.Marshal(got)
					w, _ := json.Marshal(s.Want)
					t.Errorf("scenario %d step %d query %q\n go: %s\n ts: %s", ci, si, s.Q, g, w)
					if fails++; fails > 8 {
						t.FailNow()
					}
				}
			}
		}
	}
	t.Logf("%d searches over %d scenarios match", searches, len(cases))
}

func sameHits(a, b []Hit) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		x, y := a[i], b[i]
		if math.Abs(x.Score-y.Score) > 1e-9*math.Max(1, math.Abs(y.Score)) {
			return false
		}
		x.Score, y.Score = 0, 0
		if !reflect.DeepEqual(x, y) {
			return false
		}
	}
	return true
}
