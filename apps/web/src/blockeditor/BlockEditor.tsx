/**
 * The note editor, modelled on AppFlowy Editor: a page of blocks you write in directly. The document,
 * selection, undo and every editing rule live in the Go core (WebAssembly); this component draws blocks,
 * turns browser input into core commands, and shows the slash menu, the selection toolbar, block handles
 * and popovers.
 */
import katex from 'katex';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CODE_LANGUAGES } from '../editor/blocks.js';
import { parseAttachmentLink, uploadForMarkdown } from '../lib/attachments.js';
import { useUi } from '../lib/store.js';
import { FloatingMenu, type MenuItem } from '../components/Menu.js';
import { slugHeading } from '../components/Markdown.js';
import {
  EditorCore,
  type Attrs,
  type Command,
  type Position,
  type Result,
  type Selection,
} from './core.js';
import { Renderer, hasText, offsetIn, textLength } from './render.js';
import { CALLOUT_ICONS, TURN_ITEMS, filterItems, itemOf, type BlockItem } from './items.js';

export interface BlockEditorHandle {
  wrap(before: string, after?: string): void;
  insert(text: string): void;
  cloze(): void;
  getSelection(): string;
  goToLine(line: number): void;
  goToHeading(slug: string): boolean;
  focus(): void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  getTitles?: () => string[];
  onOpenWiki?: (target: string, heading?: string) => void;
  onOpenAttachment?: (hash: string, ext: string, name: string) => void;
}

type Pt = { x: number; y: number };
type Popover =
  | { kind: 'link'; at: Pt; value: string }
  | { kind: 'formula'; at: Pt; value: string; path: number[]; offset: number }
  | { kind: 'math'; at: Pt; value: string; id: string }
  | { kind: 'raw'; at: Pt; value: string; id: string }
  | { kind: 'image'; at: Pt; value: string; id: string };
type MenuState =
  | { kind: 'block'; at: Pt; id: string }
  | { kind: 'context'; at: Pt; id: string | null }
  | { kind: 'turn'; at: Pt }
  | { kind: 'lang'; at: Pt; id: string }
  | { kind: 'icon'; at: Pt; id: string };
interface Slash {
  id: string;
  /** offset of the "/" (or "[[") in the block */
  from: number;
  query: string;
  at: Pt;
  active: number;
  wiki?: boolean;
}

const MOD = /Mac|iPhone|iPad/.test(typeof navigator === 'undefined' ? '' : navigator.platform);
const modKey = (e: { metaKey: boolean; ctrlKey: boolean }) => (MOD ? e.metaKey : e.ctrlKey);
const samePos = (a: Position, b: Position) =>
  a.offset === b.offset && a.path.join() === b.path.join();
const sameSel = (a: Selection, b: Selection) => samePos(a.start, b.start) && samePos(a.end, b.end);

export const BlockEditor = forwardRef<BlockEditorHandle, Props>(function BlockEditor(
  { value, onChange, getTitles, onOpenWiki, onOpenAttachment },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const core = useRef<EditorCore | null>(null);
  const rend = useRef<Renderer | null>(null);
  const own = useRef(value);
  const sel = useRef<Selection | null>(null);
  const composing = useRef(false);
  const settingDom = useRef(false);
  const saveTimer = useRef<number>(0);
  const latest = useRef({ onChange, getTitles, onOpenWiki, onOpenAttachment });
  latest.current = { onChange, getTitles, onOpenWiki, onOpenAttachment };

  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [marks, setMarks] = useState<Attrs>({});
  const [toolbar, setToolbar] = useState<DOMRect | null>(null);
  const [slash, setSlash] = useState<Slash | null>(null);
  const slashRef = useRef<Slash | null>(null);
  slashRef.current = slash;
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pop, setPop] = useState<Popover | null>(null);
  const [hover, setHover] = useState<{ id: string; top: number } | null>(null);
  const [drop, setDrop] = useState<{ top: number; left: number; width: number } | null>(null);
  const toast = useUi((s) => s.toast);
  const flashcards = useUi((s) => !!s.modules.flashcards);
  const mods = useRef({ flashcards });
  mods.current = { flashcards };

  // ---- talking to the core ----

  const flush = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = 0;
    const c = core.current;
    if (!c) return;
    const md = c.markdown();
    if (md !== own.current) {
      own.current = md;
      latest.current.onChange(md);
    }
  }, []);

  /** Put the DOM selection where the model says, without triggering our selectionchange handler. */
  const placeDom = useCallback((s: Selection) => {
    const r = rend.current;
    const root = host.current;
    if (!r || !root || document.activeElement !== root) return;
    const a = r.toDom(s.start);
    const b = r.toDom(s.end);
    if (!a || !b) return;
    const ds = document.getSelection();
    if (!ds) return;
    settingDom.current = true;
    ds.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
    queueMicrotask(() => (settingDom.current = false));
    // keep the caret in view
    const rect = ds.rangeCount ? ds.getRangeAt(0).getBoundingClientRect() : null;
    const scroller = root.closest('.be-scroll');
    if (rect && scroller && rect.height) {
      const box = scroller.getBoundingClientRect();
      if (rect.bottom > box.bottom - 24) scroller.scrollTop += rect.bottom - box.bottom + 48;
      else if (rect.top < box.top + 8) scroller.scrollTop -= box.top - rect.top + 48;
    }
  }, []);

  const apply = useCallback(
    (res: Result, opts: { keepDom?: boolean; force?: string[] } = {}) => {
      const r = rend.current;
      if (!res.view || !r) return;
      r.apply(res.view, opts.force);
      sel.current = res.view.selection;
      setMarks(res.view.marks ?? {});
      r.setCaret(r.idAt(res.view.selection.end.path) ?? null);
      if (!opts.keepDom) placeDom(res.view.selection);
      if (res.changed) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(flush, 350);
      }
    },
    [flush, placeDom],
  );

  const run = useCallback(
    (cmd: Command, opts?: { keepDom?: boolean; force?: string[] }): Result | null => {
      const c = core.current;
      if (!c) return null;
      const res = c.exec(cmd);
      apply(res, opts);
      return res;
    },
    [apply],
  );

  /** Read the DOM selection into the model (when it moved by mouse or arrow keys). */
  const syncSelection = useCallback(() => {
    const r = rend.current;
    const ds = document.getSelection();
    if (!r || !ds || !ds.anchorNode || !host.current?.contains(ds.anchorNode)) return null;
    const a = r.toPos(ds.anchorNode, ds.anchorOffset);
    const b = r.toPos(ds.focusNode!, ds.focusOffset);
    if (!a || !b) return null;
    const s = { start: a, end: b };
    if (!sel.current || !sameSel(s, sel.current))
      run({ name: 'select', selection: s }, { keepDom: true });
    return s;
  }, [run]);

  // ---- open / reload ----

  useEffect(() => {
    let alive = true;
    const root = host.current!;
    EditorCore.open(value)
      .then((c) => {
        if (!alive) return c.close();
        core.current = c;
        rend.current = new Renderer(root);
        own.current = value;
        run({ name: 'view' }, { keepDom: true });
        setStatus('ready');
      })
      .catch((e) => {
        console.error(e);
        if (alive) setStatus('failed');
      });
    return () => {
      alive = false;
      if (saveTimer.current) flush();
      core.current?.close();
      core.current = null;
      rend.current = null;
      root.textContent = '';
    };
    // opening happens once; later value changes go through "load" below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status !== 'ready' || value === own.current) return;
    // a different note was opened, or the file changed on disk
    window.clearTimeout(saveTimer.current);
    own.current = value;
    run({ name: 'load', markdown: value }, { keepDom: true });
    setSlash(null);
    setPop(null);
  }, [value, status, run]);

  // ---- helpers for menus ----

  const caretRect = (): DOMRect | null => {
    const ds = document.getSelection();
    if (!ds?.rangeCount) return null;
    const range = ds.getRangeAt(0).cloneRange();
    let rect = range.getBoundingClientRect();
    if (!rect.height) {
      const el = (
        range.startContainer instanceof Element
          ? range.startContainer
          : range.startContainer.parentElement
      ) as Element | null;
      rect = el?.getBoundingClientRect() ?? rect;
    }
    return rect;
  };

  const blockPath = (id: string) => rend.current?.paths.get(id);
  const caretId = () => (sel.current ? rend.current?.idAt(sel.current.end.path) : undefined);
  const textBefore = (id: string, upTo: number) => rend.current?.readText(id).slice(0, upTo) ?? '';

  const updateSlash = useCallback(() => {
    const s = slashRef.current;
    const cur = sel.current;
    if (!s || !cur) return;
    const id = rend.current?.idAt(cur.end.path);
    const off = cur.end.offset;
    if (id !== s.id || off <= s.from || !samePos(cur.start, cur.end)) return setSlash(null);
    const before = textBefore(id, off);
    const lead = s.wiki ? '[[' : '/';
    if (before.slice(s.from, s.from + lead.length) !== lead) return setSlash(null);
    const query = before.slice(s.from + lead.length);
    if (query.includes('\n') || query.length > 40 || (s.wiki && query.includes(']')))
      return setSlash(null);
    if (
      !s.wiki &&
      filterItems(query, mods.current).length === 0 &&
      query.length > s.query.length + 3
    )
      return setSlash(null);
    setSlash({ ...s, query, active: query === s.query ? s.active : 0 });
  }, []);

  const openSlash = (wiki = false) => {
    const cur = sel.current;
    const id = cur && rend.current?.idAt(cur.end.path);
    const r = caretRect();
    if (!cur || !id || !r) return;
    const from = cur.end.offset - (wiki ? 2 : 1);
    setSlash({ id, from, query: '', at: { x: r.left, y: r.bottom + 6 }, active: 0, wiki });
  };

  const pickImage = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const md = await uploadForMarkdown(f);
        run({ name: 'paste', markdown: md });
      } catch (e) {
        toast(`Could not add the image: ${(e as Error).message}`);
      }
    };
    input.click();
  };

  const choose = (item: BlockItem, queryLen: number) => {
    setSlash(null);
    host.current?.focus();
    if (item.special) {
      if (queryLen) run({ name: 'slash', type: 'paragraph', queryLen });
      // removing "/query" from a non-empty line keeps it a paragraph; from an empty one "slash" re-inserts one
      if (item.special === 'image') pickImage();
      if (item.special === 'inline-math') {
        run({ name: 'insertFormula', text: 'x' });
        const r = caretRect();
        const cur = sel.current!;
        if (r)
          setPop({
            kind: 'formula',
            at: { x: r.left, y: r.bottom + 6 },
            value: 'x',
            path: cur.end.path,
            offset: cur.end.offset - 1,
          });
      }
      if (item.special === 'date') {
        run({
          name: 'insertText',
          text: new Date().toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          }),
        });
      }
      if (item.special === 'cloze') {
        const used = [...own.current.matchAll(/\{\{c(\d+)::/g)].map((m) => Number(m[1]));
        run({ name: 'paste', markdown: `{{c${used.length ? Math.max(...used) + 1 : 1}::answer}}` });
      }
      if (item.special === 'page-link') {
        run({ name: 'insertText', text: '[' });
        run({ name: 'insertText', text: '[' });
        openSlash(true);
      }
      return;
    }
    run({ name: 'slash', type: item.type, attrs: item.attrs, queryLen });
    if (item.type === 'math_equation') openAtomAfterInsert('math');
  };

  /** After inserting an equation block, open its editor straight away. */
  const openAtomAfterInsert = (kind: 'math') => {
    const r = rend.current;
    const cur = sel.current;
    if (!r || !cur) return;
    // the caret is in the paragraph after the new block
    const p = cur.end.path;
    const prev = [...p.slice(0, -1), p[p.length - 1]! - 1];
    const id = r.idAt(prev);
    const el = id ? r.element(id) : undefined;
    if (!id || !el) return;
    const b = el.getBoundingClientRect();
    if (kind === 'math')
      setPop({ kind: 'math', at: { x: b.left, y: b.bottom + 6 }, value: '', id });
  };

  const chooseWiki = (title: string) => {
    const s = slashRef.current;
    const cur = sel.current;
    if (!s || !cur) return;
    setSlash(null);
    const path = cur.end.path;
    run({
      name: 'select',
      selection: { start: { path, offset: s.from }, end: { path, offset: cur.end.offset } },
    });
    run({ name: 'paste', markdown: `[[${title.replace(/[[\]]/g, '')}]]` });
  };

  // ---- browser events ----

  useEffect(() => {
    const root = host.current!;
    const inField = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

    const selectRange = (r: StaticRange) => {
      const rr = rend.current!;
      const a = rr.toPos(r.startContainer, r.startOffset);
      const b = rr.toPos(r.endContainer, r.endOffset);
      if (a && b) run({ name: 'select', selection: { start: a, end: b } }, { keepDom: true });
    };

    const onBeforeInput = (e: InputEvent) => {
      if (inField(e.target) || !core.current) return;
      if (e.isComposing || e.inputType === 'insertCompositionText') return;
      syncSelection();
      const ranges = e.getTargetRanges?.() ?? [];
      const collapsed = sel.current ? samePos(sel.current.start, sel.current.end) : true;
      switch (e.inputType) {
        case 'insertText': {
          e.preventDefault();
          const text = e.data ?? '';
          run({ name: 'insertText', text });
          if (text === '/') openSlash();
          else if (text === '[') {
            const id = caretId();
            const off = sel.current?.end.offset ?? 0;
            if (id && textBefore(id, off).endsWith('[[')) openSlash(true);
          }
          queueMicrotask(updateSlash);
          return;
        }
        case 'insertReplacementText': {
          e.preventDefault();
          const text = e.dataTransfer?.getData('text/plain') ?? e.data ?? '';
          if (ranges[0]) selectRange(ranges[0]);
          run({ name: 'insertText', text });
          return;
        }
        case 'insertParagraph':
          e.preventDefault();
          run({ name: 'insertNewline' });
          return;
        case 'insertLineBreak':
          e.preventDefault();
          run({ name: 'insertSoftBreak' });
          return;
        case 'deleteContentBackward':
        case 'deleteContentForward': {
          e.preventDefault();
          const back = e.inputType === 'deleteContentBackward';
          const atEdge =
            sel.current && collapsed && (back ? sel.current.start.offset === 0 : false);
          if (collapsed && !atEdge && ranges[0] && !ranges[0].collapsed) {
            const rr = rend.current!;
            const a = rr.toPos(ranges[0].startContainer, ranges[0].startOffset);
            const b = rr.toPos(ranges[0].endContainer, ranges[0].endOffset);
            if (a && b && a.path.join() === b.path.join() && a.offset !== b.offset) {
              run({ name: 'select', selection: { start: a, end: b } }, { keepDom: true });
              run({ name: 'deleteSelection' });
              queueMicrotask(updateSlash);
              return;
            }
          }
          run({ name: back ? 'deleteBackward' : 'deleteForward' });
          queueMicrotask(updateSlash);
          return;
        }
        case 'deleteWordBackward':
        case 'deleteWordForward':
        case 'deleteSoftLineBackward':
        case 'deleteSoftLineForward':
        case 'deleteHardLineBackward':
        case 'deleteHardLineForward':
        case 'deleteContent':
        case 'deleteByCut': {
          e.preventDefault();
          if (collapsed && ranges[0] && !ranges[0].collapsed) selectRange(ranges[0]);
          const nowCollapsed = sel.current ? samePos(sel.current.start, sel.current.end) : true;
          run({
            name: nowCollapsed
              ? e.inputType.includes('Forward')
                ? 'deleteForward'
                : 'deleteBackward'
              : 'deleteSelection',
          });
          queueMicrotask(updateSlash);
          return;
        }
        case 'historyUndo':
          e.preventDefault();
          run({ name: 'undo' });
          return;
        case 'historyRedo':
          e.preventDefault();
          run({ name: 'redo' });
          return;
        case 'formatBold':
        case 'formatItalic':
        case 'formatUnderline':
        case 'formatStrikeThrough': {
          e.preventDefault();
          const m = {
            formatBold: 'bold',
            formatItalic: 'italic',
            formatUnderline: 'underline',
            formatStrikeThrough: 'strikethrough',
          }[e.inputType]!;
          run({ name: 'toggleMark', mark: m });
          return;
        }
        default:
          // pastes and drops arrive as their own events; nothing else may edit the DOM behind the model's back
          e.preventDefault();
      }
    };

    // text the browser changed directly (IME composition, some autocorrect) is read back into the model
    const syncBlockFromDom = () => {
      const r = rend.current;
      const ds = document.getSelection();
      if (!r || !ds?.anchorNode) return;
      const id = r.blockOf(ds.anchorNode);
      const path = id ? r.paths.get(id) : undefined;
      const text = id ? r.textEl(id) : null;
      if (!id || !path || !text) return;
      const caret = text.contains(ds.focusNode)
        ? offsetIn(text, ds.focusNode!, ds.focusOffset)
        : textLength(text);
      run({ name: 'syncText', path, text: r.readText(id), caret }, { force: [id] });
    };
    const onCompStart = () => {
      composing.current = true;
      syncSelection();
      if (sel.current && !samePos(sel.current.start, sel.current.end))
        run({ name: 'deleteSelection' });
    };
    const onCompEnd = () => {
      composing.current = false;
      syncBlockFromDom();
      queueMicrotask(updateSlash);
    };
    const onInput = (e: Event) => {
      if (inField(e.target) || composing.current) return;
      syncBlockFromDom();
    };

    const onSelChange = () => {
      if (settingDom.current || composing.current) return;
      const ds = document.getSelection();
      if (!ds?.anchorNode || !root.contains(ds.anchorNode)) {
        setToolbar(null);
        return;
      }
      const s = syncSelection();
      if (!s) return;
      queueMicrotask(updateSlash);
      if (!samePos(s.start, s.end) && ds.rangeCount) {
        const rect = ds.getRangeAt(0).getBoundingClientRect();
        setToolbar(rect.width || rect.height ? rect : null);
      } else setToolbar(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (inField(e.target) || !core.current) return;
      const s = slashRef.current;
      if (s) {
        const items = s.wiki ? wikiMatches(s.query) : filterItems(s.query, mods.current);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const n = Math.max(1, items.length);
          setSlash({ ...s, active: (s.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
          return;
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && items.length) {
          e.preventDefault();
          const it = items[Math.min(s.active, items.length - 1)]!;
          if (s.wiki) chooseWiki(it as string);
          else choose(it as BlockItem, s.query.length + 1);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setSlash(null);
          return;
        }
      }
      const mod = modKey(e);
      const k = e.key.toLowerCase();
      if (e.key === 'Tab') {
        e.preventDefault();
        syncSelection();
        const id = caretId();
        if (id && rend.current?.blocks.get(id)?.type === 'code' && !e.shiftKey)
          run({ name: 'insertText', text: '  ' });
        else run({ name: e.shiftKey ? 'outdent' : 'indent' });
        return;
      }
      if (mod && !e.altKey) {
        const markKeys: Record<string, string> = {
          b: 'bold',
          i: 'italic',
          u: 'underline',
          e: 'code',
        };
        if (!e.shiftKey && markKeys[k]) {
          e.preventDefault();
          syncSelection();
          run({ name: 'toggleMark', mark: markKeys[k]! });
          return;
        }
        if (e.shiftKey && (k === 's' || k === 'x')) {
          e.preventDefault();
          syncSelection();
          run({ name: 'toggleMark', mark: 'strikethrough' });
          return;
        }
        if (k === 'k') {
          e.preventDefault();
          e.stopPropagation(); // the app's command palette also listens for Mod+K
          openLink();
          return;
        }
        if (k === 'z') {
          e.preventDefault();
          run({ name: e.shiftKey ? 'redo' : 'undo' });
          return;
        }
        if (k === 'y') {
          e.preventDefault();
          run({ name: 'redo' });
          return;
        }
        if (k === 'a') {
          e.preventDefault();
          syncSelection();
          run({ name: 'selectAll' });
          return;
        }
        if (k === 'd') {
          e.preventDefault();
          const id = caretId();
          if (id) run({ name: 'duplicate', id });
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          syncSelection();
          run({ name: 'toggleTodo' });
          return;
        }
        if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          syncSelection();
          run({ name: e.key === 'ArrowUp' ? 'moveUp' : 'moveDown' });
          return;
        }
      }
      // Notion's block shortcuts (by physical key: Alt and Shift change e.key on some layouts)
      const digit = /^Digit(\d)$/.exec(e.code)?.[1];
      const turn = (type: string, attrs?: Attrs) => {
        e.preventDefault();
        syncSelection();
        run({ name: 'turnInto', type, attrs });
      };
      if (mod && e.altKey && !e.shiftKey && digit && Number(digit) <= 3) {
        const lvl = Number(digit);
        return lvl ? turn('heading', { level: lvl }) : turn('paragraph');
      }
      if (mod && e.shiftKey && !e.altKey && digit === '7') return turn('numbered_list');
      if (mod && e.shiftKey && !e.altKey && digit === '8') return turn('bulleted_list');
      if (mod && e.shiftKey && !e.altKey && digit === '9')
        return turn('todo_list', { checked: false });
      if (mod && e.altKey && e.code === 'KeyC') return turn('code', { language: '' });
      if (mod && e.altKey && e.code === 'KeyT')
        return turn('toggle_list', { level: 0, collapsed: false });
      if (e.key === 'Escape') {
        setPop(null);
        setMenu(null);
      }
    };

    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      if (inField(e.target)) return;
      e.preventDefault();
      syncSelection();
      const res = run({ name: cut ? 'cut' : 'copy' });
      if (!res?.text && !res?.plain) return;
      e.clipboardData?.setData('text/plain', res.plain ?? '');
      e.clipboardData?.setData('text/x-classpad-markdown', res.text ?? '');
    };

    const insertFiles = async (files: File[]) => {
      for (const f of files) {
        try {
          run({ name: 'paste', markdown: await uploadForMarkdown(f) });
        } catch (err) {
          toast(`Could not add ${f.name}: ${(err as Error).message}`);
        }
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (inField(e.target)) return;
      e.preventDefault();
      syncSelection();
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) return void insertFiles(files);
      const md = e.clipboardData?.getData('text/x-classpad-markdown');
      const text = e.clipboardData?.getData('text/plain') ?? '';
      run({ name: 'paste', markdown: md || text });
    };
    const onDrop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      const caret = document.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (caret) {
        const p = rend.current?.toPos(caret.startContainer, caret.startOffset);
        if (p) run({ name: 'select', selection: { start: p, end: p } });
      }
      void insertFiles(files);
    };

    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      const action = t.closest<HTMLElement>('[data-action]')?.dataset.action;
      const id = rend.current?.blockOf(t);
      if (!action || !id) return;
      syncSelection();
      const b = rend.current!.blocks.get(id)!;
      const path = blockPath(id)!;
      const r = t.getBoundingClientRect();
      const below = { x: r.left, y: r.bottom + 6 };
      switch (action) {
        case 'check':
          e.preventDefault();
          run({ name: 'setAttrs', path, attrs: { checked: !b.data?.checked } }, { keepDom: true });
          return;
        case 'fold':
          e.preventDefault();
          run(
            { name: 'setAttrs', path, attrs: { collapsed: !b.data?.collapsed } },
            { keepDom: true },
          );
          return;
        case 'icon':
          e.preventDefault();
          setMenu({ kind: 'icon', at: below, id });
          return;
        case 'lang':
          e.preventDefault();
          setMenu({ kind: 'lang', at: below, id });
          return;
        case 'copy-code':
          e.preventDefault();
          void navigator.clipboard?.writeText((b.delta ?? []).map((o) => o.insert).join(''));
          toast('Code copied');
          return;
        case 'edit-formula': {
          e.preventDefault();
          const span = t.closest<HTMLElement>('[data-embed]')!;
          const text = rend.current!.textEl(id)!;
          const offset = offsetIn(
            text,
            span.parentNode!,
            [...span.parentNode!.childNodes].indexOf(span),
          );
          setPop({ kind: 'formula', at: below, value: span.dataset.formula ?? '', path, offset });
          return;
        }
        case 'edit-atom': {
          if (t.closest('input,button')) return;
          e.preventDefault();
          const box = rend.current!.element(id)!.getBoundingClientRect();
          const at = { x: box.left, y: box.bottom + 6 };
          if (b.type === 'math_equation')
            setPop({ kind: 'math', at, value: String(b.data?.formula ?? ''), id });
          else if (b.type === 'raw')
            setPop({ kind: 'raw', at, value: String(b.data?.text ?? ''), id });
          else if (b.type === 'image')
            setPop({ kind: 'image', at, value: String(b.data?.alt ?? ''), id });
          return;
        }
        case 'add-row':
        case 'add-col': {
          e.preventDefault();
          const rows = ((b.data?.rows as string[][]) ?? [[]]).map((row) => [...row]);
          if (action === 'add-row') rows.push(rows[0]!.map(() => ''));
          else rows.forEach((row, i) => row.push(i === 0 ? `Column ${row.length + 1}` : ''));
          run({ name: 'setAttrs', path, attrs: { rows } }, { keepDom: true });
          return;
        }
      }
    };

    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      const wiki = t.closest<HTMLElement>('.af-wiki');
      if (wiki && (modKey(e) || !e.detail || e.detail === 1)) {
        if (!modKey(e) && document.getSelection()?.isCollapsed === false) return;
        const [target, heading] = (wiki.dataset.wiki ?? '').split('#');
        if (modKey(e) || e.altKey === false) {
          e.preventDefault();
          latest.current.onOpenWiki?.(target!, heading);
        }
        return;
      }
      const link = t.closest<HTMLAnchorElement>('.af-link');
      if (link) {
        e.preventDefault();
        if (!modKey(e)) return;
        const href = link.dataset.href ?? '';
        const att = parseAttachmentLink(href);
        if (att) latest.current.onOpenAttachment?.(att.hash, att.ext, link.textContent || att.name);
        else if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener');
      }
    };

    const onCellChange = (e: Event) => {
      const t = e.target as HTMLInputElement;
      if (!t.classList?.contains('af-cell')) return;
      const id = rend.current?.blockOf(t);
      const b = id ? rend.current!.blocks.get(id) : undefined;
      if (!id || !b) return;
      const rows = ((b.data?.rows as string[][]) ?? []).map((row) => [...row]);
      rows[Number(t.dataset.row)]![Number(t.dataset.col)] = t.value;
      run({ name: 'setAttrs', path: blockPath(id)!, attrs: { rows } }, { keepDom: true });
    };

    const onContext = (e: MouseEvent) => {
      if (inField(e.target)) return;
      e.preventDefault();
      syncSelection();
      setMenu({
        kind: 'context',
        at: { x: e.clientX, y: e.clientY },
        id: rend.current?.blockOf(e.target as Node) ?? null,
      });
    };

    const onBlur = () => {
      if (saveTimer.current) flush();
    };

    const sub: [string, EventListener][] = [
      ['beforeinput', onBeforeInput as EventListener],
      ['compositionstart', onCompStart],
      ['compositionend', onCompEnd],
      ['input', onInput],
      ['keydown', onKeyDown as EventListener],
      ['copy', ((e: ClipboardEvent) => onCopy(e, false)) as EventListener],
      ['cut', ((e: ClipboardEvent) => onCopy(e, true)) as EventListener],
      ['paste', onPaste as EventListener],
      ['drop', onDrop as EventListener],
      ['mousedown', onMouseDown as EventListener],
      ['click', onClick as EventListener],
      ['change', onCellChange],
      ['contextmenu', onContext as EventListener],
      ['blur', onBlur],
    ];
    for (const [n, f] of sub) root.addEventListener(n, f);
    document.addEventListener('selectionchange', onSelChange);
    return () => {
      for (const [n, f] of sub) root.removeEventListener(n, f);
      document.removeEventListener('selectionchange', onSelChange);
    };
    // handlers read everything through refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, syncSelection, updateSlash, flush]);

  const wikiMatches = (q: string): string[] => {
    const titles = latest.current.getTitles?.() ?? [];
    const lq = q.toLowerCase();
    return titles
      .filter((t) => t.toLowerCase().includes(lq))
      .slice(0, 8)
      .concat(q && !titles.includes(q) ? [q] : []);
  };

  const openLink = () => {
    syncSelection();
    const r = caretRect();
    if (!r) return;
    setPop({ kind: 'link', at: { x: r.left, y: r.bottom + 6 }, value: String(marks.href ?? '') });
  };

  // ---- block handles (+ and drag grip) ----

  const onHover = (e: React.MouseEvent) => {
    if (drag.current) return;
    const r = rend.current;
    const wrap = wrapRef.current;
    if (!r || !wrap) return;
    const t = (e.target as HTMLElement).closest<HTMLElement>('.af-block');
    if (!t || !host.current?.contains(t)) {
      if (!(e.target as HTMLElement).closest('.be-handle')) setHover(null);
      return;
    }
    const row =
      t.querySelector<HTMLElement>(':scope > .af-row, :scope > .af-code-wrap, :scope > .af-atom') ??
      t;
    const top = row.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop;
    if (!hover || hover.id !== t.dataset.id || hover.top !== top)
      setHover({ id: t.dataset.id!, top });
  };

  const plus = () => {
    const r = rend.current;
    if (!hover || !r) return;
    const path = r.paths.get(hover.id);
    if (!path) return;
    host.current?.focus();
    const len = r.textEl(hover.id) ? textLength(r.textEl(hover.id)!) : 0;
    run({
      name: 'select',
      selection: { start: { path, offset: len }, end: { path, offset: len } },
    });
    run({ name: 'insertBlock', type: 'paragraph' });
    run({ name: 'insertText', text: '/' });
    openSlash();
  };

  const drag = useRef<{
    id: string;
    x: number;
    y: number;
    moved: boolean;
    target?: { id: string; where: 'before' | 'after' | 'inside' };
  } | null>(null);

  const gripDown = (e: React.PointerEvent) => {
    if (!hover) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: hover.id, x: e.clientX, y: e.clientY, moved: false };
  };
  const gripMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const r = rend.current;
    const wrap = wrapRef.current;
    if (!d || !r || !wrap) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
    d.moved = true;
    const under = document.elementsFromPoint(
      host.current!.getBoundingClientRect().left + 70,
      e.clientY,
    );
    const el = under
      .map((x) => x.closest<HTMLElement>('.af-block'))
      .find((x) => x && x.dataset.id !== d.id && !r.element(d.id)?.contains(x));
    if (!el) return setDrop(null);
    const row =
      el.querySelector<HTMLElement>(
        ':scope > .af-row, :scope > .af-code-wrap, :scope > .af-atom',
      ) ?? el;
    const box = row.getBoundingClientRect();
    const wb = wrap.getBoundingClientRect();
    const type = r.blocks.get(el.dataset.id!)?.type ?? '';
    const nestable = ['bulleted_list', 'numbered_list', 'todo_list', 'toggle_list'].includes(type);
    let where: 'before' | 'after' | 'inside' =
      e.clientY < box.top + box.height / 2 ? 'before' : 'after';
    if (where === 'after' && nestable && e.clientX > box.left + 60) where = 'inside';
    d.target = { id: el.dataset.id!, where };
    const y = where === 'before' ? box.top : box.bottom;
    const left = box.left - wb.left + (where === 'inside' ? 28 : 0);
    setDrop({
      top: y - wb.top + wrap.scrollTop - 1,
      left,
      width: box.width - (where === 'inside' ? 28 : 0),
    });
  };
  const gripUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setDrop(null);
    if (!d) return;
    if (d.moved) setHover(null);
    if (!d.moved) {
      setMenu({ kind: 'block', at: { x: e.clientX, y: e.clientY + 8 }, id: d.id });
      return;
    }
    if (d.target) run({ name: 'move', id: d.id, target: d.target.id, where: d.target.where });
  };

  // ---- imperative API (outline, flashcards, toolbar in the page header) ----

  useImperativeHandle(ref, () => ({
    wrap: (before, after = before) => {
      syncSelection();
      const res = run({ name: 'copy' });
      run({ name: 'paste', markdown: before + (res?.text ?? '') + after });
    },
    insert: (text) => {
      run({ name: 'paste', markdown: text });
    },
    cloze: () => {
      const used = [...own.current.matchAll(/\{\{c(\d+)::/g)].map((m) => Number(m[1]));
      const n = used.length ? Math.max(...used) + 1 : 1;
      syncSelection();
      const res = run({ name: 'copy' });
      run({ name: 'paste', markdown: `{{c${n}::${res?.text ?? ''}}}` });
    },
    getSelection: () => {
      syncSelection();
      return run({ name: 'copy' }, { keepDom: true })?.plain ?? '';
    },
    goToLine: () => host.current?.focus(),
    goToHeading: (slug) => {
      const r = rend.current;
      if (!r) return false;
      for (const [id, b] of r.blocks) {
        if (b.type !== 'heading' && !(b.type === 'toggle_list' && b.data?.level)) continue;
        const text = (b.delta ?? []).map((o) => o.insert).join('');
        if (slugHeading(text) !== slug) continue;
        const path = r.paths.get(id)!;
        r.element(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        host.current?.focus();
        run({
          name: 'select',
          selection: { start: { path, offset: 0 }, end: { path, offset: 0 } },
        });
        return true;
      }
      return false;
    },
    focus: () => host.current?.focus(),
  }));

  // ---- render ----

  const closeMenus = () => {
    setMenu(null);
    host.current?.focus();
    if (sel.current) placeDom(sel.current);
  };
  const curBlock = () => {
    const id = caretId();
    return id ? rend.current?.blocks.get(id) : undefined;
  };

  const turnItems = (forId?: string): MenuItem[] => {
    const b = forId ? rend.current?.blocks.get(forId) : curBlock();
    const current = b ? itemOf(b.type, b.data) : undefined;
    return TURN_ITEMS.map((it) => ({
      id: `turn-${it.key}`,
      label: it.label,
      glyph: it.glyph,
      checked: current === it.key,
      onSelect: () => {
        if (forId) {
          const path = rend.current!.paths.get(forId)!;
          run({
            name: 'select',
            selection: { start: { path, offset: 0 }, end: { path, offset: 0 } },
          });
        }
        run({ name: 'turnInto', type: it.type, attrs: it.attrs });
        closeMenus();
      },
    }));
  };

  const blockItems = (id: string): MenuItem[] => [
    {
      id: 'turn',
      label: 'Turn into',
      glyph: '↻',
      children: turnItems(id),
      disabled: !hasText(rend.current?.blocks.get(id)?.type ?? ''),
    },
    {
      id: 'dup',
      label: 'Duplicate',
      glyph: '⧉',
      shortcut: `${MOD ? '⌘' : 'Ctrl+'}D`,
      onSelect: () => (run({ name: 'duplicate', id }), closeMenus()),
    },
    {
      id: 'up',
      label: 'Move up',
      glyph: '↑',
      onSelect: () => {
        const p = rend.current!.paths.get(id)!;
        run({
          name: 'select',
          selection: { start: { path: p, offset: 0 }, end: { path: p, offset: 0 } },
        });
        run({ name: 'moveUp' });
        closeMenus();
      },
    },
    {
      id: 'down',
      label: 'Move down',
      glyph: '↓',
      onSelect: () => {
        const p = rend.current!.paths.get(id)!;
        run({
          name: 'select',
          selection: { start: { path: p, offset: 0 }, end: { path: p, offset: 0 } },
        });
        run({ name: 'moveDown' });
        closeMenus();
      },
    },
    {
      id: 'del',
      label: 'Delete',
      glyph: '🗑',
      danger: true,
      shortcut: 'Del',
      onSelect: () => (run({ name: 'deleteBlock', id }), closeMenus()),
    },
  ];

  const nativePaste = () => {
    if (window.classpad?.paste) void window.classpad.paste();
    else void navigator.clipboard?.readText().then((t) => run({ name: 'paste', markdown: t }));
  };

  const menuItems = (m: MenuState): MenuItem[] => {
    switch (m.kind) {
      case 'block':
        return blockItems(m.id);
      case 'turn':
        return turnItems();
      case 'lang':
        return CODE_LANGUAGES.map(([v, label]) => ({
          id: `lang-${v || 'plain'}`,
          label,
          checked: String(rend.current?.blocks.get(m.id)?.data?.language ?? '') === v,
          onSelect: () => {
            run(
              { name: 'setAttrs', path: rend.current!.paths.get(m.id)!, attrs: { language: v } },
              { keepDom: true },
            );
            closeMenus();
          },
        }));
      case 'icon':
        return CALLOUT_ICONS.map((icon) => ({
          id: `icon-${icon}`,
          label: icon,
          onSelect: () => {
            run(
              { name: 'setAttrs', path: rend.current!.paths.get(m.id)!, attrs: { icon } },
              { keepDom: true },
            );
            closeMenus();
          },
        }));
      case 'context': {
        const hasSel = sel.current ? !samePos(sel.current.start, sel.current.end) : false;
        const k = MOD ? '⌘' : 'Ctrl+';
        const clip: MenuItem[] = [
          {
            id: 'cut',
            label: 'Cut',
            glyph: '✂',
            shortcut: `${k}X`,
            disabled: !hasSel,
            onSelect: () => {
              document.execCommand('cut');
              closeMenus();
            },
          },
          {
            id: 'copy',
            label: 'Copy',
            glyph: '⧉',
            shortcut: `${k}C`,
            disabled: !hasSel,
            onSelect: () => {
              document.execCommand('copy');
              closeMenus();
            },
          },
          {
            id: 'paste',
            label: 'Paste',
            glyph: '📋',
            shortcut: `${k}V`,
            onSelect: () => {
              closeMenus();
              nativePaste();
            },
          },
        ];
        return m.id
          ? [
              ...clip,
              ...blockItems(m.id).map((it, i) => (i === 0 ? { ...it, section: 'Block' } : it)),
            ]
          : clip;
      }
    }
  };

  const slashItems = slash
    ? slash.wiki
      ? wikiMatches(slash.query)
      : filterItems(slash.query, mods.current)
    : [];

  return (
    <div
      className="be-scroll"
      ref={wrapRef}
      onMouseMove={onHover}
      onMouseLeave={() => !drag.current && setHover(null)}
    >
      {status === 'loading' && <p className="muted be-status">Opening the editor…</p>}
      {status === 'failed' && (
        <p className="be-status" role="alert">
          The editor could not start. Switch to Source mode from the ⋯ menu to keep writing.
        </p>
      )}
      <div
        ref={host}
        className="be-page"
        contentEditable={status === 'ready'}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Note"
        spellCheck
        tabIndex={0}
      />
      {hover && status === 'ready' && (
        <div className="be-handle" style={{ top: hover.top }} contentEditable={false}>
          <button
            type="button"
            className="be-plus"
            aria-label="Add a block below"
            title="Click to add a block below"
            onMouseDown={(e) => e.preventDefault()}
            onClick={plus}
          >
            +
          </button>
          <button
            type="button"
            className="be-grip"
            aria-label="Drag to move, click for block menu"
            title="Drag to move · Click for menu"
            onPointerDown={gripDown}
            onPointerMove={gripMove}
            onPointerUp={gripUp}
          >
            ⋮⋮
          </button>
        </div>
      )}
      {drop && <div className="be-drop" style={drop} aria-hidden="true" />}

      {slash &&
        slashItems.length > 0 &&
        createPortal(
          <div
            className="lp-menu be-slash"
            role="listbox"
            tabIndex={0}
            aria-label={slash.wiki ? 'Link to note' : 'Insert a block'}
            style={{ left: slash.at.x, top: slash.at.y }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {slash.wiki
              ? (slashItems as string[]).map((t, i) => (
                  <div
                    key={t}
                    role="option"
                    aria-selected={i === slash.active}
                    className={`lp-menu-item${i === slash.active ? ' active' : ''}`}
                    onClick={() => chooseWiki(t)}
                  >
                    <span className="lp-menu-glyph" aria-hidden="true">
                      ↗
                    </span>
                    <span className="lp-menu-label">{t}</span>
                  </div>
                ))
              : (slashItems as BlockItem[]).map((it, i, all) => (
                  <div key={it.key}>
                    {(i === 0 || all[i - 1]!.section !== it.section) && !slash.query && (
                      <div className="lp-menu-section" role="presentation">
                        {it.section}
                      </div>
                    )}
                    <div
                      role="option"
                      aria-selected={i === slash.active}
                      className={`lp-menu-item${i === slash.active ? ' active' : ''}`}
                      onClick={() => choose(it, slash.query.length + 1)}
                      onMouseEnter={() => setSlash({ ...slash, active: i })}
                    >
                      <span className="lp-menu-glyph" aria-hidden="true">
                        {it.glyph}
                      </span>
                      <span className="be-slash-text">
                        <span className="lp-menu-label">{it.label}</span>
                        <span className="be-slash-hint">{it.hint}</span>
                      </span>
                      {it.shortcut && <span className="lp-menu-shortcut">{it.shortcut}</span>}
                    </div>
                  </div>
                ))}
          </div>,
          document.body,
        )}

      {toolbar &&
        !slash &&
        !menu &&
        !pop &&
        createPortal(
          <Toolbar
            rect={toolbar}
            marks={marks}
            flashcards={flashcards}
            onMark={(m) => run({ name: 'toggleMark', mark: m })}
            onLink={openLink}
            onMath={() => {
              const res = run({ name: 'copy' }, { keepDom: true });
              run({ name: 'insertFormula', text: res?.plain || 'x' });
            }}
            onCard={() => {
              const used = [...own.current.matchAll(/\{\{c(\d+)::/g)].map((m) => Number(m[1]));
              const n = used.length ? Math.max(...used) + 1 : 1;
              const res = run({ name: 'copy' }, { keepDom: true });
              run({ name: 'paste', markdown: `{{c${n}::${res?.text ?? ''}}}` });
            }}
            onTurn={(r) => setMenu({ kind: 'turn', at: { x: r.left, y: r.bottom + 4 } })}
          />,
          document.body,
        )}

      {menu && (
        <FloatingMenu
          at={menu.at}
          items={menuItems(menu)}
          onClose={closeMenus}
          label={
            menu.kind === 'lang'
              ? 'Code language'
              : menu.kind === 'icon'
                ? 'Callout icon'
                : 'Block options'
          }
        />
      )}

      {pop && (
        <PopoverEditor
          pop={pop}
          onClose={() => {
            setPop(null);
            host.current?.focus();
            if (sel.current) placeDom(sel.current);
          }}
          onSave={(v) => {
            const r = rend.current!;
            if (pop.kind === 'link') run({ name: 'setLink', href: v.trim() });
            if (pop.kind === 'formula')
              run(
                { name: 'setFormula', path: pop.path, offset: pop.offset, text: v },
                { keepDom: true },
              );
            if (pop.kind === 'math')
              run(
                { name: 'setAttrs', path: r.paths.get(pop.id)!, attrs: { formula: v } },
                { keepDom: true },
              );
            if (pop.kind === 'raw')
              run(
                { name: 'setAttrs', path: r.paths.get(pop.id)!, attrs: { text: v } },
                { keepDom: true },
              );
            if (pop.kind === 'image')
              run(
                { name: 'setAttrs', path: r.paths.get(pop.id)!, attrs: { alt: v } },
                { keepDom: true },
              );
          }}
        />
      )}
    </div>
  );
});

function Toolbar({
  rect,
  marks,
  flashcards,
  onMark,
  onLink,
  onMath,
  onCard,
  onTurn,
}: {
  rect: DOMRect;
  marks: Attrs;
  flashcards: boolean;
  onMark: (m: string) => void;
  onLink: () => void;
  onMath: () => void;
  onCard: () => void;
  onTurn: (r: DOMRect) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => setW(ref.current?.offsetWidth ?? 0), [flashcards]);
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), window.innerWidth - w - 8);
  const btn = (label: string, title: string, run: () => void, on = false, cls = '') => (
    <button
      key={title}
      type="button"
      className={`lp-bub-btn ${cls}${on ? ' on' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={on}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {label}
    </button>
  );
  const k = MOD ? '⌘' : 'Ctrl+';
  return (
    <div
      ref={ref}
      className="lp-bubble be-toolbar"
      role="toolbar"
      aria-label="Format selected text"
      style={{ left, top: Math.max(8, rect.top - 46) }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className="lp-bub-btn lp-bub-turn"
        aria-haspopup="menu"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => onTurn(e.currentTarget.getBoundingClientRect())}
      >
        Turn into ▾
      </button>
      <span className="lp-bub-sep" aria-hidden="true" />
      {btn('B', `Bold (${k}B)`, () => onMark('bold'), !!marks.bold, 'b')}
      {btn('I', `Italic (${k}I)`, () => onMark('italic'), !!marks.italic, 'i')}
      {btn('U', `Underline (${k}U)`, () => onMark('underline'), !!marks.underline, 'u')}
      {btn(
        'S',
        `Strikethrough (${k}⇧S)`,
        () => onMark('strikethrough'),
        !!marks.strikethrough,
        's',
      )}
      {btn('<>', `Inline code (${k}E)`, () => onMark('code'), !!marks.code, 'mono')}
      {btn('Σ', 'Equation', onMath)}
      {btn('🔗', `Link (${k}K)`, onLink, typeof marks.href === 'string')}
      {flashcards && btn('{{ }}', 'Flashcard blank', onCard)}
    </div>
  );
}

function PopoverEditor({
  pop,
  onClose,
  onSave,
}: {
  pop: Popover;
  onClose: () => void;
  onSave: (v: string) => void;
}) {
  const [v, setV] = useState(pop.value);
  const ref = useRef<HTMLDivElement>(null);
  const multiline = pop.kind === 'math' || pop.kind === 'raw';
  const label = {
    link: 'Link address',
    formula: 'Equation (LaTeX)',
    math: 'Equation (LaTeX)',
    raw: 'Markdown',
    image: 'Image description',
  }[pop.kind];
  const save = () => {
    onSave(v);
    onClose();
  };
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) save();
    };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  });
  const preview =
    (pop.kind === 'math' || pop.kind === 'formula') && v ? mathPreview(v, pop.kind === 'math') : '';
  const field = {
    autoFocus: true,
    'aria-label': label,
    className: 'input be-pop-field',
    value: v,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setV(e.target.value),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      if (e.key === 'Enter' && (!multiline || modKey(e))) {
        e.preventDefault();
        save();
      }
    },
  };
  return createPortal(
    <div
      ref={ref}
      className="be-pop"
      role="dialog"
      aria-label={label}
      style={{
        left: Math.min(pop.at.x, window.innerWidth - 380),
        top: Math.min(pop.at.y, window.innerHeight - 200),
      }}
    >
      <div className="small muted">{label}</div>
      {multiline ? (
        <textarea rows={4} {...field} />
      ) : (
        <input placeholder={pop.kind === 'link' ? 'https://…' : ''} {...field} />
      )}
      {preview && <div className="be-pop-preview" dangerouslySetInnerHTML={{ __html: preview }} />}
      <div className="be-pop-actions">
        {pop.kind === 'link' && pop.value && (
          <button type="button" className="btn ghost small" onClick={() => (onSave(''), onClose())}>
            Remove link
          </button>
        )}
        <button type="button" className="btn primary small" onClick={save}>
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}

function mathPreview(src: string, display: boolean): string {
  try {
    return katex.renderToString(src, { throwOnError: false, displayMode: display });
  } catch {
    return '';
  }
}
