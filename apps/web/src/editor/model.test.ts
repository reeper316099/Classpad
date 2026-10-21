import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  blockAt,
  deleteBlock,
  duplicateBlock,
  moveBlock,
  reorderBlock,
  renumberOrdered,
  slashEdit,
  togglesOf,
  turnBlockInto,
  tree,
} from './model.js';

const mk = (doc: string) =>
  EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
const at = (s: EditorState, needle: string, off = 0) => s.doc.toString().indexOf(needle) + off;
const apply = (s: EditorState, e: { changes: unknown }) =>
  s.update({ changes: e.changes as never }).state.doc.toString();

describe('finding blocks', () => {
  const s = mk(
    '# Title\n\nPara one\ncontinues.\n\n- a\n    - nested\n- b\n\n```py\nx = 1\n```\n\n> quote\n',
  );
  it('classifies top-level blocks', () => {
    expect(blockAt(s, at(s, '# Title'))!.kind).toBe('h1');
    expect(blockAt(s, at(s, 'continues'))!.kind).toBe('text');
    expect(blockAt(s, at(s, 'x = 1'))!.kind).toBe('code');
    expect(blockAt(s, at(s, '> quote'))!.kind).toBe('quote');
  });
  it('covers all the lines of a paragraph', () => {
    const b = blockAt(s, at(s, 'Para'))!;
    expect(s.sliceDoc(b.from, b.to)).toBe('Para one\ncontinues.');
  });
  it('finds list items, including nested ones, with their children', () => {
    const outer = blockAt(s, at(s, '- a'))!;
    expect(outer.kind).toBe('bullet');
    expect(s.sliceDoc(outer.from, outer.to)).toBe('- a\n    - nested');
    const inner = blockAt(s, at(s, 'nested'))!;
    expect(s.sliceDoc(inner.from, inner.to)).toBe('    - nested');
    expect(inner.depth).toBe(1);
    expect(blockAt(s, at(s, '- b'))!.siblings).toHaveLength(2);
  });
  it('returns null on a blank line between blocks', () => {
    expect(blockAt(s, at(s, '\n\nPara') + 1)).toBeNull();
  });
});

describe('toggles as blocks', () => {
  const doc =
    'before\n\n<details open>\n<summary><h2>Big</h2></summary>\n\ninner text\n\n- item\n\n</details>\n\nafter\n';
  const s = mk(doc);
  it('finds the toggle with offsets', () => {
    const [t] = togglesOf(s);
    expect(t!.title).toBe('Big');
    expect(t!.level).toBe(2);
    expect(s.sliceDoc(t!.titleFrom, t!.titleTo)).toBe('Big');
    expect(s.sliceDoc(t!.bodyFrom, t!.bodyTo).trim()).toBe('inner text\n\n- item');
  });
  it('treats the whole toggle as one block from its tag lines and inner content as separate blocks', () => {
    const t = blockAt(s, at(s, 'Big'))!;
    expect(t.kind).toBe('toggle-h2');
    expect(s.sliceDoc(t.from, t.to).startsWith('<details open>')).toBe(true);
    expect(s.sliceDoc(t.from, t.to).endsWith('</details>')).toBe(true);
    const inner = blockAt(s, at(s, 'inner text'))!;
    expect(inner.kind).toBe('text');
    expect(inner.siblings.map((x) => s.sliceDoc(x.from, x.to))).toEqual(['inner text', '- item']);
    expect(blockAt(s, at(s, 'after'))!.siblings).toHaveLength(3); // before, toggle, after
  });
});

describe('moving, copying and deleting', () => {
  it('moves a block past its neighbour, keeping the spacing', () => {
    const s = mk('one\n\ntwo\n\nthree\n');
    const e = moveBlock(s, blockAt(s, at(s, 'two'))!, 1)!;
    expect(apply(s, e)).toBe('one\n\nthree\n\ntwo\n');
    expect(moveBlock(s, blockAt(s, 0)!, -1)).toBeNull();
  });
  it('moves list items together with their children', () => {
    const s = mk('- a\n    - a1\n- b\n- c\n');
    const e = moveBlock(s, blockAt(s, at(s, '- a'))!, 1)!;
    expect(apply(s, e)).toBe('- b\n- a\n    - a1\n- c\n');
  });
  it('moves a whole toggle as one unit', () => {
    const s = mk('<details>\n<summary>T</summary>\n\nbody\n\n</details>\n\nafter\n');
    const e = moveBlock(s, blockAt(s, at(s, 'T</'))!, 1)!;
    expect(apply(s, e)).toBe('after\n\n<details>\n<summary>T</summary>\n\nbody\n\n</details>\n');
  });
  it('duplicates paragraphs with a blank line and list items directly below', () => {
    const p = mk('one\n\ntwo\n');
    expect(apply(p, duplicateBlock(p, blockAt(p, 0)!))).toBe('one\n\none\n\ntwo\n');
    const l = mk('- a\n- b\n');
    expect(apply(l, duplicateBlock(l, blockAt(l, 0)!))).toBe('- a\n- a\n- b\n');
  });
  it('deletes a block and its separator', () => {
    const s = mk('one\n\ntwo\n\nthree\n');
    expect(apply(s, deleteBlock(s, blockAt(s, at(s, 'two'))!))).toBe('one\n\nthree\n');
    const last = mk('one\n\ntwo');
    expect(apply(last, deleteBlock(last, blockAt(last, at(last, 'two'))!))).toBe('one');
  });
  it('renumbers an ordered list after a move', () => {
    const s = mk('1. a\n2. b\n3. c\n');
    const moved = s.update({
      changes: moveBlock(s, blockAt(s, at(s, '1. a'))!, 1)!.changes as never,
    }).state;
    expect(moved.doc.toString()).toBe('2. b\n1. a\n3. c\n');
    const fix = moved.update({ changes: renumberOrdered(moved, 0) as never }).state;
    expect(fix.doc.toString()).toBe('1. b\n2. a\n3. c\n');
  });
});

describe('turn into', () => {
  const turn = (doc: string, needle: string, kind: Parameters<typeof turnBlockInto>[2]) => {
    const s = mk(doc);
    const e = turnBlockInto(s, blockAt(s, at(s, needle))!, kind);
    return e ? apply(s, e) : null;
  };
  it('changes line-level kinds in place', () => {
    expect(turn('hello\n', 'hello', 'h2')).toBe('## hello\n');
    expect(turn('## hello\n', 'hello', 'text')).toBe('hello\n');
    expect(turn('- item\n    - child\n', 'item', 'todo')).toBe('- [ ] item\n    - child\n');
  });
  it('only changes the first line of a paragraph', () => {
    expect(turn('one\ntwo\n', 'one', 'h1')).toBe('# one\ntwo\n');
  });
  it('turns a multi-line quote into text and back', () => {
    expect(turn('> a\n> b\n', 'a', 'text')).toBe('a\nb\n');
  });
  it('wraps into code and unwraps again', () => {
    expect(turn('print(1)\n', 'print', 'code')).toBe('```\nprint(1)\n```\n');
    expect(turn('```py\nprint(1)\n```\n', 'print', 'text')).toBe('print(1)\n');
  });
  it('turns text into a toggle with the text as title, and a toggle back into text', () => {
    expect(turn('Why?\n', 'Why', 'toggle')).toBe(
      '<details open>\n<summary>Why?</summary>\n\n\n</details>\n',
    );
    const back = turn(
      '<details open>\n<summary>Why?</summary>\n\nanswer\n\n</details>\n',
      'Why',
      'h2',
    );
    expect(back).toBe('## Why?\n\nanswer\n');
  });
  it('changes toggle heading levels', () => {
    expect(
      turn('<details>\n<summary>T</summary>\n\nb\n\n</details>\n', 'T<', 'toggle-h3'),
    ).toContain('<summary><h3>T</h3></summary>');
  });
});

describe('slash commands', () => {
  const run = (doc: string, slash: string, kind: Parameters<typeof slashEdit>[3]) => {
    const s = mk(doc);
    const from = at(s, slash);
    const e = slashEdit(s, from, from + slash.length, kind);
    const after = s.update({ changes: e.changes as never }).state;
    return {
      doc: after.doc.toString(),
      sel: after.sliceDoc(e.select.anchor, e.select.head ?? e.select.anchor),
    };
  };
  it('replaces an empty line with the block', () => {
    expect(run('/h1', '/h1', 'h1').doc).toBe('# ');
    expect(run('/todo', '/todo', 'todo').doc).toBe('- [ ] ');
  });
  it('turns a line that already has text into the block, keeping the text', () => {
    expect(run('keep me /h2', '/h2', 'h2').doc).toBe('## keep me');
  });
  it('wraps text for code and toggles', () => {
    expect(run('let x /code', '/code', 'code').doc).toBe('```\nlet x\n```');
    const t = run('/toggle', '/toggle', 'toggle');
    expect(t.sel).toBe('Toggle');
    expect(t.doc).toContain('<details open>');
  });
  it('inserts a divider or table without eating the text', () => {
    expect(run('text /div', '/div', 'divider').doc).toBe('text\n\n---\n\n');
    expect(run('/table', '/table', 'table').doc).toContain('| Column 1 |');
  });
});

describe('the syntax tree is complete for realistic notes', () => {
  it('parses a long outline without losing nodes', () => {
    const doc = Array.from(
      { length: 300 },
      (_, i) => `- item ${i}\n    - child ${i}\n        text under ${i}`,
    ).join('\n');
    const s = mk(doc);
    let items = 0;
    tree(s).iterate({ enter: (n) => void (n.name === 'ListItem' && items++) });
    expect(items).toBe(600);
  });
});

describe('drag to reorder', () => {
  const run = (doc: string, needle: string, to: number) => {
    const s = mk(doc);
    const e = reorderBlock(s, blockAt(s, at(s, needle))!, to);
    return e ? apply(s, e) : null;
  };
  it('moves a block to any position among its siblings', () => {
    const doc = 'one\n\ntwo\n\nthree\n\nfour\n';
    expect(run(doc, 'one', 4)).toBe('two\n\nthree\n\nfour\n\none\n');
    expect(run(doc, 'four', 0)).toBe('four\n\none\n\ntwo\n\nthree\n');
    expect(run(doc, 'two', 3)).toBe('one\n\nthree\n\ntwo\n\nfour\n');
  });
  it('does nothing when dropped where it already is', () => {
    const doc = 'one\n\ntwo\n\nthree\n';
    expect(run(doc, 'two', 1)).toBeNull();
    expect(run(doc, 'two', 2)).toBeNull();
  });
  it('reorders list items with their children', () => {
    expect(run('- a\n    - a1\n- b\n- c\n', '- a', 3)).toBe('- b\n- c\n- a\n    - a1\n');
  });
});
