# Changelog

## Unreleased

### Security

- Updated zod (data validation) to 4.6.7 for GHSA-mrhx-c7xc-m3w5, where a very large list could exhaust memory during validation. Plugin files without a `wide` section still get its defaults.

### Note editor: blocks, like AppFlowy

- Notes are now a page of blocks you write in directly, modelled on AppFlowy's editor: the `/` menu (with a hint for every block), Markdown shortcuts as you type (`# `, `- `, `[] `, `1. `, `> ` toggle, `" ` quote, ` ```python `, `---`, `$$`, `**bold**`, `$x$`, `[[Note]]`), a hover `+` and drag handle, a block menu (Turn into, Duplicate, Move, Delete), a selection toolbar with underline, and in-place editors for equations, tables, images and links.
- The editor's core is written in Go and runs in the page as WebAssembly: the block document, selection, undo and every editing rule. Typing takes under 1 ms per key even on a 1,200-block note. This is the first part of [moving Classpad to Go](docs/go-port/README.md).
- Notes are still plain Markdown files. Opening a note never changes it; the first edit saves it in a tidy Markdown style, and a fuzz test checks that saving never loses text. Toggle fold state is now saved in the note.
- Source mode (raw Markdown) is still in the `⋯` menu.
- Building Classpad now needs Go 1.24+ as well as Node.js.

### Go port, step 2: the grade engine

- The grade and GPA engine is now also written in Go (`internal/grades`): current grade with its step-by-step breakdown, what-if, the score needed for a target, sensitivity, projection, GPA, retakes and the GPA planner. It gives the same answers as the TypeScript engine digit for digit, checked on 45,000 generated cases, and CI checks the two still agree on every change.
- Nothing changes in the app yet: the Go engine takes over when the local API moves to Go (step 4). See [docs/go-port](docs/go-port/README.md).

### Go port, step 3: storage

- The data folder store is now also written in Go (`internal/jsonstore`): atomic saves, per-file locking, recovery of corrupt files from backups, migrations, encryption at rest, zipped backups and the watcher for hand edits.
- Data folders don't change: the Go store writes the same bytes as today's store and the same encrypted files, and each reads the other's files and backups. CI checks both directions on every change.
- Building Classpad now needs Go 1.26 or newer.

### Grading

- Typing a bare score such as `18` on a 20-point assignment now records 18/20 (it was read as 18%, which dragged grades down). Write `90%` for a percent. Scores already saved as percents are not changed; re-enter them.
- Set a class's own category weights: **Grades → Set up grading** lets you add categories (Homework, Exams…), give each a weight, drop the lowest scores, choose how a category is combined, and sort assignments into categories (with a "match by type or title" shortcut). Before, the category mode had no way to create categories, so every assignment needed its own weight. See [docs/GRADING.md](docs/GRADING.md).

### Note editor: one view, like Notion

- Edit and preview are now a single live view. The page looks finished as you type; Markdown syntax shows only where your caret is. The file on disk is never reshaped (opening a note leaves it byte-for-byte unchanged).
- Type `/` for blocks (text, headings, to-do, lists, toggle list and toggle headings, quote, callout, code, equation, table, divider, image or file). Hover handles to add a block or drag to reorder; right-click or click the grip for Turn into, Duplicate, Move and Delete; select text for a floating formatting toolbar.
- Enter starts a new block; lists continue and step out the way you expect; Tab nests and moves between table cells; `[] ` becomes a to-do and a typed code fence closes itself.
- Code blocks have a language picker and a Copy button. Equations, tables, images and attachments render in place.
- The tidy header: title, class/date/tags, save status and a single `⋯` menu (outline, focus mode, source mode, flashcard from selection, delete). See [docs/EDITOR.md](docs/EDITOR.md).

### Notes

- Collapsible toggles like Notion's: toggle list and toggle headings 1, 2 and 3 (stored as portable `<details>`, nestable). Insert them from the new **Toggle** menu in the note toolbar.
- Code blocks: a toolbar button with a language picker, and rendered blocks show their language with a Copy button.

### Class page

- The Notes, Readings and Files tabs are real: a class's notes, its reading list with progress (add readings right there), and its syllabus plus attached files.

### Notion import

- A note's class now falls back to the class page's list of notes, then to its related assignment or reading, and anything unresolved is reported as a warning. Assignments and readings get the same fallbacks.
- Toggles stay collapsible. More Status and reading-status wordings are understood.
- Class Type accepts any value (it was limited to Core, Gen Ed and Elective, which hid other imported types).

### Import and export helpers

- Gradebook CSV import for LMS-style exports (a row per assignment, or a column per assignment), with a preview, warnings for anything skipped, and undo.
- Declarative plugins: drop a JSON file in `plugins/` to teach Classpad a new CSV layout. Plugins contain no code. See [docs/PLUGINS.md](docs/PLUGINS.md).
- Gradebook CSV export (one row per assignment, with class percent and letter).
- One-way "Export to a folder" for other apps: backup, spreadsheet, calendar files and Markdown notes. Asks before writing unencrypted copies of encrypted data.

## 0.1.0 (first public release)

Local-first student workspace. No network, no telemetry, no accounts.

### Grades

- Exact-decimal engine with assignment-weight, category-weight and points modes, drop-lowest, extra
  credit, late penalties, curves and pass/fail.
- Step-by-step breakdown for every number; what-if (never saved); "what do I need?" solver; sensitivity.
- GPA: unweighted, weighted, credit-weighted, per semester and cumulative, retakes, target planner.

### Notes and planner

- Markdown notes as real `.md` files: math (KaTeX), wiki links and backlinks, templates, PDF viewer.
- Timetable, calendar, tasks, workload heatmap, study timer and statistics, dashboard.

### Import and export

- Notion export, CSV, ICS, Markdown folders and JSON backups with preview, conflict strategies and undo.
- JSON, CSV, ICS, Markdown and printable report exports.

### Optional modules

- Reading (on by default), journal, contacts, activities, jobs & internships, admissions, budget.
- Flashcards with SM-2 style spaced repetition and `{{c1::cloze}}` cards generated from notes.

### Privacy and security

- App lock with optional AES-256-GCM encryption at rest (scrypt). Lost passphrases cannot be recovered.
- Sandboxed renderer, token-protected loopback API, all non-local requests blocked.

### Quality

- Accessibility audit (axe) passes in light and dark themes across all pages.
- Performance budgets verified at 10,000 notes and 5,000 assignments.

### Known limitations

- Builds are unsigned; your OS will warn on first launch.
- Attachments are not encrypted at rest.
- English only. No sync between devices.
