//go:build js && wasm

// Command editorwasm is the note editor's core compiled to WebAssembly. It exposes a small API on
// globalThis.classpadEditor; the page draws blocks and forwards keys and edits to it.
package main

import (
	"syscall/js"

	"github.com/reeper316099/classpad/internal/editor/core"
)

func main() {
	states := map[int]*core.State{}
	next := 1
	api := js.Global().Get("Object").New()
	api.Set("create", js.FuncOf(func(_ js.Value, args []js.Value) any {
		id := next
		next++
		states[id] = core.New(args[0].String())
		return id
	}))
	api.Set("exec", js.FuncOf(func(_ js.Value, args []js.Value) any {
		s := states[args[0].Int()]
		if s == nil {
			return `{"error":"closed"}`
		}
		return s.ExecJSON(args[1].String())
	}))
	api.Set("markdown", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if s := states[args[0].Int()]; s != nil {
			return s.Markdown()
		}
		return ""
	}))
	api.Set("destroy", js.FuncOf(func(_ js.Value, args []js.Value) any {
		delete(states, args[0].Int())
		return nil
	}))
	js.Global().Set("classpadEditor", api)
	if ready := js.Global().Get("classpadEditorReady"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}
	select {}
}
