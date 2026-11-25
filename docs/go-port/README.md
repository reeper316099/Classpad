# Porting Classpad to Go

Classpad is moving from Electron + Node.js to Go. The goal is one Go program with no Electron and no Node.js at
run time. The interface stays HTML/TypeScript, shown in the operating system's own web view through
[Wails](https://wails.io) (WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux).

| Piece                   | Today                                  | After the port                                |
| ----------------------- | -------------------------------------- | --------------------------------------------- |
| Desktop shell           | Electron (bundles Chromium + Node.js)  | Wails (Go + the system web view)              |
| Local API and storage   | Fastify on Node.js                     | Go (`net/http`) in the same process           |
| Grade engine, importers | TypeScript packages                    | Go packages under `internal/`                 |
| Note editor core        | **Go, compiled to WebAssembly** (done) | the same                                      |
| Interface               | React + TypeScript                     | the same (Node.js is needed only to build it) |

## Order

1. **Note editor core** (done). AppFlowy's document model and editing commands, in Go, running in the page as
   WebAssembly. See [EDITOR.md](../EDITOR.md).
2. **Grade engine** (`packages/grades` → `internal/grades`). Pure logic with the largest test suite, so the Go
   version can be checked against the TypeScript one case by case (exact decimals, same step breakdowns).
3. **Storage** (`packages/jsonstore`): atomic writes, encryption at rest, backups, the file watcher. The on-disk
   format does not change, so existing data folders keep working.
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

## Building

- Go 1.24 or newer (the toolchain in CI comes from `go.mod`).
- `go test ./cmd/... ./internal/...` runs the Go tests; `node scripts/build-editor-wasm.mjs` builds the editor core for the app.
- Node.js stays a build-time tool for the interface (Vite, TypeScript) after the port. It is no longer part of
  what users download.
