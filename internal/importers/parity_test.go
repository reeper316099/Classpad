package importers

import (
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"sort"
	"testing"
	"time"
)

// The TypeScript importers' results for generated inputs (scripts/importers-parity.mjs). The Go
// importers must give the same JSON for every one.

type rawCase map[string]json.RawMessage

type parityFile struct {
	TZ           string    `json:"tz"`
	Unit         []rawCase `json:"unit"`
	CSV          []rawCase `json:"csv"`
	CSVImports   []rawCase `json:"csvImports"`
	Gradebooks   []rawCase `json:"gradebooks"`
	Calendars    []rawCase `json:"calendars"`
	ICSExports   []rawCase `json:"icsExports"`
	Folds        []rawCase `json:"folds"`
	ToCSVCases   []rawCase `json:"toCsvCases"`
	Templates    []rawCase `json:"templates"`
	MDFolders    []rawCase `json:"mdFolders"`
	Backups      []rawCase `json:"backups"`
	NotionBodies []rawCase `json:"notionBodies"`
	Notion       []rawCase `json:"notion"`
	Fixture      []rawCase `json:"notionFixture"`
}

func loadParity(t *testing.T) parityFile {
	t.Helper()
	path := "testdata/parity.json.gz"
	if p := os.Getenv("IMPORTERS_PARITY_FILE"); p != "" {
		path = p
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	var p parityFile
	if err := json.NewDecoder(z).Decode(&p); err != nil {
		t.Fatal(err)
	}
	loc, err := time.LoadLocation(p.TZ)
	if err != nil {
		t.Fatal(err)
	}
	Local = loc
	return p
}

func dec[T any](t *testing.T, raw json.RawMessage) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("%v in %s", err, raw)
	}
	return v
}

// canon parses JSON (or marshals a Go value) to plain values; FRONTMATTER messages are cleared
// because they quote the YAML library's own error text.
func canon(t *testing.T, v any) any {
	t.Helper()
	b, ok := v.(json.RawMessage)
	if !ok {
		var err error
		if b, err = json.Marshal(v); err != nil {
			t.Fatal(err)
		}
	}
	var x any
	if err := json.Unmarshal(b, &x); err != nil {
		t.Fatal(err)
	}
	var clean func(any)
	clean = func(v any) {
		switch y := v.(type) {
		case map[string]any:
			if y["code"] == "FRONTMATTER" {
				y["message"] = ""
			}
			for _, e := range y {
				clean(e)
			}
		case []any:
			for _, e := range y {
				clean(e)
			}
		}
	}
	clean(x)
	return x
}

func same(t *testing.T, where string, got any, want json.RawMessage) bool {
	t.Helper()
	g, w := canon(t, got), canon(t, want)
	if reflect.DeepEqual(g, w) {
		return true
	}
	gb, _ := json.Marshal(g)
	t.Errorf("%s differs at %s\n go: %s\n ts: %s", where, diffPath(g, w, ""), cut(gb), cut(want))
	return false
}

func cut(b []byte) string {
	if len(b) > 3000 {
		return string(b[:3000]) + "…"
	}
	return string(b)
}

func diffPath(a, b any, path string) string {
	switch x := a.(type) {
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok {
			return path
		}
		keys := map[string]bool{}
		for k := range x {
			keys[k] = true
		}
		for k := range y {
			keys[k] = true
		}
		var ks []string
		for k := range keys {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		for _, k := range ks {
			if !reflect.DeepEqual(x[k], y[k]) {
				return diffPath(x[k], y[k], path+"."+k)
			}
		}
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return fmt.Sprintf("%s (length %d vs %d)", path, len(x), lenOf(b))
		}
		for i := range x {
			if !reflect.DeepEqual(x[i], y[i]) {
				return diffPath(x[i], y[i], fmt.Sprintf("%s[%d]", path, i))
			}
		}
	}
	return fmt.Sprintf("%s: %#v ≠ %#v", path, a, b)
}

func lenOf(v any) int {
	if a, ok := v.([]any); ok {
		return len(a)
	}
	return -1
}

// ---- JSON shapes of the parse functions, as the TypeScript functions return them ----

func dateJSON(d *ParsedDate) any {
	if d == nil {
		return nil
	}
	m := map[string]any{"start": d.Start, "hasTime": d.HasTime}
	if d.End != "" {
		m["end"] = d.End
	}
	if d.tzSet {
		m["timezoneLabel"] = d.TimezoneLabel
	}
	return m
}

func relJSON(rs []RelationRef) any {
	out := []any{}
	for _, r := range rs {
		m := map[string]any{"title": r.Title}
		if r.Path != "" {
			m["path"] = r.Path
		}
		if r.URL != "" {
			m["url"] = r.URL
		}
		if r.ID != "" {
			m["id"] = r.ID
		}
		out = append(out, m)
	}
	return out
}

func tableJSON(tb Table) any {
	rows := []any{}
	for _, r := range tb.Rows {
		m := map[string]any{}
		for k, v := range r.Cells {
			m[k] = v
		}
		if r.Extra != nil {
			m["__parsed_extra"] = r.Extra
		}
		rows = append(rows, m)
	}
	return map[string]any{"fields": tb.Fields, "rows": rows}
}

func str(raw json.RawMessage) string {
	var s string
	json.Unmarshal(raw, &s)
	return s
}

func unitResult(t *testing.T, fn string, args []json.RawMessage) any {
	a := func(i int) string { return str(args[i]) }
	switch fn {
	case "parseDays":
		return ParseDays(a(0))
	case "parsePercent":
		return ParsePercent(a(0))
	case "parseNumber":
		return ParseNumber(a(0))
	case "parseBool":
		return ParseBool(a(0))
	case "parseNotionDate":
		return dateJSON(ParseNotionDate(a(0)))
	case "parseTimeRange":
		s, e, ok := ParseTimeRange(a(0))
		if !ok {
			return nil
		}
		return map[string]string{"start": s, "end": e}
	case "parseTimes":
		m, w := ParseTimes(a(0), dec[[]string](t, args[1]))
		return map[string]any{"meetings": m, "warnings": w}
	case "cleanLabel":
		return CleanLabel(a(0))
	case "normalizePriority":
		p := NormalizePriority(a(0))
		if p == nil {
			return nil
		}
		return map[string]string{"value": p.Value, "label": p.Label}
	case "normalizeAssignmentStatus":
		v, k := NormalizeAssignmentStatus(a(0))
		return map[string]any{"value": v, "known": k}
	case "normalizeReadingStatus":
		v, k := NormalizeReadingStatus(a(0))
		return map[string]any{"value": v, "known": k}
	case "normalizeTaskPriority":
		if p := NormalizeTaskPriority(a(0)); p != "" {
			return p
		}
		return nil
	case "slugOption":
		return SlugOption(a(0))
	case "splitMulti":
		return SplitMulti(a(0))
	case "parseRelation":
		return relJSON(ParseRelation(a(0)))
	case "normTitle":
		return NormTitle(a(0))
	case "splitName":
		b, id, s := SplitName(a(0))
		m := map[string]any{"base": b, "suffix": s}
		if id != "" {
			m["id"] = id
		}
		return m
	case "detectKind":
		if k := DetectKind(dec[[]string](t, args[0])); k != "" {
			return k
		}
		return nil
	}
	t.Fatalf("unknown function %s", fn)
	return nil
}

func ok(v any) map[string]any { return map[string]any{"ok": v} }

func TestParityWithTypeScript(t *testing.T) {
	p := loadParity(t)
	fails := 0
	check := func(where string, got any, want json.RawMessage) {
		if !same(t, where, got, want) {
			if fails++; fails > 25 {
				t.FailNow()
			}
		}
	}
	for i, c := range p.Unit {
		fn := str(c["fn"])
		args := dec[[]json.RawMessage](t, c["args"])
		check(fmt.Sprintf("unit %d %s(%s)", i, fn, c["args"]), ok(unitResult(t, fn, args)), c["want"])
	}
	for i, c := range p.CSV {
		check(fmt.Sprintf("csv %d %q", i, str(c["text"])), tableJSON(ParseCSV(str(c["text"]))), c["want"])
	}
	for i, c := range p.CSVImports {
		check(fmt.Sprintf("csv import %d (%s)", i, str(c["collection"])), PreviewCSV(str(c["text"]), str(c["collection"])), c["want"])
	}
	for i, c := range p.Gradebooks {
		plugin := dec[MappingPlugin](t, c["plugin"])
		cls := str(c["className"])
		csv, warnings := MapGradebook(str(c["text"]), plugin, cls)
		check(fmt.Sprintf("gradebook %d (%s)", i, plugin.ID), map[string]any{"csv": csv, "warnings": warnings}, c["want"])
		check(fmt.Sprintf("gradebook preview %d (%s)", i, plugin.ID), PreviewGradebook(str(c["text"]), plugin, cls), c["preview"])
	}
	for i, c := range p.Calendars {
		out, err := PreviewICS(str(c["text"]), dec[ICSOptions](t, c["opts"]))
		var got any = ok(out)
		if err != nil {
			got = map[string]any{"error": "throws"}
		}
		want := c["want"]
		if w := dec[map[string]any](t, want); w["error"] != nil {
			want = json.RawMessage(`{"error":"throws"}`)
		}
		check(fmt.Sprintf("calendar %d %q", i, str(c["text"])), got, want)
	}
	for i, c := range p.ICSExports {
		in := dec[struct {
			Now       time.Time     `json:"now"`
			Name      string        `json:"name"`
			Deadlines []ICSDeadline `json:"deadlines"`
			Meetings  []ICSMeeting  `json:"meetings"`
		}](t, c["input"])
		check(fmt.Sprintf("ics export %d", i), BuildICS(in.Deadlines, in.Meetings, in.Now, in.Name), c["want"])
	}
	for i, c := range p.Folds {
		check(fmt.Sprintf("fold %d", i), Fold(str(c["line"])), c["want"])
	}
	for i, c := range p.ToCSVCases {
		check(fmt.Sprintf("toCsv %d", i), ToCSV(dec[[]string](t, c["headers"]), dec[[]map[string]string](t, c["rows"])), c["want"])
	}
	for _, c := range p.Templates {
		check("csvTemplate "+str(c["collection"]), CSVTemplate(str(c["collection"])), c["want"])
	}
	for i, c := range p.MDFolders {
		files := map[string][]byte{}
		for k, v := range dec[map[string]string](t, c["files"]) {
			files[k] = []byte(v)
		}
		check(fmt.Sprintf("markdown folder %d", i), PreviewMarkdownFolder(OpenMemory(files)), c["want"])
	}
	for i, c := range p.Backups {
		b, err := ParseBackup(str(c["text"]))
		var got any = ok(b)
		if err != nil {
			got = map[string]any{"error": err.Error()}
		}
		check(fmt.Sprintf("backup %d", i), got, c["want"])
	}
	for i, c := range p.NotionBodies {
		ctx := dec[struct {
			PagePath      string   `json:"pagePath"`
			PropertyNames []string `json:"propertyNames"`
			Files         []string `json:"files"`
			DropTooltips  bool     `json:"dropTooltips"`
		}](t, c["ctx"])
		props := map[string]bool{}
		for _, n := range ctx.PropertyNames {
			props[n] = true
		}
		r := ConvertNotionMarkdown(str(c["input"]), BodyContext{PagePath: ctx.PagePath, PropertyNames: props,
			HasFile: func(p string) bool { return contains(ctx.Files, p) }, DropTooltips: ctx.DropTooltips})
		if r.Warnings == nil {
			r.Warnings = []string{}
		}
		check(fmt.Sprintf("page body %d %q", i, str(c["input"])), map[string]any{
			"markdown": r.Markdown, "attachments": r.Attachments, "droppedTooltips": r.DroppedTooltips, "warnings": r.Warnings,
		}, c["want"])
	}
	for i, c := range p.Notion {
		in := dec[struct {
			Files map[string]string `json:"files"`
			Zip   string            `json:"zip"`
		}](t, c["input"])
		opts := dec[struct {
			Today        string `json:"today"`
			DropTooltips bool   `json:"dropTooltips"`
		}](t, c["opts"])
		var a Archive
		if in.Zip != "" {
			b, _ := base64.StdEncoding.DecodeString(in.Zip)
			var err error
			if a, err = OpenZip(b); err != nil {
				t.Fatal(err)
			}
		} else {
			files := map[string][]byte{}
			for k, v := range in.Files {
				files[k] = []byte(v)
			}
			a = OpenMemory(files)
		}
		check(fmt.Sprintf("notion export %d", i), PreviewNotion(a, NotionOptions{Today: opts.Today, KeepTooltips: !opts.DropTooltips}), c["want"])
	}
	fixture, err := OpenDir("../../fixtures/synthetic/notion-export")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range p.Fixture {
		check("synthetic Notion export, today "+str(c["today"]), PreviewNotion(fixture, NotionOptions{Today: str(c["today"])}), c["want"])
	}
	t.Logf("%d unit, %d CSV, %d CSV import, %d gradebook, %d calendar, %d Markdown folder, %d page body and %d Notion export cases checked",
		len(p.Unit), len(p.CSV), len(p.CSVImports), len(p.Gradebooks), len(p.Calendars), len(p.MDFolders), len(p.NotionBodies), len(p.Notion))
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}
