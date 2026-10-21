import {
  autocompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { Facet, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { BLOCKS, type BlockKind } from './blocks.js';
import { slashEdit, tree } from './model.js';

/** Things the "/" menu can do that need the page (a file picker). */
export interface EditorActions {
  pickFiles(view: EditorView): void;
}
export const editorActions = Facet.define<EditorActions, EditorActions>({
  combine: (v) => v[0] ?? { pickFiles: () => undefined },
});

interface Command {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  section: string;
  glyph: string;
  shortcut?: string;
  run(view: EditorView, from: number, to: number): void;
}

const blockCommand = (b: (typeof BLOCKS)[number]): Command => ({
  id: b.kind,
  label: b.label,
  hint: b.hint,
  keywords: b.keywords,
  section: b.section,
  glyph: b.glyph,
  shortcut: b.shortcut,
  run: (view, from, to) => applyBlock(view, from, to, b.kind),
});

export function applyBlock(view: EditorView, from: number, to: number, kind: BlockKind) {
  const e = slashEdit(view.state, from, to, kind);
  view.dispatch({
    changes: e.changes,
    selection: { anchor: e.select.anchor, head: e.select.head ?? e.select.anchor },
    scrollIntoView: true,
    userEvent: 'input.complete',
  });
  view.focus();
}

const insertAt = (view: EditorView, from: number, to: number, text: string, caret: number) => {
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + caret },
    userEvent: 'input.complete',
    scrollIntoView: true,
  });
  view.focus();
};

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const EXTRA: Command[] = [
  {
    id: 'link',
    label: 'Link to note',
    hint: 'Link to another note.',
    keywords: 'page wiki mention',
    section: 'Inline',
    glyph: '[[',
    run: (v, f, t) => {
      insertAt(v, f, t, '[[]]', 2);
      startCompletion(v);
    },
  },
  {
    id: 'math-inline',
    label: 'Inline equation',
    hint: 'Math inside a sentence.',
    keywords: 'latex katex formula',
    section: 'Inline',
    glyph: 'Σ',
    run: (v, f, t) => insertAt(v, f, t, '$$', 1),
  },
  {
    id: 'cloze',
    label: 'Flashcard blank',
    hint: 'Hide a word for flashcards.',
    keywords: 'cloze flashcard card',
    section: 'Inline',
    glyph: '{{ }}',
    run: (v, f, t) => {
      const used = [...v.state.doc.toString().matchAll(/\{\{c(\d+)::/g)].map((m) => Number(m[1]));
      const n = (used.length ? Math.max(...used) : 0) + 1;
      insertAt(v, f, t, `{{c${n}::}}`, `{{c${n}::`.length);
    },
  },
  {
    id: 'date',
    label: 'Today’s date',
    hint: 'Insert the date.',
    keywords: 'today now time',
    section: 'Inline',
    glyph: '📅',
    run: (v, f, t) => insertAt(v, f, t, today(), today().length),
  },
  {
    id: 'file',
    label: 'Image or file',
    hint: 'Upload an image, PDF or file.',
    keywords: 'image picture photo pdf attachment upload',
    section: 'Media',
    glyph: '🖼',
    run: (v, f, t) => {
      v.dispatch({ changes: { from: f, to: t } });
      v.state.facet(editorActions).pickFiles(v);
    },
  },
];

const SECTION_RANK: Record<string, number> = {
  'Basic blocks': 0,
  Toggles: 1,
  Advanced: 2,
  Inline: 3,
  Media: 4,
};

const COMMANDS: Command[] = [...BLOCKS.map(blockCommand), ...EXTRA];

const score = (c: Command, q: string): number => {
  if (!q) return 1;
  const label = c.label.toLowerCase();
  if (label.startsWith(q)) return 4;
  if (label.split(' ').some((w) => w.startsWith(q))) return 3;
  if (c.id.startsWith(q)) return 3;
  if (label.includes(q)) return 2;
  if (
    c.keywords
      .toLowerCase()
      .split(' ')
      .some((w) => w.startsWith(q))
  )
    return 2;
  if (c.keywords.toLowerCase().includes(q)) return 1;
  return 0;
};

export function slashCommands(query: string): Command[] {
  const q = query.trim().toLowerCase();
  return COMMANDS.map((c, i) => ({ c, s: score(c, q), i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}

function slashSource(ctx: CompletionContext): CompletionResult | null {
  const m = ctx.matchBefore(/\/[\w-]*(?: [\w-]*)?$/);
  if (!m) return null;
  const line = ctx.state.doc.lineAt(m.from);
  const before = line.text.slice(0, m.from - line.from);
  if (before.length && !/[\s>]$|^\s*[-*+] (\[.\] )?$/.test(before) && !/\s$/.test(before))
    return null; // "a/b", "http://x/y"
  // not inside code
  let inCode = false;
  tree(ctx.state).iterate({
    from: m.from,
    to: m.from,
    enter: (n) => {
      if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'InlineCode')
        inCode = true;
    },
  });
  if (inCode) return null;
  const found = slashCommands(m.text.slice(1));
  if (!found.length) return null;
  const options: Completion[] = found.map((c) => ({
    label: c.label,
    detail: c.shortcut,
    info: undefined,
    section: { name: c.section, rank: SECTION_RANK[c.section] ?? 9 },
    type: `lp-${c.id}`,
    boost: 0,
    apply: (view, _c, from, to) => c.run(view, from, to),
    // carried for the renderers below
    ...({ glyph: c.glyph, hint: c.hint } as object),
  }));
  return { from: m.from, options, filter: false };
}

export const slashMenu = (more: CompletionSource[] = []): Extension =>
  autocompletion({
    override: [slashSource, ...more],
    icons: false,
    defaultKeymap: true,
    maxRenderedOptions: 40,
    activateOnTypingDelay: 20,
    closeOnBlur: true,
    optionClass: () => 'lp-slash-opt',
    addToOptions: [
      {
        position: 10,
        render: (c, _state, view) => {
          // the list scrolls, so it has to be reachable from the keyboard
          queueMicrotask(() =>
            view.dom.querySelector('.cm-tooltip-autocomplete > ul')?.setAttribute('tabindex', '0'),
          );
          const e = document.createElement('span');
          e.className = 'lp-slash-glyph';
          e.setAttribute('aria-hidden', 'true');
          e.textContent = (c as unknown as { glyph?: string }).glyph ?? '';
          return e;
        },
      },
      {
        position: 90,
        render: (c) => {
          const e = document.createElement('span');
          e.className = 'lp-slash-hint';
          e.textContent = (c as unknown as { hint?: string }).hint ?? '';
          return e;
        },
      },
    ],
    tooltipClass: () => 'lp-slash',
  });
