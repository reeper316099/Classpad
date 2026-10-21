import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const main = path.join(here, '../apps/desktop/dist/main.cjs');
const axeSource = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);
const dataDir = mkdtempSync(path.join(tmpdir(), 'classpad-e2e-mod-'));

let app: ElectronApplication;
let page: Page;
async function launch() {
  const noSandbox = process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : [];
  app = await electron.launch({
    args: [main, ...noSandbox],
    env: { ...process.env, CLASSPAD_DATA_DIR: dataDir, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
}
const call = (method: string, p: string, body?: unknown) =>
  page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(`/api/v1${u}`, {
        method: m as string,
        headers: {
          authorization: `Bearer ${window.classpad!.api.token}`,
          'content-type': 'application/json',
        },
        body: b ? JSON.stringify(b) : undefined,
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [method, p, body] as const,
  );

test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('modules: turn on, add data, journal is private by default', async () => {
  await launch();
  await page.getByRole('heading', { name: 'Open demo data' }).click();
  await expect(page.getByRole('heading', { name: 'Demo Term' })).toBeVisible();
  await page.locator('aside.sidebar').getByRole('link', { name: 'Settings', exact: true }).click();
  // only Reading is on by default
  await expect(
    page.locator('aside.sidebar').getByRole('link', { name: 'Jobs & internships' }),
  ).toHaveCount(0);
  for (const label of ['Journal', 'Flashcards', 'Budget'])
    await page
      .locator('section', { has: page.getByRole('heading', { name: 'Modules' }) })
      .getByRole('checkbox', { name: new RegExp(`^${label}`) })
      .check();
  await expect(
    page.locator('aside.sidebar').getByRole('link', { name: 'Journal', exact: true }),
  ).toBeVisible();

  await page.locator('aside.sidebar').getByRole('link', { name: 'Journal', exact: true }).click();
  await page.getByRole('button', { name: 'New entry' }).first().click();
  const dlg = page.locator('dialog[open]');
  await dlg.getByLabel('Title').fill('Lorem day');
  await dlg.getByLabel('Entry text').fill('ipsum dolor sit amet');
  await dlg.getByRole('button', { name: 'Save' }).click();
  const text = page.locator('.sens-j').first();
  await expect(text).toBeVisible();
  expect(await text.evaluate((e) => getComputedStyle(e).filter)).toContain('blur');
  await page.getByRole('button', { name: 'Reveal entries' }).click();
  expect(await text.evaluate((e) => getComputedStyle(e).filter)).toBe('none');

  await page.locator('aside.sidebar').getByRole('link', { name: 'Budget', exact: true }).click();
  await page
    .getByRole('button', { name: /^(New|Add)/ })
    .first()
    .click();
  await expect(page.locator('dialog[open]')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('flashcards: review a cloze card with the keyboard', async () => {
  await call('POST', '/flashcards', { front: 'Lorem ___', back: 'ipsum' });
  await page
    .locator('aside.sidebar')
    .getByRole('link', { name: 'Flashcards', exact: true })
    .click();
  await page
    .getByRole('button', { name: /^Review/ })
    .first()
    .click();
  await page.keyboard.press('Space');
  await expect(page.getByText('ipsum', { exact: true })).toBeVisible();
  await page.keyboard.press('3');
  await expect(page.getByText('All done for now')).toBeVisible();
});

test('app lock: locks the API and UI, refuses a wrong passphrase, unlock restores', async () => {
  const setup = await call('POST', '/lock/setup', {
    passphrase: 'correct horse battery',
    collections: ['journal', 'notes'],
  });
  expect(setup.status).toBe(200);
  await page.reload();
  await page.getByRole('button', { name: 'Lock Classpad now' }).click();
  await expect(page.getByRole('heading', { name: 'Classpad is locked' })).toBeVisible();
  expect((await call('GET', '/journal')).status).toBe(423);

  await page.getByLabel('Passphrase').fill('wrong passphrase');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toContainText('not correct');
  await page.getByLabel('Passphrase').fill('correct horse battery');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('heading', { name: 'Classpad is locked' })).toHaveCount(0);
  const j = await call('GET', '/journal');
  expect(j.status).toBe(200);
  expect(JSON.stringify(j.body)).toContain('Lorem day');
});

const ROUTES = [
  '/',
  '/classes',
  '/assignments',
  '/grades',
  '/gpa',
  '/notes',
  '/planner',
  '/study',
  '/import',
  '/settings',
  '/journal',
  '/flashcards',
  '/modules/reading',
  '/modules/budget',
];
for (const scheme of ['light', 'dark'] as const) {
  test(`accessibility (axe, ${scheme}): no serious or critical violations`, async () => {
    await page.emulateMedia({ colorScheme: scheme });
    const failures: string[] = [];
    for (const r of ROUTES) {
      await page.evaluate((h) => (location.hash = h), r);
      await page.waitForTimeout(700);
      await page.evaluate(axeSource);
      const res = await page.evaluate(async () => {
        // @ts-expect-error injected by the line above
        const out = await window.axe.run(document, { resultTypes: ['violations'] });
        return out.violations
          .filter((v: { impact: string }) => v.impact === 'serious' || v.impact === 'critical')
          .map(
            (v: { id: string; nodes: { target: unknown[] }[] }) =>
              `${v.id}: ${v.nodes
                .slice(0, 3)
                .map((n) => n.target.join(' '))
                .join(' | ')}`,
          );
      });
      failures.push(...res.map((x: string) => `${r} → ${x}`));
    }
    expect(failures).toEqual([]);
  });
}
