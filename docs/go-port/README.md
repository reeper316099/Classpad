# Porting Classpad to Go

Classpad moved from Electron + Node.js to Go: it is now one Go program, with no Electron and no Node.js at run
time. The interface stays HTML/TypeScript, shown in the operating system's own web view through
[Wails](https://wails.io) (WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux).

| Piece                 | Before                                | Now                                           |
| --------------------- | ------------------------------------- | --------------------------------------------- |
| Desktop shell         | Electron (bundles Chromium + Node.js) | **Wails** (Go + the system web view)          |
| Local API             | Fastify on Node.js                    | **Go** (`net/http`) in the same process       |
| Storage (data folder) | TypeScript                            | **Go**, `internal/jsonstore`                  |
| Grade engine          | TypeScript                            | **Go**, `internal/grades`                     |
| Importers             | TypeScript                            | **Go**, `internal/importers`                  |
| Note editor core      | TypeScript                            | **Go, compiled to WebAssembly**               |
| Interface             | React + TypeScript                    | the same (Node.js is needed only to build it) |

## Order

1. **Note editor core** (done). AppFlowy's document model and editing commands, in Go, running in the page as
   WebAssembly. See [EDITOR.md](../EDITOR.md).
2. **Grade engine** (done). `packages/grades` → `internal/grades`, with its own exact decimal type that rounds
   like decimal.js. It gives the same JSON as the TypeScript engine, field for field: numbers, step breakdowns
   and warnings. `scripts/grades-parity.mjs` runs the TypeScript engine on generated cases and saves the answers;
   the Go test runs the same inputs and compares. 45,000 cases over three seeds matched, and CI checks a fresh set
   on every change. The app keeps calling the TypeScript engine until step 5, when the API (its only caller) is Go.
3. **Storage** (done). `packages/jsonstore` → `internal/jsonstore`: atomic writes, per-file locking, corruption
   recovery from backups, migrations, encryption at rest (scrypt + AES-256-GCM), zipped backups and the watcher
   for hand edits. The on-disk format does not change: the Go store writes the same bytes as the TypeScript one
   (sorted JSON, including JavaScript's number format and key order) and the same encrypted envelopes, and each
   store reads the other's files and backups. `scripts/jsonstore-compat.mjs` records what the TypeScript store
   writes; the Go tests compare (60,000 random JSON values matched), and CI checks both directions on every
   change. Like the grade engine, it takes over when the API is Go (step 5).
4. **Importers** (done). `packages/importers` → `internal/importers`: Notion exports, CSV files, gradebook
   mappings, calendars (.ics, both ways), Markdown folders and Classpad backups. They give the same preview,
   field for field, including the quirks of the JavaScript libraries the TypeScript code relies on: papaparse's
   delimiter and line-ending guesses, ical.js's strict date rules, the YAML 1.2 core schema, and JavaScript's
   own `Number()`, whitespace, sorting and URI rules. `scripts/importers-parity.mjs` runs the TypeScript
   importers on generated synthetic inputs (cell formats, CSV quoting, whole Notion exports, zipped and nested)
   and the Go test compares: about 110,000 cases over four seeds matched, and a real Notion export, checked
   locally and never committed, gave an identical preview. This step moved ahead of the API because the API
   uses the importers.
5. **API** (done). `packages/server` → `internal/server` and
   `cmd/classpad-server`: every route, with the same JSON, status codes, error shapes and headers, so the
   interface does not change. It runs on the Go storage, grade engine and importers from steps 2 to 4.
   `scripts/api-parity.mjs` starts both servers on empty data folders, sends each the same 215 requests (demo
   data, every collection, grades and GPA, search, notes and flashcards, the study timer, attachments, every
   export, imports with undo, folder sync, the lock with encryption at rest, and bad input of every kind) and
   compares the answers after replacing ids and timestamps: all 215 match, and CI runs it on Linux and macOS.
   Matching JavaScript took a few deliberate details: Go must not fuse a multiply and an add into one step
   where JavaScript rounds twice (search scores differed in the last digit on Apple Silicon), and absent
   fields must stay absent rather than become `null`. Not ported: the development-only `/openapi.json`.
   For a while the Electron app started the Go server as a child process; its main bundle shrank from 1.92 MB
   to 0.61 MB without Fastify and the rest of the TypeScript server. `npm run dev` uses the Go server too.
6. **Shell** (done): Electron → Wails 3. `cmd/classpad` is the desktop app. The API runs in the same process
   and the web view calls its handler directly, so it no longer listens on a network port at all. A bridge
   script (`cmd/classpad/bridge.js`) gives the page the same `window.classpad` the Electron preload did: native
   menu, folder picker, paste, the report window (printing replaces "save as PDF": the system print dialog
   saves PDFs), exports through a native Save dialog, live updates as app events, and external links opened in
   the browser. `scripts/package-desktop.mjs` builds the installers (`packaging/`). Tests: the end-to-end suite
   now runs the interface against the Go server in WebKit and Chromium, the engines of the desktop app's web
   views (70 runs, all passing), and `CLASSPAD_SELFTEST=1` starts the real app hidden and checks it (bridge,
   in-process API and token, live updates, interface, editor core, report) on all three systems in CI.
   `apps/desktop` (Electron) is gone. The TypeScript packages stay as the reference the Go code is checked
   against.

Each step shipped on its own.

## Measurements

Every number here was measured on the same machine (Apple M-series laptop, macOS, Node.js 22.15, Go 1.27). This
page gets new rows as each part is ported, measured the same way. Nothing here is an estimate.

### Runtime: Node.js vs Go

A minimal local HTTP server, the shape of Classpad's API, built each way.

|                                 | Node.js 22                | Go                          | Difference        |
| ------------------------------- | ------------------------- | --------------------------- | ----------------- |
| What has to ship                | the `node` binary: 222 MB | one compiled binary: 5.3 MB | about 40× smaller |
| Start-up (median of 20 runs)    | 67 ms (`node -e ""`)      | 10.5 ms                     | about 6× faster   |
| Memory with an idle HTTP server | 42.5 MB peak RSS          | 9.9 MB RSS                  | about 4× less     |

Method: `go build -ldflags="-s -w"` of a program that serves one route on 127.0.0.1; start-up is wall-clock time
from process launch to exit; memory from `/usr/bin/time -l` (Node.js) and `ps -o rss` (Go). The Node.js binary
size is the one installed on the test machine; official builds differ by platform.

### The app download

|                        | Electron (v1.3.1) | Electron + the Go server (step 5) | Wails + Go (step 6) |
| ---------------------- | ----------------- | --------------------------------- | ------------------- |
| macOS installer (.dmg) | 231.7 MB          | 240.8 MB                          | 23.7 MB             |

All universal (arm64 + x64), so about 9.8× smaller than Electron. Electron ships a full copy of Chromium and
Node.js in every app; Wails uses the web view the operating system already has. Unpacked, the universal app is
one 52.4 MB binary (25.6 MB for arm64, 26.8 MB for x64), each half carrying the embedded interface (13 MB, of
which 5.9 MB is the editor core's WebAssembly). Release builds leave the interface's source maps out (12 MB).

### Note editor core (Go → WebAssembly)

Measured in Node.js 22 running the same `editor.wasm` the app loads, on a note of 1,200 blocks (300 sections with
headings, formatted paragraphs, inline equations, links and lists):

|                                  | Result                                    |
| -------------------------------- | ----------------------------------------- |
| `editor.wasm` size               | 5.6 MB (1.6 MB gzipped), loaded from disk |
| Load and start the core          | 28–39 ms, once per app start              |
| Open the 1,200-block note        | 50 ms                                     |
| One keystroke (edit + view diff) | 0.93 ms; under 1 KB sent to the page      |
| Write the note back to Markdown  | 42–46 ms (runs after you pause typing)    |

The first version sent the whole block tree after every keystroke: 6.5 ms and 177 KB per key on this note.
Sending only the blocks that changed brought it to 0.93 ms.

The old editor was CodeMirror (TypeScript), which works on the Markdown text directly and has no block model.
The two do different work, so there is no like-for-like speed comparison. The Go core's job is to be fast enough
that typing never waits on it, and at under 1 ms per key on a very long note, it is.

### Grade engine (Go vs TypeScript on Node.js)

The same work in both engines, on the same inputs from `internal/grades/testdata/parity.json.gz`. The class is
synthetic: 60 assignments in four weighted categories with drop-lowest and a late policy, 15 not graded yet.

| Work                                                         | TypeScript (Node.js 22) | Go           | Difference        |
| ------------------------------------------------------------ | ----------------------- | ------------ | ----------------- |
| Open the class's grade page (grade, sensitivity, projection) | 3.23–3.26 ms            | 2.44–2.50 ms | about 1.3× faster |
| "What do I need for a 90?", overall and per remaining item   | 78–79 ms                | 49–52 ms     | about 1.6× faster |
| Every function on all 600 generated cases                    | 152–154 ms              | 76–78 ms     | about 2× faster   |

Method: two rounds, alternating the engines. Go is `go test -bench . -benchtime 3s -count 3 ./internal/grades`;
TypeScript is `node scripts/grades-bench.mjs` (median of seven one-second runs after a warm-up). The ranges are
the lowest and highest result across rounds.

The gain is smaller than for start-up and memory because almost all the time goes into exact decimal arithmetic
(40 significant digits, no floating point), which is big-number work in both languages, and Node.js's JIT is
good at long loops like these. Both engines do the same amount of it, step texts included. Either way a class
page is computed in a few milliseconds; the real savings from Go come at step 6, when Node.js and Chromium
leave the download.

### Storage (Go vs TypeScript on Node.js)

The same work in both stores on the same synthetic data: a data file of 2,000 assignment-like records (657 KB of
JSON, identical bytes from both) in a folder with 200 notes. Saves are atomic and flushed to disk (`fsync`; both
use `F_FULLFSYNC` on macOS).

| Work                                     | TypeScript (Node.js 22) | Go           | Difference         |
| ---------------------------------------- | ----------------------- | ------------ | ------------------ |
| Turn the data into stable JSON (no disk) | 3.56–3.63 ms            | 2.55–2.64 ms | about 1.4× faster  |
| Save the file                            | 7.74–7.90 ms            | 6.53–6.83 ms | about 1.2× faster  |
| Read and parse the file                  | 1.49–1.51 ms            | 1.70–1.80 ms | about 1.15× slower |
| Save and read it encrypted               | 13.4–13.5 ms            | 13.9–14.8 ms | about the same     |
| Back up the folder (zip of 201 files)    | 33.5–33.5 ms            | 20.7–23.4 ms | about 1.5× faster  |

Method: as for the grade engine, two rounds alternating the stores: `go test -bench . -benchtime 2s -count 2
./internal/jsonstore` and `node scripts/jsonstore-bench.mjs` (median of seven rounds after a warm-up).

Reading is the one place Node.js stays ahead: `JSON.parse` is C++ inside V8 and very fast. The first Go version
used the general-purpose `encoding/json` and was 4× slower at reading and 2.4× slower at writing; a small JSON
parser and writer made for this format brought both to the numbers above. Every one of these is a few
milliseconds for a large file, so neither store makes the app wait.

### Importers (Go vs TypeScript on Node.js)

The same work in both, on the synthetic inputs in `internal/importers/testdata/parity.json.gz` and the repo's
synthetic Notion export (read into memory first, so the timing is the import and not the disk).

| Work                                                      | TypeScript (Node.js 22) | Go           | Difference         |
| --------------------------------------------------------- | ----------------------- | ------------ | ------------------ |
| Preview the synthetic Notion export (57 files)            | 2.32 ms                 | 2.11–2.16 ms | about 1.1× faster  |
| Preview 60 generated Notion exports (some zipped, nested) | 23.7–23.9 ms            | 18.5–19.8 ms | about 1.25× faster |
| Read 300 CSV files and preview 80 CSV imports             | 6.57–6.61 ms            | 4.12–4.18 ms | about 1.6× faster  |
| Read 80 calendars                                         | 1.36 ms                 | 0.41–0.42 ms | about 3.3× faster  |

Method: two rounds alternating the languages, `go test -bench . -benchtime 2s -count 2 ./internal/importers`
and `node scripts/importers-bench.mjs` (median of seven rounds after a warm-up).

Two Go-only fixes came out of testing: making references unique (`#2`, `#3`…) and finding nested toggles were
quadratic in the TypeScript algorithm (a calendar with 20,000 events sharing one UID took 58 seconds in the
first Go version); both are now linear, with the same output. A fuzz test checks no file can crash an importer.

### API server (Go vs TypeScript on Node.js)

Each server as its own process on a fresh data folder, then loaded with the demo data.

| Measure                                    | TypeScript (Node.js 22) | Go           | Difference           |
| ------------------------------------------ | ----------------------- | ------------ | -------------------- |
| Start-up until it answers (median of 10)   | 343–347 ms              | 34–37 ms     | about 10× faster     |
| Memory, idle                               | 94.9–96.1 MB RSS        | 14.1–14.3 MB | about 6.7× less      |
| Memory after the demo data and 1,800 calls | 142.8–143.1 MB RSS      | 21.9–22.2 MB | about 6.5× less      |
| `GET /health`                              | 0.18 ms                 | 0.10 ms      | about 1.7× faster    |
| `GET /assignments?limit=100&sort=due`      | 0.63 ms                 | 0.34–0.36 ms | about 1.8× faster    |
| `GET /search?q=lorem`                      | 0.21 ms                 | 0.11–0.12 ms | about 1.8× faster    |
| `GET /stats/overview`                      | 0.57–0.58 ms            | 0.54–0.55 ms | about the same       |
| `GET /gpa`                                 | 0.40 ms                 | 0.45 ms      | Go about 1.1× slower |
| `GET /export/report`                       | 0.38 ms                 | 0.44–0.45 ms | Go about 1.2× slower |

Method: `node scripts/api-bench.mjs --go <binary>` twice (Go built with `-ldflags="-s -w"`, 9.1 MB); request
times are the median of 300 calls after 20 warm-up calls, over loopback HTTP. The first Go version sorted lists
at 1.0 ms: it rebuilt collation keys on every comparison, and now builds one per item. GPA and the report are
still slower because the Go side turns engine results into JSON through an extra encode-and-parse step; both
stay under half a millisecond.

## Building

- Go 1.26 or newer (the toolchain in CI comes from `go.mod`).
- `go test ./cmd/... ./internal/...` runs the Go tests; `node scripts/build-editor-wasm.mjs` builds the editor core for the app.
- After changing the grade engine: `npx tsc -b packages/grades && node scripts/grades-parity.mjs` regenerates the
  TypeScript answers, then `go test ./internal/grades` checks the Go engine against them.
- After changing the store: `npx tsc -b packages/jsonstore && node scripts/jsonstore-compat.mjs`, then
  `go test ./internal/jsonstore`.
- After changing the API: `npx tsc -b packages/server`, `go build -o /tmp/classpad-server ./cmd/classpad-server`,
  then `node scripts/api-parity.mjs --go /tmp/classpad-server` (add `--keep` to look at both transcripts).
- After changing an importer: `npx tsc -b packages/importers && node scripts/importers-parity.mjs`, then
  `go test ./internal/importers`. `node scripts/gen-unicode-tables.mjs` regenerates the emoji table
  (`\p{Extended_Pictographic}`, which Go's regexp lacks) from Node's Unicode data.
- The desktop app: `node scripts/build-desktop.mjs` (builds the web interface, embeds it, and builds
  `cmd/classpad` into `build/`). On Linux it needs GTK 4 and WebKitGTK 6.0 (`libgtk-4-dev libwebkitgtk-6.0-dev`
  on Debian and Ubuntu); macOS and Windows need nothing extra.
- Go modules used: `golang.org/x/crypto` (scrypt), `golang.org/x/text` (Unicode normalization),
  `golang.org/x/sys` and `github.com/fsnotify/fsnotify` (the file watcher), `gopkg.in/yaml.v3` (note front
  matter), and `github.com/wailsapp/wails/v3` (the desktop shell). Everything else is the standard library.
- Node.js stays a build-time tool for the interface (Vite, TypeScript) after the port. It is no longer part of
  what users download.
