import {
  chromium,
  test,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const webDir = path.join(root, 'apps/web/dist');
/** Built once per run by global-setup.ts. */
export const serverBinary = path.join(
  tmpdir(),
  `classpad-e2e-server${process.platform === 'win32' ? '.exe' : ''}`,
);

/**
 * The app as the end-to-end tests see it: the Go API server (the same one the desktop app runs in
 * process) serving the built interface, opened in a browser engine like the desktop app's web view:
 * WebKit for macOS and Linux, Chromium for Windows (WebView2). A small stand-in for the desktop
 * bridge gives the page its token. Browsers run headless, so a test run never opens a window.
 */
export interface App {
  url: string;
  close(): Promise<void>;
}

/** Remove a temp folder; on Windows files can stay locked for a moment, and that must not fail a test. */
export function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* best effort */
  }
}

function engine() {
  return test.info().project.name === 'webkit' ? webkit : chromium;
}

async function startServer(
  dataDir: string,
  token: string,
): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn(
    serverBinary,
    ['--data-dir', dataDir, '--static', webDir, '--exit-with-stdin'],
    { env: { ...process.env, CLASSPAD_TOKEN: token }, stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const line = await new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (c) => reject(new Error(`classpad-server exited (${c})`)));
    createInterface({ input: child.stdout! }).once('line', resolve);
  });
  child.removeAllListeners('exit');
  return { url: (JSON.parse(line) as { url: string }).url, child };
}

/** What the desktop bridge gives the page, minus the native parts (no menu, no dialogs). */
function bridge({ token, dataDir }: { token: string; dataDir: string }) {
  const headers = { authorization: `Bearer ${token}` };
  (window as unknown as { classpad: unknown }).classpad = {
    api: { baseUrl: '', token },
    platform: 'e2e',
    version: 'e2e',
    dataDir,
    onMenu: () => () => {},
    openDataFolder: async () => {},
    chooseFolder: async () => null,
    paste: async () => {},
    // the desktop app shows the report in its own window; here it opens as a pop-up
    async openReport(hide = false) {
      const res = await fetch(`/api/v1/export/report${hide ? '?hide=1' : ''}`, { headers });
      window.open(URL.createObjectURL(await res.blob()), '_blank');
    },
    saveReportPdf: async () => ({ saved: false }),
  };
}

/** Start the server on dataDir and open the app. */
export async function launch(dataDir: string): Promise<{ app: App; page: Page }> {
  const token = randomBytes(32).toString('hex');
  const server = await startServer(dataDir, token);
  const browser: Browser = await engine().launch();
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1280, height: 860 },
  });
  await context.addInitScript(bridge, { token, dataDir });
  const page = await context.newPage();
  await page.goto(`${server.url}/`);
  await page.waitForLoadState('domcontentloaded');
  const app: App = {
    url: server.url,
    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      const exited = new Promise((r) => server.child.once('exit', r));
      server.child.stdin!.end(); // a clean stop releases the data folder lock
      await exited;
    },
  };
  return { app, page };
}
