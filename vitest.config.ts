import { configDefaults, defineConfig } from 'vitest/config';

// The TypeScript grades, storage, importers and server packages are frozen: they are the reference
// the Go code was ported from and checked against, and the Go code is now the source of truth
// (docs/go-port/README.md). Their tests no longer run.
const FROZEN = ['packages/grades', 'packages/jsonstore', 'packages/importers', 'packages/server'];

export default defineConfig({
  test: {
    // unit tests only: e2e/*.spec.ts are Playwright's
    include: ['**/*.test.{ts,tsx}'],
    exclude: [...configDefaults.exclude, 'e2e/**', ...FROZEN.map((p) => `${p}/**`)],
  },
});
