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

const here = path.dirname(fileURLToPath(import.meta.url));
const main = path.join(here, '../apps/desktop/dist/main.cjs');
const dataDir = mkdtempSync(path.join(tmpdir(), 'classpad-e2e-notes-'));
let app: ElectronApplication;
let page: Page;

test.afterAll(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('class page tabs are real, and notes get code blocks and toggles', async () => {
  app = await electron.launch({
    args: [main],
    env: { ...process.env, CLASSPAD_DATA_DIR: dataDir, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  page = await app.firstWindow();
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

  // editor: a code block in Python and a toggle heading
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.type('print("hi")');
  await page.keyboard.press('ControlOrMeta+a');
  await page.getByLabel('Code block language').selectOption('python');
  await page.getByRole('button', { name: /^Code block/ }).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.getByLabel('Insert a toggle').selectOption('2');
  await page.keyboard.type('My dropdown');
  await expect(editor).toContainText('```python');
  await expect(editor).toContainText('<h2>');

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.md pre code')).toContainText('print("hi")');
  const summary = page.locator('.md details > summary');
  await expect(summary).toHaveText('My dropdown');
  await expect(summary).toHaveClass(/toggle-h2/);
  await expect(page.locator('.md details')).not.toHaveAttribute('open', '');
  await summary.click();
  await expect(page.locator('.md details')).toHaveAttribute('open', '');

  // back on the class: the note is listed under its class
  await page.locator('aside.sidebar').getByRole('link', { name: 'Classes', exact: true }).click();
  await page.getByText('Intro to Lorem Studies').first().click();
  await page.getByRole('tab', { name: 'Notes' }).click();
  await expect(page.getByRole('link', { name: /E2E Toolbar Note/ })).toBeVisible();
});
