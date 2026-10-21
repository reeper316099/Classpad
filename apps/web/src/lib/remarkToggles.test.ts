import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import { parseSummary, remarkToggles } from './remarkToggles.js';

const run = (md: string) => {
  const p = unified().use(remarkParse);
  const tree = p.parse(md);
  unified().use(remarkToggles).runSync(tree);
  return tree as unknown as { children: { type: string; children?: unknown[]; data?: unknown }[] };
};
const first = (md: string) =>
  run(md).children[0] as never as {
    type: string;
    data: { hProperties: Record<string, unknown> };
    children: {
      type: string;
      data: { hProperties: { className: string[] } };
      children: { value: string }[];
    }[];
  };

describe('toggles', () => {
  it('turns <details><summary> into a toggle with its body', () => {
    const t = first('<details>\n<summary>Why?</summary>\n\nBecause **reasons**.\n\n</details>\n');
    expect(t.type).toBe('toggle');
    expect(t.children[0]!.children[0]!.value).toBe('Why?');
    expect(t.children[0]!.data.hProperties.className).toEqual(['toggle-list']);
    expect(t.children).toHaveLength(2);
    expect(t.children[1]!.type).toBe('paragraph');
  });

  it('understands toggle headings 1, 2 and 3', () => {
    for (const n of [1, 2, 3]) {
      const t = first(`<details>\n<summary><h${n}>Section</h${n}></summary>\n\nx\n\n</details>`);
      expect(t.children[0]!.children[0]!.value).toBe('Section');
      expect(t.children[0]!.data.hProperties.className).toEqual([`toggle-h${n}`]);
    }
  });

  it('nests toggles', () => {
    const t = first(
      '<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\ndeep\n\n</details>\n\nafter inner\n\n</details>',
    );
    expect(t.children.map((c) => c.type)).toEqual(['toggleSummary', 'toggle', 'paragraph']);
  });

  it('handles a one-line toggle and the open attribute', () => {
    const t = first('<details open><summary>Quick</summary>Short answer</details>');
    expect(t.type).toBe('toggle');
    expect(t.data.hProperties.open).toBe(true);
    expect(t.children[1]!.type).toBe('paragraph');
  });

  it('keeps content of an unclosed toggle and leaves other HTML alone', () => {
    const tree = run(
      '<details>\n<summary>Open ended</summary>\n\ntext\n\n<script>alert(1)</script>',
    );
    expect(tree.children[0]!.type).toBe('toggle');
    expect(JSON.stringify(tree)).toContain('"type":"html"'); // still an html node, which the renderer skips
  });

  it('parses summaries', () => {
    expect(parseSummary('<h2>Title</h2>')).toEqual({ level: 2, text: 'Title' });
    expect(parseSummary('Plain <b>bold</b>')).toEqual({ level: 0, text: 'Plain bold' });
    expect(parseSummary(undefined)).toEqual({ level: 0, text: 'Toggle' });
  });
});
