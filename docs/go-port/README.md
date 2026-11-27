# Porting Classpad to Go

Classpad is moving from Electron + Node.js to Go. The goal is one Go program with no Electron and no Node.js at
run time. The interface stays HTML/TypeScript, shown in the operating system's own web view through
[Wails](https://wails.io) (WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux).

| Piece                 | Today                                  | After the port                                |
| --------------------- | -------------------------------------- | --------------------------------------------- |
| Desktop shell         | Electron (bundles Chromium + Node.js)  | Wails (Go + the system web view)              |
| Local API             | Fastify on Node.js                     | Go (`net/http`) in the same process           |
| Storage (data folder) | **Go** (done; used once the API is Go) | Go, `internal/jsonstore`                      |
| Grade engine          | **Go** (done; used once the API is Go) | Go, `internal/grades`                         |
| Importers             | TypeScript packages                    | Go packages under `internal/`                 |
| Note editor core      | **Go, compiled to WebAssembly** (done) | the same                                      |
| Interface             | React + TypeScript                     | the same (Node.js is needed only to build it) |

## Order

1. **Note editor core** (done). AppFlowy's document model and editing commands, in Go, running in the page as
   WebAssembly. See [EDITOR.md](../EDITOR.md).
2. **Grade engine** (done). `packages/grades` → `internal/grades`, with its own exact decimal type that rounds
   like decimal.js. It gives the same JSON as the TypeScript engine, field for field: numbers, step breakdowns
   and warnings. `scripts/grades-parity.mjs` runs the TypeScript engine on generated cases and saves the answers;
   the Go test runs the same inputs and compares. 45,000 cases over three seeds matched, and CI checks a fresh set
   on every change. The app keeps calling the TypeScript engine until step 4, when the API (its only caller) is Go.
3. **Storage** (done). `packages/jsonstore` → `internal/jsonstore`: atomic writes, per-file locking, corruption
   recovery from backups, migrations, encryption at rest (scrypt + AES-256-GCM), zipped backups and the watcher
   for hand edits. The on-disk format does not change: the Go store writes the same bytes as the TypeScript one
   (sorted JSON, including JavaScript's number format and key order) and the same encrypted envelopes, and each
   store reads the other's files and backups. `scripts/jsonstore-compat.mjs` records what the TypeScript store
   writes; the Go tests compare (60,000 random JSON values matched), and CI checks both directions on every
   change. Like the grade engine, it takes over at step 4.
4. **API** (`packages/server`): the same routes and JSON, so the interface does not change.
5. **Importers** (`packages/importers`) and the plugin mapper.
6. **Shell**: swap Electron for Wails, then remove Node.js from the shipped app.

Each step ships on its own. Until step 6 the app keeps running on Electron with the parts that are already Go.

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

|                        | Electron (v1.3.1, today) | Wails + Go         |
| ---------------------- | ------------------------ | ------------------ |
| macOS installer (.dmg) | 231.7 MB (universal)     | measured at step 6 |

Electron ships a full copy of Chromium and Node.js in every app. Wails uses the web view the operating system
already has, which is where most of the difference will come from.

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

## Building

- Go 1.26 or newer (the toolchain in CI comes from `go.mod`).
- `go test ./cmd/... ./internal/...` runs the Go tests; `node scripts/build-editor-wasm.mjs` builds the editor core for the app.
- After changing the grade engine: `npx tsc -b packages/grades && node scripts/grades-parity.mjs` regenerates the
  TypeScript answers, then `go test ./internal/grades` checks the Go engine against them.
- After changing the store: `npx tsc -b packages/jsonstore && node scripts/jsonstore-compat.mjs`, then
  `go test ./internal/jsonstore`.
- Go modules used: `golang.org/x/crypto` (scrypt), `golang.org/x/text` (Unicode normalization of passphrases),
  `golang.org/x/sys` and `github.com/fsnotify/fsnotify` (the file watcher). Everything else is the standard library.
- Node.js stays a build-time tool for the interface (Vite, TypeScript) after the port. It is no longer part of
  what users download.
