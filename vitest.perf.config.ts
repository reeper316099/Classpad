import { defineConfig } from 'vitest/config';
// Wall-clock performance budgets. Run alone so results are not distorted by other test files.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.perf.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
