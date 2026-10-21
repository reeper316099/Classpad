import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'scripts/**/*.test.mjs',
      'apps/web/src/**/*.test.{ts,tsx}',
    ],
    // wall-clock budgets run alone (`npm run test:perf`) so they measure the app, not CPU contention
    exclude: ['**/node_modules/**', '**/*.perf.test.ts'],
    // Windows runners are slow at file-heavy tests; the default 5 s is too tight there
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environment: 'node',
    environmentMatchGlobs: [['apps/web/src/**/*.test.tsx', 'jsdom']],
  },
});
