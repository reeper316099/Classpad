# Plugins, gradebook import and folder export

Classpad has three optional helpers for moving data in and out. None of them use the network.

## Importing a gradebook CSV

Import & export → **Gradebook CSV (LMS export)**. Pick a format, choose the file, review the preview, import.
If the file has no class column, type the class name; assignments are attached to it (created if missing).

Built-in formats:

| Format                               | Shape                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Gradebook: one row per assignment    | Columns like Assignment, Score, Points Possible, Due, Category, Weight.                              |
| Gradebook: one column per assignment | One column per assignment and a row of scores. Points possible may be in the header: `Essay 1 (50)`. |

Scores may be `18` (points, when points possible is known), `45/50`, or `92%`. Excused, missing or non-numeric
scores are left ungraded and listed as warnings. Columns a format does not use are listed too, never silently dropped.

## Writing a plugin

A plugin is a JSON file in the `plugins/` folder inside your data folder (Settings → Show in folder). It says
which of _your file's_ columns feed which Classpad field. **Plugins contain no code**; Classpad validates them and only
ever reads them as data, so a plugin cannot do anything a plain data file cannot.

See [examples/plugins/marks-sheet.json](examples/plugins/marks-sheet.json). Reference:

| Field                      | Meaning                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pluginVersion`            | Always `1`.                                                                                                                                                          |
| `id`                       | Lowercase letters, digits and dashes (2–39 characters). Must be unique, including built-ins.                                                                         |
| `name`, `description`      | Shown in the format list.                                                                                                                                            |
| `kind`                     | `gradebook-csv` (the only kind in this version).                                                                                                                     |
| `layout`                   | `long` (a row per assignment) or `wide` (a column per assignment).                                                                                                   |
| `columns.*`                | Long layout. A header name, or a list tried in order, case-insensitive, for `title`, `class`, `due`, `score`, `pointsPossible`, `weight`, `status`, `type`, `notes`. |
| `wide.studentColumn/Value` | Wide layout. Pick your row when the file has several students.                                                                                                       |
| `wide.skipColumns`         | Wide layout. Headers that are not assignments (ids, totals…).                                                                                                        |
| `wide.pointsRow`           | Wide layout. `{ "column": "Student", "equals": "Points Possible" }` marks a row of points.                                                                           |
| `wide.pointsInHeader`      | Wide layout. Read `(50)` / `[20 pts]` from headers. Default `true`.                                                                                                  |
| `scoreFormat`              | `auto` (default), `percent` or `points` for bare numbers.                                                                                                            |
| `className`                | Class to use when the file has none.                                                                                                                                 |
| `skipRows`                 | Rows to ignore: `{ "column": "...", "equals": "..." }` or `"contains"`. No regular expressions, on purpose.                                                          |

Problems never break the app: an invalid plugin is listed with the reason on the import page, and the rest keep working.
Files over 64 KB and more than 50 plugin files are ignored.

## Exporting to a folder (for your other apps)

Import & export → **Export to a folder**. Classpad writes a `Classpad Export` folder containing:

- `classpad-backup.json`: everything; re-importable.
- `gradebook.csv`: one row per assignment with the class's current percent and letter.
- `csv/`: one CSV per collection. `calendar/`: deadlines and timetable as `.ics`. `notes/`: your notes as Markdown.

It is **one-way and replaces itself**: Classpad never reads the folder back, and each export removes only files an earlier
export wrote. It refuses to use a folder inside Classpad's own data folder, and refuses an existing `Classpad Export`
folder it did not create. Exported files are **not encrypted**; if you use encryption at rest, Classpad asks you to confirm first.

Open the folder in a spreadsheet, subscribe a calendar app to the `.ics` files, point a Markdown notes app at `notes/`,
or let a file-sync tool you already trust copy it elsewhere. Classpad itself never syncs.
