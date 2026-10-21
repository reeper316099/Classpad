# The note editor

Notes are written in one view: the page looks finished while you type, with no separate edit and preview
panes. Under the hood a note is still a plain Markdown file, and the editor never rewrites what you did not touch.

## How it works

The editor shows Markdown as it will read. The syntax (`#`, `**`, `[ ]`, the URL of a link…) is hidden, and
appears dimly on the line or element your caret is in, so you can always see and edit what is really there. Click
an equation, table or image and its source opens; move away and it renders again.

Because the file is the source of truth, opening a note, scrolling, or typing and deleting a character leaves it
byte-for-byte unchanged. If you ever want the raw text, `⋯` → **Source mode** shows it, and switches back.

## Blocks

Type **`/`** on a line to pick a block. It filters as you type, with Enter to choose.

| Block                                                                       | Typing shortcut | Notes                                                                         |
| --------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------- |
| Text, Heading 1–3                                                           | `#` `##` `###`  |                                                                               |
| To-do, Bulleted, Numbered                                                   | `[] ` `-` `1.`  | To-dos are real checkboxes; Tab nests, Enter on an empty item steps out       |
| Quote, Callout                                                              | `>`             | A quote that starts with an emoji becomes a callout                           |
| Toggle list, Toggle heading 1–3                                             |                 | Collapsible, nestable; stored as portable `<details>`                         |
| Code                                                                        | ` ``` `         | Pick the language from the header; Copy button on hover                       |
| Block equation, Table, Divider                                              | `$$` · · `---`  | Equations use KaTeX; Tab moves between table cells, and adds a row at the end |
| Image or file, Link to note, Inline equation, Flashcard blank, Today's date |                 | Under the same menu                                                           |

Hover a block to see **`+`** (add a block below) and a drag grip **`⋮⋮`**. Drag to reorder, or click it for
**Turn into**, **Duplicate**, **Move** and **Delete**. **Right-click** anywhere for the same, plus Cut/Copy/Paste.
Select text for a floating toolbar (bold, italic, strikethrough, code, equation, link, Turn into).

## Keyboard

| Keys                       | Does                                    |
| -------------------------- | --------------------------------------- |
| Ctrl/⌘ B · I · E · Shift S | Bold · italic · code · strikethrough    |
| Ctrl/⌘ K                   | Link                                    |
| Ctrl/⌘ Alt 1 · 2 · 3 · 0   | Heading 1 · 2 · 3 · plain text          |
| Ctrl/⌘ Shift 7 · 8 · 9     | Numbered · bulleted · to-do             |
| Ctrl/⌘ Alt C · T           | Code block · toggle                     |
| Ctrl/⌘ Shift ↑ ↓           | Move the block                          |
| Ctrl/⌘ D                   | Duplicate the block                     |
| Ctrl/⌘ Enter               | Check or uncheck a to-do                |
| Enter · Shift Enter        | New block · line break inside the block |

## Good to know

- Opening or closing a toggle changes the view only; it is not saved in the note. A toggle opens by default when
  it has the `open` attribute (new ones do).
- Toggles are recognised only when well-formed (a `<details>` line, a `<summary>` line, a closing `</details>`). A
  half-typed tag stays ordinary text and never swallows the page.
- Raw HTML in a note is never rendered, except these toggle tags.
- Large notes stay fast: only what is on screen is decorated (a 150,000-character outline opens in a quarter of a second).

## For contributors

The editor lives in `apps/web/src/editor/`:

- `blocks.ts`: block kinds, the menu catalogue, and line conversions (pure strings, tested).
- `model.ts`: finds the block at a position and implements move, duplicate, delete, turn-into and reorder on a CodeMirror state (tested without a browser).
- `live.ts`: the live-preview decorations (per-viewport inline plugin plus a document-wide field for tables, equations and toggles).
- `widgets.ts`, `slash.ts`, `keys.ts`, `handle.ts`: widgets, the `/` menu, key handling, and the hover handles.
- Menus are React (`components/Menu.tsx`, `components/EditorMenus.tsx`).
