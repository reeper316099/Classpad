import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'scripts/**/*.test.mjs',
      'apps/web/src/**/*.test.{ts,tsx}',
    ],
    environment: 'node',
    environmentMatchGlobs: [['apps/web/src/**/*.test.tsx', 'jsdom']],
  },
});
