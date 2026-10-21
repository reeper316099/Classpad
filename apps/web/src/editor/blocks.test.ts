import { describe, expect, it } from 'vitest';
import {
  blockInsert,
  emptyTable,
  findToggles,
  parseLine,
  turnLine,
  wrapCode,
  wrapToggle,
} from './blocks.js';

describe('reading a line', () => {
  it('recognises every line-level block', () => {
    const k = (s: string) => parseLine(s).kind;
    expect(k('plain')).toBe('text');
    expect(k('# A')).toBe('h1');
    expect(k('### A')).toBe('h3');
    expect(k('- [ ] x')).toBe('todo');
    expect(k('* [x] x')).toBe('todo-done');
    expect(k('- x')).toBe('bullet');
    expect(k('    - nested')).toBe('bullet');
    expect(k('12. x')).toBe('number');
    expect(k('> quote')).toBe('quote');
    expect(k('> 💡 tip')).toBe('callout');
    expect(k('#hashtag')).toBe('text'); // a heading needs a space
  });
  it('splits indent, marker and body', () => {
    expect(parseLine('  - [ ] do it')).toEqual({
      indent: '  ',
      kind: 'todo',
      marker: '- [ ] ',
      body: 'do it',
    });
  });
});

describe('turning a line into another block', () => {
  it('changes the prefix and keeps the text', () => {
    expect(turnLine('plain text', 'h2')).toBe('## plain text');
    expect(turnLine('## Title', 'text')).toBe('Title');
    expect(turnLine('# Title', 'h3')).toBe('### Title');
    expect(turnLine('- item', 'todo')).toBe('- [ ] item');
    expect(turnLine('- [x] item', 'number')).toBe('1. item');
    expect(turnLine('> quoted', 'bullet')).toBe('- quoted');
    expect(turnLine('text', 'quote')).toBe('> text');
    expect(turnLine('text', 'callout')).toBe('> 💡 text');
  });
  it('keeps list nesting only for list kinds', () => {
    expect(turnLine('    - nested', 'todo')).toBe('    - [ ] nested');
    expect(turnLine('    - nested', 'h1')).toBe('# nested');
  });
  it('leaves multi-line kinds alone', () => {
    expect(turnLine('x', 'code')).toBe('x');
  });
});

describe('multi-line blocks', () => {
  it('wraps code with a safe fence', () => {
    expect(wrapCode('a', 'python')).toBe('```python\na\n```');
    expect(wrapCode('a ```b``` c').startsWith('````')).toBe(true);
    expect(wrapCode('x', 'py thon\n```')).toBe('```python\nx\n```');
  });
  it('wraps toggles, open so the body is visible', () => {
    expect(wrapToggle('body', 0)).toBe(
      '<details open>\n<summary>Toggle</summary>\n\nbody\n\n</details>',
    );
    expect(wrapToggle('', 2, 'T')).toContain('<summary><h2>T</h2></summary>');
  });
  it('builds a table', () => {
    const t = emptyTable(2, 1).split('\n');
    expect(t).toHaveLength(3);
    expect(t[1]).toBe('| --- | --- |');
  });
});

describe('inserting from the menu', () => {
  it('selects what to type over', () => {
    const t = blockInsert('toggle-h2');
    expect(t.text.slice(...t.select)).toBe('Toggle');
    const c = blockInsert('code', 'let x');
    expect(c.text.slice(...c.select)).toBe('let x');
    const h = blockInsert('h1', 'Hello');
    expect(h.text).toBe('# Hello');
    expect(h.select).toEqual([7, 7]);
  });
  it('math block puts the cursor between the dollars', () => {
    const m = blockInsert('math', '');
    expect(m.text).toBe('$$\n\n$$\n');
    expect(m.select).toEqual([3, 3]);
  });
});

describe('finding toggles', () => {
  const doc = (s: string) => s.split('\n');
  it('finds a toggle list and a toggle heading', () => {
    const t = findToggles(
      doc(
        '<details>\n<summary>A</summary>\n\nx\n\n</details>\n\n<details open>\n<summary><h2>B</h2></summary>\n\ny\n\n</details>',
      ),
    );
    expect(t.map((x) => [x.title, x.level, x.isOpen, x.open, x.close])).toEqual([
      ['A', 0, false, 1, 6],
      ['B', 2, true, 8, 13],
    ]);
  });
  it('nests', () => {
    const t = findToggles(
      doc(
        '<details>\n<summary>O</summary>\n\n<details>\n<summary>I</summary>\n\nz\n\n</details>\n\n</details>',
      ),
    );
    expect(t.map((x) => [x.title, x.depth, x.close])).toEqual([
      ['O', 0, 11],
      ['I', 1, 9],
    ]);
  });
  it('ignores unclosed or half-typed tags and anything inside code', () => {
    expect(findToggles(doc('<details>\n<summary>A</summary>\n\nnever closed'))).toEqual([]);
    expect(findToggles(doc('<details>\nno summary\n</details>'))).toEqual([]);
    expect(findToggles(doc('```\n<details>\n<summary>A</summary>\n</details>\n```'))).toEqual([]);
  });
});
