import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionContext,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  placeholder,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { uploadForMarkdown } from '../lib/attachments.js';
import { useUi } from '../lib/store.js';

export interface EditorHandle {
  /** Wrap the selection (or insert the pair) e.g. wrap('**') or wrap('$', '$'). */
  wrap(before: string, after?: string): void;
  insert(text: string): void;
  /** Prefix each selected line, e.g. '- [ ] '. */
  prefixLines(prefix: string): void;
  cloze(): void;
  getSelection(): string;
  goToLine(line: number): void;
  focus(): void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  getTitles?: () => string[];
  onCursorLine?: (line: number) => void;
}

const style = HighlightStyle.define([
  { tag: t.heading, color: 'var(--primary)', fontWeight: '650' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--info)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', color: 'var(--secondary)' },
  { tag: t.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--text-muted)' },
  { tag: [t.keyword, t.operator], color: 'var(--primary)' },
  { tag: [t.string, t.regexp], color: 'var(--success)' },
  { tag: [t.number, t.bool, t.atom], color: 'var(--warning)' },
  { tag: t.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
]);

const theme = EditorView.theme({
  '&': {
    color: 'var(--text)',
    backgroundColor: 'transparent',
    height: '100%',
    fontSize: '0.95rem',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-sans)', lineHeight: '1.7', padding: '8px 4px' },
  '.cm-content': { caretColor: 'var(--primary)', padding: '0 12px' },
  '.cm-cursor': { borderLeftColor: 'var(--primary)', borderLeftWidth: '2px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--accent) 6%, transparent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'color-mix(in oklab, var(--accent) 30%, transparent) !important',
  },
  '.cm-placeholder': { color: 'var(--text-muted)' },
  '.cm-tooltip': {
    background: 'var(--surface-solid)',
    border: '1px solid var(--border-strong)',
    borderRadius: '10px',
    boxShadow: 'var(--shadow-md)',
    color: 'var(--text)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    background: 'color-mix(in oklab, var(--accent) 22%, transparent)',
    color: 'var(--text)',
  },
});

const wrapSel = (view: EditorView, before: string, after = before) => {
  view.dispatch(
    view.state.changeByRange((r) => {
      const sel = view.state.sliceDoc(r.from, r.to);
      // toggle off when already wrapped
      if (
        sel.length >= before.length + after.length &&
        sel.startsWith(before) &&
        sel.endsWith(after)
      ) {
        const inner = sel.slice(before.length, sel.length - after.length);
        return {
          changes: { from: r.from, to: r.to, insert: inner },
          range: EditorSelection.range(r.from, r.from + inner.length),
        };
      }
      return {
        changes: { from: r.from, to: r.to, insert: before + sel + after },
        range: r.empty
          ? EditorSelection.cursor(r.from + before.length)
          : EditorSelection.range(r.from + before.length, r.to + before.length),
      };
    }),
  );
  view.focus();
};

export const MarkdownEditor = forwardRef<EditorHandle, Props>(function MarkdownEditor(
  { value, onChange, getTitles, onCursorLine },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, getTitles, onCursorLine });
  latest.current = { onChange, getTitles, onCursorLine };
  const own = useRef(value);
  const toast = useUi((s) => s.toast);

  useImperativeHandle(ref, () => ({
    wrap: (b, a) => view.current && wrapSel(view.current, b, a),
    insert: (text) => {
      const v = view.current;
      if (!v) return;
      v.dispatch(v.state.replaceSelection(text));
      v.focus();
    },
    prefixLines: (prefix) => {
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      const changes = [];
      for (let ln = v.state.doc.lineAt(from).number; ln <= v.state.doc.lineAt(to).number; ln++)
        changes.push({ from: v.state.doc.line(ln).from, insert: prefix });
      v.dispatch({ changes });
      v.focus();
    },
    cloze: () => {
      const v = view.current;
      if (!v) return;
      const used = [...v.state.doc.toString().matchAll(/\{\{c(\d+)::/g)].map((m) => Number(m[1]));
      const n = (used.length ? Math.max(...used) : 0) + 1;
      wrapSel(v, `{{c${n}::`, '}}');
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
    focus: () => view.current?.focus(),
  }));

  useEffect(() => {
    if (!host.current) return;
    const files = async (v: EditorView, list: File[]) => {
      for (const f of list) {
        try {
          const md = await uploadForMarkdown(f);
          const head = v.state.selection.main.head;
          const atLineStart = v.state.doc.lineAt(head).from === head;
          v.dispatch(v.state.replaceSelection((atLineStart ? '' : '\n') + md + '\n'));
        } catch (e) {
          toast(`Could not add ${f.name || 'file'}: ${(e as Error).message}`);
        }
      }
    };
    const wikiSource = (ctx: CompletionContext) => {
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
      highlightActiveLine(),
      EditorView.lineWrapping,
      closeBrackets(),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(style),
      theme,
      placeholder('Start writing… Markdown, $math$, [[links]], paste images'),
      autocompletion({ override: [wikiSource], icons: false }),
      keymap.of([
        { key: 'Mod-b', run: (v) => (wrapSel(v, '**'), true) },
        { key: 'Mod-i', run: (v) => (wrapSel(v, '*'), true) },
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
          if (!fs.length) return false;
          e.preventDefault();
          void files(v, fs);
          return true;
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
      }),
    ];
    view.current = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host.current,
    });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // accept external changes (switching notes, file changed on disk)
  useEffect(() => {
    const v = view.current;
    if (v && value !== own.current) {
      own.current = value;
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: value },
        selection: { anchor: 0 },
      });
    }
  }, [value]);

  return <div ref={host} className="cm-host" />;
});
