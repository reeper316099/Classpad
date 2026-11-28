import { defineConfig } from 'vitest/config';

// The TypeScript grades, storage, importers and server packages are frozen: they are the reference
// the Go code was ported from and checked against, and the Go code is now the source of truth
// (docs/go-port/README.md). Their tests no longer run.
const FROZEN = ['grades', 'jsonstore', 'importers', 'server'];

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'scripts/**/*.test.mjs',
      'apps/web/src/**/*.test.{ts,tsx}',
    ],
    exclude: ['**/node_modules/**', ...FROZEN.map((p) => `packages/${p}/**`)],
    // Windows runners are slow at file-heavy tests; the default 5 s is too tight there
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environment: 'node',
    environmentMatchGlobs: [['apps/web/src/**/*.test.tsx', 'jsdom']],
  },
});
