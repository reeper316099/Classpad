// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EMBED, offsetIn, pointIn, renderInline, textLength } from './render.js';

const el = (ops: Parameters<typeof renderInline>[1]) => {
  const d = document.createElement('div');
  renderInline(d, ops);
  return d;
};

describe('block text <-> DOM positions', () => {
  it('renders formatting as nested elements', () => {
    const d = el([
      { insert: 'a ' },
      { insert: 'bold', attributes: { bold: true, italic: true } },
      { insert: ' link', attributes: { href: 'https://example.com' } },
      { insert: 'Page', attributes: { wiki: true } },
    ]);
    expect(d.querySelector('strong em')?.textContent).toBe('bold');
    expect(d.querySelector('a.af-link')?.getAttribute('href')).toBe('https://example.com');
    expect(d.querySelector<HTMLElement>('a.af-wiki')?.dataset.wiki).toBe('Page');
  });

  it('maps offsets both ways across formatting and an inline equation', () => {
    const d = el([
      { insert: 'ab' },
      { insert: 'cd', attributes: { bold: true } },
      { insert: EMBED, attributes: { formula: 'x^2' } },
      { insert: 'ef' },
    ]);
    expect(textLength(d)).toBe(7);
    for (let off = 0; off <= 7; off++) {
      const p = pointIn(d, off);
      expect(offsetIn(d, p.node, p.offset)).toBe(off);
    }
    // a point inside the equation's rendering counts as next to it
    const math = d.querySelector('.af-imath')!;
    expect(offsetIn(d, math.firstChild!, 0)).toBe(4);
  });

  it('keeps a caret line for empty text and a trailing line break', () => {
    expect(el([]).querySelector('br')).not.toBeNull();
    const d = el([{ insert: 'line\n' }]);
    expect(d.querySelector('br')).not.toBeNull();
    expect(textLength(d)).toBe(5);
    expect(offsetIn(d, d, d.childNodes.length)).toBe(5);
  });

  it('counts UTF-16 units like the Go core', () => {
    const d = el([{ insert: 'a😀b' }]);
    expect(textLength(d)).toBe(4);
    expect(offsetIn(d, d.firstChild!, 3)).toBe(3);
  });
});
