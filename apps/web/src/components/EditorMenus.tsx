import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EditorView } from '@codemirror/view';
import { BLOCKS, CODE_LANGUAGES, type BlockKind } from '../editor/blocks.js';
import { blockActions, link, wrap } from '../editor/keys.js';
import { blockAt } from '../editor/model.js';
import { FloatingMenu, type MenuItem } from './Menu.js';

export type MenuState = {
  kind: 'block' | 'context' | 'turn' | 'lang';
  at: { x: number; y: number };
  pos: number;
} | null;

const TURNABLE = BLOCKS.filter((b) => b.kind !== 'divider' && b.kind !== 'table');

/** The menus that act on blocks: the grip menu, the right-click menu, and "Turn into" from the selection toolbar. */
export function EditorMenu({
  view,
  state,
  onClose,
  paste,
}: {
  view: EditorView;
  state: NonNullable<MenuState>;
  onClose: () => void;
  paste: () => void;
}) {
  const sel = view.state.selection.main;
  const hasSel = !sel.empty;
  const block = blockAt(view.state, state.pos);
  const done = () => {
    onClose();
    view.focus();
  };
  const after = (fn: () => void) => () => {
    fn();
    view.focus();
  };

  const turn: MenuItem[] = TURNABLE.map((b) => ({
    id: `turn-${b.kind}`,
    label: b.label,
    glyph: b.glyph,
    checked: block?.kind === b.kind,
    onSelect: after(() => blockActions.turnInto(view, state.pos, b.kind)),
  }));
  const insert: MenuItem[] = BLOCKS.map((b) => ({
    id: `ins-${b.kind}`,
    label: b.label,
    glyph: b.glyph,
    section: b.section,
    onSelect: after(() => blockActions.insertAfter(view, state.pos, b.kind as BlockKind)),
  }));

  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  const clipboard: MenuItem[] = [
    {
      id: 'cut',
      label: 'Cut',
      glyph: '✂',
      shortcut: `${mod}X`,
      disabled: !hasSel,
      onSelect: after(() => {
        void navigator.clipboard?.writeText(view.state.sliceDoc(sel.from, sel.to));
        view.dispatch({ changes: { from: sel.from, to: sel.to }, userEvent: 'delete.cut' });
      }),
    },
    {
      id: 'copy',
      label: 'Copy',
      glyph: '⧉',
      shortcut: `${mod}C`,
      disabled: !hasSel,
      onSelect: after(
        () => void navigator.clipboard?.writeText(view.state.sliceDoc(sel.from, sel.to)),
      ),
    },
    {
      id: 'paste',
      label: 'Paste',
      glyph: '⎘',
      shortcut: `${mod}V`,
      onSelect: () => (view.focus(), paste()),
    },
  ];
  const format: MenuItem[] = hasSel
    ? [
        {
          id: 'bold',
          label: 'Bold',
          glyph: 'B',
          shortcut: `${mod}B`,
          section: 'Format',
          onSelect: after(() => wrap('**')(view)),
        },
        {
          id: 'italic',
          label: 'Italic',
          glyph: 'I',
          shortcut: `${mod}I`,
          onSelect: after(() => wrap('*')(view)),
        },
        {
          id: 'strike',
          label: 'Strikethrough',
          glyph: 'S',
          onSelect: after(() => wrap('~~')(view)),
        },
        {
          id: 'code',
          label: 'Code',
          glyph: '<>',
          shortcut: `${mod}E`,
          onSelect: after(() => wrap('`')(view)),
        },
        { id: 'math', label: 'Equation', glyph: 'Σ', onSelect: after(() => wrap('$')(view)) },
        {
          id: 'link',
          label: 'Link',
          glyph: '🔗',
          shortcut: `${mod}K`,
          onSelect: after(() => link(view)),
        },
      ]
    : [];
  const blockItems: MenuItem[] = block
    ? [
        { id: 'turn', label: 'Turn into', glyph: '↻', section: 'Block', children: turn },
        { id: 'insert', label: 'Insert below', glyph: '＋', children: insert },
        {
          id: 'dup',
          label: 'Duplicate',
          glyph: '⧉',
          shortcut: `${mod}D`,
          onSelect: after(() => blockActions.duplicate(view, state.pos)),
        },
        {
          id: 'up',
          label: 'Move up',
          glyph: '↑',
          shortcut: `${mod}⇧↑`,
          disabled: block.index === 0,
          onSelect: after(() => blockActions.move(view, state.pos, -1)),
        },
        {
          id: 'down',
          label: 'Move down',
          glyph: '↓',
          shortcut: `${mod}⇧↓`,
          disabled: block.index === block.siblings.length - 1,
          onSelect: after(() => blockActions.move(view, state.pos, 1)),
        },
        {
          id: 'del',
          label: 'Delete',
          glyph: '🗑',
          danger: true,
          onSelect: after(() => blockActions.remove(view, state.pos)),
        },
      ]
    : [];

  if (state.kind === 'lang') {
    const fence = view.state.doc.lineAt(Math.max(0, state.pos - 1)).text;
    const current = /^\s*(?:`{3,}|~{3,})([\w+#-]*)/.exec(fence)?.[1] ?? '';
    const langs: MenuItem[] = CODE_LANGUAGES.map(([id, label]) => ({
      id: `lang-${id || 'plain'}`,
      label,
      checked: id === current,
      onSelect: after(() => blockActions.setCodeLanguage(view, state.pos, id)),
    }));
    return <FloatingMenu at={state.at} items={langs} onClose={done} label="Code language" />;
  }
  const items =
    state.kind === 'turn'
      ? turn
      : state.kind === 'block'
        ? blockItems
        : [...clipboard, ...format, ...blockItems];
  return (
    <FloatingMenu
      at={state.at}
      items={items}
      onClose={done}
      label={state.kind === 'turn' ? 'Turn into' : 'Block options'}
    />
  );
}

export interface BubbleState {
  /** Viewport coordinates of the selection. */
  x: number;
  top: number;
  pos: number;
}

/** The small toolbar that floats above selected text. */
export function BubbleBar({
  view,
  at,
  onTurn,
  flashcards,
  onCard,
}: {
  view: EditorView;
  at: BubbleState;
  onTurn: (r: DOMRect) => void;
  flashcards: boolean;
  onCard: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => setW(ref.current?.offsetWidth ?? 0), [flashcards]);
  const left = Math.min(Math.max(8, at.x - w / 2), window.innerWidth - w - 8);
  const btn = (label: string, title: string, run: () => void, cls = '') => (
    <button
      key={title}
      type="button"
      className={`lp-bub-btn ${cls}`}
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        run();
        view.focus();
      }}
    >
      {label}
    </button>
  );
  return createPortal(
    <div
      ref={ref}
      className="lp-bubble"
      role="toolbar"
      aria-label="Format selected text"
      style={{ left, top: Math.max(8, at.top - 46) }}
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
      {btn('B', 'Bold', () => wrap('**')(view), 'b')}
      {btn('I', 'Italic', () => wrap('*')(view), 'i')}
      {btn('S', 'Strikethrough', () => wrap('~~')(view), 's')}
      {btn('<>', 'Inline code', () => wrap('`')(view), 'mono')}
      {btn('Σ', 'Equation', () => wrap('$')(view))}
      {btn('🔗', 'Link', () => link(view))}
      {flashcards && btn('{{ }}', 'Flashcard blank', () => onCard())}
    </div>,
    document.body,
  );
}
