package importers

import (
	"strings"
	"testing"
	"time"
)

// Large hostile inputs must stay fast (each well under a second): nothing here may be quadratic.
func TestWorstCaseInputs(t *testing.T) {
	if testing.Short() {
		t.Skip("slow")
	}
	ctx := BodyContext{PagePath: "a/b.md", PropertyNames: map[string]bool{"x": true}, HasFile: func(string) bool { return false }, DropTooltips: true}
	for name, s := range map[string]string{
		"details open":    strings.Repeat("<details>", 20000),
		"details summary": strings.Repeat("<details><summary>", 20000),
		"toggles":         strings.Repeat("<details><summary>s</summary>b</details>", 2000),
		"quotes":          strings.Repeat(`"`, 200000),
		"quote pairs":     strings.Repeat(`"a"",`, 100000),
		"newlines":        strings.Repeat("\n", 200000),
		"hashes":          strings.Repeat("#\n", 100000),
		"hash spaces":     "#" + strings.Repeat(" \n", 100000),
		"links":           strings.Repeat("[a](b.png)", 50000),
		"asides":          strings.Repeat("<aside>", 50000),
		"relations":       strings.Repeat("(a.md", 50000),
		"ics lines":       "BEGIN:VCALENDAR\n" + strings.Repeat("BEGIN:VEVENT\nSUMMARY:x\nDTSTART:20260101T000000\nEND:VEVENT\n", 20000) + "END:VCALENDAR",
		"csv wide":        strings.Repeat("a,", 100000) + "\n" + strings.Repeat("1,", 100000),
		"props":           strings.Repeat("x: 1\n", 100000),
	} {
		t0 := time.Now()
		ParseCSV(s)
		ConvertNotionMarkdown(s, ctx)
		PreviewICS(s, ICSOptions{})
		ParseRelation(s)
		firstH1(s)
		ParseNotionDate(s)
		if d := time.Since(t0); d > 2*time.Second {
			t.Errorf("%s: %v for %d bytes", name, d, len(s))
		}
	}
}
