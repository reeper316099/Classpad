// Regenerates docs/screenshots from the built-in DEMO data in a throwaway data folder.
// Usage: npm run bundle -w @classpad/desktop && node scripts/screenshots.mjs
import { _electron as electron } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs/screenshots');
mkdirSync(out, { recursive: true });
const dataDir = mkdtempSync(path.join(tmpdir(), 'classpad-shots-'));
const app = await electron.launch({
  args: [path.join(root, 'apps/desktop/dist/main.cjs')],
  env: { ...process.env, CLASSPAD_DATA_DIR: dataDir, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForLoadState('domcontentloaded');
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
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log('Screenshots written to docs/screenshots');
