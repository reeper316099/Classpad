# Developer notes

- Monorepo via npm workspaces; TypeScript project references (`npm run typecheck`).
- `private-fixtures/` is gitignored; tests needing it are optional and skipped in CI.
- `scripts/guard-private.mjs` runs on pre-commit and in CI.
- Unsigned builds for now; code signing can be added to electron-builder later (M7).
