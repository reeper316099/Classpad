# Importing data

Classpad imports from a Notion-style export (zip), CSV files, `.ics` calendars, a Markdown folder
(Obsidian-style), and its own JSON backup. Nothing is written until you commit a **preview**.

## Flow

1. `POST /api/v1/import/preview` (zip as raw body with `?kind=notion|markdown`, or JSON with
   `text`/`dataBase64`). Returns counts, titles, the database mapping, warnings, skipped groups,
   and a **grade validation report**. No writes.
2. `POST /api/v1/import/commit` with `{ previewId, strategy }`. A `pre-import` backup is taken first.
3. `POST /api/v1/import/undo/:id` reverses it (created items removed, edited items restored).

Strategies: `skip`, `update_empty` (default: fill only empty fields, never overwrite your edits),
`overwrite`, `keep_both`. Re-importing is idempotent: every item carries an `importRef`
(`notion:<kind>:<page id>:<normalized title>`), so the same export never duplicates anything.

## What the Notion importer understands

- Detects databases by **column headers**, not names. When a database has both `X.csv` and
  `X_all.csv`, the `_all` file (every property) is used; embedded per-page views are ignored.
- Percent cells (`20%`), long-form dates (`August 28, 2026`), ranges (`A → B`), times and time-zone
  labels (labels are dropped; local wall time is kept).
- Class `Times` in both compact form (`11:50a-1:10p`, applied to every day in `Days`) and one line per
  day (`Mon 10:00 AM - 11:15 AM`). The raw text is kept.
- Priority options containing emoji, invisible direction marks or odd spaces are normalized to
  `important | mid | low`; the cleaned display label is kept as `priorityLabel`.
- Relation cells (`Title (path.md)` or URL-only references to pages outside the export).
  Assignments whose class cannot be resolved go to an **Unassigned** class instead of being lost.
- Which class a note belongs to: its own `Class` relation first; if that is empty or points outside
  the export, the class page's own list of notes; then the class of the assignment or reading it
  relates to. Assignments and readings use the same fallbacks. Anything still unresolved is listed as a
  warning (`NOTE_CLASS` / `RELATION`) instead of being left silently without a class.
- Dropdown (select) options: common wordings of Status are understood (`Done`, `Submitted`,
  `Doing`, `To-do`, `Late`, …), as are reading statuses (`Finished`, `Currently reading`, …). Class types
  and assignment types accept any value. An option that is not recognised is reported as a warning.
- Page bodies are converted to standard Markdown: callouts become blockquotes, **toggles (toggle lists and
  toggle headings 1–3) stay collapsible** as `<details>` blocks, nesting included, escaped checkboxes are unescaped, `$` + backtick equations become `$…$`, page links
  become `[[wiki-links]]`, files and images are copied into content-addressed `attachments/`.
  Links to embedded database views are dropped.
- Template pages (rows-less pages in a database folder, or titles like "New …", "… Template",
  "Default") become **templates** under `config/templates/`, not entries. Callouts that start with
  "Tip", "Tooltip" or "Hint" are treated as template-author hints and dropped.
- Computed columns (`% Grade`, `Weighted Grade`, `Days Left`, …) are **not imported**. Instead the
  report recomputes each class grade with the default scheme and compares it to the exported
  `% Grade` (tolerance 0.01); mismatches are listed.
- Journal, contacts, jobs and budget rows are imported into the optional modules (turn them on in
  Settings → Modules to see them). Instructor names are kept on the class.
- Notion's Markdown export writes toggles as `<details>` only in some exports; where a page's toggles were
  exported as plain nested bullets, they arrive as nested bullets, because the file no longer says they
  were toggles.

## Other formats

- **CSV**: one collection at a time; download a template from `GET /import/templates/:collection`.
  Class/semester columns match existing items by name or code.
- **ICS**: events become tasks (or assignments of a named class). Recurring events import once.
- **Markdown folder**: top-level folder = class, YAML frontmatter (`title`, `tags`, `date`) is read,
  `[[wiki-links]]` kept, `![[image]]` embeds imported.
- **JSON backup**: `GET /export/json` → restore with `kind: "json"` (same strategies).

## Exports

`GET /export/csv/:collection`, `/export/ics?kind=deadlines|timetable|all`, `/export/json`,
`/export/markdown` (zip vault with frontmatter + wiki-links + attachments),
`/export/report[?hide=1]` (printable HTML grade report with step-by-step breakdowns and GPA;
print to PDF from the app). CSV cells beginning with `=`, `+`, `-`, `@` are escaped against
spreadsheet formula injection.

## Privacy and fixtures

Synthetic fixtures (`npm run fixtures:generate`) contain only invented lorem-ipsum data. Your real
export lives in the gitignored `private-fixtures/`. `npm run fixtures:check-leak` (local only)
confirms nothing from it leaked into `fixtures/synthetic/`; `scripts/import-report.mjs <zip>`
prints counts and parity statuses without printing content.
