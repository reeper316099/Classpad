/**
 * Draws the Go core's block tree into one contenteditable element and maps between DOM points and model
 * positions (block path + UTF-16 offset). The DOM is always rebuilt from the model; the browser never keeps
 * edits of its own except during IME composition, which is synced back when it ends.
 */
import katex from 'katex';
import { attachmentBlobUrl, parseAttachmentLink } from '../lib/attachments.js';
import type { BlockData, Path, Position, TextOp, TreeNode, View } from './core.js';

export const EMBED = '￼';
const TEXT_TYPES = new Set([
  'paragraph',
  'heading',
  'todo_list',
  'bulleted_list',
  'numbered_list',
  'quote',
  'callout',
  'code',
  'toggle_list',
]);
export const hasText = (t: string) => TEXT_TYPES.has(t);

const PLACEHOLDER: Record<string, string> = {
  paragraph: "Type '/' for commands",
  heading: 'Heading',
  todo_list: 'To-do',
  bulleted_list: 'List',
  numbered_list: 'List',
  quote: 'Quote',
  callout: 'Callout',
  toggle_list: 'Toggle',
  code: '',
};

const BULLETS = ['•', '◦', '▪'];

function mathHtml(src: string, display: boolean): string {
  try {
    return katex.renderToString(src || '\\square', { throwOnError: false, displayMode: display });
  } catch {
    return src;
  }
}

export interface RenderHooks {
  /** Attachment images resolve to blob URLs asynchronously. */
  onImageError?: (id: string) => void;
}

export class Renderer {
  blocks = new Map<string, BlockData>();
  tree: TreeNode[] = [];
  paths = new Map<string, Path>();
  private els = new Map<string, HTMLElement>();
  private depth = new Map<string, number>();
  caretId: string | null = null;

  constructor(
    readonly root: HTMLElement,
    private hooks: RenderHooks = {},
  ) {}

  idAt(path: Path): string | undefined {
    let list = this.tree;
    let node: TreeNode | undefined;
    for (const i of path) {
      node = list[i];
      if (!node) return undefined;
      list = node.children ?? [];
    }
    return node?.id;
  }

  /** Apply a view diff from the core. Returns ids whose element was rebuilt. */
  apply(v: View, force: Iterable<string> = []): void {
    for (const [id, b] of Object.entries(v.blocks)) this.blocks.set(id, b);
    const dirty = new Set<string>([...Object.keys(v.blocks), ...force]);
    if (v.tree) {
      this.tree = v.tree;
      this.paths.clear();
      this.depth.clear();
      const walk = (ns: TreeNode[], p: Path, d: number) =>
        ns.forEach((n, i) => {
          const q = [...p, i];
          this.paths.set(n.id, q);
          this.depth.set(n.id, d);
          walk(n.children ?? [], q, d + 1);
        });
      walk(this.tree, [], 0);
      for (const id of [...this.blocks.keys()])
        if (!this.paths.has(id)) {
          this.blocks.delete(id);
          this.els.delete(id);
        }
    }
    for (const id of dirty) if (this.paths.has(id)) this.renderBlock(id);
    if (v.tree) this.reconcile(this.root, this.tree);
    // bullets change shape with depth, so re-render moved bullets
    if (v.tree)
      for (const [id, b] of this.blocks)
        if (b.type === 'bulleted_list' && !dirty.has(id)) this.renderBlock(id);
  }

  private reconcile(container: HTMLElement, nodes: TreeNode[]): void {
    let prev: Element | null = null;
    for (const n of nodes) {
      let el = this.els.get(n.id);
      if (!el) el = this.renderBlock(n.id);
      const next: Element | null = prev ? prev.nextElementSibling : container.firstElementChild;
      if (next !== el) container.insertBefore(el, next);
      prev = el;
      const kids = el.querySelector<HTMLElement>(':scope > .af-children');
      if (kids) this.reconcile(kids, n.children ?? []);
    }
    // remove what is left over
    let extra = prev ? prev.nextElementSibling : container.firstElementChild;
    while (extra) {
      const nx = extra.nextElementSibling;
      extra.remove();
      extra = nx;
    }
  }

  element(id: string): HTMLElement | undefined {
    return this.els.get(id);
  }

  textEl(id: string): HTMLElement | null {
    return (
      this.els
        .get(id)
        ?.querySelector<HTMLElement>(
          ':scope > .af-row .af-text, :scope > .af-code-wrap .af-text',
        ) ?? null
    );
  }

  /** (Re)build one block's own element, keeping its children container. */
  renderBlock(id: string): HTMLElement {
    const b = this.blocks.get(id)!;
    const old = this.els.get(id);
    const el = document.createElement('div');
    el.className = `af-block af-${b.type.replace(/_/g, '-')}`;
    el.dataset.id = id;
    el.dataset.type = b.type;
    const data = b.data ?? {};
    const lvl = Number(data.level ?? 0);
    if (b.type === 'heading') el.classList.add(`af-h${lvl || 1}`);
    if (b.type === 'toggle_list' && lvl) el.classList.add('af-toggle-heading', `af-h${lvl}`);
    if (id === this.caretId) el.classList.add('af-caret');

    if (hasText(b.type)) {
      if (b.type === 'code') el.appendChild(this.codeBlock(id, b));
      else {
        const row = document.createElement('div');
        row.className = 'af-row';
        const prefix = this.prefix(id, b);
        if (prefix) row.appendChild(prefix);
        const text = document.createElement('div');
        text.className = 'af-text';
        if (b.type === 'heading' || (b.type === 'toggle_list' && lvl)) {
          text.setAttribute('role', 'heading');
          text.setAttribute('aria-level', String(lvl || 1));
        }
        renderInline(text, b.delta ?? []);
        if (!(b.delta ?? []).length) {
          text.classList.add('af-empty');
          text.dataset.placeholder =
            b.type === 'heading' ? `Heading ${lvl || 1}` : (PLACEHOLDER[b.type] ?? '');
        }
        if (b.type === 'todo_list' && data.checked) text.classList.add('af-done');
        row.appendChild(text);
        el.appendChild(row);
      }
      if (b.type !== 'code') {
        const kids =
          old?.querySelector<HTMLElement>(':scope > .af-children') ?? document.createElement('div');
        kids.className = 'af-children';
        if (b.type === 'toggle_list' && data.collapsed) kids.hidden = true;
        else kids.hidden = false;
        el.appendChild(kids);
      }
    } else {
      el.contentEditable = 'false';
      el.appendChild(this.atomic(id, b));
    }
    if (old) old.replaceWith(el);
    this.els.set(id, el);
    return el;
  }

  private prefix(id: string, b: BlockData): HTMLElement | null {
    const data = b.data ?? {};
    const span = (cls: string, text: string) => {
      const s = document.createElement('span');
      s.className = `af-prefix ${cls}`;
      s.contentEditable = 'false';
      s.textContent = text;
      return s;
    };
    switch (b.type) {
      case 'bulleted_list':
        return span('af-bullet', BULLETS[this.depthOf(id, 'bulleted_list') % 3]!);
      case 'numbered_list':
        return span('af-number', `${b.number ?? 1}.`);
      case 'todo_list': {
        const c = span('af-check', data.checked ? '✓' : '');
        c.setAttribute('role', 'checkbox');
        c.setAttribute('aria-checked', String(!!data.checked));
        c.setAttribute('aria-label', 'Done');
        c.dataset.action = 'check';
        if (data.checked) c.classList.add('on');
        return c;
      }
      case 'toggle_list': {
        const c = span('af-chevron', '▶');
        c.setAttribute('role', 'button');
        c.setAttribute('aria-label', data.collapsed ? 'Expand' : 'Collapse');
        c.setAttribute('aria-expanded', String(!data.collapsed));
        c.dataset.action = 'fold';
        if (!data.collapsed) c.classList.add('open');
        return c;
      }
      case 'callout': {
        const c = span('af-icon', String(data.icon ?? '💡'));
        c.dataset.action = 'icon';
        c.setAttribute('role', 'button');
        c.setAttribute('aria-label', 'Change icon');
        return c;
      }
    }
    return null;
  }

  private depthOf(id: string, type: string): number {
    // nesting depth among blocks of the same list kind
    let d = 0;
    const p = this.paths.get(id) ?? [];
    for (let i = 1; i < p.length; i++) {
      const anc = this.idAt(p.slice(0, i));
      if (anc && this.blocks.get(anc)?.type === type) d++;
    }
    return d;
  }

  private codeBlock(id: string, b: BlockData): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'af-code-wrap';
    const head = document.createElement('div');
    head.className = 'af-code-head';
    head.contentEditable = 'false';
    const lang = document.createElement('button');
    lang.type = 'button';
    lang.className = 'af-code-lang';
    lang.dataset.action = 'lang';
    lang.textContent = `${String(b.data?.language || 'Plain text')} ▾`;
    lang.setAttribute('aria-label', 'Code language');
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'af-code-copy';
    copy.dataset.action = 'copy-code';
    copy.textContent = 'Copy';
    head.append(lang, copy);
    const pre = document.createElement('pre');
    pre.className = 'af-text af-code-text';
    pre.spellcheck = false;
    const text = (b.delta ?? []).map((o) => o.insert).join('');
    pre.textContent = text;
    if (!text || text.endsWith('\n')) pre.appendChild(document.createElement('br'));
    wrap.append(head, pre);
    void id;
    return wrap;
  }

  private atomic(id: string, b: BlockData): HTMLElement {
    const data = b.data ?? {};
    const box = document.createElement('div');
    box.className = 'af-atom';
    box.dataset.action = 'edit-atom';
    box.tabIndex = -1;
    switch (b.type) {
      case 'divider':
        box.appendChild(document.createElement('hr'));
        break;
      case 'math_equation':
        box.classList.add('af-math-block');
        box.innerHTML = mathHtml(String(data.formula ?? ''), true);
        box.setAttribute('role', 'button');
        box.setAttribute('aria-label', 'Edit equation');
        break;
      case 'image': {
        const url = String(data.url ?? '');
        const img = document.createElement('img');
        img.alt = String(data.alt ?? '');
        img.className = 'af-img';
        const att = parseAttachmentLink(url);
        if (att)
          void attachmentBlobUrl(att.hash)
            .then((u) => (img.src = u))
            .catch(() => this.hooks.onImageError?.(id));
        else if (/^(https?:|data:|blob:)/.test(url)) img.src = url;
        box.appendChild(img);
        break;
      }
      case 'table': {
        box.classList.add('af-table-wrap');
        box.dataset.action = '';
        const rows = (data.rows as string[][] | undefined) ?? [];
        const t = document.createElement('table');
        t.className = 'af-table';
        rows.forEach((r, ri) => {
          const tr = document.createElement('tr');
          r.forEach((c, ci) => {
            const cell = document.createElement(ri === 0 ? 'th' : 'td');
            const input = document.createElement('input');
            input.className = 'af-cell';
            input.value = c;
            input.dataset.row = String(ri);
            input.dataset.col = String(ci);
            input.setAttribute('aria-label', `Row ${ri + 1}, column ${ci + 1}`);
            cell.appendChild(input);
            tr.appendChild(cell);
          });
          t.appendChild(tr);
        });
        const add = (label: string, action: string) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'af-table-add';
          btn.dataset.action = action;
          btn.textContent = label;
          return btn;
        };
        box.append(t, add('+ Row', 'add-row'), add('+ Column', 'add-col'));
        break;
      }
      default: {
        // raw Markdown the editor does not model (HTML, footnotes…): shown as source, edited in a popover
        box.classList.add('af-raw');
        const pre = document.createElement('pre');
        pre.textContent = String(data.text ?? '');
        box.appendChild(pre);
        box.setAttribute('role', 'button');
        box.setAttribute('aria-label', 'Edit Markdown');
      }
    }
    return box;
  }

  setCaret(id: string | null): void {
    if (id === this.caretId) return;
    if (this.caretId) this.els.get(this.caretId)?.classList.remove('af-caret');
    this.caretId = id;
    if (id) this.els.get(id)?.classList.add('af-caret');
  }

  // ---- DOM <-> model ----

  /** Block id for a DOM node inside the editor. */
  blockOf(node: Node | null): string | null {
    const el = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(
      '.af-block',
    );
    return el?.dataset.id ?? null;
  }

  toPos(node: Node, offset: number): Position | null {
    if (!this.root.contains(node)) return null;
    if (node === this.root) {
      // between blocks: the start of the block at that index (or the end of the last)
      const kids = [...this.root.children] as HTMLElement[];
      const target = kids[offset] ?? kids[kids.length - 1];
      const id = target?.dataset.id;
      if (!id) return null;
      const end = offset >= kids.length;
      return this.edge(id, end);
    }
    const id = this.blockOf(node);
    if (!id) return null;
    const text = this.textEl(id);
    const path = this.paths.get(id);
    if (!path) return null;
    if (!text || !text.contains(node)) {
      // in a prefix, header or a child container edge: start or end of the block's own text
      const el = this.els.get(id)!;
      const before =
        text && (node.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      void el;
      return { path, offset: before || !text ? 0 : textLength(text) };
    }
    return { path, offset: offsetIn(text, node, offset) };
  }

  private edge(id: string, end: boolean): Position | null {
    const path = this.paths.get(id);
    const text = this.textEl(id);
    if (!path) return null;
    return { path, offset: end && text ? textLength(text) : 0 };
  }

  toDom(pos: Position): { node: Node; offset: number } | null {
    const id = this.idAt(pos.path);
    if (!id) return null;
    const text = this.textEl(id);
    if (!text) return null;
    return pointIn(text, pos.offset);
  }

  /** The text of a block as the page now shows it (embeds as one placeholder char each). */
  readText(id: string): string {
    const text = this.textEl(id);
    if (!text) return '';
    let s = '';
    for (const l of leaves(text))
      s += l.kind === 'text' ? l.node.textContent : l.kind === 'embed' ? EMBED : '';
    return s;
  }
}

// ---- inline rendering ----

export function renderInline(into: HTMLElement, delta: TextOp[]): void {
  into.textContent = '';
  for (const op of delta) {
    const a = op.attributes ?? {};
    if (op.insert === EMBED && typeof a.formula === 'string') {
      const m = document.createElement('span');
      m.className = 'af-imath';
      m.contentEditable = 'false';
      m.dataset.embed = '1';
      m.dataset.action = 'edit-formula';
      m.dataset.formula = a.formula;
      m.innerHTML = mathHtml(a.formula, false);
      into.appendChild(m);
      continue;
    }
    let node: Node = document.createTextNode(op.insert);
    const wrapIn = (tag: string, cls?: string) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      e.appendChild(node);
      node = e;
      return e;
    };
    if (a.code) wrapIn('code', 'af-icode');
    if (a.underline) wrapIn('u');
    if (a.strikethrough) wrapIn('s');
    if (a.italic) wrapIn('em');
    if (a.bold) wrapIn('strong');
    if (a.wiki) {
      const w = wrapIn('a', 'af-wiki');
      w.dataset.wiki = op.insert;
      w.setAttribute('role', 'link');
    } else if (typeof a.href === 'string') {
      const l = wrapIn('a', 'af-link');
      l.setAttribute('href', a.href);
      l.dataset.href = a.href;
      l.title = `${a.href} (${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'}+click to open)`;
    }
    into.appendChild(node);
  }
  const last = delta[delta.length - 1];
  if (!delta.length || last!.insert.endsWith('\n') || last!.insert === EMBED)
    into.appendChild(document.createElement('br'));
}

type Leaf =
  | { kind: 'text'; node: Text }
  | { kind: 'embed'; node: HTMLElement }
  | { kind: 'br'; node: HTMLElement };

function* leaves(root: Node): Generator<Leaf> {
  for (const c of root.childNodes) {
    if (c.nodeType === Node.TEXT_NODE) yield { kind: 'text', node: c as Text };
    else if (c instanceof HTMLElement) {
      if (c.dataset.embed) yield { kind: 'embed', node: c };
      else if (c.tagName === 'BR') yield { kind: 'br', node: c };
      else yield* leaves(c);
    }
  }
}

const leafLen = (l: Leaf) => (l.kind === 'text' ? l.node.length : l.kind === 'embed' ? 1 : 0);

export function textLength(root: HTMLElement): number {
  let n = 0;
  for (const l of leaves(root)) n += leafLen(l);
  return n;
}

/** UTF-16 offset of a DOM point inside a block's text element. */
export function offsetIn(root: HTMLElement, node: Node, offset: number): number {
  let acc = 0;
  // anywhere inside an inline equation's rendering counts as just before it
  const embed = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
    '[data-embed]',
  );
  if (embed && root.contains(embed) && embed !== root) {
    for (const l of leaves(root)) {
      if (l.node === embed) return acc;
      acc += leafLen(l);
    }
    return acc;
  }
  if (node === root || (node instanceof Element && !(node as HTMLElement).dataset?.embed)) {
    const target = node.childNodes[offset] ?? null;
    for (const l of leaves(root)) {
      if (
        target &&
        (l.node === target ||
          target.contains(l.node) ||
          target.compareDocumentPosition(l.node) & Node.DOCUMENT_POSITION_FOLLOWING)
      )
        return acc;
      if (
        !target &&
        !node.contains(l.node) &&
        node.compareDocumentPosition(l.node) & Node.DOCUMENT_POSITION_FOLLOWING
      )
        return acc;
      acc += leafLen(l);
    }
    return acc;
  }
  for (const l of leaves(root)) {
    if (l.kind === 'text' && l.node === node) return acc + offset;
    if (l.kind === 'embed' && l.node.contains(node)) return acc + (offset > 0 ? 1 : 0);
    acc += leafLen(l);
  }
  return acc;
}

/** DOM point for a UTF-16 offset inside a block's text element. */
export function pointIn(root: HTMLElement, offset: number): { node: Node; offset: number } {
  let acc = 0;
  let lastText: Text | null = null;
  for (const l of leaves(root)) {
    const len = leafLen(l);
    if (l.kind === 'text') {
      if (offset <= acc + len) return { node: l.node, offset: offset - acc };
      lastText = l.node;
    } else if (l.kind === 'embed' || l.kind === 'br') {
      if (offset <= acc) {
        const parent = l.node.parentNode!;
        return { node: parent, offset: [...parent.childNodes].indexOf(l.node) };
      }
    }
    acc += len;
  }
  if (lastText) return { node: lastText, offset: lastText.length };
  return { node: root, offset: 0 };
}
