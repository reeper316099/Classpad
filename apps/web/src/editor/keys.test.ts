import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { blockActions, enterMarkup, tableCells, tableTab } from './keys.js';

/** Run a command against a plain state with the caret at `|`. */
function run(doc: string, times = 1) {
  const caret = doc.indexOf('|');
  let state = EditorState.create({
    doc: doc.replace('|', ''),
    selection: { anchor: caret },
    extensions: [markdown({ base: markdownLanguage })],
  });
  const view = {
    get state() {
      return state;
    },
    dispatch: (spec: Parameters<EditorState['update']>[0]) => {
      state = state.update(spec).state;
    },
  } as unknown as EditorView;
  for (let i = 0; i < times; i++) enterMarkup(view);
  const d = state.doc.toString();
  const h = state.selection.main.head;
  return d.slice(0, h) + '|' + d.slice(h);
}

describe('Enter in lists', () => {
  it('continues a bullet, keeping nesting', () => {
    expect(run('- one|')).toBe('- one\n- |');
    expect(run('- a\n    - two|')).toBe('- a\n    - two\n    - |');
  });
  it('continues a to-do unchecked, and numbers count up', () => {
    expect(run('- [x] done|')).toBe('- [x] done\n- [ ] |');
    expect(run('1. a\n2. b|')).toBe('1. a\n2. b\n3. |');
  });
  it('splits an item at the caret', () => {
    expect(run('- hel|lo')).toBe('- hel\n- |lo');
  });
  it('steps out one level on an empty nested item, then leaves the list', () => {
    expect(run('- a\n    - |')).toBe('- a\n- |');
    expect(run('- a\n    - |', 2)).toBe('- a\n\n|');
  });
  it('clears an empty top-level item', () => {
    expect(run('- a\n- |')).toBe('- a\n\n|');
  });
  it('renumbers following items', () => {
    expect(run('1. a|\n2. b')).toBe('1. a\n2. |\n3. b');
  });
});

describe('Enter in quotes', () => {
  it('continues the quote and leaves it when empty', () => {
    expect(run('> hi|')).toBe('> hi\n> |');
    expect(run('> hi\n> |')).toBe('> hi\n\n|');
  });
  it('continues a callout as a plain quote line', () => {
    expect(run('> 💡 tip|')).toBe('> 💡 tip\n> |');
  });
});

describe('leaves everything else to other handlers', () => {
  it('does nothing on a paragraph or with the caret inside a marker', () => {
    const view = (doc: string, at: number) => {
      const state = EditorState.create({
        doc,
        selection: { anchor: at },
        extensions: [markdown({ base: markdownLanguage })],
      });
      return { state, dispatch: () => undefined } as unknown as EditorView;
    };
    expect(enterMarkup(view('plain text', 5))).toBe(false);
    expect(enterMarkup(view('- item', 1))).toBe(false);
  });
});

describe('code block language', () => {
  const lang = (doc: string, codeFrom: number, l: string) => {
    let state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
    const view = {
      get state() {
        return state;
      },
      dispatch: (spec: Parameters<EditorState['update']>[0]) => {
        state = state.update(spec).state;
      },
      focus: () => undefined,
    } as unknown as EditorView;
    blockActions.setCodeLanguage(view, codeFrom, l);
    return state.doc.toString();
  };
  it('sets, changes and clears the language on the opening fence', () => {
    expect(lang('```\nx\n```', 4, 'python')).toBe('```python\nx\n```');
    expect(lang('```js\nx\n```', 6, 'rust')).toBe('```rust\nx\n```');
    expect(lang('```python\nx\n```', 10, '')).toBe('```\nx\n```');
  });
  it('keeps a longer fence and refuses junk in the language', () => {
    expect(lang('````\n```\n````', 5, 'md')).toBe('````md\n```\n````');
    expect(lang('```\nx\n```', 4, 'py\n```x')).toBe('```pyx\nx\n```');
  });
});

describe('Tab in tables', () => {
  const tab = (doc: string, dir: 1 | -1 = 1) => {
    const caret = doc.indexOf('|');
    void caret;
    const at = doc.indexOf('§');
    let state = EditorState.create({
      doc: doc.replace('§', ''),
      selection: { anchor: at },
      extensions: [markdown({ base: markdownLanguage })],
    });
    const view = {
      get state() {
        return state;
      },
      dispatch: (spec: Parameters<EditorState['update']>[0]) => {
        state = state.update(spec).state;
      },
    } as unknown as EditorView;
    const handled = tableTab(view, dir);
    const s = state.selection.main;
    return { handled, doc: state.doc.toString(), selected: state.sliceDoc(s.from, s.to) };
  };
  it('splits a row into cells', () => {
    expect(tableCells('| a | bb |')).toEqual([
      [2, 3],
      [6, 8],
    ]);
  });
  it('moves to the next cell and selects its text', () => {
    const r = tab('| a§ | b |\n| - | - |\n| 1 | 2 |');
    expect(r.selected).toBe('b');
  });
  it('wraps to the next row, skipping the --- line', () => {
    const r = tab('| a | b§ |\n| - | - |\n| 1 | 2 |');
    expect(r.selected).toBe('1');
  });
  it('goes back with Shift-Tab', () => {
    const r = tab('| a | b |\n| - | - |\n| 1§ | 2 |', -1);
    expect(r.selected).toBe('b');
  });
  it('adds a row after the last cell', () => {
    const r = tab('| a | b |\n| - | - |\n| 1 | 2§ |');
    expect(r.doc).toBe('| a | b |\n| - | - |\n| 1 | 2 |\n|   |   |');
  });
  it('ignores lines that are not table rows', () => {
    expect(tab('plain§ text').handled).toBe(false);
  });
});
