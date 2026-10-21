# Changelog

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
