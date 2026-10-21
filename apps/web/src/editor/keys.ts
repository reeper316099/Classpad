import { indentLess, indentMore } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { EditorSelection, type Extension } from '@codemirror/state';
import { EditorView, keymap, type Command } from '@codemirror/view';
import { blockInsert, parseLine, type BlockKind } from './blocks.js';
import { setFold } from './live.js';
import {
  blockAt,
  deleteBlock,
  duplicateBlock,
  moveBlock,
  renumberOrdered,
  togglesOf,
  tree,
  turnBlockInto,
  type Edit,
} from './model.js';

const apply = (view: EditorView, e: Edit, extra: { renumber?: boolean } = {}) => {
  view.dispatch({
    changes: e.changes,
    selection: { anchor: e.select.anchor, head: e.select.head ?? e.select.anchor },
    scrollIntoView: true,
    userEvent: 'input.block',
  });
  if (extra.renumber) {
    const fix = renumberOrdered(view.state, view.state.selection.main.head);
    if (fix.length) view.dispatch({ changes: fix, userEvent: 'input.block' });
  }
  view.focus();
};

/** Block actions, shared by the keyboard, the block menu and the right-click menu. */
export const blockActions = {
  turnInto(view: EditorView, pos: number, kind: BlockKind) {
    const b = blockAt(view.state, pos);
    const e = b && turnBlockInto(view.state, b, kind);
    if (e) apply(view, e, { renumber: kind === 'number' });
  },
  move(view: EditorView, pos: number, dir: -1 | 1) {
    const b = blockAt(view.state, pos);
    const e = b && moveBlock(view.state, b, dir);
    if (e) apply(view, e, { renumber: b!.kind === 'number' });
  },
  duplicate(view: EditorView, pos: number) {
    const b = blockAt(view.state, pos);
    if (b) apply(view, duplicateBlock(view.state, b), { renumber: b.kind === 'number' });
  },
  /** Add a new, empty block of `kind` after the block at `pos`. */
  insertAfter(view: EditorView, pos: number, kind: BlockKind) {
    const b = blockAt(view.state, pos);
    const at = b ? b.to : view.state.doc.lineAt(pos).to;
    const ins = blockInsert(kind, '');
    const lead = b?.isList ? '\n' : '\n\n';
    const text = ins.text.replace(/\n+$/, '');
    view.dispatch({
      changes: { from: at, insert: lead + text },
      selection: {
        anchor: at + lead.length + ins.select[0],
        head: at + lead.length + Math.min(ins.select[1], text.length),
      },
      userEvent: 'input.block',
      scrollIntoView: true,
    });
    view.focus();
  },
  /** Change the language of the code block whose first code line starts at `codeFrom`. */
  setCodeLanguage(view: EditorView, codeFrom: number, lang: string) {
    const fence = view.state.doc.lineAt(Math.max(0, codeFrom - 1));
    const m = /^(\s*)(`{3,}|~{3,})/.exec(fence.text);
    if (!m) return;
    const from = fence.from + m[0].length;
    view.dispatch({
      changes: { from, to: fence.to, insert: lang.replace(/[^\w+#-]/g, '') },
      userEvent: 'input.block',
    });
    view.focus();
  },
  remove(view: EditorView, pos: number) {
    const b = blockAt(view.state, pos);
    if (b) apply(view, deleteBlock(view.state, b), { renumber: b.kind === 'number' });
  },
};

const inFence = (view: EditorView, pos: number) => {
  let hit: { from: number; to: number; marks: number } | null = null;
  tree(view.state).iterate({
    from: pos,
    to: pos,
    enter: (n) => {
      if (n.name === 'FencedCode')
        hit = { from: n.from, to: n.to, marks: n.node.getChildren('CodeMark').length };
    },
  });
  return hit as { from: number; to: number; marks: number } | null;
};

/**
 * Enter inside a list item or quote, like Notion: continue the list; on an empty item step out one level
 * (nested) or leave the list (top level).
 */
export const enterMarkup: Command = (view) => {
  const sel = view.state.selection.main;
  const doc = view.state.doc;
  const line = doc.lineAt(sel.head);
  const p = parseLine(line.text);
  const isList =
    p.kind === 'bullet' || p.kind === 'number' || p.kind === 'todo' || p.kind === 'todo-done';
  const isQuote = p.kind === 'quote' || p.kind === 'callout';
  if (!isList && !isQuote) return false;
  const markerEnd = line.from + p.indent.length + p.marker.length;
  if (sel.head < markerEnd) return false; // the caret is inside the marker itself: plain newline
  if (p.body.trim() === '') {
    if (isList && p.indent.length > 0) {
      const less = p.indent.replace(/^(\t| {1,4})/, '');
      view.dispatch({
        changes: { from: line.from, to: line.from + p.indent.length, insert: less },
        selection: { anchor: line.from + less.length + p.marker.length },
        userEvent: 'input',
      });
    } else {
      // leave the list: a blank line, then a fresh paragraph (without it Markdown would fold the next line into the last item)
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '\n' },
        selection: { anchor: line.from + 1 },
        userEvent: 'input',
      });
    }
    return true;
  }
  let marker = p.marker;
  if (p.kind === 'todo-done') marker = marker.replace(/\[[xX]\]/, '[ ]');
  if (p.kind === 'number') marker = marker.replace(/^\d+/, (n) => String(Number(n) + 1));
  if (p.kind === 'callout') marker = '> ';
  const insert = `\n${p.indent}${marker}`;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
    scrollIntoView: true,
    userEvent: 'input',
  });
  if (p.kind === 'number') {
    const fix = renumberOrdered(view.state, view.state.selection.main.head);
    if (fix.length) view.dispatch({ changes: fix, userEvent: 'input' });
  }
  return true;
};

/** Enter starts a new block, the way Notion does. Lists and quotes continue via the Markdown keymap that follows. */
const enter: Command = (view) => {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const doc = view.state.doc;
  const line = doc.lineAt(sel.head);
  const fence = inFence(view, sel.head);

  // an opening ``` or $$ with nothing after it: close it for the user
  if (
    /^\s*(`{3,}|~{3,})[\w+#-]*\s*$/.test(line.text) &&
    sel.head === line.to &&
    fence &&
    fence.marks < 2 &&
    fence.from === line.from
  ) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line.text)![1]!;
    view.dispatch({
      changes: { from: line.to, insert: `\n\n${f}` },
      selection: { anchor: line.to + 1 },
      userEvent: 'input',
    });
    return true;
  }
  if (line.text.trim() === '$$' && sel.head === line.to) {
    const open = (doc.sliceString(0, line.from).match(/^\s*\$\$\s*$/gm) ?? []).length % 2 === 0;
    if (open) {
      view.dispatch({
        changes: { from: line.to, insert: '\n\n$$' },
        selection: { anchor: line.to + 1 },
        userEvent: 'input',
      });
      return true;
    }
  }
  if (fence) return false; // inside code: a plain newline

  // toggle title: step into the body
  const t = togglesOf(view.state).find((x) => x.summaryFrom === line.from);
  if (t) {
    const bodyLines: number[] = [];
    if (t.bodyTo >= t.bodyFrom)
      for (let n = doc.lineAt(t.bodyFrom).number; n <= doc.lineAt(t.bodyTo).number; n++)
        bodyLines.push(n);
    const first = bodyLines.find((n) => doc.line(n).text.trim() !== '') ?? bodyLines.at(-1);
    view.dispatch({ effects: setFold(t.openFrom, false) });
    if (first === undefined) {
      view.dispatch({
        changes: { from: line.to, insert: '\n\n' },
        selection: { anchor: line.to + 2 },
      });
    } else {
      const l = doc.line(first);
      view.dispatch({
        selection: { anchor: l.text.trim() === '' ? l.to : l.from },
        scrollIntoView: true,
      });
    }
    return true;
  }

  const p = parseLine(line.text);
  if (/^(bullet|number|todo|todo-done|quote|callout)$/.test(p.kind)) return enterMarkup(view);
  if (line.text.trim() === '') return false;
  // paragraphs and headings: a new block means a new paragraph
  view.dispatch({
    changes: { from: sel.head, insert: '\n\n' },
    selection: { anchor: sel.head + 2 },
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
};

const softBreak: Command = (view) => {
  const sel = view.state.selection.main;
  if (inFence(view, sel.head)) return false;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: '\n' },
    selection: { anchor: sel.from + 1 },
    userEvent: 'input',
  });
  return true;
};

const onListLine = (view: EditorView) => {
  const p = parseLine(view.state.doc.lineAt(view.state.selection.main.head).text);
  return ['bullet', 'number', 'todo', 'todo-done'].includes(p.kind);
};
const isRow = (t: string) => /^\s*\|.*\|\s*$/.test(t);
const isDelimiter = (t: string) => /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(t);

/** Cell boundaries of a table row: [start, end] of each cell's text (trimmed), as offsets in the line. */
export function tableCells(text: string): [number, number][] {
  const cells: [number, number][] = [];
  const pipes: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === '|' && text[i - 1] !== '\\') pipes.push(i);
  for (let i = 0; i + 1 < pipes.length; i++) {
    let a = pipes[i]! + 1;
    let b = pipes[i + 1]!;
    while (a < b && text[a] === ' ') a++;
    while (b > a && text[b - 1] === ' ') b--;
    cells.push([a, b]);
  }
  return cells;
}

/** Tab / Shift-Tab in a table row: next / previous cell, and a new row after the last cell. */
export function tableTab(view: EditorView, dir: 1 | -1): boolean {
  const doc = view.state.doc;
  const head = view.state.selection.main.head;
  const line = doc.lineAt(head);
  if (!isRow(line.text)) return false;
  const here = head - line.from;
  const cells = tableCells(line.text);
  let i = cells.findIndex(([a, b]) => here >= a - 1 && here <= b + 1);
  if (i < 0) i = dir === 1 ? -1 : cells.length;
  const select = (ln: number, c: number) => {
    const l = doc.line(ln);
    const cs = tableCells(l.text);
    const [a, b] = cs[Math.min(c, cs.length - 1)] ?? [2, 2];
    view.dispatch({ selection: { anchor: l.from + a, head: l.from + b }, scrollIntoView: true });
  };
  let ln = line.number;
  const c = i + dir;
  if (c >= 0 && c < cells.length) {
    select(ln, c);
    return true;
  }
  // move to the neighbouring row, skipping the |---| line
  ln += dir;
  while (ln >= 1 && ln <= doc.lines && isDelimiter(doc.line(ln).text)) ln += dir;
  if (ln >= 1 && ln <= doc.lines && isRow(doc.line(ln).text)) {
    select(ln, dir === 1 ? 0 : tableCells(doc.line(ln).text).length - 1);
    return true;
  }
  if (dir === 1) {
    const row = `| ${cells.map(() => ' ').join(' | ')} |`;
    view.dispatch({
      changes: { from: line.to, insert: `\n${row}` },
      selection: { anchor: line.to + 3 },
      scrollIntoView: true,
      userEvent: 'input',
    });
    return true;
  }
  return true; // first cell of the first row: stay in the table
}

const tab: Command = (view) => {
  if (tableTab(view, 1)) return true;
  if (inFence(view, view.state.selection.main.head) || onListLine(view)) return indentMore(view);
  return false;
};
const shiftTab: Command = (view) => {
  if (tableTab(view, -1)) return true;
  if (inFence(view, view.state.selection.main.head) || onListLine(view)) return indentLess(view);
  return false;
};

/** Backspace at the very start of a toggle title turns the toggle back into a plain block instead of eating its tags. */
const backspace: Command = (view) => {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const t = togglesOf(view.state).find((x) => sel.head === x.titleFrom);
  if (!t) return false;
  blockActions.turnInto(view, t.summaryFrom, 'text');
  return true;
};
const deleteForward: Command = (view) => {
  const sel = view.state.selection.main;
  return sel.empty && togglesOf(view.state).some((x) => sel.head === x.titleTo);
};

const toggleTask: Command = (view) => {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const p = parseLine(line.text);
  if (p.kind === 'todo' || p.kind === 'todo-done') {
    const at = line.from + p.indent.length + p.marker.indexOf('[') + 1;
    view.dispatch({
      changes: { from: at, to: at + 1, insert: p.kind === 'todo' ? 'x' : ' ' },
      userEvent: 'input.toggle',
    });
  } else blockActions.turnInto(view, line.from, 'todo');
  return true;
};

const wrapSel =
  (before: string, after = before): Command =>
  (view) => {
    view.dispatch(
      view.state.changeByRange((r) => {
        const s = view.state.sliceDoc(r.from, r.to);
        if (s.length >= before.length + after.length && s.startsWith(before) && s.endsWith(after)) {
          const inner = s.slice(before.length, s.length - after.length);
          return {
            changes: { from: r.from, to: r.to, insert: inner },
            range: EditorSelection.range(r.from, r.from + inner.length),
          };
        }
        return {
          changes: { from: r.from, to: r.to, insert: before + s + after },
          range: r.empty
            ? EditorSelection.cursor(r.from + before.length)
            : EditorSelection.range(r.from + before.length, r.to + before.length),
        };
      }),
    );
    return true;
  };

export const wrap = wrapSel;

export const link: Command = (view) => {
  const r = view.state.selection.main;
  const s = view.state.sliceDoc(r.from, r.to);
  const text = `[${s || 'text'}](url)`;
  const urlFrom = r.from + text.indexOf('(url)') + 1;
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: text },
    selection: { anchor: urlFrom, head: urlFrom + 3 },
    userEvent: 'input',
  });
  return true;
};

const turn =
  (kind: BlockKind): Command =>
  (view) => {
    blockActions.turnInto(view, view.state.selection.main.head, kind);
    return true;
  };
const move =
  (dir: -1 | 1): Command =>
  (view) => {
    blockActions.move(view, view.state.selection.main.head, dir);
    return true;
  };

/** "[] " at the start of a line becomes a to-do, like Notion. */
const todoShortcut = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== ' ') return false;
  const line = view.state.doc.lineAt(from);
  const before = view.state.sliceDoc(line.from, from);
  const m = /^(\s*)\[\]$/.exec(before);
  if (!m) return false;
  view.dispatch({
    changes: { from: line.from + m[1]!.length, to, insert: '- [ ] ' },
    selection: { anchor: line.from + m[1]!.length + 6 },
    userEvent: 'input.type',
  });
  return true;
});

export const editorKeys = (): Extension => [
  indentUnit.of('    '),
  todoShortcut,
  keymap.of([
    { key: 'Enter', run: enter },
    { key: 'Shift-Enter', run: softBreak },
    { key: 'Backspace', run: backspace },
    { key: 'Delete', run: deleteForward },
    { key: 'Tab', run: tab },
    { key: 'Shift-Tab', run: shiftTab },
    { key: 'Mod-Enter', run: toggleTask },
    { key: 'Mod-b', run: wrapSel('**') },
    { key: 'Mod-i', run: wrapSel('*') },
    { key: 'Mod-e', run: wrapSel('`') },
    { key: 'Mod-Shift-s', run: wrapSel('~~') },
    { key: 'Mod-k', run: link },
    { key: 'Mod-Alt-0', run: turn('text') },
    { key: 'Mod-Alt-1', run: turn('h1') },
    { key: 'Mod-Alt-2', run: turn('h2') },
    { key: 'Mod-Alt-3', run: turn('h3') },
    { key: 'Mod-Shift-7', run: turn('number') },
    { key: 'Mod-Shift-8', run: turn('bullet') },
    { key: 'Mod-Shift-9', run: turn('todo') },
    { key: 'Mod-Alt-c', run: turn('code') },
    { key: 'Mod-Alt-t', run: turn('toggle') },
    { key: 'Mod-Shift-ArrowUp', run: move(-1) },
    { key: 'Mod-Shift-ArrowDown', run: move(1) },
    {
      key: 'Mod-d',
      run: (view) => {
        blockActions.duplicate(view, view.state.selection.main.head);
        return true;
      },
    },
  ]),
];
