import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState, type ChangeSpec, type Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import {
  blockInsert,
  findToggles,
  isLineKind,
  parseLine,
  turnLine,
  wrapCode,
  wrapToggle,
  type BlockKind,
} from './blocks.js';

/** A toggle with document offsets (the line-number version lives in blocks.ts). */
export interface TogglePos {
  openFrom: number;
  openTo: number;
  summaryFrom: number;
  summaryTo: number;
  /** Start of the first body line (after the summary) and end of the last (before `</details>`); body is empty when to < from. */
  bodyFrom: number;
  bodyTo: number;
  closeFrom: number;
  closeTo: number;
  level: 0 | 1 | 2 | 3;
  title: string;
  /** Where the title text sits inside the summary line. */
  titleFrom: number;
  titleTo: number;
  isOpen: boolean;
  depth: number;
}

const cache = new WeakMap<Text, TogglePos[]>();

export const togglesOf = (state: EditorState): TogglePos[] => togglesOfDoc(state.doc);

export function togglesOfDoc(doc: Text): TogglePos[] {
  const hit = cache.get(doc);
  if (hit) return hit;
  const lines: string[] = [];
  for (const l of doc.iterLines()) lines.push(l);
  const out = findToggles(lines).map((t): TogglePos => {
    const open = doc.line(t.open);
    const sum = doc.line(t.summary);
    const close = doc.line(t.close);
    const next = t.summary + 1;
    const bodyFrom = next <= t.close - 1 ? doc.line(next).from : sum.to + 1;
    const bodyTo = next <= t.close - 1 ? doc.line(t.close - 1).to : sum.to;
    const text = sum.text;
    const tStart = text.indexOf('>', text.toLowerCase().indexOf('<summary')) + 1;
    let a = tStart;
    if (t.level) a = text.indexOf('>', tStart) + 1; // skip <hN>
    const endTag = text.toLowerCase().lastIndexOf('</summary>');
    let b = endTag < 0 ? text.length : endTag;
    if (t.level) b = text.toLowerCase().lastIndexOf(`</h${t.level}>`);
    return {
      openFrom: open.from,
      openTo: open.to,
      summaryFrom: sum.from,
      summaryTo: sum.to,
      bodyFrom,
      bodyTo,
      closeFrom: close.from,
      closeTo: close.to,
      level: t.level,
      title: t.title,
      titleFrom: sum.from + a,
      titleTo: sum.from + Math.max(a, b),
      isOpen: t.isOpen,
      depth: t.depth,
    };
  });
  cache.set(doc, out);
  return out;
}

export const tree = (state: EditorState) =>
  ensureSyntaxTree(state, state.doc.length, 250) ?? syntaxTree(state);

// ---------------------------------------------------------------------------------------------
// blocks

export interface Unit {
  from: number;
  to: number;
  node?: SyntaxNode;
  toggle?: TogglePos;
}

export interface Block {
  /** Start of the first line and end of the last line. */
  from: number;
  to: number;
  kind: BlockKind;
  /** Part of a list (so moving and copying keep list spacing). */
  isList: boolean;
  /** The blocks next to this one, in order, including this one. */
  siblings: { from: number; to: number }[];
  index: number;
  toggle?: TogglePos;
  /** Nesting depth for list items. */
  depth: number;
}

const lineStart = (s: EditorState, p: number) => s.doc.lineAt(p).from;
const lineEnd = (s: EditorState, p: number) => s.doc.lineAt(p).to;

const TOP = new Set([
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'SetextHeading1',
  'SetextHeading2',
  'Paragraph',
  'BulletList',
  'OrderedList',
  'Blockquote',
  'FencedCode',
  'CodeBlock',
  'Table',
  'HorizontalRule',
  'HTMLBlock',
  'CommentBlock',
]);

/** The blocks directly inside [from, to]: top-level tree nodes, with each toggle counted as one block. */
export function unitsIn(
  state: EditorState,
  from: number,
  to: number,
  toggles = togglesOf(state),
): Unit[] {
  const spans = toggles.filter(
    (t) =>
      t.openFrom >= from &&
      t.closeTo <= to &&
      !toggles.some(
        (o) =>
          o !== t &&
          o.openFrom >= from &&
          o.closeTo <= to &&
          o.openFrom <= t.openFrom &&
          o.closeTo >= t.closeTo,
      ),
  );
  const units: Unit[] = spans.map((t) => ({ from: t.openFrom, to: t.closeTo, toggle: t }));
  const root = tree(state).topNode;
  for (let n = root.firstChild; n; n = n.nextSibling) {
    if (!TOP.has(n.name)) continue;
    const a = lineStart(state, n.from);
    const b = lineEnd(state, Math.max(n.from, n.to - 1));
    if (a < from || b > to) continue;
    if (spans.some((s) => a >= s.openFrom && a <= s.closeTo)) continue;
    units.push({ from: a, to: b, node: n });
  }
  return units.sort((x, y) => x.from - y.from);
}

function kindOfUnit(state: EditorState, u: Unit): BlockKind {
  if (u.toggle) return u.toggle.level ? (`toggle-h${u.toggle.level}` as BlockKind) : 'toggle';
  const name = u.node?.name ?? '';
  if (/^ATXHeading[1-3]$/.test(name)) return `h${name.slice(-1)}` as BlockKind;
  if (/^(ATXHeading|SetextHeading)/.test(name)) return 'h3';
  if (name === 'FencedCode' || name === 'CodeBlock') return 'code';
  if (name === 'Table') return 'table';
  if (name === 'HorizontalRule') return 'divider';
  if (name === 'Blockquote')
    return parseLine(state.doc.lineAt(u.from).text).kind === 'callout' ? 'callout' : 'quote';
  if (name === 'Paragraph' && state.sliceDoc(u.from, u.from + 2) === '$$') return 'math';
  return 'text';
}

const listItemsOf = (list: SyntaxNode): SyntaxNode[] => {
  const items: SyntaxNode[] = [];
  for (let c = list.firstChild; c; c = c.nextSibling) if (c.name === 'ListItem') items.push(c);
  return items;
};

/** The innermost toggle whose body contains `pos`, and the toggle whose own tag lines contain it. */
function toggleContext(toggles: TogglePos[], pos: number): { body?: TogglePos; own?: TogglePos } {
  let body: TogglePos | undefined;
  let own: TogglePos | undefined;
  for (const t of toggles) {
    if (pos < t.openFrom || pos > t.closeTo) continue;
    const inBody = t.bodyTo >= t.bodyFrom && pos >= t.bodyFrom && pos <= t.bodyTo;
    if (inBody) {
      if (!body || t.depth > body.depth) body = t;
    } else if (!own || t.depth > own.depth) own = t;
  }
  // a toggle's tag lines only matter when no deeper toggle's body contains the position
  if (own && body && body.depth > own.depth) own = undefined;
  return { body, own };
}

export function blockAt(state: EditorState, pos: number): Block | null {
  const toggles = togglesOf(state);
  const ctx = toggleContext(toggles, pos);
  let from = 0;
  let to = state.doc.length;
  if (ctx.body) {
    from = ctx.body.bodyFrom;
    to = ctx.body.bodyTo;
  } else if (ctx.own) {
    const parent = toggles
      .filter(
        (t) => t !== ctx.own && t.openFrom < ctx.own!.openFrom && t.closeTo > ctx.own!.closeTo,
      )
      .sort((a, b) => b.depth - a.depth)[0];
    if (parent) {
      from = parent.bodyFrom;
      to = parent.bodyTo;
    }
  }
  const units = unitsIn(state, from, to, toggles);
  const idx = units.findIndex((u) => pos >= u.from && pos <= u.to);
  if (idx < 0) return null;
  const u = units[idx]!;
  const siblings = units.map((x) => ({ from: x.from, to: x.to }));
  if (u.toggle) {
    return {
      from: u.from,
      to: u.to,
      kind: kindOfUnit(state, u),
      isList: false,
      siblings,
      index: idx,
      toggle: u.toggle,
      depth: 0,
    };
  }
  const node = u.node!;
  if (node.name === 'BulletList' || node.name === 'OrderedList') {
    let list = node;
    let depth = 0;
    for (;;) {
      const items = listItemsOf(list);
      const i = items.findIndex(
        (it) =>
          pos >= lineStart(state, it.from) &&
          pos <= lineEnd(state, it.to - 1 > it.from ? it.to - 1 : it.from),
      );
      if (i < 0) return null;
      const item = items[i]!;
      const first = state.doc.lineAt(item.from);
      const nested =
        pos > first.to
          ? [...Array(1)].flatMap(() => {
              for (let c = item.firstChild; c; c = c.nextSibling)
                if (
                  (c.name === 'BulletList' || c.name === 'OrderedList') &&
                  pos >= lineStart(state, c.from) &&
                  pos <= lineEnd(state, c.to - 1)
                )
                  return [c];
              return [];
            })[0]
          : undefined;
      if (nested) {
        list = nested;
        depth++;
        continue;
      }
      const line = parseLine(first.text);
      const k: BlockKind =
        line.kind === 'todo' || line.kind === 'todo-done'
          ? 'todo'
          : list.name === 'OrderedList'
            ? 'number'
            : 'bullet';
      return {
        from: lineStart(state, item.from),
        to: lineEnd(state, Math.max(item.from, item.to - 1)),
        kind: k,
        isList: true,
        siblings: items.map((x) => ({
          from: lineStart(state, x.from),
          to: lineEnd(state, Math.max(x.from, x.to - 1)),
        })),
        index: i,
        depth,
      };
    }
  }
  return {
    from: u.from,
    to: u.to,
    kind: kindOfUnit(state, u),
    isList: false,
    siblings,
    index: idx,
    depth: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// edits (each returns a change spec plus where the caret goes, or null when it does not apply)

export interface Edit {
  changes: ChangeSpec;
  /** Selection after the change, in the new document. */
  select: { anchor: number; head?: number };
}

const text = (s: EditorState, a: number, b: number) => s.sliceDoc(a, b);

export function moveBlock(state: EditorState, b: Block, dir: -1 | 1): Edit | null {
  const other = b.siblings[b.index + dir];
  if (!other) return null;
  const [first, second] = dir < 0 ? [other, b] : [b, other];
  const sep = text(state, first.to, second.from);
  const a = text(state, first.from, first.to);
  const c = text(state, second.from, second.to);
  const insert = c + sep + a;
  // where the moved block starts in the new text
  const start = dir < 0 ? first.from : first.from + c.length + sep.length;
  return { changes: { from: first.from, to: second.to, insert }, select: { anchor: start } };
}

export function duplicateBlock(state: EditorState, b: Block): Edit {
  const copy = text(state, b.from, b.to);
  const sep = b.isList ? '\n' : '\n\n';
  return { changes: { from: b.to, insert: sep + copy }, select: { anchor: b.to + sep.length } };
}

export function deleteBlock(state: EditorState, b: Block): Edit {
  let from = b.from;
  let to = b.to;
  const d = state.doc;
  if (to < d.length) {
    to += 1; // the newline that ends the block
    if (to < d.length && d.sliceString(to, to + 1) === '\n') to += 1; // and one blank separator line
  } else if (from > 0) {
    from -= 1; // last block: take the newline before it
    if (from > 0 && d.sliceString(from - 1, from) === '\n') from -= 1;
  }
  return { changes: { from, to }, select: { anchor: Math.min(from, d.length - (to - from)) } };
}

/** Strip block syntax from every line of a block, leaving plain text lines. */
function plainLines(s: EditorState, b: Block): string[] {
  const out: string[] = [];
  for (let n = s.doc.lineAt(b.from).number; n <= s.doc.lineAt(b.to).number; n++) {
    const l = s.doc.line(n).text;
    if (/^\s*(`{3,}|~{3,})/.test(l)) continue;
    out.push(parseLine(l).body);
  }
  return out;
}

export function turnBlockInto(state: EditorState, b: Block, kind: BlockKind): Edit | null {
  if (kind === b.kind) return null;
  if (kind === 'divider' || kind === 'table') return null;
  const first = state.doc.lineAt(b.from);
  const firstText = parseLine(first.text);

  // from a toggle
  if (b.toggle) {
    const t = b.toggle;
    if (kind === 'toggle' || kind === 'toggle-h1' || kind === 'toggle-h2' || kind === 'toggle-h3') {
      const level = kind === 'toggle' ? 0 : (Number(kind.slice(-1)) as 1 | 2 | 3);
      const summary = level
        ? `<summary><h${level}>${t.title}</h${level}></summary>`
        : `<summary>${t.title}</summary>`;
      return {
        changes: { from: t.summaryFrom, to: t.summaryTo, insert: summary },
        select: { anchor: t.summaryFrom + summary.indexOf(t.title) },
      };
    }
    // dissolve the toggle: its title becomes a block of the new kind, its body is kept
    const body =
      t.bodyTo >= t.bodyFrom
        ? text(state, t.bodyFrom, t.bodyTo).replace(/^\n+/, '').replace(/\n+$/, '')
        : '';
    const head = isLineKind(kind) ? turnLine(t.title, kind) : t.title;
    const insert = head + (body ? '\n\n' + body : '');
    return {
      changes: { from: t.openFrom, to: t.closeTo, insert },
      select: { anchor: t.openFrom + insert.length },
    };
  }

  // from a code block: its contents become the text
  if (b.kind === 'code') {
    const lines = plainLines(state, b);
    const body = lines.join('\n');
    const insert =
      kind === 'text'
        ? body
        : isLineKind(kind)
          ? lines.map((l, i) => (i === 0 ? turnLine(l, kind) : l)).join('\n')
          : blockInsert(kind, body).text.trimEnd();
    return {
      changes: { from: b.from, to: b.to, insert },
      select: { anchor: b.from + insert.length },
    };
  }

  const lines = plainLines(state, b);
  const head = firstText.body;

  if (isLineKind(kind)) {
    if (b.isList) {
      const n = kind === 'number' ? 1 : 1;
      const line = turnLine(first.text, kind, n);
      return {
        changes: { from: first.from, to: first.to, insert: line },
        select: { anchor: first.from + line.length },
      };
    }
    if (b.kind === 'quote' || b.kind === 'callout') {
      const insert = lines.map((l, i) => (i === 0 ? turnLine(l, kind) : l)).join('\n');
      return {
        changes: { from: b.from, to: b.to, insert },
        select: { anchor: b.from + insert.length },
      };
    }
    const line = turnLine(first.text, kind);
    return {
      changes: { from: first.from, to: first.to, insert: line },
      select: { anchor: first.from + line.length },
    };
  }

  if (kind === 'code') {
    const insert = wrapCode(lines.join('\n'));
    return {
      changes: { from: b.from, to: b.to, insert },
      select: { anchor: b.from + insert.length },
    };
  }
  if (kind === 'math') {
    const insert = `$$\n${lines.join('\n')}\n$$`;
    return { changes: { from: b.from, to: b.to, insert }, select: { anchor: b.from + 3 } };
  }
  if (kind === 'toggle' || kind === 'toggle-h1' || kind === 'toggle-h2' || kind === 'toggle-h3') {
    const level = kind === 'toggle' ? 0 : (Number(kind.slice(-1)) as 1 | 2 | 3);
    const rest = b.isList ? text(state, first.to + 1, b.to) : lines.slice(1).join('\n');
    const insert = wrapToggle(b.isList && first.to < b.to ? rest : rest, level, head || 'Toggle');
    return {
      changes: { from: b.from, to: b.to, insert },
      select: { anchor: b.from + insert.indexOf(head || 'Toggle') },
    };
  }
  return null;
}

/**
 * What choosing a block from the "/" menu does to the line it was typed on. `slashFrom..cursor` is the "/word" that
 * is removed first; whatever else is on the line is kept (and becomes the block's text).
 */
export function slashEdit(
  state: EditorState,
  slashFrom: number,
  cursor: number,
  kind: BlockKind,
): Edit {
  const line = state.doc.lineAt(slashFrom);
  const before = state.sliceDoc(line.from, slashFrom);
  const after = state.sliceDoc(cursor, line.to);
  const rest = (before + after).replace(/\s+$/, '');
  const empty = rest.trim() === '';
  if (kind === 'divider' || kind === 'table') {
    const ins = blockInsert(kind);
    if (empty)
      return {
        changes: { from: line.from, to: line.to, insert: ins.text },
        select: { anchor: line.from + ins.select[0], head: line.from + ins.select[1] },
      };
    const text2 = '\n\n' + ins.text;
    return {
      changes: { from: line.from, to: line.to, insert: rest + text2 },
      select: {
        anchor: line.from + rest.length + 2 + ins.select[0],
        head: line.from + rest.length + 2 + ins.select[1],
      },
    };
  }
  const ins = blockInsert(kind, isLineKind(kind) ? parseLine(rest).body : rest);
  const base = isLineKind(kind) && !empty ? turnLine(rest, kind) : null;
  if (base !== null)
    return {
      changes: { from: line.from, to: line.to, insert: base },
      select: { anchor: line.from + base.length },
    };
  const insert = ins.text.replace(/\n$/, '');
  return {
    changes: { from: line.from, to: line.to, insert },
    select: { anchor: line.from + ins.select[0], head: line.from + ins.select[1] },
  };
}

/** Numbers of an ordered list, rewritten 1, 2, 3… after items moved. */
export function renumberOrdered(state: EditorState, pos: number): ChangeSpec[] {
  const out: ChangeSpec[] = [];
  const t = tree(state);
  let n: SyntaxNode | null = t.resolveInner(Math.min(pos, state.doc.length), 1);
  while (n && n.name !== 'OrderedList') n = n.parent;
  if (!n) return out;
  const items = listItemsOf(n);
  // the list starts at its smallest number (the first item may just have been moved there)
  const nums = items
    .map((it) => Number(/^\s*(\d+)/.exec(state.doc.lineAt(it.from).text)?.[1] ?? NaN))
    .filter((x) => !Number.isNaN(x));
  const start = nums.length ? Math.min(...nums) : 1;
  items.forEach((it, i) => {
    const mark = it.getChild('ListMark');
    if (!mark) return;
    const cur = state.sliceDoc(mark.from, mark.to);
    const want = `${start + i}${cur.replace(/^\d+/, '')}`;
    if (cur !== want) out.push({ from: mark.from, to: mark.to, insert: want });
  });
  return out;
}

/** Move a block so it sits at `toIndex` among its siblings (0 = first, siblings.length = last). Spacing between siblings is kept. */
export function reorderBlock(state: EditorState, b: Block, toIndex: number): Edit | null {
  const sibs = b.siblings;
  const n = sibs.length;
  const dest = Math.min(Math.max(0, toIndex), n);
  // inserting before `dest` once the block itself is lifted out
  const target = dest > b.index ? dest - 1 : dest;
  if (target === b.index) return null;
  const texts = sibs.map((s) => state.sliceDoc(s.from, s.to));
  const seps = sibs.slice(1).map((s, i) => state.sliceDoc(sibs[i]!.to, s.from));
  const moved = texts.splice(b.index, 1)[0]!;
  texts.splice(target, 0, moved);
  let insert = texts[0]!;
  for (let i = 1; i < texts.length; i++) insert += seps[i - 1]! + texts[i]!;
  let start = 0;
  for (let i = 0; i < target; i++) start += texts[i]!.length + seps[i]!.length;
  const first = sibs[0]!.from;
  return {
    changes: { from: first, to: sibs[n - 1]!.to, insert },
    select: { anchor: first + start },
  };
}
