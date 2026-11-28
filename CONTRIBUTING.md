# Contributing

Thanks for helping! Requirements: Node 22+, npm 10+, and Go 1.26+. The app is Go (the server, storage, grade
engine, importers, the note editor's core and the desktop shell); Node.js builds the interface (React +
TypeScript). See [docs/go-port](docs/go-port/README.md).

1. `npm install` (also installs the pre-commit guard via `npx simple-git-hooks`).
2. Make changes with tests. `npm run lint && npm run typecheck && npm test` and `go vet ./cmd/... ./internal/... && go test ./cmd/... ./internal/...`
   must pass (format Go code with `gofmt`).
3. Grade math must use exact decimals (`Dec` in `internal/grades`) and return a step-by-step breakdown. Change
   the Go code only: `packages/grades`, `jsonstore`, `importers` and `server` are the frozen TypeScript originals
   (see their `FROZEN.md`). Their answers are recorded in the Go tests' `testdata`; a deliberate change in an
   answer updates the recording in the same commit (for the API: `node scripts/api-parity.mjs --go <binary>
--update`).
4. Never commit real student data, third-party template content, or branding. Use
   `fixtures/synthetic/` only. See `docs/CONTRIBUTING-DEV.md`.
5. Open a PR using the template. Be kind: see the Code of Conduct.

Good first issues: new letter-scale presets, CSV templates, additional Markdown note templates.
