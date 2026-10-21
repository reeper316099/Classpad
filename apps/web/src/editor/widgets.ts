import { EditorView, WidgetType } from '@codemirror/view';
import katex from 'katex';
import { attachmentBlobUrl, parseAttachmentLink } from '../lib/attachments.js';

/** What the editor needs from the page around it. Provided as a facet so the editor stays reusable. */
export interface LiveCallbacks {
  openWiki(target: string, heading?: string): void;
  openAttachment(hash: string, ext: string, name: string): void;
  /** The language label of a code block was clicked. */
  openLanguageMenu(at: { x: number; y: number }, codeFrom: number): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Mark a widget so a click puts the caret in the source it replaces (which then shows as raw Markdown). */
const editable = (e: HTMLElement, where: 'start' | 'end' = 'start') => {
  e.dataset.lpEdit = where;
  return e;
};

export class BulletWidget extends WidgetType {
  constructor(readonly level: number) {
    super();
  }
  eq(o: BulletWidget) {
    return o.level === this.level;
  }
  toDOM() {
    const s = el('span', 'cm-lp-bullet', ['•', '◦', '▪'][this.level % 3]);
    s.setAttribute('aria-hidden', 'true');
    return s;
  }
}

export class NumberWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  eq(o: NumberWidget) {
    return o.label === this.label;
  }
  toDOM() {
    const s = el('span', 'cm-lp-number', this.label);
    s.setAttribute('aria-hidden', 'true');
    return s;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(
    readonly done: boolean,
    /** Position of the `[ ]` in the document. */
    readonly boxFrom: number,
  ) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.done === this.done && o.boxFrom === this.boxFrom;
  }
  toDOM(view: EditorView) {
    const wrap = el('span', 'cm-lp-check-wrap');
    const b = el('span', `cm-lp-check${this.done ? ' on' : ''}`);
    b.setAttribute('role', 'checkbox');
    b.setAttribute('aria-checked', String(this.done));
    b.setAttribute('aria-label', 'To-do');
    if (this.done) b.textContent = '✓';
    wrap.appendChild(b);
    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({
        changes: { from: this.boxFrom + 1, to: this.boxFrom + 2, insert: this.done ? ' ' : 'x' },
        userEvent: 'input.toggle',
      });
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

export class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return editable(el('span', 'cm-lp-hr'));
  }
}

/** Header above a code block: language and a copy button. */
export class FenceWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly codeFrom: number,
    readonly codeTo: number,
  ) {
    super();
  }
  eq(o: FenceWidget) {
    return o.lang === this.lang && o.codeFrom === this.codeFrom && o.codeTo === this.codeTo;
  }
  toDOM(view: EditorView) {
    const h = el('span', 'cm-lp-fence-head');
    const lang = el('button', 'cm-lp-fence-lang', `${this.lang || 'code'} ▾`);
    lang.type = 'button';
    lang.setAttribute('aria-label', 'Code language');
    lang.setAttribute('aria-haspopup', 'menu');
    lang.addEventListener('mousedown', (e) => e.preventDefault());
    lang.addEventListener('click', () => {
      const r = lang.getBoundingClientRect();
      view.dom.dispatchEvent(
        new CustomEvent('lp-fence-lang', {
          detail: { x: r.left, y: r.bottom + 4, codeFrom: this.codeFrom },
        }),
      );
    });
    h.appendChild(lang);
    const copy = el('button', 'cm-lp-fence-copy', 'Copy');
    copy.type = 'button';
    copy.setAttribute('aria-label', 'Copy code');
    copy.addEventListener('mousedown', (e) => e.preventDefault());
    copy.addEventListener('click', () => {
      const code = view.state.sliceDoc(this.codeFrom, this.codeTo);
      void navigator.clipboard?.writeText(code).then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1400);
      });
    });
    h.appendChild(copy);
    return h;
  }
  ignoreEvent() {
    return true;
  }
}

export class ChevronWidget extends WidgetType {
  constructor(
    readonly collapsed: boolean,
    readonly openFrom: number,
    readonly level: number,
  ) {
    super();
  }
  eq(o: ChevronWidget) {
    return o.collapsed === this.collapsed && o.openFrom === this.openFrom && o.level === this.level;
  }
  toDOM(view: EditorView, toggle?: (from: number, collapsed: boolean) => void) {
    void toggle;
    const b = el('span', `cm-lp-chevron${this.collapsed ? '' : ' open'}`, '▸');
    b.setAttribute('role', 'button');
    b.setAttribute('aria-expanded', String(!this.collapsed));
    b.setAttribute('aria-label', this.collapsed ? 'Expand toggle' : 'Collapse toggle');
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dom.dispatchEvent(
        new CustomEvent('lp-toggle', {
          detail: { from: this.openFrom, collapsed: !this.collapsed },
        }),
      );
    });
    return b;
  }
  ignoreEvent() {
    return true;
  }
}

export class WikiWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly heading: string | undefined,
    readonly label: string,
    readonly open: (t: string, h?: string) => void,
  ) {
    super();
  }
  eq(o: WikiWidget) {
    return o.target === this.target && o.heading === this.heading && o.label === this.label;
  }
  toDOM() {
    const a = el('span', 'cm-lp-wiki', this.label);
    a.setAttribute('role', 'link');
    a.title = `Open “${this.target}”`;
    a.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.open(this.target, this.heading);
    });
    return a;
  }
  ignoreEvent() {
    return true;
  }
}

const KATEX = { throwOnError: false, strict: 'ignore', trust: false, maxExpand: 200 } as const;

export class MathWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly display: boolean,
  ) {
    super();
  }
  eq(o: MathWidget) {
    return o.src === this.src && o.display === this.display;
  }
  toDOM() {
    const s = el('span', this.display ? 'cm-lp-math-block' : 'cm-lp-math');
    try {
      s.innerHTML = katex.renderToString(this.src, { ...KATEX, displayMode: this.display });
    } catch {
      s.textContent = this.src;
    }
    return editable(s);
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly href: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.href === this.href && o.alt === this.alt;
  }
  toDOM(view: EditorView) {
    const wrap = el('span', 'cm-lp-img');
    const att = parseAttachmentLink(this.href);
    if (!att) {
      wrap.classList.add('cm-lp-img-off');
      wrap.textContent = `Image not loaded: ${this.alt || 'remote image'}`;
      wrap.title = 'Remote images are never loaded';
      return editable(wrap);
    }
    const img = el('img', 'cm-lp-img-el');
    img.alt = this.alt;
    img.draggable = false;
    img.addEventListener('load', () => view.requestMeasure());
    void attachmentBlobUrl(att.hash)
      .then((u) => (img.src = u))
      .catch(() => {
        wrap.textContent = `Image missing: ${this.alt || att.name}`;
        view.requestMeasure();
      });
    wrap.appendChild(img);
    return editable(wrap);
  }
}

export class FileWidget extends WidgetType {
  constructor(
    readonly href: string,
    readonly label: string,
    readonly open: (hash: string, ext: string, name: string) => void,
  ) {
    super();
  }
  eq(o: FileWidget) {
    return o.href === this.href && o.label === this.label;
  }
  toDOM() {
    const a = el('span', 'cm-lp-file');
    a.appendChild(el('span', 'cm-lp-file-icon', '📎'));
    a.appendChild(document.createTextNode(this.label));
    a.setAttribute('role', 'link');
    a.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const att = parseAttachmentLink(this.href);
      if (att) this.open(att.hash, att.ext, this.label || att.name);
    });
    return a;
  }
  ignoreEvent() {
    return true;
  }
}

/** A tiny inline renderer for table cells: code, bold, italic, strike and links, built with DOM nodes (no HTML parsing). */
export function renderInline(src: string, into: HTMLElement): void {
  const re =
    /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\)|\$[^$\s][^$]*\$)/g;
  let last = 0;
  for (const m of src.matchAll(re)) {
    if (m.index! > last) into.append(src.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) into.append(el('code', 'cm-lp-icode', t.slice(1, -1)));
    else if (t.startsWith('**')) into.append(el('strong', '', t.slice(2, -2)));
    else if (t.startsWith('~~')) into.append(el('s', '', t.slice(2, -2)));
    else if (t.startsWith('[['))
      into.append(el('span', 'cm-lp-wiki', t.slice(2, -2).split('|').pop()!.split('#')[0]!));
    else if (t.startsWith('[')) into.append(el('span', 'cm-lp-link', t.slice(1, t.indexOf(']'))));
    else if (t.startsWith('$')) {
      const s = el('span', 'cm-lp-math');
      try {
        s.innerHTML = katex.renderToString(t.slice(1, -1), { ...KATEX, displayMode: false });
      } catch {
        s.textContent = t;
      }
      into.append(s);
    } else into.append(el('em', '', t.slice(1, -1)));
    last = m.index! + t.length;
  }
  if (last < src.length) into.append(src.slice(last));
}

export class TableWidget extends WidgetType {
  constructor(
    readonly rows: string[][],
    readonly aligns: ('left' | 'center' | 'right' | '')[],
    readonly key: string,
  ) {
    super();
  }
  eq(o: TableWidget) {
    return o.key === this.key;
  }
  toDOM() {
    const wrap = el('div', 'cm-lp-table-wrap');
    const t = el('table', 'cm-lp-table');
    this.rows.forEach((cells, r) => {
      const tr = document.createElement('tr');
      cells.forEach((c, i) => {
        const td = document.createElement(r === 0 ? 'th' : 'td');
        if (this.aligns[i]) td.style.textAlign = this.aligns[i]!;
        renderInline(c.trim(), td);
        td.dataset.lpRow = String(r);
        tr.appendChild(td);
      });
      (r === 0 ? (t.tHead ?? t.createTHead()) : (t.tBodies[0] ?? t.createTBody())).appendChild(tr);
    });
    wrap.appendChild(t);
    return editable(wrap);
  }
}

export class MathBlockWidget extends MathWidget {
  constructor(src: string) {
    super(src, true);
  }
}

/** Zero-height placeholder for lines that are hidden (toggle tags, folded toggle bodies). */
export class HiddenWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const d = el('div', 'cm-lp-hidden');
    d.setAttribute('aria-hidden', 'true');
    return d;
  }
}
