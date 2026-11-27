import { defineConfig } from '@playwright/test';

// On your own machine the app opens its windows invisibly and without taking focus during tests
// (see apps/desktop main.ts); set CLASSPAD_E2E_BACKGROUND=0 to watch. CI has no one to disturb, and
// an inactive window there runs CSS transitions slowly enough to upset the contrast checks.
process.env.CLASSPAD_E2E_BACKGROUND ??= process.env.CI ? '0' : '1';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1, // one Electron app at a time
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
