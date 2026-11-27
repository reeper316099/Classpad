import { defineConfig } from '@playwright/test';

// Each test file starts the Go API server on its own temporary data folder and opens the app in a
// headless browser (see harness.ts), so a run never opens a window. Two engines, like the desktop
// app's web views: WebKit (macOS, Linux) and Chromium (Windows' WebView2).
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  globalSetup: './global-setup.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1, // one app at a time
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium' }, { name: 'webkit' }],
});
