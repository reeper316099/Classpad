import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const main = path.join(here, '../apps/desktop/dist/main.cjs');
const dataDir = mkdtempSync(path.join(tmpdir(), 'classpad-e2e-m9-'));
const outDir = mkdtempSync(path.join(tmpdir(), 'classpad-e2e-m9-out-'));
let app: ElectronApplication;
let page: Page;
const api = (p: string, method = 'GET', body?: unknown) =>
  page.evaluate(
    async ([u, m, b]) =>
      (
        await fetch(`/api/v1${u}`, {
          method: m as string,
          headers: {
            authorization: `Bearer ${window.classpad!.api.token}`,
            'content-type': 'application/json',
          },
          body: b ? JSON.stringify(b) : undefined,
        })
      ).json(),
    [p, method, body] as const,
  );

test.afterAll(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

test('import a gradebook with a user plugin, then export to a folder', async () => {
  mkdirSync(path.join(dataDir, 'plugins'), { recursive: true });
  writeFileSync(
    path.join(dataDir, 'plugins', 'marks.json'),
    JSON.stringify({
      pluginVersion: 1,
      id: 'marks',
      name: 'Marks sheet (test plugin)',
      kind: 'gradebook-csv',
      columns: { title: 'Task', score: 'Mark', pointsPossible: 'Out of' },
    }),
  );
  app = await electron.launch({
    args: [main],
    env: { ...process.env, CLASSPAD_DATA_DIR: dataDir, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const sem = await api('/semesters', 'POST', { name: 'M9 Term' });
  await api('/classes', 'POST', { name: 'Lorem 101', semesterId: sem.id });

  await page
    .locator('aside.sidebar')
    .getByRole('link', { name: 'Import & export', exact: true })
    .click();
  await page.getByLabel('What to import').selectOption({ label: 'Gradebook CSV (LMS export)' });
  await page.getByLabel('Gradebook format').selectOption({ label: 'Marks sheet (test plugin)' });
  await page.getByLabel('Class for these assignments').fill('Lorem 101');
  await page.locator('input[type=file]').setInputFiles({
    name: 'marks.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Task,Mark,Out of\nQuiz A,17,20\nEssay B,,50\n'),
  });
  await expect(page.getByRole('heading', { name: 'Preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Imported' })).toBeVisible();
  const list = await api('/assignments?limit=50');
  const quiz = list.items.find((a: { title: string }) => a.title === 'Quiz A');
  expect(quiz.score.percent).toBeCloseTo(85);

  await page.getByLabel('Export folder').fill(outDir);
  await page.getByRole('button', { name: 'Export now' }).click();
  await expect(page.getByText(/Last export: \d+ files/)).toBeVisible();
  const target = path.join(outDir, 'Classpad Export');
  expect(existsSync(path.join(target, 'gradebook.csv'))).toBe(true);
  expect(readFileSync(path.join(target, 'gradebook.csv'), 'utf8')).toContain('Quiz A');
});
