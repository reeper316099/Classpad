# Changelog

## Unreleased

### Classpad is now one Go program

- The desktop app no longer bundles Electron (a copy of Chromium and Node.js). It is a single Go program that shows the interface in your system's own web view: WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux.
- **Smaller and faster:** the macOS download is 23.7 MB instead of 231.7 MB. The app's server starts in about 35 ms instead of about 350 ms and uses about 22 MB of memory instead of about 143 MB, and it answers about as fast or faster on every page measured.
- **Safer:** the server now runs inside the app and no longer listens on a network port at all, so no other program on your computer can reach it. The rule that the app never contacts the internet still holds (the page's security policy blocks anything outside the app); links open in your browser.
- **Your data folder doesn't change.** Notes stay Markdown files and everything else stays where it was; the new app reads the folder as it is. The old Electron app's own files (the `electron` folder inside your data folder) are no longer used and can be deleted.
- **Save Grade Report as PDF** is now **Print Grade Report…**: the system print dialog can save it as a PDF on all three systems.
- **Installers:** a universal `.dmg` for macOS; for Windows an installer that needs no administrator rights (it adds Microsoft's WebView2 if Windows 10 lacks it) and a portable `.exe`; for Linux `.deb`, `.rpm` and a `.tar.gz` (they need GTK 4 and WebKitGTK 6.0). There is no AppImage any more: putting WebKitGTK inside one is not reliable.
- Exports (CSV, calendars, backups, notes) are saved through a normal Save dialog.

### Fixes

- Typing right after opening a note could be lost: the note showed a moment before it could be edited. A click made while the editor is still opening now puts the cursor in once it is ready, and if the editor's core cannot start, it says so instead of loading forever.
- Menus no longer pick the row under a mouse that merely rests where they open (for example the `/` menu: Enter now takes the first match). The mouse moves the highlight only when it actually moves.
- The note's save label said "Saved" for a moment after you typed, before your words had been handed over for saving. It now says "Unsaved changes" straight away.
- A link to a note made a moment ago elsewhere (an import, another window) could show "Pick a note" instead of the note.
- Dialogs reset their fields before they appear, so typing as soon as one opens is never cleared.
- A key pressed as a flashcard review opens is no longer missed.
- Items created together (an import, the demo data) now keep the order they were made in lists sorted by creation.
- Windows: backups failed in the new desktop app because of a lock file the system browser engine keeps in the data folder; such lock files are now left out of backups.
- Settings now stick between launches: which modules are switched on, theme and accent, the chosen semester, week start, reminders, Pomodoro lengths, the export folder and Source mode. They were kept in the window's browser storage, which the desktop app lost on every launch (it opens on a new local port each time, and browser storage belongs to one address). They are now saved in the data folder (`config/settings.json`), so they are also in backups. Settings from before this fix are moved over the first time the app opens.

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
- The app uses it since the server moved to Go (see above). See [docs/go-port](docs/go-port/README.md).

### Go port, step 3: storage

- The data folder store is now also written in Go (`internal/jsonstore`): atomic saves, per-file locking, recovery of corrupt files from backups, migrations, encryption at rest, zipped backups and the watcher for hand edits.
- Data folders don't change: the Go store writes the same bytes as today's store and the same encrypted files, and each reads the other's files and backups. CI checks both directions on every change.
- Building Classpad now needs Go 1.26 or newer.

### Go port, step 4: importers

- The importers are now also written in Go (`internal/importers`): Notion exports (zipped, nested or as a folder), CSV files, gradebook mappings, calendars (.ics in and out), Markdown folders and Classpad backups.
- They give the same preview as today's importers for the same file, down to how odd CSVs are split and how calendar times are read. This was checked on about 110,000 generated cases and on a real Notion export. CI checks the two still agree on every change.
- The importers moved ahead of the API in the port plan, since the API uses them; the app uses them since the server moved to Go.

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
