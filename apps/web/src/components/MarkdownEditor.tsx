import { closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { BubbleBar, EditorMenu, type BubbleState, type MenuState } from './EditorMenus.js';
import { blockHandles, handleHooks } from '../editor/handle.js';
import { editorKeys, wrap } from '../editor/keys.js';
import { liveCallbacks, liveEnabled, livePreview } from '../editor/live.js';
import { editorActions, slashMenu } from '../editor/slash.js';
import { uploadForMarkdown } from '../lib/attachments.js';
import { slugHeading } from './Markdown.js';
import { useUi } from '../lib/store.js';

export interface EditorHandle {
  /** Wrap the selection (or insert the pair) e.g. wrap('**') or wrap('$', '$'). */
  wrap(before: string, after?: string): void;
  insert(text: string): void;
  cloze(): void;
  getSelection(): string;
  goToLine(line: number): void;
  /** Scroll to the heading whose slug matches (outline clicks, `[[Note#Heading]]` links). */
  goToHeading(slug: string): boolean;
  focus(): void;
  /** The underlying view, for menus that act on blocks. */
  view(): EditorView | null;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  getTitles?: () => string[];
  onCursorLine?: (line: number) => void;
  /** Show the raw Markdown instead of the live view. */
  sourceMode?: boolean;
  onOpenWiki?: (target: string, heading?: string) => void;
  onOpenAttachment?: (hash: string, ext: string, name: string) => void;
  /** Called when the view is created or replaced, so menus can attach to it. */
  onView?: (v: EditorView | null) => void;
}

/** Token colours for code inside code blocks (always on). */
const codeStyle = HighlightStyle.define([
  { tag: [t.keyword, t.operator], color: 'var(--primary)' },
  { tag: [t.string, t.regexp], color: 'var(--success)' },
  { tag: [t.number, t.bool, t.atom], color: 'var(--warning)' },
  { tag: t.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.className, t.typeName], color: 'var(--info)' },
]);

/** Extra colouring only for source mode (the live view styles these itself). */
const sourceStyle = HighlightStyle.define([
  { tag: t.heading, color: 'var(--primary)', fontWeight: '650' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--info)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', color: 'var(--secondary)' },
  { tag: t.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--text-muted)' },
]);

const theme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'transparent', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-placeholder': { color: 'var(--text-muted)' },
  '.cm-tooltip': {
    background: 'var(--surface-solid)',
    border: '1px solid var(--border-strong)',
    borderRadius: '12px',
    boxShadow: 'var(--shadow-lg)',
    color: 'var(--text)',
  },
});

export const MarkdownEditor = forwardRef<EditorHandle, Props>(function MarkdownEditor(
  {
    value,
    onChange,
    getTitles,
    onCursorLine,
    sourceMode = false,
    onOpenWiki,
    onOpenAttachment,
    onView,
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({
    onChange,
    getTitles,
    onCursorLine,
    onOpenWiki,
    onOpenAttachment,
    onView,
  });
  latest.current = { onChange, getTitles, onCursorLine, onOpenWiki, onOpenAttachment, onView };
  const own = useRef(value);
  const toast = useUi((s) => s.toast);
  const mode = useRef(new Compartment());
  const [menu, setMenu] = useState<MenuState>(null);
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  const [cur, setCur] = useState<EditorView | null>(null);
  const flashcards = useUi((s) => !!s.modules.flashcards);
  const menuOpen = useRef(false);
  menuOpen.current = !!menu;

  useImperativeHandle(ref, () => ({
    wrap: (b, a) => {
      const v = view.current;
      if (v) {
        wrap(b, a)(v);
        v.focus();
      }
    },
    insert: (text) => {
      const v = view.current;
      if (!v) return;
      v.dispatch(v.state.replaceSelection(text));
      v.focus();
    },
    cloze: () => {
      const v = view.current;
      if (!v) return;
      const used = [...v.state.doc.toString().matchAll(/\{\{c(\d+)::/g)].map((m) => Number(m[1]));
      const n = (used.length ? Math.max(...used) : 0) + 1;
      wrap(`{{c${n}::`, '}}')(v);
      v.focus();
    },
    getSelection: () => {
      const v = view.current;
      if (!v) return '';
      const { from, to } = v.state.selection.main;
      return v.state.sliceDoc(from, to);
    },
    goToLine: (line) => {
      const v = view.current;
      if (!v) return;
      const l = v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines));
      v.dispatch({
        selection: { anchor: l.from },
        effects: EditorView.scrollIntoView(l.from, { y: 'start', yMargin: 24 }),
      });
      v.focus();
    },
    goToHeading: (slug) => {
      const v = view.current;
      if (!v) return false;
      let fence = false;
      for (let n = 1; n <= v.state.doc.lines; n++) {
        const l = v.state.doc.line(n);
        if (/^\s*(```|~~~)/.test(l.text)) fence = !fence;
        const m = !fence && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l.text);
        if (m && slugHeading(m[1]!) === slug) {
          v.dispatch({
            selection: { anchor: l.from },
            effects: EditorView.scrollIntoView(l.from, { y: 'start', yMargin: 24 }),
          });
          return true;
        }
      }
      return false;
    },
    focus: () => view.current?.focus(),
    view: () => view.current,
  }));

  useEffect(() => {
    if (!host.current) return;
    const files = async (v: EditorView, list: File[]) => {
      for (const f of list) {
        try {
          const md = await uploadForMarkdown(f);
          const head = v.state.selection.main.head;
          const atLineStart = v.state.doc.lineAt(head).from === head;
          v.dispatch(v.state.replaceSelection((atLineStart ? '' : '\n\n') + md + '\n'));
        } catch (e) {
          toast(`Could not add ${f.name || 'file'}: ${(e as Error).message}`);
        }
      }
    };
    const pickFiles = (v: EditorView) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.onchange = () => void files(v, [...(input.files ?? [])]);
      input.click();
    };
    let raf = 0;
    const updateBubble = (v: EditorView) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const s = v.state.selection.main;
        if (s.empty || (!v.hasFocus && !menuOpen.current) || s.to - s.from > 5000)
          return setBubble(null);
        const a = v.coordsAtPos(s.from);
        const b = v.coordsAtPos(s.to);
        if (!a || !b) return setBubble(null);
        const sameLine = Math.abs(a.top - b.top) < 4;
        const x = sameLine ? (a.left + b.right) / 2 : a.left + 60;
        setBubble((p) =>
          p && Math.abs(p.x - x) < 1 && Math.abs(p.top - a.top) < 1
            ? p
            : { x, top: a.top, pos: s.from },
        );
      });
    };
    const wikiSource = (ctx: import('@codemirror/autocomplete').CompletionContext) => {
      const m = ctx.matchBefore(/\[\[[^\]\n]*$/);
      if (!m) return null;
      const typed = m.text.slice(2).toLowerCase();
      const titles = (latest.current.getTitles?.() ?? [])
        .filter((x) => x.toLowerCase().includes(typed))
        .slice(0, 30);
      return {
        from: m.from + 2,
        options: titles.map((label) => ({ label, apply: `${label}]]`, type: 'text' })),
        filter: false,
      };
    };
    const extensions: Extension[] = [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      closeBrackets(),
      // our own Enter/Backspace handling goes first; the stock Markdown keymap is added below as a fallback
      markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
      syntaxHighlighting(codeStyle),
      mode.current.of([
        liveEnabled.of(!sourceMode),
        sourceMode ? syntaxHighlighting(sourceStyle) : [],
      ]),
      livePreview(),
      liveCallbacks.of({
        openWiki: (target, heading) => latest.current.onOpenWiki?.(target, heading),
        openAttachment: (h, e, n) => latest.current.onOpenAttachment?.(h, e, n),
        openLanguageMenu: (at, codeFrom) => setMenu({ kind: 'lang', at, pos: codeFrom }),
      }),
      editorActions.of({ pickFiles }),
      theme,
      placeholder('Write something, or type / for blocks'),
      slashMenu([wikiSource]),
      editorKeys(),
      blockHandles(),
      handleHooks.of({
        openBlockMenu: (at, pos) => setMenu({ kind: 'block', at, pos }),
        openContextMenu: (at, pos) => setMenu({ kind: 'context', at, pos }),
      }),
      keymap.of([
        ...closeBracketsKeymap,
        ...markdownKeymap,
        ...completionKeymap,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.contentAttributes.of({ 'aria-label': 'Note editor', spellcheck: 'true' }),
      EditorView.domEventHandlers({
        paste: (e, v) => {
          const fs = [...(e.clipboardData?.files ?? [])].filter((f) =>
            /^(image\/|application\/pdf)/.test(f.type),
          );
          if (fs.length) {
            e.preventDefault();
            void files(v, fs);
            return true;
          }
          // pasting a link over selected text makes it a link
          const text = e.clipboardData?.getData('text/plain')?.trim() ?? '';
          const sel = v.state.selection.main;
          if (!sel.empty && /^https?:\/\/\S+$/.test(text)) {
            e.preventDefault();
            const s = v.state.sliceDoc(sel.from, sel.to);
            v.dispatch({
              changes: { from: sel.from, to: sel.to, insert: `[${s}](${text})` },
              userEvent: 'input.paste',
            });
            return true;
          }
          return false;
        },
        drop: (e, v) => {
          const fs = [...(e.dataTransfer?.files ?? [])].filter((f) =>
            /^(image\/|application\/pdf)/.test(f.type),
          );
          if (!fs.length) return false;
          e.preventDefault();
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos !== null) v.dispatch({ selection: { anchor: pos } });
          void files(v, fs);
          return true;
        },
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          own.current = u.state.doc.toString();
          latest.current.onChange(own.current);
        }
        if (u.selectionSet || u.docChanged)
          latest.current.onCursorLine?.(u.state.doc.lineAt(u.state.selection.main.head).number);
        if (u.selectionSet || u.docChanged || u.focusChanged || u.geometryChanged)
          updateBubble(u.view);
      }),
    ];
    view.current = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host.current,
    });
    latest.current.onView?.(view.current);
    setCur(view.current);
    return () => {
      cancelAnimationFrame(raf);
      setCur(null);
      latest.current.onView?.(null);
      view.current?.destroy();
      view.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // live view <-> source mode
  useEffect(() => {
    view.current?.dispatch({
      effects: mode.current.reconfigure([
        liveEnabled.of(!sourceMode),
        sourceMode ? syntaxHighlighting(sourceStyle) : [],
      ]),
    });
  }, [sourceMode]);

  // accept external changes (switching notes, file changed on disk)
  useEffect(() => {
    const v = view.current;
    if (v && value !== own.current) {
      own.current = value;
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: value },
        selection: EditorSelection.single(0),
      });
    }
  }, [value]);

  const paste = () => {
    if (window.classpad?.paste) void window.classpad.paste();
    else
      void navigator.clipboard
        ?.readText()
        .then((t) => cur?.dispatch(cur.state.replaceSelection(t)));
  };
  return (
    <>
      <div ref={host} className="cm-host" />
      {cur && menu && (
        <EditorMenu view={cur} state={menu} paste={paste} onClose={() => setMenu(null)} />
      )}
      {cur && bubble && !sourceMode && (
        <BubbleBar
          view={cur}
          at={bubble}
          flashcards={flashcards}
          onCard={() => wrap('{{c1::', '}}')(cur)}
          onTurn={(r) =>
            setMenu({ kind: 'turn', at: { x: r.left, y: r.bottom + 4 }, pos: bubble.pos })
          }
        />
      )}
    </>
  );
});
