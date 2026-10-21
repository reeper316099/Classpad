import AdmZip from 'adm-zip';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const main = path.join(root, 'apps/desktop/dist/main.cjs');
const fixtures = path.join(root, 'fixtures/synthetic/notion-export');

const dataDir = mkdtempSync(path.join(tmpdir(), 'classpad-e2e-'));
test.afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  // E2E_EXECUTABLE=/path/to/Classpad(.exe/.app binary) runs the same tests against a packaged build
  const exe = process.env.E2E_EXECUTABLE;
  const noSandbox = process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : [];
  const app = await electron.launch({
    ...(exe ? { executablePath: exe, args: noSandbox } : { args: [main, ...noSandbox] }),
    env: { ...process.env, CLASSPAD_DATA_DIR: dataDir, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}
const api = (page: Page, p: string) =>
  page.evaluate(
    async (u) =>
      (
        await fetch(`/api/v1${u}`, {
          headers: { authorization: `Bearer ${window.classpad!.api.token}` },
        })
      ).json(),
    p,
  );
const nav = (page: Page, name: string) =>
  page.locator('aside.sidebar').getByRole('link', { name, exact: true }).click();

test.describe.configure({ mode: 'serial' });
let app: ElectronApplication;
let page: Page;

test('first run: secure shell, no network, demo data', async () => {
  ({ app, page } = await launch());
  await expect(page).toHaveTitle(/Classpad/);

  // the bridge exists, with a per-launch token, and the page is served from our own loopback server
  const info = await page.evaluate(() => ({
    url: location.origin,
    hasToken: (window.classpad?.api.token.length ?? 0) >= 32,
    node: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
  }));
  expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(info.hasToken).toBe(true);
  expect(info.node).toBe('undefined'); // no Node in the renderer
  expect(info.process).toBe('undefined');

  // "no network" is enforced: remote requests are blocked, and the API refuses requests without the token
  const remote = await page.evaluate(async () => {
    try {
      await fetch('https://example.com/', { mode: 'no-cors' });
      return 'reached';
    } catch {
      return 'blocked';
    }
  });
  expect(remote).toBe('blocked');
  const noToken = await page.evaluate(async () => (await fetch('/api/v1/health')).status);
  expect(noToken).toBe(401);

  await expect(page.getByRole('heading', { name: 'Welcome to Classpad' })).toBeVisible();
  await page.getByRole('heading', { name: 'Open demo data' }).click();
  await expect(page.getByRole('heading', { name: 'Demo Term' })).toBeVisible();
  await expect(page.getByText('Intro to Lorem Studies').first()).toBeVisible();
});

test('add an assignment with a weight and enter scores', async () => {
  await nav(page, 'Assignments');
  await page.getByRole('button', { name: 'New assignment' }).first().click();
  const dlg = page.locator('dialog[open]');
  await dlg.getByLabel('Title').fill('E2E Essay');
  await dlg.getByLabel('Class', { exact: true }).selectOption({ label: 'Intro to Lorem Studies' });
  await dlg.getByLabel('Weight %').fill('4');
  await dlg.getByRole('button', { name: 'Add assignment' }).click();
  await expect(page.getByRole('button', { name: 'E2E Essay', exact: true })).toBeVisible();

  const score = page.getByLabel('Score for E2E Essay');
  await score.fill('88');
  await score.press('Enter');
  await expect
    .poll(
      async () =>
        (
          (await api(page, '/assignments?limit=1000')) as {
            items: { title: string; score?: { percent: number } }[];
          }
        ).items.find((a) => a.title === 'E2E Essay')?.score?.percent,
    )
    .toBe(88);
});

test('grades: what-if, what do I need, and the step-by-step panel', async () => {
  await nav(page, 'Grades');
  await expect(page.getByText('How this was calculated')).toBeVisible();
  await expect(page.getByText('Graded items (score × weight)')).toBeVisible();

  await page.getByRole('tab', { name: 'What-if' }).click();
  await page.getByLabel('What-if score for Final exam').fill('100');
  await expect(page.getByText(/pts/).first()).toBeVisible(); // live delta against the actual grade
  await expect(page.getByText('How the what-if was calculated')).toBeVisible();
  const saved = await api(page, '/assignments?limit=1000');
  expect(
    (saved as { items: { title: string; score?: unknown }[] }).items.find(
      (a) => a.title === 'Final exam',
    )?.score,
  ).toBeUndefined(); // never persisted

  await page.getByRole('tab', { name: 'What do I need?' }).click();
  await page.getByRole('button', { name: 'Percent' }).click();
  await page.getByLabel('Target percent').fill('90');
  await expect(page.getByText(/^(Reachable|Not reachable|Already secured)$/).first()).toBeVisible();
  await expect(page.getByText('How this was calculated')).toBeVisible();
});

test('notes: write math, then find it by search', async () => {
  await nav(page, 'Notes');
  await page.keyboard.press('n');
  const dlg = page.locator('dialog[open]');
  await dlg.getByLabel('Title').fill('E2E Math');
  await dlg.getByRole('button', { name: 'Create note' }).click();
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.type('Euler: $e^{i\\pi} + 1 = 0$ and a [[Ipsum sampling notes]] link');
  await expect(page.locator('.preview-pane .katex').first()).toBeVisible();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  await page.getByLabel('Search notes').fill('Euler');
  await expect(page.locator('.notes-tree').getByRole('button', { name: /E2E Math/ })).toBeVisible();
  // wiki link resolves and backlinks show on the target note
  const target = (await api(page, '/notes?limit=1000')) as {
    items: { id: string; title: string }[];
  };
  const ipsum = target.items.find((n) => n.title === 'Ipsum sampling notes')!;
  const backlinks = (await api(page, `/notes/${ipsum.id}/backlinks`)) as { title: string }[];
  expect(backlinks.map((b) => b.title)).toContain('E2E Math');
});

test('import the synthetic export, then open the printable report', async () => {
  // build a zip of the fake (lorem ipsum) export on the fly
  const zip = new AdmZip();
  const add = (dir: string, rel = '') => {
    for (const f of readdirSync(path.join(dir, rel))) {
      const r = rel ? `${rel}/${f}` : f;
      if (statSync(path.join(dir, r)).isDirectory()) add(dir, r);
      else zip.addFile(r, readFileSync(path.join(dir, r)));
    }
  };
  add(fixtures);
  const zipPath = path.join(dataDir, 'synthetic.zip');
  writeFileSync(zipPath, zip.toBuffer());

  await nav(page, 'Import & export');
  await page.locator('input[type=file]').setInputFiles(zipPath);
  await expect(page.getByRole('heading', { name: 'Preview' })).toBeVisible();
  await expect(page.getByText('Grade check')).toBeVisible();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Imported' })).toBeVisible();
  const classes = (await api(page, '/classes?limit=1000')) as { items: { name: string }[] };
  expect(classes.items.map((c) => c.name)).toEqual(
    expect.arrayContaining(['LOREM 101', 'IPSUM 202', 'Unassigned']),
  );

  // importing again must not duplicate anything
  const before = ((await api(page, '/assignments?limit=1000')) as { total: number }).total;
  await page.locator('input[type=file]').setInputFiles(zipPath);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Imported' })).toBeVisible();
  expect(((await api(page, '/assignments?limit=1000')) as { total: number }).total).toBe(before);

  // the printable grade report opens in its own script-free window
  const popup = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Printable grade report' }).click();
  const report = await popup;
  await report.waitForLoadState();
  await expect(report.getByRole('heading', { name: 'Grade report' })).toBeVisible();
  await expect(report.getByText('How this was calculated').first()).toBeVisible();
  await report.close();
});

test('restart: everything persisted, and the window comes back', async () => {
  await app.close();
  ({ app, page } = await launch());
  await expect(page.getByRole('heading', { name: 'Demo Term' })).toBeVisible(); // no welcome screen the second time

  const asg = (await api(page, '/assignments?limit=1000')) as {
    items: { title: string; score?: { percent: number } }[];
  };
  expect(asg.items.find((a) => a.title === 'E2E Essay')?.score?.percent).toBe(88);
  const notes = (await api(page, '/notes?limit=1000')) as {
    items: { title: string; markdown: string }[];
  };
  expect(notes.items.find((n) => n.title === 'E2E Math')?.markdown).toContain(
    '$e^{i\\pi} + 1 = 0$',
  );
  const sems = (await api(page, '/semesters')) as { items: { name: string }[] };
  expect(sems.items.map((s) => s.name)).toEqual(
    expect.arrayContaining(['Demo Term', 'Autumn Block A']),
  );

  await nav(page, 'Notes');
  await expect(page.getByRole('button', { name: 'E2E Math' })).toBeVisible();
  await app.close();
});
