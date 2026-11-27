// Regenerates docs/screenshots from the built-in DEMO data in a throwaway data folder: the Go server
// serves the built interface and a headless browser takes the pictures.
// Usage: npm run build -w @classpad/web && node scripts/screenshots.mjs
import { chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs/screenshots');
mkdirSync(out, { recursive: true });
const dataDir = mkdtempSync(path.join(tmpdir(), 'classpad-shots-'));
const bin = path.join(dataDir, `server${process.platform === 'win32' ? '.exe' : ''}`);
if (
  spawnSync('go', ['build', '-o', bin, './cmd/classpad-server'], { cwd: root, stdio: 'inherit' })
    .status
)
  process.exit(1);
const token = randomBytes(32).toString('hex');
const server = spawn(
  bin,
  [
    '--data-dir',
    path.join(dataDir, 'data'),
    '--static',
    path.join(root, 'apps/web/dist'),
    '--exit-with-stdin',
  ],
  { env: { ...process.env, CLASSPAD_TOKEN: token }, stdio: ['pipe', 'pipe', 'inherit'] },
);
const { url } = JSON.parse(
  await new Promise((resolve) => createInterface({ input: server.stdout }).once('line', resolve)),
);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // the desktop app's bridge gives the page its token
  await context.addInitScript((t) => {
    window.classpad = { api: { baseUrl: '', token: t }, onMenu: () => () => {} };
  }, token);
  const page = await context.newPage();
  await page.goto(`${url}/`);
  await page.getByRole('heading', { name: 'Open demo data' }).click();
  await page.getByRole('heading', { name: 'Demo Term' }).waitFor();
  const shots = [
    ['dashboard', '/'],
    ['grades', '/grades'],
    ['notes', '/notes'],
    ['planner', '/planner'],
    ['gpa', '/gpa'],
  ];
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [name, route] of shots) {
      await page.evaluate((h) => (location.hash = h), route);
      await page.waitForTimeout(900);
      await page.screenshot({ path: path.join(out, `${name}-${scheme}.png`) });
    }
  }
} finally {
  await browser.close();
  const exited = new Promise((r) => server.once('exit', r));
  server.stdin.end();
  await exited;
  rmSync(dataDir, { recursive: true, force: true });
}
console.log('Screenshots written to docs/screenshots');
