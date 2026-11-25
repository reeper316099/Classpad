/** The blocks the slash menu, "Turn into" and the + button offer, mapped to the Go core's block types. */
import type { Attrs } from './core.js';

export interface BlockItem {
  key: string;
  label: string;
  hint: string;
  keywords: string;
  section: 'Basic blocks' | 'Toggles' | 'Media' | 'Advanced' | 'Inline';
  glyph: string;
  /** What typing at the start of a line does, shown on the right like AppFlowy and Notion. */
  shortcut?: string;
  type: string;
  attrs?: Attrs;
  /** Can an existing text block be turned into this? */
  turnable?: boolean;
  /** Not a block: runs a special action. */
  special?: 'image' | 'inline-math' | 'page-link' | 'date' | 'cloze';
  /** Shown only when a module is on. */
  module?: 'flashcards';
}

export const ITEMS: BlockItem[] = [
  {
    key: 'text',
    label: 'Text',
    hint: 'Just start writing with plain text.',
    keywords: 'paragraph plain',
    section: 'Basic blocks',
    glyph: 'T',
    type: 'paragraph',
    turnable: true,
  },
  {
    key: 'h1',
    label: 'Heading 1',
    hint: 'Big section heading.',
    keywords: 'title h1 #',
    section: 'Basic blocks',
    glyph: 'H1',
    shortcut: '#',
    type: 'heading',
    attrs: { level: 1 },
    turnable: true,
  },
  {
    key: 'h2',
    label: 'Heading 2',
    hint: 'Medium section heading.',
    keywords: 'subtitle h2 ##',
    section: 'Basic blocks',
    glyph: 'H2',
    shortcut: '##',
    type: 'heading',
    attrs: { level: 2 },
    turnable: true,
  },
  {
    key: 'h3',
    label: 'Heading 3',
    hint: 'Small section heading.',
    keywords: 'h3 ###',
    section: 'Basic blocks',
    glyph: 'H3',
    shortcut: '###',
    type: 'heading',
    attrs: { level: 3 },
    turnable: true,
  },
  {
    key: 'todo',
    label: 'To-do list',
    hint: 'Track tasks with a checklist.',
    keywords: 'checkbox task checklist todo',
    section: 'Basic blocks',
    glyph: '☑',
    shortcut: '[]',
    type: 'todo_list',
    attrs: { checked: false },
    turnable: true,
  },
  {
    key: 'bullet',
    label: 'Bulleted list',
    hint: 'A simple bulleted list.',
    keywords: 'ul unordered list bullets',
    section: 'Basic blocks',
    glyph: '•',
    shortcut: '-',
    type: 'bulleted_list',
    turnable: true,
  },
  {
    key: 'number',
    label: 'Numbered list',
    hint: 'A list with numbering.',
    keywords: 'ol ordered list numbers',
    section: 'Basic blocks',
    glyph: '1.',
    shortcut: '1.',
    type: 'numbered_list',
    turnable: true,
  },
  {
    key: 'quote',
    label: 'Quote',
    hint: 'Capture a quote.',
    keywords: 'blockquote cite',
    section: 'Basic blocks',
    glyph: '❝',
    shortcut: '"',
    type: 'quote',
    turnable: true,
  },
  {
    key: 'callout',
    label: 'Callout',
    hint: 'Make writing stand out.',
    keywords: 'note info tip highlight box',
    section: 'Basic blocks',
    glyph: '💡',
    type: 'callout',
    attrs: { icon: '💡' },
    turnable: true,
  },
  {
    key: 'divider',
    label: 'Divider',
    hint: 'Visually divide blocks.',
    keywords: 'line separator hr rule',
    section: 'Basic blocks',
    glyph: '—',
    shortcut: '---',
    type: 'divider',
  },
  {
    key: 'toggle',
    label: 'Toggle list',
    hint: 'Hide and show content inside.',
    keywords: 'collapse dropdown details expand',
    section: 'Toggles',
    glyph: '▸',
    shortcut: '>',
    type: 'toggle_list',
    attrs: { level: 0, collapsed: false },
    turnable: true,
  },
  {
    key: 'toggle-h1',
    label: 'Toggle heading 1',
    hint: 'A collapsible Heading 1.',
    keywords: 'collapse dropdown heading h1',
    section: 'Toggles',
    glyph: '▸1',
    type: 'toggle_list',
    attrs: { level: 1, collapsed: false },
    turnable: true,
  },
  {
    key: 'toggle-h2',
    label: 'Toggle heading 2',
    hint: 'A collapsible Heading 2.',
    keywords: 'collapse dropdown heading h2',
    section: 'Toggles',
    glyph: '▸2',
    type: 'toggle_list',
    attrs: { level: 2, collapsed: false },
    turnable: true,
  },
  {
    key: 'toggle-h3',
    label: 'Toggle heading 3',
    hint: 'A collapsible Heading 3.',
    keywords: 'collapse dropdown heading h3',
    section: 'Toggles',
    glyph: '▸3',
    type: 'toggle_list',
    attrs: { level: 3, collapsed: false },
    turnable: true,
  },
  {
    key: 'image',
    label: 'Image',
    hint: 'Upload a picture from this computer.',
    keywords: 'picture photo upload file',
    section: 'Media',
    glyph: '🖼',
    type: 'image',
    special: 'image',
  },
  {
    key: 'code',
    label: 'Code',
    hint: 'Capture a code snippet.',
    keywords: 'snippet programming pre',
    section: 'Advanced',
    glyph: '{ }',
    shortcut: '```',
    type: 'code',
    attrs: { language: '' },
    turnable: true,
  },
  {
    key: 'math',
    label: 'Block equation',
    hint: 'Display a math formula.',
    keywords: 'latex katex math formula',
    section: 'Advanced',
    glyph: 'Σ',
    shortcut: '$$',
    type: 'math_equation',
    attrs: { formula: '' },
  },
  {
    key: 'table',
    label: 'Table',
    hint: 'Add a simple table.',
    keywords: 'grid rows columns',
    section: 'Advanced',
    glyph: '▦',
    type: 'table',
  },
  {
    key: 'inline-math',
    label: 'Inline equation',
    hint: 'Math inside a line of text.',
    keywords: 'latex katex formula inline',
    section: 'Inline',
    glyph: '√x',
    type: '',
    special: 'inline-math',
  },
  {
    key: 'page-link',
    label: 'Link to note',
    hint: 'Mention another note.',
    keywords: 'wiki page mention note link [[',
    section: 'Inline',
    glyph: '↗',
    type: '',
    special: 'page-link',
  },
  {
    key: 'date',
    label: "Today's date",
    hint: 'Insert the date as text.',
    keywords: 'today date now',
    section: 'Inline',
    glyph: '📅',
    type: '',
    special: 'date',
  },
  {
    key: 'cloze',
    label: 'Flashcard blank',
    hint: 'A {{c1::…}} blank for flashcards.',
    keywords: 'cloze flashcard blank card',
    section: 'Inline',
    glyph: '{ }',
    type: '',
    special: 'cloze',
    module: 'flashcards',
  },
];

export const TURN_ITEMS = ITEMS.filter((i) => i.turnable);

/** Filter by what was typed after "/" (label first, then keywords), like AppFlowy's selection menu. */
export function filterItems(query: string, modules: Record<string, boolean> = {}): BlockItem[] {
  const q = query.trim().toLowerCase();
  const items = ITEMS.filter((i) => !i.module || modules[i.module]);
  if (!q) return items;
  const starts = items.filter((i) => i.label.toLowerCase().startsWith(q));
  const rest = items.filter(
    (i) =>
      !starts.includes(i) &&
      (i.label.toLowerCase().includes(q) ||
        i.keywords
          .toLowerCase()
          .split(' ')
          .some((k) => k.startsWith(q))),
  );
  return [...starts, ...rest];
}

/** Which item a block currently is (for check marks in "Turn into"). */
export function itemOf(type: string, data: Attrs = {}): string | undefined {
  return ITEMS.find(
    (i) =>
      i.type === type &&
      (i.type !== 'heading' && i.type !== 'toggle_list'
        ? true
        : Number(i.attrs?.level ?? 0) === Number(data.level ?? 0)),
  )?.key;
}

export const CALLOUT_ICONS = ['💡', '📌', '⚠️', '✅', '❗', '📝', '🔥', 'ℹ️', '❓', '⭐'];
