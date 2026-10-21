import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Remove a temp folder; Windows keeps Electron's cache files locked for a moment, and that must not fail a test. */
function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* best effort */
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const main = path.join(here, '../apps/desktop/dist/main.cjs');
const dataDir = mkdtempSync(path.join(tmpdir(), 'classpad-e2e-notes-'));
let app: ElectronApplication;
let page: Page;

test.afterAll(async () => {
  await app?.close();
  cleanup(dataDir);
});

test('class page tabs are real, and notes get code blocks and toggles', async () => {
  app = await electron.launch({
    args: [main],
    env: { ...process.env, CLASSPAD_DATA_DIR: dataDir, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('heading', { name: 'Open demo data' }).click();
  await expect(page.getByRole('heading', { name: 'Demo Term' })).toBeVisible();

  await page.locator('aside.sidebar').getByRole('link', { name: 'Classes', exact: true }).click();
  await page.getByText('Intro to Lorem Studies').first().click();

  // none of the tabs say "later milestone" any more
  for (const tab of ['Notes', 'Readings', 'Files']) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByText(/later milestone|coming next|optional modules/i)).toHaveCount(0);
  }

  // Notes tab: create a note for this class from here
  await page.getByRole('tab', { name: 'Notes' }).click();
  await page.getByRole('button', { name: 'New note' }).first().click();
  const dlg = page.locator('dialog[open]');
  await dlg.getByLabel('Title').fill('E2E Toolbar Note');
  await dlg.getByRole('button', { name: 'Create note' }).click();

  // the editor is one view: pick blocks from the "/" menu and see them as you type
  const editor = page.locator('.cm-content');
  const menu = page.locator('.cm-tooltip.lp-slash li[aria-selected]');
  await editor.click();
  await page.keyboard.type('/code');
  await expect(menu).toContainText('Code');
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.keyboard.type('print("hi")');
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/toggle h');
  await expect(page.locator('.cm-tooltip.lp-slash li')).toHaveCount(3);
  await page.waitForTimeout(250);
  await page.keyboard.press('ArrowDown'); // Toggle heading 2
  await page.keyboard.press('Enter');
  await page.keyboard.type('My dropdown');
  await page.keyboard.press('ControlOrMeta+Home');

  await expect(page.locator('.cm-lp-code-line').first()).toBeVisible();
  const summary = page.locator('.cm-lp-toggle.cm-lp-h2');
  await expect(summary).toContainText('My dropdown');
  await expect(page.locator('.cm-lp-chevron')).toHaveAttribute('aria-expanded', 'true'); // new toggles start open
  await page.locator('.cm-lp-chevron').click();
  await expect(page.locator('.cm-lp-chevron')).toHaveAttribute('aria-expanded', 'false');

  // back on the class: the note is listed under its class
  await page.locator('aside.sidebar').getByRole('link', { name: 'Classes', exact: true }).click();
  await page.getByText('Intro to Lorem Studies').first().click();
  await page.getByRole('tab', { name: 'Notes' }).click();
  await expect(page.getByRole('link', { name: /E2E Toolbar Note/ })).toBeVisible();
});
