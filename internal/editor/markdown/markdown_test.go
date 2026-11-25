package markdown

import (
	"strings"
	"testing"
	"unicode"

	"github.com/reeper316099/classpad/internal/editor/doc"
)

// Markdown that is already in the editor's normal form must come back byte for byte.
func TestRoundTrip(t *testing.T) {
	cases := []string{
		"# Lorem ipsum\n\nDolor **sit** amet, *consectetur* `adipiscing` ~~elit~~.\n",
		"Line one\nline two of the same paragraph\n",
		"- one\n- two\n  - nested\n  - nested two\n- three\n",
		"1. first\n2. second\n3. third\n",
		"5. five\n6. six\n",
		"- [ ] open task\n- [x] done task\n",
		"> quoted\n> second line\n",
		"> 💡 a callout\n",
		"```go\nfunc main() {}\n```\n",
		"````\n```\nnested fence\n```\n````\n",
		"$$\nE = mc^2\n$$\n",
		"Inline $x^2$ math and [[Wiki Page]] and [a link](https://example.com).\n",
		"---\n",
		"![diagram](attachment://abc123.png)\n",
		"| A | B |\n| --- | --- |\n| 1 | 2 |\n",
		"<details open>\n<summary>Toggle</summary>\n\nInside the toggle.\n\n</details>\n",
		"<details>\n<summary><h2>Toggle heading</h2></summary>\n\n- child\n\n</details>\n",
		"Costs $5 and $6, snake_case_name stays.\n",
		"First\n\n\nSecond after an empty line\n",
		"<div>raw html</div>\n",
		"Text with <u>underline</u>.\n",
		"**bold *and italic* inside**\n",
		"[**bold link**](https://example.com)\n",
		"- item\n\n  continued paragraph inside\n",
	}
	for _, md := range cases {
		got := Encode(Decode(md))
		if got != md {
			t.Errorf("round trip changed\n--- in\n%q\n--- out\n%q", md, got)
		}
	}
}

func TestDecodeShapes(t *testing.T) {
	d := Decode("# Title\n\n- [x] done\n  - child\n\n> 📌 pin\n")
	top := d.Root.Children
	if len(top) != 3 || top[0].Type != doc.Heading || top[1].Type != doc.Todo || top[2].Type != doc.Callout {
		t.Fatalf("%+v", top)
	}
	if !top[1].Bool(doc.AttrChecked) || len(top[1].Children) != 1 || top[1].Children[0].Type != doc.Bulleted {
		t.Fatal("todo child")
	}
	if top[2].String(doc.AttrIcon) != "📌" || top[2].Delta.Text() != "pin" {
		t.Fatal("callout")
	}
}

func TestInlineFormats(t *testing.T) {
	d := ParseInline("a **b** *c* `d` ~~e~~ [f](g) [[h]] $i$")
	want := map[string]string{"b": Bold, "c": Italic, "d": Code, "e": Strike, "f": Href, "h": Wiki}
	for _, o := range d {
		if k, ok := want[o.Insert]; ok {
			if o.Attrs[k] == nil {
				t.Errorf("%q missing %s", o.Insert, k)
			}
			delete(want, o.Insert)
		}
		if o.Insert == doc.Embed && o.Attrs[Formula] != "i" {
			t.Error("formula")
		}
	}
	if len(want) != 0 {
		t.Errorf("missing %v", want)
	}
}

func TestEscapesWhenNeeded(t *testing.T) {
	d := doc.Delta{}.Insert("2 * 3 * 4 and *stars*", nil)
	md := RenderInline(d)
	if back := ParseInline(md); back.Text() != d.Text() || len(back) != 1 {
		t.Fatalf("%q -> %#v", md, back)
	}
}

func TestStable(t *testing.T) {
	// whatever goes in, a second round trip changes nothing
	inputs := []string{
		"* a\n+ b\n\n\n\n1) x\n2) y\n",
		"Setext\n---\ntext",
		"- a\n\n- b\n",
		"<details>\n<summary>unclosed\n",
		"```\nunclosed fence\n",
		"  indented two\n\n      code block\n",
		"| a | b |\n|---|:-:|\n| 1 |\n",
		"> 🎯 icon\n> more\n\n> plain\n",
		"**unclosed *mixed _marks\n",
		"[[]] [](x) [a]( b ) $ $ $$x$$\n",
		"- a\n    - deep\n        - deeper\n- b\n",
		"1. a\n   - nested in number\n10. ten\n",
		"Trailing\n\n\n\n",
		"\n\nLeading blank lines\n",
	}
	for _, in := range inputs {
		once := Encode(Decode(in))
		twice := Encode(Decode(once))
		if once != twice {
			t.Errorf("not stable for %q\nonce:  %q\ntwice: %q", in, once, twice)
		}
	}
}

func TestEmptyDocument(t *testing.T) {
	d := Decode("")
	if len(d.Root.Children) != 1 || d.Root.Children[0].Type != doc.Paragraph {
		t.Fatal("empty note should have one paragraph")
	}
	if Encode(d) != "" {
		t.Fatal("empty note should encode empty")
	}
}

// FuzzNoTextLost: saving a note never loses its words. Pathological Markdown may be re-formatted, but every
// letter and digit the editor showed comes back after encoding and decoding again.
func FuzzNoTextLost(f *testing.F) {
	for _, s := range []string{"# a\n- b\n  - c\n", "> x\n", "```\ny\n```", "<details>\n<summary>t</summary>\n\nz\n\n</details>", "**a** *b* `c` $d$ [[e]]", "| a |\n|---|\n| b |"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, in string) {
		first := Decode(in)
		again := Decode(Encode(first))
		if a, b := words(first), words(again); a != b {
			t.Errorf("text changed for %q\nbefore: %q\nafter:  %q", in, a, b)
		}
	})
}

// words collects letters and digits of every block's text and attributes, in order.
func words(d *doc.Document) string {
	var b strings.Builder
	keep := func(s string) {
		for _, r := range s {
			if unicode.IsLetter(r) || unicode.IsDigit(r) {
				b.WriteRune(r)
			}
		}
	}
	d.Walk(func(n *doc.Node, _ doc.Path) bool {
		for _, o := range n.Delta {
			keep(o.Insert)
			if f, ok := o.Attrs[Formula].(string); ok {
				keep(f)
			}
		}
		for _, k := range []string{doc.AttrFormula, doc.AttrText, doc.AttrURL, doc.AttrAlt} {
			keep(n.String(k))
		}
		for _, r := range n.Rows() {
			keep(strings.Join(r, ""))
		}
		return true
	})
	return b.String()
}
