import { defineConfig } from '@playwright/test';

// The app opens its windows invisibly and without taking focus during tests (see apps/desktop
// main.ts). Set CLASSPAD_E2E_BACKGROUND=0 to watch the tests run.
process.env.CLASSPAD_E2E_BACKGROUND ??= '1';

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
