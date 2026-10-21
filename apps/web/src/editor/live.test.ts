import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { buildBlocks, buildInline, foldField, livePreview, setFold } from './live.js';

const cb = {
  openWiki: () => undefined,
  openAttachment: () => undefined,
  openLanguageMenu: () => undefined,
};
const make = (doc: string, caret = 0) =>
  EditorState.create({
    doc,
    selection: EditorSelection.single(caret),
    extensions: [markdown({ base: markdownLanguage }), livePreview()],
  });
const caretAt = (doc: string, needle: string, off = 0) => doc.indexOf(needle) + off;

interface D {
  from: number;
  to: number;
  kind: string;
}
const kinds = (
  items: { from: number; to: number; value: { spec: Record<string, unknown> } }[],
): D[] =>
  items.map((i) => {
    const sp = i.value.spec as {
      class?: string;
      widget?: { constructor: { name: string } };
      attributes?: { class?: string };
    };
    const kind = sp.widget
      ? sp.widget.constructor.name
      : (sp.class ?? sp.attributes?.class ?? 'hide');
    return { from: i.from, to: i.to, kind };
  });
const inline = (doc: string, caret = 0) => {
  const s = make(doc, caret);
  return kinds(buildInline(s, [{ from: 0, to: s.doc.length }], cb).all as never);
};
const blocks = (doc: string, caret = 0) => kinds(buildBlocks(make(doc, caret)) as never);
const has = (d: D[], kind: string | RegExp) =>
  d.some((x) => (typeof kind === 'string' ? x.kind === kind : kind.test(x.kind)));

describe('headings', () => {
  it('hide the # marker until the caret is on the line', () => {
    const doc = '# Title\n\nbody';
    expect(inline(doc, caretAt(doc, 'body'))).toContainEqual({ from: 0, to: 2, kind: 'hide' });
    expect(has(inline(doc, caretAt(doc, 'body')), 'cm-lp-h cm-lp-h1')).toBe(true);
    expect(inline(doc, 3).some((d) => d.kind === 'hide' && d.from === 0)).toBe(false);
    expect(has(inline(doc, 3), 'cm-lp-syntax')).toBe(true);
  });
});

describe('lists', () => {
  it('replace the bullet and hide nested indentation when the caret is elsewhere', () => {
    const doc = '- one\n    - nested\n\nafter';
    const d = inline(doc, caretAt(doc, 'after'));
    expect(d.filter((x) => x.kind === 'BulletWidget')).toHaveLength(2);
    expect(d.some((x) => x.kind === 'hide' && x.from === 6 && x.to === 10)).toBe(true); // the 4 spaces
  });
  it('show raw markers on the line being edited', () => {
    const doc = '- one\n- two';
    const d = inline(doc, 2);
    expect(d.filter((x) => x.kind === 'BulletWidget')).toHaveLength(1); // only the other line
    expect(has(d, 'cm-lp-syntax')).toBe(true);
  });
  it('turn tasks into checkboxes and mark finished ones', () => {
    const doc = '- [ ] a\n- [x] b\n\nend';
    const d = inline(doc, caretAt(doc, 'end'));
    expect(d.filter((x) => x.kind === 'CheckboxWidget')).toHaveLength(2);
    expect(has(d, /cm-lp-done/)).toBe(true);
  });
  it('show ordered-list numbers as widgets', () => {
    expect(has(inline('1. a\n2. b\n\nz', 12), 'NumberWidget')).toBe(true);
  });
});

describe('inline formatting', () => {
  const doc = 'plain **bold** and *it* and `code` and ~~gone~~ end';
  it('hides the markers when the caret is outside', () => {
    const d = inline(doc, doc.length);
    expect(d.filter((x) => x.kind === 'hide')).toHaveLength(8);
    for (const c of ['cm-lp-strong', 'cm-lp-em', 'cm-lp-icode', 'cm-lp-strike'])
      expect(has(d, c)).toBe(true);
  });
  it('shows only the markers of the element the caret is in', () => {
    const d = inline(doc, caretAt(doc, 'bold', 2));
    expect(d.filter((x) => x.kind === 'hide')).toHaveLength(6); // everything except the bold pair
    expect(d.filter((x) => x.kind === 'cm-lp-syntax').length).toBeGreaterThanOrEqual(2);
  });
});

describe('links and attachments', () => {
  it('hides a link’s URL and styles the text', () => {
    const doc = 'see [site](https://example.com) now';
    const d = inline(doc, doc.length);
    expect(has(d, 'cm-lp-link')).toBe(true);
    expect(d.some((x) => x.kind === 'hide' && x.from === caretAt(doc, ']('))).toBe(true);
  });
  it('shows attachments as a file chip and images as images', () => {
    const hash = 'a'.repeat(64);
    const doc = `[notes](attachment://${hash}.pdf)\n\n![fig](attachment://${hash}.png)\n\nend`;
    const d = inline(doc, doc.length);
    expect(has(d, 'FileWidget')).toBe(true);
    expect(has(d, 'ImageWidget')).toBe(true);
    expect(has(inline(doc, doc.indexOf('![fig]') + 3), 'ImageWidget')).toBe(false); // raw while editing
  });
  it('shows [[wiki links]] as pills and reveals the source near the caret', () => {
    const doc = 'go to [[Other Note|alias]] ok';
    expect(has(inline(doc, doc.length), 'WikiWidget')).toBe(true);
    expect(has(inline(doc, caretAt(doc, 'Other')), 'WikiWidget')).toBe(false);
    expect(has(inline(doc, caretAt(doc, 'Other')), 'cm-lp-wiki-raw')).toBe(true);
  });
});

describe('math and clozes', () => {
  it('renders inline math but not currency', () => {
    expect(has(inline('area is $\\pi r^2$ here', 20), 'MathWidget')).toBe(true);
    expect(has(inline('costs $5 and $6 total', 20), 'MathWidget')).toBe(false);
  });
  it('hides the cloze braces and highlights the answer', () => {
    const d = inline('The {{c1::answer}} is', 20);
    expect(has(d, 'cm-lp-cloze')).toBe(true);
    expect(d.filter((x) => x.kind === 'hide')).toHaveLength(2);
  });
  it('does not touch anything inside a code block', () => {
    const code = '```\n[[x]] $y$ **z**\n```\n\nend';
    const d = inline(code, code.length);
    expect(has(d, 'WikiWidget') || has(d, 'MathWidget') || has(d, 'cm-lp-strong')).toBe(false);
  });
});

describe('code blocks', () => {
  const doc = '```python\nx = 1\n```\n\nend';
  it('show a header and hide the fences when the caret is outside', () => {
    const d = inline(doc, caretAt(doc, 'end'));
    expect(has(d, 'FenceWidget')).toBe(true);
    expect(has(d, /cm-lp-fence /)).toBe(true);
    expect(has(d, /cm-lp-fence-end/)).toBe(true);
  });
  it('show the raw fences while editing', () => {
    const d = inline(doc, caretAt(doc, 'x = 1'));
    expect(has(d, 'FenceWidget')).toBe(false);
    expect(has(d, /cm-lp-fence-raw/)).toBe(true);
  });
});

describe('toggles', () => {
  const doc = 'top\n\n<details>\n<summary>Title</summary>\n\nbody text\n\n</details>\n\nend';
  it('hide the tag lines and show a chevron before the title', () => {
    const b = blocks(doc, doc.length);
    expect(b.filter((x) => x.kind === 'HiddenWidget').length).toBeGreaterThanOrEqual(2);
    const d = inline(doc, doc.length);
    expect(has(d, 'ChevronWidget')).toBe(true);
  });
  it('fold the body away when collapsed (the default without the open attribute)', () => {
    const b = blocks(doc, doc.length);
    const body = doc.indexOf('body text');
    expect(b.some((x) => x.from <= body && x.to >= doc.indexOf('</details>'))).toBe(true);
  });
  it('keep the body visible when the toggle has the open attribute', () => {
    const open = doc.replace('<details>', '<details open>');
    const body = open.indexOf('body text');
    expect(blocks(open, open.length).some((x) => x.from <= body && x.to >= body)).toBe(false);
  });
  it('expand and collapse from the chevron, and open when the caret is inside', () => {
    let s = make(doc, doc.length);
    const from = doc.indexOf('<details>');
    s = s.update({ effects: setFold(from, false) }).state;
    expect(s.field(foldField).get(from)).toBe(false);
    s = s.update({ effects: setFold(from, true) }).state;
    expect(s.field(foldField).get(from)).toBe(true);
    s = s.update({ selection: { anchor: doc.indexOf('body text') + 2 } }).state;
    expect(s.field(foldField).get(from)).toBe(false); // jumped into it: it opens
  });
  it('remember an override while text above is edited', () => {
    let s = make(doc, doc.length);
    const from = doc.indexOf('<details>');
    s = s.update({ effects: setFold(from, false) }).state;
    s = s.update({ changes: { from: 0, insert: 'XYZ' } }).state;
    expect(s.field(foldField).get(from + 3)).toBe(false);
  });
  it('keep the caret out of the hidden tag part of the title line', () => {
    let s = make(doc, doc.length);
    const line = s.doc.line(4);
    s = s.update({ selection: { anchor: line.from } }).state;
    expect(s.selection.main.head).toBe(line.from + '<summary>'.length);
  });
});

describe('tables and display math', () => {
  it('render a table widget when the caret is elsewhere, raw when inside', () => {
    const doc = '| a | b |\n| - | - |\n| 1 | 2 |\n\nend';
    expect(has(blocks(doc, doc.length), 'TableWidget')).toBe(true);
    expect(has(blocks(doc, 2), 'TableWidget')).toBe(false);
    expect(has(inline(doc, 2), 'cm-lp-table-raw')).toBe(true);
  });
  it('render display math', () => {
    const doc = '$$\n\\int_0^1 x\\,dx\n$$\n\nend';
    expect(has(blocks(doc, doc.length), 'MathBlockWidget')).toBe(true);
    expect(has(blocks(doc, 4), 'MathBlockWidget')).toBe(false);
  });
});

describe('quotes and rules', () => {
  it('style quote lines and hide the > marks', () => {
    const doc = '> quoted\n> more\n\nend';
    const d = inline(doc, doc.length);
    expect(d.filter((x) => x.kind === 'cm-lp-quote')).toHaveLength(2);
    expect(d.filter((x) => x.kind === 'hide')).toHaveLength(2);
  });
  it('make a callout out of a quote that starts with an emoji', () => {
    expect(has(inline('> 💡 tip\n\nend', 12), /cm-lp-callout/)).toBe(true);
  });
  it('draw a rule', () => {
    expect(has(inline('a\n\n---\n\nb', 8), 'HrWidget')).toBe(true);
  });
});

describe('performance on a realistic large note', () => {
  it('decorates a 150k-character outline in well under 100 ms for a screenful', () => {
    const doc = Array.from(
      { length: 1500 },
      (_, i) => `- item ${i} with **bold** and [[link ${i}]]\n    - child ${i}`,
    ).join('\n');
    const s = make(doc, 0);
    const t0 = performance.now();
    buildInline(s, [{ from: 0, to: 4000 }], cb);
    buildBlocks(s);
    expect(performance.now() - t0).toBeLessThan(250);
  });
});
