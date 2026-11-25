package core

import (
	"encoding/json"
	"fmt"

	"github.com/reeper316099/classpad/internal/editor/doc"
	"github.com/reeper316099/classpad/internal/editor/markdown"
)

// Command is one call from the page, e.g. {"name":"insertText","text":"a"}.
type Command struct {
	Name     string         `json:"name"`
	Text     string         `json:"text,omitempty"`
	Mark     string         `json:"mark,omitempty"`
	Href     string         `json:"href,omitempty"`
	Type     string         `json:"type,omitempty"`
	Attrs    doc.Attrs      `json:"attrs,omitempty"`
	Sel      *doc.Selection `json:"selection,omitempty"`
	Path     doc.Path       `json:"path,omitempty"`
	Offset   int            `json:"offset,omitempty"`
	Caret    int            `json:"caret,omitempty"`
	ID       string         `json:"id,omitempty"`
	Target   string         `json:"target,omitempty"`
	Where    string         `json:"where,omitempty"`
	QueryLen int            `json:"queryLen,omitempty"`
	Plain    bool           `json:"plain,omitempty"`
	Markdown string         `json:"markdown,omitempty"`
}

// Result is sent back after every command.
type Result struct {
	View    *View  `json:"view,omitempty"`
	Changed bool   `json:"changed"`
	Text    string `json:"text,omitempty"`  // copy: Markdown
	Plain   string `json:"plain,omitempty"` // copy: plain text
	Error   string `json:"error,omitempty"`
}

// newBlock builds the block a menu asks for, with text for text blocks.
func newBlock(typ string, attrs doc.Attrs, text string) *doc.Node {
	var d doc.Delta
	if text != "" {
		d = markdown.ParseInline(text)
	}
	if typ == doc.Todo && attrs == nil {
		attrs = doc.Attrs{doc.AttrChecked: false}
	}
	if typ == doc.Table && attrs == nil {
		attrs = doc.Attrs{doc.AttrRows: [][]string{{"Column 1", "Column 2", "Column 3"}, {"", "", ""}, {"", "", ""}}}
	}
	if typ == doc.Callout && attrs == nil {
		attrs = doc.Attrs{doc.AttrIcon: "💡"}
	}
	if typ == doc.Toggle && attrs == nil {
		attrs = doc.Attrs{doc.AttrLevel: 0}
	}
	return doc.NewNode(typ, attrs, d)
}

// Exec runs a command and returns the new view.
func (s *State) Exec(c Command) (res Result) {
	defer func() {
		if r := recover(); r != nil {
			res = Result{Error: fmt.Sprint(r)}
			v := s.View(true)
			res.View = &v
		}
	}()
	full := false
	switch c.Name {
	case "select":
		if c.Sel != nil {
			s.SetSelection(*c.Sel)
		}
	case "insertText":
		s.InsertText(c.Text)
	case "insertNewline":
		s.InsertNewline()
	case "insertSoftBreak":
		s.InsertSoftBreak()
	case "deleteBackward":
		s.DeleteBackward()
	case "deleteForward":
		s.DeleteForward()
	case "deleteSelection":
		s.DeleteSelection()
	case "syncText":
		s.SyncText(c.Path, c.Text, c.Caret)
	case "toggleMark":
		s.ToggleMark(c.Mark)
	case "setLink":
		s.SetLink(c.Href)
	case "insertFormula":
		s.InsertFormula(c.Text)
	case "setFormula":
		s.SetFormula(c.Path, c.Offset, c.Text)
	case "indent":
		s.Indent()
	case "outdent":
		s.Outdent()
	case "turnInto":
		s.TurnInto(c.Type, c.Attrs)
	case "insertBlock":
		s.InsertBlock(newBlock(c.Type, c.Attrs, c.Text))
	case "slash":
		s.ApplySlash(c.QueryLen, newBlock(c.Type, c.Attrs, c.Text))
	case "setAttrs":
		s.SetAttrs(c.Path, c.Attrs)
	case "toggleTodo":
		s.ToggleTodo()
	case "move":
		s.MoveBlock(c.ID, c.Target, c.Where)
	case "moveUp":
		s.MoveUp()
	case "moveDown":
		s.MoveDown()
	case "duplicate":
		s.Duplicate(c.ID)
	case "deleteBlock":
		s.DeleteBlock(c.ID)
	case "selectAll":
		s.SelectAll()
	case "undo":
		s.Undo()
	case "redo":
		s.Redo()
	case "paste":
		s.Paste(c.Markdown, c.Plain)
	case "copy", "cut":
		res.Text, res.Plain = s.Copy()
		if c.Name == "cut" {
			s.DeleteSelection()
		}
	case "load":
		*s = *New(c.Markdown)
	case "view":
		full = true
	default:
		return Result{Error: "unknown command " + c.Name}
	}
	res.Changed = s.Dirty()
	v := s.View(full || c.Name == "load")
	res.View = &v
	return res
}

// ExecJSON is Exec for callers that speak JSON (the WebAssembly bridge).
func (s *State) ExecJSON(in string) string {
	var c Command
	var res Result
	if err := json.Unmarshal([]byte(in), &c); err != nil {
		res = Result{Error: err.Error()}
	} else {
		res = s.Exec(c)
	}
	out, _ := json.Marshal(res)
	return string(out)
}
