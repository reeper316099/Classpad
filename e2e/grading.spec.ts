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
const dataDir = mkdtempSync(path.join(tmpdir(), 'classpad-e2e-grading-'));
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
  cleanup(dataDir);
});

test('set your own category weights for a class, then sort assignments into them', async () => {
  app = await electron.launch({
    args: [main],
    env: { ...process.env, CLASSPAD_DATA_DIR: dataDir, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForLoadState('domcontentloaded');
  const sem = await api('/semesters', 'POST', { name: 'Cat Term' });
  const cls = await api('/classes', 'POST', { name: 'Cat Class', semesterId: sem.id });
  for (const [title, type, score] of [
    ['Homework 1', 'homework', 100],
    ['Homework 2', 'homework', 80],
    ['Final exam', 'exam', 90],
  ] as const)
    await api('/assignments', 'POST', {
      title,
      classId: cls.id,
      type: [type],
      score: { percent: score },
      weight: 5,
    });

  await page.evaluate((id) => (location.hash = `#/classes/${id}/grades`), cls.id);
  await page.getByRole('button', { name: 'Set up grading' }).click();
  const dlg = page.locator('dialog[open]');
  await dlg.getByRole('radio', { name: /Categories/ }).check();
  await dlg.getByRole('button', { name: 'Homework · Quizzes · Exams' }).click();
  await expect(dlg.getByRole('status')).toContainText('Total 100%');
  // drop each student's lowest homework
  await dlg.getByLabel('Drop lowest for Homework').fill('1');
  await expect(dlg.getByText('3 not in a category yet')).toBeVisible();
  await dlg.getByRole('button', { name: 'Match by type or title' }).click();
  await expect(dlg.getByText(/not in a category yet/)).toHaveCount(0);
  // the dialog has no serious accessibility problems
  const axeSource = (await import('node:fs')).readFileSync(
    (await import('node:module')).createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
    'utf8',
  );
  await page.evaluate(axeSource);
  const bad = await page.evaluate(async () => {
    // @ts-expect-error injected above
    const out = await window.axe.run(document.querySelector('dialog[open]'), {
      resultTypes: ['violations'],
    });
    return out.violations
      .filter((v: { impact: string }) => v.impact === 'serious' || v.impact === 'critical')
      .map((v: { id: string }) => v.id);
  });
  expect(bad).toEqual([]);
  await dlg.getByRole('button', { name: 'Save grading' }).click();
  await expect(dlg).toHaveCount(0);

  // homework (dropped lowest) 100 at 30%, exam 90 at 50%, quizzes empty: (3000 + 4500) / 80
  await expect
    .poll(async () =>
      Number(
        ((await api(`/grades/class/${cls.id}`)) as { grade: { percentRaw: string } }).grade
          .percentRaw,
      ),
    )
    .toBeCloseTo(93.75);
  await expect(page.getByText('Cat Class categories')).toBeVisible();

  // the assignment form now asks for a category instead of a weight
  await page.getByRole('button', { name: 'Assignment', exact: true }).click();
  const form = page.locator('dialog[open]');
  await form.getByLabel('Class', { exact: true }).selectOption({ label: 'Cat Class' });
  await expect(form.getByLabel('Category')).toBeVisible();
  await expect(form.getByLabel('Category').locator('option')).toContainText([
    '— none —',
    'Homework (30%)',
    'Quizzes (20%)',
    'Exams (50%)',
  ]);
  await expect(form.getByLabel('Weight %')).toHaveCount(0);
});
