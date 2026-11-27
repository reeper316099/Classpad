package importers

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

// The same work as scripts/importers-bench.mjs times in the TypeScript importers.

func benchData(b *testing.B) parityFile {
	b.Helper()
	t := &testing.T{}
	p := loadParity(t)
	return p
}

// BenchmarkNotionFixture previews the synthetic export, read into memory once (the timing is the
// import, not the disk).
func BenchmarkNotionFixture(b *testing.B) {
	benchData(b)
	dir, err := OpenDir("../../fixtures/synthetic/notion-export")
	if err != nil {
		b.Fatal(err)
	}
	files := map[string][]byte{}
	for _, f := range dir.Files() {
		files[f], _ = dir.Read(f)
	}
	for b.Loop() {
		PreviewNotion(OpenMemory(files), NotionOptions{Today: "2031-10-15"})
	}
}

func BenchmarkNotionExports(b *testing.B) {
	p := benchData(b)
	type input struct {
		files map[string][]byte
		zip   []byte
	}
	var inputs []input
	for _, c := range p.Notion {
		var in struct {
			Files map[string]string `json:"files"`
			Zip   string            `json:"zip"`
		}
		json.Unmarshal(c["input"], &in)
		if in.Zip != "" {
			z, _ := base64.StdEncoding.DecodeString(in.Zip)
			inputs = append(inputs, input{zip: z})
			continue
		}
		files := map[string][]byte{}
		for k, v := range in.Files {
			files[k] = []byte(v)
		}
		inputs = append(inputs, input{files: files})
	}
	for b.Loop() {
		for _, in := range inputs {
			var a Archive
			if in.zip != nil {
				a, _ = OpenZip(in.zip)
			} else {
				a = OpenMemory(in.files)
			}
			PreviewNotion(a, NotionOptions{Today: "2031-10-15"})
		}
	}
}

func BenchmarkCSV(b *testing.B) {
	p := benchData(b)
	var texts []string
	for _, c := range p.CSV {
		texts = append(texts, str(c["text"]))
	}
	type imp struct{ text, collection string }
	var imps []imp
	for _, c := range p.CSVImports {
		imps = append(imps, imp{str(c["text"]), str(c["collection"])})
	}
	for b.Loop() {
		for _, t := range texts {
			ParseCSV(t)
		}
		for _, c := range imps {
			PreviewCSV(c.text, c.collection)
		}
	}
}

func BenchmarkCalendars(b *testing.B) {
	p := benchData(b)
	type cal struct {
		text string
		opts ICSOptions
	}
	var cals []cal
	for _, c := range p.Calendars {
		var o ICSOptions
		json.Unmarshal(c["opts"], &o)
		cals = append(cals, cal{str(c["text"]), o})
	}
	for b.Loop() {
		for _, c := range cals {
			PreviewICS(c.text, c.opts)
		}
	}
}
