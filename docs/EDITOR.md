# The note editor

Notes are written as a page of blocks, the way AppFlowy and Notion work: headings, lists, to-dos, toggles, code,
equations and tables, all edited in place. Under the hood each note is still a plain Markdown file. The blocks
exist only while the note is open, and the file is written back only when you change something.

The editor is modelled on [AppFlowy Editor](https://github.com/AppFlowy-IO/appflowy-editor) (Flutter/Dart).
Its core (the block document, selection, undo, and every editing rule) is ported to Go and runs in the page as
WebAssembly. A thin TypeScript layer draws the blocks and passes keys and edits to the core.

## Blocks

Type **`/`** for the block menu. It filters as you type; arrows and Enter to pick, Esc to close.

| Block              | Type at the start of a line                     | Stored in Markdown as                     |
| ------------------ | ----------------------------------------------- | ----------------------------------------- |
| Text               |                                                 | a paragraph                               |
| Heading 1–6        | `#` … `######` then space                       | `# Heading`                               |
| To-do list         | `[]` or `[x]` then space                        | `- [ ] task`                              |
| Bulleted list      | `-` `*` `+` then space                          | `- item`                                  |
| Numbered list      | `1.` then space                                 | `1. item` (any start number)              |
| Toggle list        | `>` then space                                  | `<details open>` + `<summary>`            |
| Toggle heading 1–3 | from the menu                                   | `<summary><h2>…</h2></summary>`           |
| Quote              | `"` then space                                  | `> quote`                                 |
| Callout            | from the menu                                   | `> 💡 text` (click the icon to change it) |
| Code               | ` ``` ` then space, or ` ```python ` then Enter | a fenced code block with its language     |
| Divider            | `---`                                           | `---`                                     |
| Block equation     | `$$` then space                                 | `$$ … $$` (KaTeX)                         |
| Table              | from the menu                                   | a GitHub-style table                      |
| Image              | from the menu, paste or drop                    | `![alt](attachment://…)`                  |

Inline, as you type the closing mark: `**bold**`, `*italic*`, `_italic_`, `` `code` ``, `~~strike~~`,
`$x^2$` (inline equation), `[text](https://…)` (link), and `[[Note]]` (link to another note; typing `[[` opens a
picker).

Markdown the editor doesn't model (raw HTML, footnotes, link definitions…) is kept exactly as written and shown as
source; click it to edit.

## Around the blocks

- **Hover** a block for **`+`** (add a block below and open the menu) and **`⋮⋮`** (drag to move; drop on the
  right half of a list item or toggle to nest inside it; click for Turn into, Duplicate, Move and Delete).
- **Select text** for the toolbar: Turn into, bold, italic, underline, strikethrough, code, equation, link, and a
  flashcard blank when the Flashcards module is on.
- **Right-click** for Cut, Copy, Paste and the block actions.
- **Code blocks** have a language picker and a Copy button in their header. Tab indents inside code.
- **Toggles** fold with their arrow. The folded state is saved in the note (`<details>` vs `<details open>`).

## Keyboard

| Keys                         | Does                                                               |
| ---------------------------- | ------------------------------------------------------------------ |
| Enter                        | New block (lists continue; Enter on an empty item leaves the list) |
| Shift Enter                  | Line break inside the block                                        |
| Backspace at a block's start | Turns it into text, then joins it to the block above               |
| Tab · Shift Tab              | Nest · un-nest (several selected blocks at once)                   |
| Ctrl/⌘ B · I · U · E         | Bold · italic · underline · inline code                            |
| Ctrl/⌘ Shift S               | Strikethrough                                                      |
| Ctrl/⌘ K                     | Link                                                               |
| Ctrl/⌘ Alt 1 · 2 · 3 · 0     | Heading 1 · 2 · 3 · text                                           |
| Ctrl/⌘ Shift 7 · 8 · 9       | Numbered · bulleted · to-do                                        |
| Ctrl/⌘ Alt C · T             | Code block · toggle                                                |
| Ctrl/⌘ Enter                 | Check or uncheck a to-do                                           |
| Ctrl/⌘ Shift ↑ ↓             | Move the block                                                     |
| Ctrl/⌘ D                     | Duplicate the block                                                |
| Ctrl/⌘ A                     | Select the block, press again for the whole note                   |
| Ctrl/⌘ Z · Shift Z           | Undo · redo (typing is grouped into words)                         |

`⋯` → **Source mode** switches to the raw Markdown and back.

## Good to know

- Opening a note, moving around, or folding nothing leaves the file byte-for-byte unchanged. The first edit saves
  the note in the editor's tidy Markdown style (for example `*` bullets become `-`). The words are always kept:
  a fuzz test checks that saving never loses text.
- Blank lines between blocks are kept as empty lines, so the spacing you see is the spacing in the file.
- Raw HTML in a note is never rendered, except the toggle tags.

## For contributors

The core is Go, under `internal/editor/`:

- `doc/`: the document model ported from AppFlowy: `Node`, `Path`, `Delta` (rich text, offsets in UTF-16 units to
  match the browser), `Selection`, the four invertible operations, and `Transaction`.
- `markdown/`: Markdown ⇄ blocks. Round-trip and fuzz tests live here.
- `core/`: the editor state and commands: typing and its shortcuts, Enter, Backspace, Delete, indent, turn into,
  slash insert, move, paste and copy, undo/redo, and the view diff sent to the page (only changed blocks).
- `cmd/editorwasm/`: the WebAssembly bridge (`globalThis.classpadEditor`).

`scripts/build-editor-wasm.mjs` builds it to `apps/web/public/editor/` (Go 1.26+ needed; `npm run dev` and the web
build run it). The page side is `apps/web/src/blockeditor/`: `core.ts` (loading and the typed command API),
`render.ts` (drawing blocks and mapping DOM points to block positions), `BlockEditor.tsx` (events, menus, handles),
and `items.ts` (the block menu). The Source mode editor is the CodeMirror one in `apps/web/src/editor/`.

Tests: `go test ./cmd/... ./internal/...` for the core, `npx vitest run apps/web/src/blockeditor` for the DOM mapping, and
`e2e/editor.spec.ts` for the real thing in a browser (WebKit and Chromium, the desktop app's engines).
