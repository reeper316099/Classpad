# Contributing

Thanks for helping! Requirements: Node 22+, npm 10+, and Go 1.26+ (the note editor's core, the grade engine, the
storage layer and the importers are Go; see [docs/go-port](docs/go-port/README.md)).

1. `npm install` (also installs the pre-commit guard via `npx simple-git-hooks`).
2. Make changes with tests. `npm run lint && npm run typecheck && npm test` and `go vet ./cmd/... ./internal/... && go test ./cmd/... ./internal/...`
   must pass (format Go code with `gofmt`).
3. Grade math must use exact decimals (`decimal.js`; `Dec` in Go) and return a step-by-step breakdown. While the port
   is under way the engine exists twice, in `packages/grades` and `internal/grades`: change both, then run
   `npx tsc -b packages/grades && node scripts/grades-parity.mjs && go test ./internal/grades` to check they agree.
   The same goes for the data folder store (`packages/jsonstore` and `internal/jsonstore`, checked by
   `scripts/jsonstore-compat.mjs`) and the importers (`packages/importers` and `internal/importers`, checked by
   `scripts/importers-parity.mjs`).
4. Never commit real student data, third-party template content, or branding. Use
   `fixtures/synthetic/` only. See `docs/CONTRIBUTING-DEV.md`.
5. Open a PR using the template. Be kind: see the Code of Conduct.

Good first issues: new letter-scale presets, CSV templates, additional Markdown note templates.
