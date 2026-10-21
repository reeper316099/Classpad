# Changelog

## Unreleased

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
