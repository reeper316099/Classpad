# Data format

Your data is plain files in one folder. You can read, back up, version or hand-edit them. Classpad
watches the folder, validates what you changed, and refuses to load a broken edit rather than
overwrite it.

## Where

| OS      | Default location                         |
| ------- | ---------------------------------------- |
| macOS   | `~/Library/Application Support/Classpad` |
| Windows | `%APPDATA%\Classpad`                     |
| Linux   | `~/.config/Classpad`                     |

Override with the `CLASSPAD_DATA_DIR` environment variable. Settings shows the folder path and has a “Show in folder” button.

## Layout

```
config/                       grading schemes, GPA scales, app config, privacy.json (lock settings)
data/
  semesters.json
  classes/<semester>.json
  assignments/<semester>/<class>.json
  tasks/tasks.json
  readings/readings.json
  notes/<class>/<title>.md    one real Markdown file per note (YAML frontmatter)
  study/YYYY-MM.jsonl         study sessions, one JSON object per line
  journal/YYYY-MM.json        optional modules from here down
  contacts/contacts.json
  flashcards/cards.json
  modules/{activities,jobs,admissions,budget}/<name>.json
attachments/                  files you attach, stored as <sha256>.<ext>; data/attachments.json holds names and links
backups/                      rolling zip backups (also taken before big imports and deletes)
quarantine/                   files that failed validation, kept for you to inspect
```

## JSON files

Each collection file looks like:

```json
{ "schemaVersion": 1, "items": [{ "id": "01J…", "createdAt": "…", "updatedAt": "…", "…": "…" }] }
```

- IDs are ULIDs. Cross-references use IDs, not names, so renaming a class never breaks a link.
- Files are written atomically (temp file, fsync, rename) and pretty-printed with stable key order,
  so they diff cleanly in git.
- `schemaVersion` drives migrations; an older file is migrated in place after a backup.

## Notes

```markdown
---
id: 01J…
title: Entropy basics
classId: 01J…
tags: [lecture]
date: 2031-03-05
---

Body in Markdown. [[Wiki links]] and $math$ are supported.
```

Notes are ordinary `.md` files. Edit them in any editor; Classpad picks the change up.

## Encryption at rest

If you turn on the lock and choose collections to encrypt, those files are stored as one JSON line:

```json
{ "classpad": "enc1", "iv": "…", "tag": "…", "data": "…" }
```

AES-256-GCM, key derived from your passphrase with scrypt (N=32768); the file path is bound in as
authenticated data, so an encrypted file cannot be swapped into another place. Details and limits
are in [SECURITY.md](../SECURITY.md). **A lost passphrase cannot be recovered.**

## Import and export

Export gives you JSON (everything), CSV (per collection), ICS (calendar), a Markdown folder (notes),
or a printable report. A JSON backup re-imports into a fresh install. Importing is previewed first, has
conflict strategies (skip, fill empty, overwrite, keep both) and can be undone.
