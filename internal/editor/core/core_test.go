package core

import (
	"strings"
	"testing"
	"time"

	"github.com/reeper316099/classpad/internal/editor/doc"
)

func at(s *State, path doc.Path, off int) *State {
	s.SetSelection(doc.Caret(path, off))
	return s
}

func typeText(s *State, text string) {
	for _, r := range text {
		s.InsertText(string(r))
	}
}

func expect(t *testing.T, s *State, want string) {
	t.Helper()
	if got := s.Markdown(); got != want {
		t.Fatalf("markdown\n got: %q\nwant: %q", got, want)
	}
}

func TestBlockShortcuts(t *testing.T) {
	cases := map[string]string{
		"# Title":     "# Title\n",
		"### Small":   "### Small\n",
		"- item":      "- item\n",
		"* item":      "- item\n",
		"1. first":    "1. first\n",
		"4. fourth":   "4. fourth\n",
		"[] task":     "- [ ] task\n",
		"[x] done":    "- [x] done\n",
		"- [] task":   "- [ ] task\n",
		"\" quoted":   "> quoted\n",
		"> toggle":    "<details open>\n<summary>toggle</summary>\n\n\n</details>\n",
		"plain # not": "plain # not\n",
	}
	for in, want := range cases {
		s := New("")
		typeText(s, in)
		if got := s.Markdown(); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}

func TestDividerAndCodeShortcuts(t *testing.T) {
	s := New("")
	typeText(s, "---")
	if s.Doc.Root.Children[0].Type != doc.Divider || !s.Sel.Start.Path.Equal(doc.Path{1}) {
		t.Fatal("--- should make a divider and move the caret below it")
	}
	s = New("")
	typeText(s, "```go")
	s.InsertNewline()
	typeText(s, "x := 1")
	expect(t, s, "```go\nx := 1\n```\n")
	s = New("")
	typeText(s, "``` ")
	typeText(s, "y")
	expect(t, s, "```\ny\n```\n")
}

func TestInlineShortcuts(t *testing.T) {
	cases := map[string]string{
		"a **bold** b":       "a **bold** b\n",
		"an *em* word":       "an *em* word\n",
		"use `code` x":       "use `code` x\n",
		"~~gone~~":           "~~gone~~\n",
		"x $y^2$ z":          "x $y^2$ z\n",
		"see [[Page]]":       "see [[Page]]\n",
		"[site](http://e.x)": "[site](http://e.x)\n",
		"2 * 3 * 4":          "2 * 3 * 4\n",
		"snake_case_x":       "snake_case_x\n",
	}
	for in, want := range cases {
		s := New("")
		typeText(s, in)
		if got := s.Markdown(); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
	s := New("")
	typeText(s, "**b**")
	if s.Doc.Root.Children[0].Delta[0].Attrs["bold"] != true {
		t.Fatal("bold not applied")
	}
	typeText(s, "x")
	if a := s.Doc.Root.Children[0].Delta[1].Attrs; a["bold"] != nil {
		t.Fatal("text after the closing ** should not be bold")
	}
}

func TestEnterContinuesAndLeavesLists(t *testing.T) {
	s := New("- one\n")
	at(s, doc.Path{0}, 5)
	s.InsertNewline()
	typeText(s, "two")
	expect(t, s, "- one\n- two\n")
	s.InsertNewline()
	s.InsertNewline() // empty bullet: becomes a paragraph
	if s.Doc.NodeAt(s.Sel.Start.Path).Type != doc.Paragraph {
		t.Fatal("empty bullet + Enter should leave the list")
	}
	s = New("- [x] done\n")
	at(s, doc.Path{0}, 4)
	s.InsertNewline()
	expect(t, s, "- [x] done\n- [ ]\n")
}

func TestEnterSplitsAndHeadingMakesParagraph(t *testing.T) {
	s := New("# Hello world\n")
	at(s, doc.Path{0}, 5)
	s.InsertNewline()
	expect(t, s, "# Hello\n\nworld\n") // Markdown drops a leading space
	s = New("abc\n")
	at(s, doc.Path{0}, 0)
	s.InsertNewline()
	expect(t, s, "\nabc\n")
	if !s.Sel.Start.Path.Equal(doc.Path{1}) {
		t.Fatal("caret should stay on the pushed-down block")
	}
}

func TestEnterInCodeAndExit(t *testing.T) {
	s := New("```\nx\n```\n")
	at(s, doc.Path{0}, 1)
	s.InsertNewline()
	s.InsertNewline()
	s.InsertNewline()
	expect(t, s, "```\nx\n```\n")
	if s.Doc.NodeAt(s.Sel.Start.Path).Type != doc.Paragraph {
		t.Fatal("two blank lines at the end of code should exit it")
	}
}

func TestEnterInOpenToggleAddsChild(t *testing.T) {
	s := New("<details open>\n<summary>T</summary>\n\n</details>\n")
	at(s, doc.Path{0}, 1)
	s.InsertNewline()
	typeText(s, "inside")
	expect(t, s, "<details open>\n<summary>T</summary>\n\ninside\n\n</details>\n")
}

func TestBackspace(t *testing.T) {
	s := New("- item\n")
	at(s, doc.Path{0}, 0)
	s.DeleteBackward()
	expect(t, s, "item\n")
	s = New("one\n\ntwo\n")
	at(s, doc.Path{1}, 0)
	s.DeleteBackward()
	expect(t, s, "onetwo\n")
	if s.Sel.Start.Offset != 3 {
		t.Fatal("caret at the join")
	}
	s = New("a\n\n---\n\nb\n")
	at(s, doc.Path{2}, 0)
	s.DeleteBackward()
	expect(t, s, "a\n\nb\n")
	s = New("a😀\n")
	at(s, doc.Path{0}, 3)
	s.DeleteBackward()
	expect(t, s, "a\n")
}

func TestBackspaceJoinsNestedLineIntoParent(t *testing.T) {
	s := New("- parent\n  - child\n")
	at(s, doc.Path{0, 0}, 0)
	s.DeleteBackward() // child bullet -> paragraph
	s.DeleteBackward() // paragraph joins the parent
	expect(t, s, "- parentchild\n")
}

func TestDeleteForwardMerges(t *testing.T) {
	s := New("one\n\ntwo\n")
	at(s, doc.Path{0}, 3)
	s.DeleteForward()
	expect(t, s, "onetwo\n")
}

func TestIndentOutdent(t *testing.T) {
	s := New("- a\n- b\n- c\n")
	at(s, doc.Path{1}, 0)
	s.Indent()
	expect(t, s, "- a\n  - b\n- c\n")
	if !s.Sel.Start.Path.Equal(doc.Path{0, 0}) {
		t.Fatalf("caret follows the block: %v", s.Sel.Start.Path)
	}
	s = New("- a\n  - b\n  - c\n")
	at(s, doc.Path{0, 0}, 0)
	s.Outdent()
	expect(t, s, "- a\n- b\n  - c\n")
}

func TestDeleteAcrossBlocksKeepsLaterChildren(t *testing.T) {
	s := New("first\n\n- second\n  - child one\n  - child two\n")
	s.SetSelection(doc.Selection{Start: doc.Position{Path: doc.Path{0}, Offset: 2}, End: doc.Position{Path: doc.Path{1, 0}, Offset: 6}})
	s.DeleteSelection()
	expect(t, s, "fione\n\n- child two\n")
}

func TestTurnIntoAndSlash(t *testing.T) {
	s := New("text\n")
	at(s, doc.Path{0}, 4)
	s.TurnInto(doc.Heading, doc.Attrs{doc.AttrLevel: 2})
	expect(t, s, "## text\n")
	s = New("")
	typeText(s, "/code")
	s.ApplySlash(5, newBlock(doc.Code, doc.Attrs{doc.AttrLanguage: "go"}, ""))
	typeText(s, "x")
	expect(t, s, "```go\nx\n```\n")
	s = New("words")
	at(s, doc.Path{0}, 5)
	typeText(s, "/h1")
	s.ApplySlash(3, newBlock(doc.Heading, doc.Attrs{doc.AttrLevel: 1}, ""))
	expect(t, s, "# words\n")
	s = New("")
	s.ApplySlash(0, newBlock(doc.Divider, nil, ""))
	expect(t, s, "---\n")
	if s.Doc.NodeAt(s.Sel.Start.Path).Type != doc.Paragraph {
		t.Fatal("a paragraph follows a divider for the caret")
	}
}

func TestUndoRedoGroupsTyping(t *testing.T) {
	s := New("")
	clock := time.Unix(0, 0)
	s.now = func() time.Time { return clock }
	typeText(s, "hello")
	clock = clock.Add(5 * time.Second)
	typeText(s, " you")
	expect(t, s, "hello you\n")
	s.Undo()
	expect(t, s, "hello\n")
	s.Undo()
	expect(t, s, "")
	s.Redo()
	s.Redo()
	expect(t, s, "hello you\n")
}

func TestPaste(t *testing.T) {
	s := New("ab\n")
	at(s, doc.Path{0}, 1)
	s.Paste("**x**", false)
	expect(t, s, "a**x**b\n")
	s = New("ab\n")
	at(s, doc.Path{0}, 1)
	s.Paste("# H\n\n- l\n", false)
	expect(t, s, "a\n\n# H\n\n- l\n\nb\n")
	s = New("")
	s.Paste("line1\nline2", true)
	expect(t, s, "line1\n\nline2\n")
}

func TestCopy(t *testing.T) {
	s := New("# Head\n\n**bold** text\n")
	s.SetSelection(doc.Selection{Start: doc.Position{Path: doc.Path{0}, Offset: 2}, End: doc.Position{Path: doc.Path{1}, Offset: 4}})
	md, plain := s.Copy()
	if md != "# ad\n\n**bold**" || plain != "ad\nbold" {
		t.Fatalf("%q %q", md, plain)
	}
}

func TestMarks(t *testing.T) {
	s := New("hello world\n")
	s.SetSelection(doc.Selection{Start: doc.Position{Path: doc.Path{0}, Offset: 0}, End: doc.Position{Path: doc.Path{0}, Offset: 5}})
	s.ToggleMark("bold")
	expect(t, s, "**hello** world\n")
	if s.ActiveMarks()["bold"] != true {
		t.Fatal("bold active")
	}
	s.ToggleMark("bold")
	expect(t, s, "hello world\n")
	at(s, doc.Path{0}, 11)
	s.ToggleMark("italic")
	typeText(s, "!")
	expect(t, s, "hello world*!*\n")
}

func TestSyncTextKeepsFormatting(t *testing.T) {
	s := New("**ab** cd\n")
	s.SyncText(doc.Path{0}, "ab cXd", 5)
	expect(t, s, "**ab** cXd\n")
}

func TestMoveAndDuplicate(t *testing.T) {
	s := New("a\n\nb\n\nc\n")
	ids := []string{}
	for _, n := range s.Doc.Root.Children {
		ids = append(ids, n.ID)
	}
	s.MoveBlock(ids[2], ids[0], "before")
	expect(t, s, "c\n\na\n\nb\n")
	s.Duplicate(ids[1])
	expect(t, s, "c\n\na\n\nb\n\nb\n")
	s.DeleteBlock(ids[2])
	expect(t, s, "a\n\nb\n\nb\n")
	at(s, doc.Path{0}, 0)
	s.MoveDown()
	expect(t, s, "b\n\na\n\nb\n")
}

func TestExecJSON(t *testing.T) {
	s := New("")
	out := s.ExecJSON(`{"name":"insertText","text":"x"}`)
	if !strings.Contains(out, `"changed":true`) || !strings.Contains(out, `"insert":"x"`) {
		t.Fatal(out)
	}
	if out := s.ExecJSON(`{"name":"nope"}`); !strings.Contains(out, "unknown command") {
		t.Fatal(out)
	}
}

func TestViewSendsOnlyChanges(t *testing.T) {
	s := New("a\n\nb\n\nc\n")
	v := s.View(true)
	if len(v.Blocks) != 3 || v.Tree == nil {
		t.Fatal("first view is full")
	}
	at(s, doc.Path{1}, 1)
	s.InsertText("x")
	v = s.View(false)
	if len(v.Blocks) != 1 || v.Tree != nil {
		t.Fatalf("typing should send one block and no tree: %d blocks, tree %v", len(v.Blocks), v.Tree != nil)
	}
	s.InsertNewline()
	v = s.View(false)
	if v.Tree == nil {
		t.Fatal("a new block changes the tree")
	}
	if v = s.View(false); len(v.Blocks) != 0 || v.Tree != nil {
		t.Fatal("nothing changed")
	}
}
