import { expect, test, type Page } from '@playwright/test';
import { cleanup, launch, type App } from './harness';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'classpad-e2e-editor-'));
let app: App;
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

/** Create a note with this Markdown and open it in the block editor. */
async function open(markdown: string, title = 'E2E note') {
  const n = await api('/notes', 'POST', { title, markdown });
  await page.evaluate((id) => (location.hash = `#/notes/${id}`), n.id);
  try {
    await page.locator('.be-page .af-block').first().waitFor({ timeout: 30_000 });
  } catch {
    const shown = await page.locator('.be-status').allTextContents();
    throw new Error(`the editor did not open; it shows: ${JSON.stringify(shown)}`);
  }
  await page.waitForTimeout(200);
  return n.id as string;
}
const menuItem = () => page.locator('.be-slash [role=option][aria-selected=true]');
/** Type a "/" command, check the highlighted entry, and pick it. */
const slash = async (typed: string, expected: string) => {
  await page.keyboard.type(typed);
  await expect(menuItem()).toContainText(expected);
  await page.keyboard.press('Enter');
};
/** The Markdown as saved on disk (without the final newline). */
const saved = (id: string) => async () =>
  ((await api(`/notes/${id}`)).markdown as string).trimEnd();
const content = () => page.locator('.be-page');
// macOS moves to the start/end of a line with Cmd+Left/Right; Home/End do that elsewhere
const mac = process.platform === 'darwin';
const lineStart = () => page.keyboard.press(mac ? 'Meta+ArrowLeft' : 'Home');
const lineEnd = () => page.keyboard.press(mac ? 'Meta+ArrowRight' : 'End');
const focusEnd = async () => {
  await content().click();
  await page.keyboard.press('ControlOrMeta+End');
};

test.beforeAll(async () => {
  ({ app, page } = await launch(dataDir));
});
test.afterAll(async () => {
  await app?.close();
  cleanup(dataDir);
});
test.describe.configure({ mode: 'serial' });

test('the "/" menu inserts blocks, and Enter starts a new block', async () => {
  const id = await open('');
  await focusEnd();
  await slash('/h2', 'Heading 2');
  await page.keyboard.type('Title');
  await page.keyboard.press('Enter');
  await slash('/todo', 'To-do list');
  await page.keyboard.type('task');
  await expect.poll(saved(id)).toBe('## Title\n\n- [ ] task');
});

test('the menu groups blocks, filters as you type, and closes on Escape', async () => {
  await open('');
  await focusEnd();
  await page.keyboard.type('/');
  const menu = page.locator('.be-slash');
  await expect(menu).toBeVisible();
  for (const label of [
    'Text',
    'Heading 1',
    'To-do list',
    'Bulleted list',
    'Numbered list',
    'Quote',
    'Callout',
    'Divider',
    'Toggle list',
    'Toggle heading 2',
    'Image',
    'Code',
    'Block equation',
    'Table',
  ])
    await expect(menu.getByText(label, { exact: true })).toBeVisible();
  await page.keyboard.type('tog');
  await expect(menu.getByRole('option')).toHaveCount(4); // toggle list + 3 toggle headings
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('lists continue on Enter and end on an empty item; Tab nests', async () => {
  const id = await open('');
  await focusEnd();
  await page.keyboard.type('- one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.type('three');
  await expect.poll(saved(id)).toBe('- one\n  - two\n  - three');
  await page.keyboard.press('Enter'); // new empty nested item
  await page.keyboard.press('Enter'); // outdents one level
  await page.keyboard.press('Enter'); // leaves the list
  await page.keyboard.type('after');
  await expect.poll(saved(id)).toBe('- one\n  - two\n  - three\n\nafter');
});

test('typing shortcuts: "[] " to-do, "```python" code, "# " heading, "> " toggle, **bold**', async () => {
  const id = await open('');
  await focusEnd();
  await page.keyboard.type('[] buy milk');
  await expect.poll(saved(id)).toBe('- [ ] buy milk');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // leave the list
  await page.keyboard.type('```python');
  await page.keyboard.press('Enter');
  await page.keyboard.type('x = 1');
  await expect.poll(saved(id)).toContain('```python\nx = 1\n```');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // two empty lines at the end leave the code block
  await page.keyboard.type('# Big');
  await expect(page.locator('.af-heading.af-h1')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await page.keyboard.type('> Details');
  await expect(page.locator('.af-toggle-list')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await page.keyboard.type('a **strong** word');
  await expect(content().locator('strong')).toHaveText('strong');
  await expect
    .poll(saved(id))
    .toContain('<details open>\n<summary>Details</summary>\n\na **strong** word\n\n</details>');
});

test('to-do checkboxes toggle on click and the file changes', async () => {
  const id = await open('- [ ] first\n- [ ] second\n\nend');
  await page.locator('.af-check').first().click();
  await expect.poll(saved(id)).toBe('- [x] first\n- [ ] second\n\nend');
  await page.locator('.af-check').first().click();
  await expect.poll(saved(id)).toBe('- [ ] first\n- [ ] second\n\nend');
});

test('toggles fold and unfold, and the state is kept in the file', async () => {
  const md =
    '<details open>\n<summary>Why?</summary>\n\nBecause of the hidden body.\n\n</details>\n\nafter';
  const id = await open(md);
  await expect(content()).toContainText('hidden body');
  await page.getByRole('button', { name: 'Collapse' }).click();
  await expect(content().getByText('Because of the hidden body.')).toBeHidden();
  await expect.poll(saved(id)).toBe(md.replace('<details open>', '<details>'));
  await page.getByRole('button', { name: 'Expand' }).click();
  await expect(content().getByText('Because of the hidden body.')).toBeVisible();
});

test('right-click opens a block menu with Turn into, Duplicate, Move and Delete', async () => {
  const id = await open('hello world\n\nsecond block');
  await content().getByText('hello world').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Block options' });
  await expect(menu).toBeVisible();
  for (const label of [
    'Cut',
    'Copy',
    'Paste',
    'Turn into',
    'Duplicate',
    'Move up',
    'Move down',
    'Delete',
  ])
    await expect(menu.getByRole('menuitem', { name: new RegExp(`^${label}`) })).toBeVisible();
  await menu.getByRole('menuitem', { name: /^Turn into/ }).hover();
  await page.getByRole('menuitem', { name: /^Heading 2/ }).click();
  await expect.poll(saved(id)).toBe('## hello world\n\nsecond block');

  await content().getByText('second block').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Move up/ }).click();
  await expect.poll(saved(id)).toBe('second block\n\n## hello world');
  await content().getByText('second block').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Delete/ }).click();
  await expect.poll(saved(id)).toBe('## hello world');
});

test('selecting text shows a formatting toolbar', async () => {
  const id = await open('make this bold');
  await content().getByText('make this bold').click();
  await page.keyboard.press('ControlOrMeta+a');
  const bar = page.getByRole('toolbar', { name: 'Format selected text' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: /^Bold/ }).click();
  await expect.poll(saved(id)).toBe('**make this bold**');
  await expect(bar.getByRole('button', { name: /^Bold/ })).toHaveAttribute('aria-pressed', 'true');
  await bar.getByRole('button', { name: 'Turn into ▾' }).click();
  await page.getByRole('menuitem', { name: /^Quote/ }).click();
  await expect.poll(saved(id)).toBe('> **make this bold**');
});

test('undo and redo', async () => {
  const id = await open('start');
  await content().getByText('start').click();
  await lineEnd();
  // one input, so the undo step does not depend on typing speed (typing a second apart starts a new step)
  await page.keyboard.insertText(' more');
  await expect.poll(saved(id)).toBe('start more');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(saved(id)).toBe('start');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(saved(id)).toBe('start more');
});

test('Backspace at the start of a block joins it to the one above', async () => {
  const id = await open('first\n\nsecond');
  await content().getByText('second').click();
  await lineStart();
  await page.keyboard.press('Backspace');
  await expect.poll(saved(id)).toBe('firstsecond');
  await page.keyboard.type('|');
  await expect.poll(saved(id)).toBe('first|second');
});

test('pasting Markdown makes blocks', async () => {
  const id = await open('before');
  await content().getByText('before').click();
  await lineEnd();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '# Pasted\n\n- one\n- two');
    document
      .querySelector('.be-page')!
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
  });
  await expect.poll(saved(id)).toBe('before\n\n# Pasted\n\n- one\n- two');
});

test('hover handles: + adds a block and opens the menu, the grip opens block options', async () => {
  const id = await open('first paragraph\n\nsecond paragraph');
  await content().getByText('first paragraph').hover();
  await expect(page.locator('.be-handle')).toBeVisible();
  await page.locator('.be-plus').click();
  await expect(page.locator('.be-slash')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace'); // remove the "/"
  await content().getByText('first paragraph').hover();
  await page.locator('.be-grip').click();
  const menu = page.getByRole('menu', { name: 'Block options' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /^Duplicate/ }).click();
  await expect.poll(saved(id)).toContain('first paragraph\n\nfirst paragraph');
});

test('dragging the grip reorders blocks', async () => {
  const id = await open('one\n\ntwo\n\nthree');
  await content().getByText('one', { exact: true }).hover();
  const grip = page.locator('.be-grip');
  await expect(grip).toBeVisible();
  const g = (await grip.boundingBox())!;
  const target = (await content().getByText('three', { exact: true }).boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, g.y + 20, { steps: 4 });
  await page.mouse.move(g.x + g.width / 2, target.y + target.height - 3, { steps: 8 });
  await page.mouse.up();
  await expect.poll(saved(id)).toBe('two\n\nthree\n\none');
});

test('a toggle heading can be made from the menu, titled, and filled in', async () => {
  const id = await open('');
  await focusEnd();
  await page.keyboard.type('/toggle h');
  await expect(page.locator('.be-slash [role=option]')).toHaveCount(3); // the three toggle headings
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.type('My title');
  await page.keyboard.press('Enter');
  await page.keyboard.type('inside');
  await expect
    .poll(saved(id))
    .toBe('<details open>\n<summary><h2>My title</h2></summary>\n\ninside\n\n</details>');
});

test('source mode shows the raw Markdown and back', async () => {
  await open('# Heading\n\nsome **bold** text');
  await expect(content()).not.toContainText('**');
  await page.getByRole('button', { name: 'Note options' }).click();
  await page.getByRole('menuitem', { name: /^Source mode/ }).click();
  await expect(page.locator('.cm-content')).toContainText('**bold**');
  await page.getByRole('button', { name: 'Note options' }).click();
  await page.getByRole('menuitem', { name: /^Source mode/ }).click();
  await expect(content()).toContainText('some bold text');
});

test('opening a note never rewrites it', async () => {
  const odd =
    '# T\n\n* star bullet\n  * two-space child\n\n1) paren list\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n<details>\n<summary>x</summary>\nno blank lines\n</details>\n\ntrailing spaces  \nnext\n\n***\n';
  const id = await open(odd);
  const before = (await api(`/notes/${id}`)).updatedAt;
  await content().getByText('next').click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(1200);
  const after = await api(`/notes/${id}`);
  expect(after.markdown).toBe(odd);
  expect(after.updatedAt).toBe(before);
});

test('a code block has a language picker in its header', async () => {
  const id = await open('```\nprint(1)\n```\n\nafter');
  await page.locator('.af-code-lang').click();
  const menu = page.getByRole('menu', { name: 'Code language' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Python' }).click();
  await expect.poll(saved(id)).toBe('```python\nprint(1)\n```\n\nafter');
  await expect(page.locator('.af-code-lang')).toContainText('python');
});

test('equations: $…$ becomes inline math, and a block equation opens an editor', async () => {
  const id = await open('');
  await focusEnd();
  await page.keyboard.type('Euler $e^{i\\pi}$ done');
  await expect(content().locator('.af-imath .katex')).toBeVisible();
  await page.keyboard.press('Enter');
  await slash('/equation', 'Block equation');
  const field = page.getByRole('dialog', { name: 'Equation (LaTeX)' }).locator('textarea');
  await field.fill('a^2+b^2=c^2');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect.poll(saved(id)).toBe('Euler $e^{i\\pi}$ done\n\n$$\na^2+b^2=c^2\n$$');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibility (axe, ${scheme}): the editor and its menus have no serious violations`, async () => {
    const { readFileSync } = await import('node:fs');
    const { createRequire } = await import('node:module');
    const axeSource = readFileSync(
      createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
      'utf8',
    );
    await page.emulateMedia({ colorScheme: scheme });
    await open(
      '# Heading\n\nA paragraph with **bold**, a [[link]] and $x^2$.\n\n- [ ] task\n- bullet\n\n```python\nx = 1\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n<details>\n<summary>Toggle</summary>\n\nbody\n\n</details>\n\nend',
    );
    await content().getByText('end').click();
    const failures: string[] = [];
    const scan = async (label: string) => {
      await page.evaluate(axeSource);
      const res = await page.evaluate(async () => {
        // @ts-expect-error injected above
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
      failures.push(...res.map((x: string) => `${label} → ${x}`));
    };
    await scan('editor');
    await content()
      .getByText('A paragraph')
      .click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('ControlOrMeta+a'); // selects the block's text
    await expect(page.getByRole('toolbar', { name: 'Format selected text' })).toBeVisible();
    await scan('selection toolbar');
    await content().getByText('end').click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Block options' })).toBeVisible();
    await scan('right-click menu');
    await page.keyboard.press('Escape');
    await content().getByText('end').click();
    await lineEnd();
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    await expect(page.locator('.be-slash')).toBeVisible();
    await scan('slash menu');
    expect(failures).toEqual([]);
  });
}

test('the editor is editable the moment a note shows (a click right away places a caret)', async () => {
  // record the page's state when the first block appears, before anything else can happen
  await page.evaluate(() => {
    const w = window as unknown as { firstShow?: boolean | null };
    w.firstShow = null;
    const seen = new MutationObserver(() => {
      const ed = document.querySelector<HTMLElement>('.be-page');
      if (ed?.querySelector('.af-block') && w.firstShow === null) {
        w.firstShow = ed.isContentEditable;
        seen.disconnect();
      }
    });
    seen.observe(document.body, { subtree: true, childList: true });
  });
  const n = await api('/notes', 'POST', { title: 'E2E first click', markdown: 'Hello' });
  await page.evaluate((id) => (location.hash = `#/notes/${id}`), n.id);
  await page.locator('.be-page .af-block').first().waitFor();
  expect(await page.evaluate(() => (window as unknown as { firstShow?: boolean }).firstShow)).toBe(
    true,
  );
  // and a click straight away is a caret you can type at
  await content().click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' world');
  await expect.poll(saved(n.id)).toBe('Hello world');
});

test('a "/" menu that opens under a resting pointer keeps its first match for Enter', async () => {
  const id = await open('');
  await focusEnd();
  await page.keyboard.type('/toggle h');
  const options = page.locator('.be-slash [role=option]');
  await expect(options).toHaveCount(3);
  // what the browser sends when the menu appears under a pointer that has not moved: hover events
  // without any movement
  for (const type of ['mouseover', 'mousemove'])
    await options.nth(1).dispatchEvent(type, { movementX: 0, movementY: 0, bubbles: true });
  await expect(menuItem()).toContainText('Toggle heading 1');
  // a real move does highlight
  const box = (await options.nth(1).boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + box.height / 2, { steps: 3 });
  await expect(menuItem()).toContainText('Toggle heading 2');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Top');
  await expect.poll(saved(id)).toContain('<summary><h1>Top</h1></summary>');
});

test('the save label never says "Saved" while typing waits to be saved', async () => {
  const id = await open('draft');
  await content().getByText('draft').click();
  await lineEnd();
  const label = page.locator('.note-status');
  await expect(label).toHaveText('Saved');
  // timed in the page from the keystroke's arrival (a test browser can take a while to deliver it);
  // the editor holds a keystroke for 350 ms before handing it over, the label must not wait for that
  await page.evaluate(() => {
    const w = window as unknown as { typedAt?: number; unsavedAt?: number };
    const el = document.querySelector('.note-status')!;
    document.addEventListener('beforeinput', () => (w.typedAt ??= performance.now()), {
      capture: true,
      once: true,
    });
    new MutationObserver(() => {
      if (el.textContent === 'Unsaved changes') w.unsavedAt ??= performance.now();
    }).observe(el, { subtree: true, characterData: true, childList: true });
  });
  await page.keyboard.type('!');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const w = window as unknown as { typedAt?: number; unsavedAt?: number };
        return w.typedAt !== undefined && w.unsavedAt !== undefined
          ? w.unsavedAt - w.typedAt
          : null;
      }),
    )
    .not.toBeNull();
  const ms = await page.evaluate(() => {
    const w = window as unknown as { typedAt: number; unsavedAt: number };
    return w.unsavedAt - w.typedAt;
  });
  expect(ms).toBeLessThan(150);
  await expect(label).toHaveText('Saved');
  expect(await saved(id)()).toBe('draft!');
});
