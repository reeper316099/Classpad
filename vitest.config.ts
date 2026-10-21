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
    environment: 'node',
    environmentMatchGlobs: [['apps/web/src/**/*.test.tsx', 'jsdom']],
  },
});
