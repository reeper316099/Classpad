package importers

import (
	"testing"
	"time"
)

// Whatever a file contains, reading it must never crash.
func FuzzImportersNeverPanic(f *testing.F) {
	for _, s := range []string{
		"a,b\n1,2\n", "\"x\nBEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:2026\r\nEND:VEVENT\r\nEND:VCALENDAR",
		"<details><summary><h2>x</h2></summary>y</details>", "---\na: [\n---\n", "Mon 9-10a; Tue", "(x.md) (https://a/b)",
		"\uFEFF\uFEFF\"a\"\"b\",c\r\n", "# \n ", "August 31st 2026 3:00 PM (EST) → 2026-13-45",
	} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		t0 := time.Now()
		defer func() {
			if d := time.Since(t0); d > 500*time.Millisecond {
				t.Fatalf("took %v for %d bytes", d, len(s))
			}
		}()
		ParseCSV(s)
		ParseNotionDate(s)
		ParseTimes(s, ParseDays(s))
		ParseRelation(s)
		NormTitle(s)
		SplitName(s)
		ConvertNotionMarkdown(s, BodyContext{PagePath: "a/b.md", PropertyNames: map[string]bool{}, HasFile: func(string) bool { return true }, DropTooltips: true})
		PreviewICS(s, ICSOptions{})
		ParseFrontmatter(s)
		PreviewCSV(s, "classes")
		MapGradebook(s, BuiltinMappings[1], "")
		ParseBackup(s)
		Fold(s)
		firstH1(s)
	})
}
