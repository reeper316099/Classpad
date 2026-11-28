import { expect, test, type Page } from '@playwright/test';
import { cleanup, launch, type App } from './harness';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'classpad-e2e-notes-'));
let app: App;
let page: Page;

test.afterAll(async () => {
  await app?.close();
  cleanup(dataDir);
});

test('class page tabs are real, and notes get code blocks and toggles', async () => {
  ({ app, page } = await launch(dataDir));
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
  const editor = page.locator('.be-page');
  const menu = page.locator('.be-slash [role=option][aria-selected=true]');
  await editor.locator('.af-block').first().waitFor();
  await editor.click();
  await page.keyboard.type('/code');
  await expect(menu).toContainText('Code');
  await page.keyboard.press('Enter');
  await page.keyboard.type('print("hi")');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // two empty lines at the end leave the code block
  await page.keyboard.type('/toggle h');
  await expect(page.locator('.be-slash [role=option]')).toHaveCount(3);
  await page.keyboard.press('ArrowDown'); // Toggle heading 2
  await page.keyboard.press('Enter');
  await page.keyboard.type('My dropdown');

  await expect(page.locator('.af-code-text')).toContainText('print("hi")');
  const summary = page.locator('.af-toggle-heading.af-h2');
  await expect(summary).toContainText('My dropdown');
  const chevron = summary.locator('.af-chevron');
  await expect(chevron).toHaveAttribute('aria-expanded', 'true'); // new toggles start open
  await chevron.click();
  await expect(page.locator('.af-toggle-heading .af-chevron')).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  // back on the class: the note is listed under its class
  await page.locator('aside.sidebar').getByRole('link', { name: 'Classes', exact: true }).click();
  await page.getByText('Intro to Lorem Studies').first().click();
  await page.getByRole('tab', { name: 'Notes' }).click();
  await expect(page.getByRole('link', { name: /E2E Toolbar Note/ })).toBeVisible();
});

test('a link to a note made a moment ago opens it, even before a live update arrives', async () => {
  // no live updates: the cached list of notes cannot know about the new note
  await page.route('**/api/v1/events*', (route) => route.abort());
  await page.reload();
  await page.locator('aside.sidebar').getByRole('link', { name: 'Notes', exact: true }).click();
  await expect(page.locator('.notes-tree')).toBeVisible();
  const id = await page.evaluate(async () => {
    const res = await fetch('/api/v1/notes', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${window.classpad!.api.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'Made elsewhere', markdown: 'Fresh text' }),
    });
    return ((await res.json()) as { id: string }).id;
  });
  await page.evaluate((nid) => (location.hash = `#/notes/${nid}`), id);
  await expect(page.locator('.be-page')).toContainText('Fresh text');
  await page.unroute('**/api/v1/events*');
});
