package schema

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/reeper316099/classpad/internal/jsv"
)

// The zod schemas' results on generated values (scripts/schema-parity.mjs): the same output, keys
// in the same order, or the same issues in the same order.

var byName = map[string]*Object{
	"Semester": Semester, "Class": Class, "Assignment": Assignment, "Task": Task, "Note": Note,
	"Reading": Reading, "StudySession": StudySession, "Attachment": Attachment,
	"GradingScheme": GradingScheme, "GpaScale": GpaScale, "JournalEntry": JournalEntry,
	"Contact": Contact, "Activity": Activity, "Job": Job, "Admission": Admission,
	"BudgetItem": BudgetItem, "Card": Card, "MappingPlugin": MappingPlugin,
}

func TestParityWithZod(t *testing.T) {
	path := "testdata/parity.json.gz"
	if p := os.Getenv("SCHEMA_PARITY_FILE"); p != "" {
		path = p
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	z, _ := gzip.NewReader(f)
	b, _ := io.ReadAll(z)
	var cases []struct {
		Name  string          `json:"name"`
		Value json.RawMessage `json:"value"`
		Want  json.RawMessage `json:"want"`
	}
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	fails := 0
	for i, c := range cases {
		s := byName[strings.TrimSuffix(c.Name, "Body")]
		if strings.HasSuffix(c.Name, "Body") {
			s = s.Omit("id", "createdAt", "updatedAt")
		}
		var v any = Missing
		if string(c.Value) != `{"$undefined":true}` {
			v, _ = jsv.Parse(string(c.Value))
		}
		out, err := Parse(s, v)
		var got string
		if err != nil {
			var issues []any
			for _, is := range err.(*Error).Issues {
				issues = append(issues, jsv.O("path", is.PathString(), "message", is.Message))
			}
			got = jsv.Stringify(jsv.O("issues", issues), "")
		} else {
			got = jsv.Stringify(jsv.O("ok", out), "")
		}
		want, _ := jsv.Parse(string(c.Want))
		if got != jsv.Stringify(want, "") {
			t.Errorf("case %d %s %s\n go: %s\n ts: %s", i, c.Name, c.Value, got, jsv.Stringify(want, ""))
			if fails++; fails > 15 {
				t.FailNow()
			}
		}
	}
	t.Logf("%d schema cases match zod", len(cases))
}
