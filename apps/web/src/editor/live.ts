import { syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  EditorState,
  Facet,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type Range,
  type Text,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { parseLine } from './blocks.js';
import { togglesOf, togglesOfDoc, tree, type TogglePos } from './model.js';
import {
  BulletWidget,
  CheckboxWidget,
  ChevronWidget,
  FenceWidget,
  FileWidget,
  HiddenWidget,
  HrWidget,
  ImageWidget,
  MathBlockWidget,
  MathWidget,
  NumberWidget,
  TableWidget,
  WikiWidget,
  type LiveCallbacks,
} from './widgets.js';

/** Callbacks supplied by the page (open a linked note or attachment). */
export const liveCallbacks = Facet.define<LiveCallbacks, LiveCallbacks>({
  combine: (v) =>
    v[0] ?? {
      openWiki: () => undefined,
      openAttachment: () => undefined,
      openLanguageMenu: () => undefined,
    },
});

/** Turn the live view off (source mode shows the plain Markdown). */
export const liveEnabled = Facet.define<boolean, boolean>({ combine: (v) => v[0] ?? true });

// ---------------------------------------------------------------------------------------------
// toggle fold state (view-only: opening and closing a toggle never edits the note)

const foldEffect = StateEffect.define<{ from: number; collapsed: boolean }>();

/** Per-toggle overrides keyed by the start of its `<details>` line. Anything not listed uses the `open` attribute. */
export const foldField = StateField.define<Map<number, boolean>>({
  create: () => new Map(),
  update(value, tr) {
    let map = value;
    if (tr.docChanged) {
      const valid = new Set(togglesOfDoc(tr.newDoc).map((t) => t.openFrom));
      const next = new Map<number, boolean>();
      for (const [k, v] of value) {
        const nk = tr.changes.mapPos(k, 1);
        if (valid.has(nk)) next.set(nk, v);
      }
      map = next;
    }
    for (const e of tr.effects)
      if (e.is(foldEffect)) {
        map = new Map(map);
        map.set(e.value.from, e.value.collapsed);
      }
    // a caret inside a folded toggle opens it (search, outline jumps, arrow keys…)
    if (tr.selection || tr.docChanged) {
      const toggles = togglesOfDoc(tr.newDoc);
      for (const t of toggles) {
        if (!isCollapsedIn(map, t)) continue;
        if (tr.newSelection.ranges.some((r) => r.head >= t.bodyFrom && r.head <= t.closeTo)) {
          if (map === value) map = new Map(map);
          map.set(t.openFrom, false);
        }
      }
    }
    return map;
  },
});

const isCollapsedIn = (map: Map<number, boolean>, t: TogglePos) => map.get(t.openFrom) ?? !t.isOpen;
export const isCollapsed = (state: EditorState, t: TogglePos) =>
  isCollapsedIn(state.field(foldField), t);
export const setFold = (from: number, collapsed: boolean) => foldEffect.of({ from, collapsed });

// ---------------------------------------------------------------------------------------------
// math blocks ($$ … $$ on their own lines)

export interface MathBlock {
  from: number;
  to: number;
  src: string;
}
const mathCache = new WeakMap<Text, MathBlock[]>();

export function mathBlocksOf(state: EditorState): MathBlock[] {
  const doc = state.doc;
  const hit = mathCache.get(doc);
  if (hit) return hit;
  const code: [number, number][] = [];
  tree(state).iterate({
    enter: (n) => {
      if (n.name === 'FencedCode' || n.name === 'CodeBlock') {
        code.push([n.from, n.to]);
        return false;
      }
      return undefined;
    },
  });
  const inCode = (p: number) => code.some(([a, b]) => p >= a && p <= b);
  const out: MathBlock[] = [];
  for (let i = 1; i <= doc.lines; i++) {
    const l = doc.line(i);
    if (inCode(l.from)) continue;
    const t = l.text.trim();
    const one = /^\$\$(.+)\$\$$/.exec(t);
    if (one && l.text.startsWith('$$')) {
      out.push({ from: l.from, to: l.to, src: one[1]!.trim() });
    } else if (t === '$$') {
      for (let j = i + 1; j <= doc.lines; j++) {
        if (doc.line(j).text.trim() === '$$') {
          out.push({
            from: l.from,
            to: doc.line(j).to,
            src: doc.sliceString(l.to + 1, doc.line(j).from - 1),
          });
          i = j;
          break;
        }
        if (inCode(doc.line(j).from)) break;
      }
    }
  }
  mathCache.set(doc, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// helpers

type Item = Range<Decoration>;
const hide = Decoration.replace({});
const line = (cls: string, style?: string) =>
  Decoration.line({ attributes: style ? { class: cls, style } : { class: cls } });
const mark = (cls: string) => Decoration.mark({ class: cls });

const touches = (sel: EditorSelection, from: number, to: number) =>
  sel.ranges.some((r) => r.from <= to && r.to >= from);

const columns = (ws: string) => [...ws].reduce((n, c) => n + (c === '\t' ? 4 : 1), 0);

const WIKI = /\[\[([^[\]|#\n]+?)(?:#([^[\]|\n]+?))?(?:\|([^[\]\n]+?))?\]\]/g;
const MATH = /(?<![\\$])\$(?![\s$])([^$\n]*?[^\s$\\])\$(?![\d$])/g;
const CLOZE = /\{\{c\d+::(.+?)\}\}/g;

export interface Built {
  all: Item[];
  /** Replacements that hide or stand in for text: the cursor must not land inside them. */
  atomic: Item[];
}

/** Decorations for the given document ranges. Pure: takes a state, not a view, so it can be tested. */
export function buildInline(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  cb: LiveCallbacks,
): Built {
  const all: Item[] = [];
  const atomic: Item[] = [];
  const sel = state.selection;
  const doc = state.doc;
  const toggles = togglesOf(state);
  const maths = mathBlocksOf(state);
  const codeRanges: [number, number][] = [];
  const done = new Set<number>(); // line starts that already got their line-level treatment

  const add = (d: Decoration, from: number, to: number = from) => all.push(d.range(from, to));
  const rep = (d: Decoration, from: number, to: number) => {
    if (to <= from) return;
    all.push(d.range(from, to));
    atomic.push(d.range(from, to));
  };
  const lineActive = (pos: number) => {
    const l = doc.lineAt(pos);
    return touches(sel, l.from, l.to);
  };
  const lineNo = (pos: number) => doc.lineAt(pos).number;
  const inView = (pos: number) => ranges.some((r) => pos >= r.from && pos <= r.to);

  /** Hide a marker plus one following space, unless the caret is on its line. */
  const hideMarker = (from: number, to: number) => {
    if (lineActive(from)) add(mark('cm-lp-syntax'), from, to);
    else rep(hide, from, to + (doc.sliceString(to, to + 1) === ' ' ? 1 : 0));
  };

  const tr = tree(state);
  for (const r of ranges) {
    tr.iterate({
      from: r.from,
      to: r.to,
      enter: (node) => {
        const n = node.node;
        const name = node.name;
        const m = /^ATXHeading([1-6])$/.exec(name);
        if (m) {
          const l = doc.lineAt(node.from);
          add(line(`cm-lp-h cm-lp-h${m[1]}`), l.from);
          const hm = n.getChild('HeaderMark');
          if (hm) hideMarker(hm.from, hm.to);
          return;
        }
        switch (name) {
          case 'Blockquote': {
            const first = doc.lineAt(node.from);
            const callout = parseLine(first.text).kind === 'callout';
            for (let i = lineNo(node.from); i <= lineNo(Math.max(node.from, node.to - 1)); i++) {
              const l = doc.line(i);
              if (inView(l.from))
                add(line(callout ? 'cm-lp-quote cm-lp-callout' : 'cm-lp-quote'), l.from);
            }
            for (let c = n.firstChild; c; c = c.nextSibling) collectQuoteMarks(c);
            return;
          }
          case 'ListItem': {
            const first = doc.lineAt(node.from);
            const lm = n.getChild('ListMark');
            if (!lm) return;
            const task = n.getChild('Task');
            const tm = task?.getChild('TaskMarker');
            const indent = columns(doc.sliceString(first.from, lm.from));
            const own = ownLines(state, n);
            const done_ = tm ? /\[[xX]\]/.test(doc.sliceString(tm.from, tm.to)) : false;
            const ordered = n.parent?.name === 'OrderedList';
            const active = lineActive(first.from);
            const pad = `${indent * 0.5 + 1.5}em`;
            for (const num of own) {
              const l = doc.line(num);
              if (!inView(l.from) || done.has(l.from)) continue;
              done.add(l.from);
              const isFirst = num === first.number;
              const cls = `${isFirst ? 'cm-lp-li' : 'cm-lp-li-cont'}${done_ ? ' cm-lp-done' : ''}${touches(sel, l.from, l.to) ? ' cm-lp-li-active' : ''}`;
              if (touches(sel, l.from, l.to)) add(line(cls), l.from);
              else {
                add(line(cls, `--lp-list: ${pad};`), l.from);
                const ws = /^[ \t]*/.exec(l.text)![0].length;
                if (!isFirst && ws) rep(hide, l.from, l.from + ws);
              }
            }
            if (!inView(first.from)) return;
            if (active) {
              add(mark('cm-lp-syntax'), lm.from, tm ? tm.to : lm.to);
              return;
            }
            if (first.from < lm.from) rep(hide, first.from, lm.from);
            const end =
              (tm ? tm.to : lm.to) +
              (doc.sliceString(tm ? tm.to : lm.to, (tm ? tm.to : lm.to) + 1) === ' ' ? 1 : 0);
            const widget = tm
              ? new CheckboxWidget(done_, tm.from)
              : ordered
                ? new NumberWidget(doc.sliceString(lm.from, lm.to))
                : new BulletWidget(Math.min(2, Math.floor(indent / 2) % 3));
            rep(Decoration.replace({ widget }), lm.from, end);
            return;
          }
          case 'FencedCode': {
            const marks = n.getChildren('CodeMark');
            const info = n.getChild('CodeInfo');
            const openLine = doc.lineAt(marks[0]?.from ?? node.from);
            const closeLine = marks.length > 1 ? doc.lineAt(marks[1]!.from) : null;
            const active = touches(sel, node.from, node.to);
            const codeFrom = Math.min(openLine.to + 1, doc.length);
            const codeTo = closeLine ? Math.max(codeFrom, closeLine.from - 1) : node.to;
            for (let i = openLine.number; i <= lineNo(Math.max(node.from, node.to - 1)); i++) {
              const l = doc.line(i);
              if (!inView(l.from)) continue;
              let cls = 'cm-lp-code-line';
              if (i === openLine.number)
                cls += active ? ' cm-lp-fence-raw cm-lp-code-open' : ' cm-lp-fence cm-lp-code-open';
              else if (closeLine && i === closeLine.number)
                cls += active
                  ? ' cm-lp-fence-raw cm-lp-code-close'
                  : ' cm-lp-fence-end cm-lp-code-close';
              add(line(cls), l.from);
            }
            if (!active && inView(openLine.from))
              add(
                Decoration.widget({
                  widget: new FenceWidget(
                    info ? doc.sliceString(info.from, info.to).trim() : '',
                    codeFrom,
                    codeTo,
                  ),
                  side: -1,
                }),
                openLine.from,
              );
            codeRanges.push([node.from, node.to]);
            return false;
          }
          case 'CodeBlock':
            codeRanges.push([node.from, node.to]);
            return false;
          case 'HorizontalRule': {
            if (lineActive(node.from)) add(mark('cm-lp-syntax'), node.from, node.to);
            else rep(Decoration.replace({ widget: new HrWidget() }), node.from, node.to);
            return false;
          }
          case 'Table': {
            if (touches(sel, node.from, node.to))
              for (let i = lineNo(node.from); i <= lineNo(node.to); i++)
                add(line('cm-lp-table-raw'), doc.line(i).from);
            return false;
          }
          case 'InlineCode': {
            const marks = n.getChildren('CodeMark');
            codeRanges.push([node.from, node.to]);
            if (marks.length === 2) {
              add(mark('cm-lp-icode'), marks[0]!.to, marks[1]!.from);
              if (touches(sel, node.from, node.to)) {
                add(mark('cm-lp-syntax'), marks[0]!.from, marks[0]!.to);
                add(mark('cm-lp-syntax'), marks[1]!.from, marks[1]!.to);
              } else {
                rep(hide, marks[0]!.from, marks[0]!.to);
                rep(hide, marks[1]!.from, marks[1]!.to);
              }
            }
            return false;
          }
          case 'StrongEmphasis':
          case 'Emphasis':
          case 'Strikethrough': {
            const cls =
              name === 'Strikethrough'
                ? 'cm-lp-strike'
                : name === 'Emphasis'
                  ? 'cm-lp-em'
                  : 'cm-lp-strong';
            const marks = n.getChildren(
              name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark',
            );
            if (marks.length >= 2) {
              add(mark(cls), marks[0]!.to, marks.at(-1)!.from);
              const touched = touches(sel, node.from, node.to);
              for (const mk of [marks[0]!, marks.at(-1)!])
                if (touched) add(mark('cm-lp-syntax'), mk.from, mk.to);
                else rep(hide, mk.from, mk.to);
            }
            return;
          }
          case 'Image': {
            const url = n.getChild('URL');
            if (!url) return false;
            const href = doc.sliceString(url.from, url.to);
            const marks = n.getChildren('LinkMark');
            const alt = marks.length >= 2 ? doc.sliceString(marks[0]!.to, marks[1]!.from) : '';
            if (touches(sel, node.from, node.to)) add(mark('cm-lp-syntax'), node.from, node.to);
            else
              rep(Decoration.replace({ widget: new ImageWidget(href, alt) }), node.from, node.to);
            return false;
          }
          case 'Link': {
            const before = node.from > 0 ? doc.sliceString(node.from - 1, node.from) : '';
            const after = doc.sliceString(node.to, node.to + 1);
            if (before === '[' && after === ']') return false; // part of a [[wiki link]], handled below
            const url = n.getChild('URL');
            const marks = n.getChildren('LinkMark');
            if (!url || marks.length < 4) return;
            const href = doc.sliceString(url.from, url.to);
            const label = doc.sliceString(marks[0]!.to, marks[1]!.from);
            const touched = touches(sel, node.from, node.to);
            if (href.startsWith('attachment://') && !touched) {
              rep(
                Decoration.replace({ widget: new FileWidget(href, label, cb.openAttachment) }),
                node.from,
                node.to,
              );
              return false;
            }
            add(
              Decoration.mark({ class: 'cm-lp-link', attributes: { 'data-href': href } }),
              marks[0]!.to,
              marks[1]!.from,
            );
            if (touched) {
              add(mark('cm-lp-syntax'), marks[0]!.from, marks[0]!.to);
              add(mark('cm-lp-syntax'), marks[1]!.from, node.to);
            } else {
              rep(hide, marks[0]!.from, marks[0]!.to);
              rep(hide, marks[1]!.from, node.to);
            }
            return;
          }
          default:
            return;
        }
      },
    });
  }

  function collectQuoteMarks(c: import('@lezer/common').SyntaxNode) {
    if (c.name === 'QuoteMark') {
      if (inView(c.from)) hideMarker(c.from, c.to);
      return;
    }
    if (c.name === 'Blockquote') return; // its own visit handles it
    for (let x = c.firstChild; x; x = x.nextSibling) collectQuoteMarks(x);
  }

  // ---- per-line work: wiki links, inline math, clozes, toggles, blank lines ----
  const inCode = (p: number) => codeRanges.some(([a, b]) => p >= a && p <= b);
  const inMath = (p: number) => maths.find((b) => p >= b.from && p <= b.to);
  const seen = new Set<number>();
  for (const r of ranges) {
    for (let i = doc.lineAt(r.from).number; i <= doc.lineAt(r.to).number; i++) {
      const l = doc.line(i);
      if (seen.has(l.from)) continue;
      seen.add(l.from);
      const mb = inMath(l.from);
      const fenced = inCode(l.from);
      // nesting inside toggles
      const depth = toggles.filter(
        (t) => t.bodyTo >= t.bodyFrom && l.from >= t.bodyFrom && l.to <= t.bodyTo,
      ).length;
      if (depth) add(line('cm-lp-intoggle', `--lp-toggle: ${depth * 1.5}em;`), l.from);
      const sum = toggles.find((t) => t.summaryFrom === l.from);
      if (sum) {
        const collapsed = isCollapsed(state, sum);
        add(line(`cm-lp-toggle${sum.level ? ` cm-lp-h cm-lp-h${sum.level}` : ''}`), l.from);
        rep(
          Decoration.replace({ widget: new ChevronWidget(collapsed, sum.openFrom, sum.level) }),
          sum.summaryFrom,
          sum.titleFrom,
        );
        rep(hide, sum.titleTo, sum.summaryTo);
        continue;
      }
      if (mb) {
        if (touches(sel, mb.from, mb.to)) add(line('cm-lp-math-raw'), l.from);
        continue;
      }
      if (l.text.trim() === '' && !fenced) {
        add(line('cm-lp-blank'), l.from);
        continue;
      }
      if (fenced) continue;
      if (l.text.indexOf('[[') >= 0)
        for (const w of l.text.matchAll(WIKI)) {
          const from = l.from + w.index!;
          const to = from + w[0].length;
          if (inCode(from)) continue;
          if (touches(sel, from, to)) add(mark('cm-lp-wiki-raw'), from, to);
          else
            rep(
              Decoration.replace({
                widget: new WikiWidget(
                  w[1]!.trim(),
                  w[2]?.trim(),
                  (w[3] ?? w[1]!).trim(),
                  cb.openWiki,
                ),
              }),
              from,
              to,
            );
        }
      if (l.text.indexOf('$') >= 0)
        for (const w of l.text.matchAll(MATH)) {
          const from = l.from + w.index!;
          const to = from + w[0].length;
          if (inCode(from)) continue;
          if (touches(sel, from, to)) add(mark('cm-lp-math-src'), from, to);
          else rep(Decoration.replace({ widget: new MathWidget(w[1]!, false) }), from, to);
        }
      if (l.text.indexOf('{{c') >= 0)
        for (const w of l.text.matchAll(CLOZE)) {
          const from = l.from + w.index!;
          const to = from + w[0].length;
          if (inCode(from)) continue;
          const open = from + w[0].indexOf('::') + 2;
          add(mark('cm-lp-cloze'), open, to - 2);
          if (touches(sel, from, to)) {
            add(mark('cm-lp-syntax'), from, open);
            add(mark('cm-lp-syntax'), to - 2, to);
          } else {
            rep(hide, from, open);
            rep(hide, to - 2, to);
          }
        }
    }
  }
  return { all, atomic };
}

/** The lines of a list item that belong to it directly (not to a nested list). */
function ownLines(state: EditorState, item: import('@lezer/common').SyntaxNode): number[] {
  const d = state.doc;
  const a = d.lineAt(item.from).number;
  const b = d.lineAt(Math.max(item.from, item.to - 1)).number;
  const skip: [number, number][] = [];
  for (let c = item.firstChild; c; c = c.nextSibling)
    if (c.name === 'BulletList' || c.name === 'OrderedList')
      skip.push([d.lineAt(c.from).number, d.lineAt(Math.max(c.from, c.to - 1)).number]);
  const out: number[] = [];
  for (let i = a; i <= b; i++) if (!skip.some(([x, y]) => i >= x && i <= y)) out.push(i);
  return out;
}

// ---------------------------------------------------------------------------------------------
// block-level replacements (document-wide: tables, display math, toggle tags, folded toggle bodies)

function cells(text: string): string[] {
  let t = text.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (t[i] === '|') {
      out.push(cur);
      cur = '';
    } else cur += t[i];
  }
  out.push(cur);
  return out;
}

export function buildBlocks(state: EditorState): Item[] {
  const items: Item[] = [];
  const sel = state.selection;
  const doc = state.doc;
  const toggles = togglesOf(state);
  const folds = state.field(foldField);
  const hidden = Decoration.replace({ widget: new HiddenWidget(), block: true });
  const collapsedRanges: [number, number][] = [];
  const insideCollapsed = (a: number, b: number) =>
    collapsedRanges.some(([x, y]) => a >= x && b <= y);
  // outer toggles first so anything inside a folded one is skipped
  for (const t of [...toggles].sort((x, y) => x.openFrom - y.openFrom)) {
    if (insideCollapsed(t.openFrom, t.closeTo)) continue;
    const collapsed = isCollapsedIn(folds, t);
    const bodyStart = t.bodyTo >= t.bodyFrom ? t.bodyFrom : t.closeFrom;
    if (!touches(sel, t.openFrom, t.openTo)) items.push(hidden.range(t.openFrom, t.openTo));
    if (collapsed) {
      items.push(hidden.range(bodyStart, t.closeTo));
      collapsedRanges.push([bodyStart, t.closeTo]);
    } else if (!touches(sel, t.closeFrom, t.closeTo))
      items.push(hidden.range(t.closeFrom, t.closeTo));
  }
  const maths = mathBlocksOf(state);
  for (const b of maths) {
    if (insideCollapsed(b.from, b.to) || touches(sel, b.from, b.to)) continue;
    items.push(
      Decoration.replace({ widget: new MathBlockWidget(b.src), block: true }).range(b.from, b.to),
    );
  }
  tree(state).iterate({
    enter: (n) => {
      if (n.name !== 'Table') return n.name === 'Document' ? undefined : false;
      const parentName = n.node.parent?.name;
      const first = doc.lineAt(n.from);
      if (parentName !== 'Document' || first.from !== n.from) return false;
      if (insideCollapsed(n.from, n.to) || touches(sel, n.from, doc.lineAt(n.to).to)) return false;
      const rows: string[][] = [];
      let aligns: ('left' | 'center' | 'right' | '')[] = [];
      const lines: string[] = [];
      for (let i = first.number; i <= doc.lineAt(n.to).number; i++) lines.push(doc.line(i).text);
      lines.forEach((tx, i) => {
        if (i === 1) {
          aligns = cells(tx).map((c) => {
            const t = c.trim();
            return t.startsWith(':') && t.endsWith(':')
              ? 'center'
              : t.endsWith(':')
                ? 'right'
                : t.startsWith(':')
                  ? 'left'
                  : '';
          });
        } else rows.push(cells(tx));
      });
      items.push(
        Decoration.replace({
          widget: new TableWidget(rows, aligns, lines.join('\n')),
          block: true,
        }).range(first.from, doc.lineAt(n.to).to),
      );
      return false;
    },
  });
  return items;
}

const blockField = StateField.define<DecorationSet>({
  create: (state) =>
    state.facet(liveEnabled) ? Decoration.set(buildBlocks(state), true) : Decoration.none,
  update(value, tr) {
    if (!tr.state.facet(liveEnabled)) return Decoration.none;
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(foldEffect)) ||
      tr.reconfigured
    )
      return Decoration.set(buildBlocks(tr.state), true);
    return value;
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of((v) => v.state.field(f)),
  ],
});

// ---------------------------------------------------------------------------------------------
// the viewport plugin

class InlinePlugin {
  decorations: DecorationSet = Decoration.none;
  atomic: DecorationSet = Decoration.none;
  private onToggle: (e: Event) => void;
  private onLang: (e: Event) => void;
  constructor(readonly view: EditorView) {
    this.build(view);
    this.onToggle = (e) => {
      const d = (e as CustomEvent<{ from: number; collapsed: boolean }>).detail;
      view.dispatch({ effects: setFold(d.from, d.collapsed) });
    };
    view.dom.addEventListener('lp-toggle', this.onToggle);
    this.onLang = (e) => {
      const d = (e as CustomEvent<{ x: number; y: number; codeFrom: number }>).detail;
      view.state.facet(liveCallbacks).openLanguageMenu({ x: d.x, y: d.y }, d.codeFrom);
    };
    view.dom.addEventListener('lp-fence-lang', this.onLang);
  }
  update(u: ViewUpdate) {
    if (
      u.docChanged ||
      u.viewportChanged ||
      u.selectionSet ||
      u.focusChanged ||
      u.startState.facet(liveEnabled) !== u.state.facet(liveEnabled) ||
      u.transactions.some((t) => t.effects.some((e) => e.is(foldEffect))) ||
      syntaxTree(u.startState) !== syntaxTree(u.state)
    )
      this.build(u.view);
  }
  destroy() {
    this.view.dom.removeEventListener('lp-toggle', this.onToggle);
    this.view.dom.removeEventListener('lp-fence-lang', this.onLang);
  }
  build(view: EditorView) {
    if (!view.state.facet(liveEnabled)) {
      this.decorations = this.atomic = Decoration.none;
      return;
    }
    const b = buildInline(view.state, view.visibleRanges, view.state.facet(liveCallbacks));
    this.decorations = Decoration.set(b.all, true);
    this.atomic = Decoration.set(b.atomic, true);
  }
}

const inlinePlugin = ViewPlugin.fromClass(InlinePlugin, {
  decorations: (p) => p.decorations,
  provide: (p) => EditorView.atomicRanges.of((v) => v.plugin(p)?.atomic ?? Decoration.none),
});

/** Keep the caret out of the hidden tag parts of a toggle's title line. */
const keepInTitle = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || !tr.startState.facet(liveEnabled)) return tr;
  const toggles = togglesOfDoc(tr.newDoc);
  if (!toggles.length) return tr;
  let changed = false;
  const fix = (p: number) => {
    for (const t of toggles) {
      if (p >= t.summaryFrom && p < t.titleFrom) return t.titleFrom;
      if (p > t.titleTo && p <= t.summaryTo) return t.titleTo;
    }
    return p;
  };
  const ranges = tr.newSelection.ranges.map((r) => {
    const a = fix(r.anchor);
    const h = fix(r.head);
    if (a !== r.anchor || h !== r.head) changed = true;
    return EditorSelection.range(a, h);
  });
  if (!changed) return tr;
  return {
    changes: tr.changes,
    selection: EditorSelection.create(ranges, tr.newSelection.mainIndex),
    effects: tr.effects,
    annotations: [
      ...(tr.annotation(Transaction.userEvent)
        ? [Transaction.userEvent.of(tr.annotation(Transaction.userEvent)!)]
        : []),
      Transaction.addToHistory.of(tr.annotation(Transaction.addToHistory) !== false),
    ],
    scrollIntoView: tr.scrollIntoView,
    filter: false,
  };
});

/** Clicking a widget that stands in for source (math, table, image, rule) puts the caret in that source. */
const clickToEdit = EditorView.domEventHandlers({
  mousedown(e, view) {
    const t = e.target as HTMLElement | null;
    const w = t?.closest<HTMLElement>('[data-lp-edit]');
    if (!w || !view.dom.contains(w)) return false;
    let pos = view.posAtDOM(w);
    const rowEl = t!.closest<HTMLElement>('[data-lp-row]');
    if (rowEl) {
      const r = Number(rowEl.dataset.lpRow);
      const start = view.state.doc.lineAt(pos).number;
      const l = view.state.doc.line(Math.min(view.state.doc.lines, start + (r === 0 ? 0 : r + 1)));
      pos = Math.min(l.to, l.from + 2);
    } else if (w.classList.contains('cm-lp-math') || w.classList.contains('cm-lp-math-block'))
      pos += w.classList.contains('cm-lp-math-block') ? 3 : 1;
    e.preventDefault();
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
    return true;
  },
  click(e) {
    // Ctrl/⌘-click opens a normal link
    const t = (e.target as HTMLElement | null)?.closest<HTMLElement>('.cm-lp-link');
    const href = t?.dataset.href;
    if (href && (e.metaKey || e.ctrlKey) && /^https?:|^mailto:/i.test(href)) {
      window.open(href, '_blank', 'noopener');
      return true;
    }
    return false;
  },
});

export const livePreview = (): Extension => [
  foldField,
  blockField,
  inlinePlugin,
  keepInTitle,
  clickToEdit,
];
