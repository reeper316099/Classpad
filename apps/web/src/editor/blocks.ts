/**
 * Block-level logic for the note editor, kept free of CodeMirror so it can be tested on plain strings.
 * A "block" is what Notion calls one: a paragraph, heading, list item, quote, code block, toggle…
 */

export type BlockKind =
  | 'text'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'todo'
  | 'bullet'
  | 'number'
  | 'toggle'
  | 'toggle-h1'
  | 'toggle-h2'
  | 'toggle-h3'
  | 'quote'
  | 'callout'
  | 'code'
  | 'divider'
  | 'math'
  | 'table';

export interface BlockDef {
  kind: BlockKind;
  label: string;
  hint: string;
  /** Extra words the slash menu also matches. */
  keywords: string;
  /** Menu section. */
  section: 'Basic blocks' | 'Toggles' | 'Advanced';
  /** What typing it does, shown on the right of the menu like Notion does. */
  shortcut?: string;
  /** Glyph for the menu (plain text so it needs no icon font). */
  glyph: string;
}

export const BLOCKS: BlockDef[] = [
  {
    kind: 'text',
    label: 'Text',
    hint: 'Just start writing with plain text.',
    keywords: 'paragraph plain',
    section: 'Basic blocks',
    glyph: 'T',
  },
  {
    kind: 'h1',
    label: 'Heading 1',
    hint: 'Big section heading.',
    keywords: 'title h1 #',
    section: 'Basic blocks',
    shortcut: '#',
    glyph: 'H1',
  },
  {
    kind: 'h2',
    label: 'Heading 2',
    hint: 'Medium section heading.',
    keywords: 'subtitle h2 ##',
    section: 'Basic blocks',
    shortcut: '##',
    glyph: 'H2',
  },
  {
    kind: 'h3',
    label: 'Heading 3',
    hint: 'Small section heading.',
    keywords: 'h3 ###',
    section: 'Basic blocks',
    shortcut: '###',
    glyph: 'H3',
  },
  {
    kind: 'todo',
    label: 'To-do list',
    hint: 'Track tasks with a checklist.',
    keywords: 'checkbox task checklist todo',
    section: 'Basic blocks',
    shortcut: '[]',
    glyph: '☑',
  },
  {
    kind: 'bullet',
    label: 'Bulleted list',
    hint: 'A simple bulleted list.',
    keywords: 'ul unordered list bullets',
    section: 'Basic blocks',
    shortcut: '-',
    glyph: '•',
  },
  {
    kind: 'number',
    label: 'Numbered list',
    hint: 'A list with numbering.',
    keywords: 'ol ordered list numbers',
    section: 'Basic blocks',
    shortcut: '1.',
    glyph: '1.',
  },
  {
    kind: 'quote',
    label: 'Quote',
    hint: 'Capture a quote.',
    keywords: 'blockquote cite',
    section: 'Basic blocks',
    shortcut: '>',
    glyph: '❝',
  },
  {
    kind: 'callout',
    label: 'Callout',
    hint: 'Make writing stand out.',
    keywords: 'note info tip highlight box',
    section: 'Basic blocks',
    glyph: '💡',
  },
  {
    kind: 'divider',
    label: 'Divider',
    hint: 'Visually divide blocks.',
    keywords: 'line separator hr rule',
    section: 'Basic blocks',
    shortcut: '---',
    glyph: '—',
  },
  {
    kind: 'toggle',
    label: 'Toggle list',
    hint: 'Hide and show content inside.',
    keywords: 'collapse dropdown details expand',
    section: 'Toggles',
    glyph: '▸',
  },
  {
    kind: 'toggle-h1',
    label: 'Toggle heading 1',
    hint: 'A collapsible Heading 1.',
    keywords: 'collapse dropdown heading h1',
    section: 'Toggles',
    glyph: '▸1',
  },
  {
    kind: 'toggle-h2',
    label: 'Toggle heading 2',
    hint: 'A collapsible Heading 2.',
    keywords: 'collapse dropdown heading h2',
    section: 'Toggles',
    glyph: '▸2',
  },
  {
    kind: 'toggle-h3',
    label: 'Toggle heading 3',
    hint: 'A collapsible Heading 3.',
    keywords: 'collapse dropdown heading h3',
    section: 'Toggles',
    glyph: '▸3',
  },
  {
    kind: 'code',
    label: 'Code',
    hint: 'Capture a code snippet.',
    keywords: 'snippet programming pre',
    section: 'Advanced',
    shortcut: '```',
    glyph: '{ }',
  },
  {
    kind: 'math',
    label: 'Block equation',
    hint: 'Display a math formula.',
    keywords: 'latex katex math formula',
    section: 'Advanced',
    shortcut: '$$',
    glyph: 'Σ',
  },
  {
    kind: 'table',
    label: 'Table',
    hint: 'Add a simple table.',
    keywords: 'grid rows columns',
    section: 'Advanced',
    glyph: '▦',
  },
];

/** Languages the renderer highlights (a practical subset; any other name still works as plain text). */
export const CODE_LANGUAGES: [string, string][] = [
  ['', 'Plain text'],
  ['python', 'Python'],
  ['javascript', 'JavaScript'],
  ['typescript', 'TypeScript'],
  ['java', 'Java'],
  ['c', 'C'],
  ['cpp', 'C++'],
  ['csharp', 'C#'],
  ['go', 'Go'],
  ['rust', 'Rust'],
  ['swift', 'Swift'],
  ['kotlin', 'Kotlin'],
  ['php', 'PHP'],
  ['ruby', 'Ruby'],
  ['r', 'R'],
  ['sql', 'SQL'],
  ['bash', 'Shell'],
  ['html', 'HTML'],
  ['css', 'CSS'],
  ['json', 'JSON'],
  ['yaml', 'YAML'],
  ['markdown', 'Markdown'],
  ['diff', 'Diff'],
];

export const blockDef = (k: BlockKind) => BLOCKS.find((b) => b.kind === k)!;

// ---------------------------------------------------------------------------------------------
// reading a line

export type LineKind =
  | 'text'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'todo'
  | 'todo-done'
  | 'bullet'
  | 'number'
  | 'quote'
  | 'callout';

export interface LineParts {
  /** Leading whitespace (list nesting). */
  indent: string;
  kind: LineKind;
  /** The syntax in front of the text, e.g. `## `, `- [ ] `, `> `. Empty for plain text. */
  marker: string;
  body: string;
}

const EMOJI = /^(\p{Extended_Pictographic}️?)\s/u;

export function parseLine(line: string): LineParts {
  const indent = /^[ \t]*/.exec(line)![0];
  const rest = line.slice(indent.length);
  let m: RegExpExecArray | null;
  if ((m = /^(#{1,6})\s+/.exec(rest)))
    return {
      indent,
      kind: `h${m[1]!.length}` as LineKind,
      marker: m[0],
      body: rest.slice(m[0].length),
    };
  if ((m = /^[-*+]\s+\[( |x|X)\]\s+/.exec(rest)))
    return {
      indent,
      kind: m[1] === ' ' ? 'todo' : 'todo-done',
      marker: m[0],
      body: rest.slice(m[0].length),
    };
  if ((m = /^[-*+]\s+/.exec(rest)))
    return { indent, kind: 'bullet', marker: m[0], body: rest.slice(m[0].length) };
  if ((m = /^\d{1,9}[.)]\s+/.exec(rest)))
    return { indent, kind: 'number', marker: m[0], body: rest.slice(m[0].length) };
  if ((m = /^>\s?/.exec(rest))) {
    const body = rest.slice(m[0].length);
    return { indent, kind: EMOJI.test(body) ? 'callout' : 'quote', marker: m[0], body };
  }
  return { indent, kind: 'text', marker: '', body: rest };
}

/** Prefix a line gets when it is turned into a given kind. */
function prefixFor(kind: BlockKind, n = 1): string | null {
  switch (kind) {
    case 'text':
      return '';
    case 'h1':
      return '# ';
    case 'h2':
      return '## ';
    case 'h3':
      return '### ';
    case 'todo':
      return '- [ ] ';
    case 'bullet':
      return '- ';
    case 'number':
      return `${n}. `;
    case 'quote':
      return '> ';
    case 'callout':
      return '> 💡 ';
    default:
      return null; // multi-line kinds are built by `wrapBlock`
  }
}

/** Is this a kind that only changes the first line's prefix? */
export const isLineKind = (k: BlockKind) => prefixFor(k) !== null;

/** Turn one line into a different line-level block, keeping its text and nesting. */
export function turnLine(line: string, kind: BlockKind, n = 1): string {
  const p = parseLine(line);
  const pre = prefixFor(kind, n);
  if (pre === null) return line;
  // a callout keeps its emoji when it is already one
  const body = kind === 'callout' && p.kind === 'callout' ? p.body : p.body;
  const keepIndent = ['todo', 'bullet', 'number'].includes(kind) ? p.indent : '';
  return keepIndent + pre + body;
}

// ---------------------------------------------------------------------------------------------
// multi-line blocks

/** Wrap text in a fenced code block; the fence is longer than any backtick run inside. */
export function wrapCode(text: string, lang = ''): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang.replace(/[^\w+#-]/g, '')}\n${text}\n${fence}`;
}

export function wrapToggle(text: string, level: 0 | 1 | 2 | 3, title = 'Toggle'): string {
  const summary = level ? `<h${level}>${title}</h${level}>` : title;
  return `<details open>\n<summary>${summary}</summary>\n\n${text}${text ? '\n' : ''}\n</details>`;
}

export const emptyTable = (cols = 3, rows = 2): string => {
  const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const head = row(Array.from({ length: cols }, (_, i) => `Column ${i + 1}`));
  const sep = row(Array.from({ length: cols }, () => '---'));
  const body = Array.from({ length: rows }, () => row(Array.from({ length: cols }, () => ' ')));
  return [head, sep, ...body].join('\n');
};

export interface Insert {
  text: string;
  /** Selection inside `text`, as offsets from its start. */
  select: [number, number];
}

/**
 * Text to insert for a block kind when the user picks it from the menu. `current` is the text of the line the
 * command was typed on (without the slash command), so "turn this line into a heading" keeps what was written.
 */
export function blockInsert(kind: BlockKind, current = ''): Insert {
  const at = (text: string, selectAfter: string): Insert => {
    const i = text.indexOf(selectAfter);
    return { text, select: i < 0 ? [text.length, text.length] : [i, i + selectAfter.length] };
  };
  switch (kind) {
    case 'divider':
      return { text: '---\n\n', select: [5, 5] };
    case 'code': {
      const t = wrapCode(current, '') + '\n';
      const start = 4;
      return { text: t, select: [start, start + current.length] };
    }
    case 'math': {
      const t = `$$\n${current}\n$$\n`;
      return { text: t, select: [3, 3 + current.length] };
    }
    case 'table':
      return at(emptyTable() + '\n', 'Column 1');
    case 'toggle':
    case 'toggle-h1':
    case 'toggle-h2':
    case 'toggle-h3': {
      const level = kind === 'toggle' ? 0 : (Number(kind.slice(-1)) as 1 | 2 | 3);
      const t = wrapToggle(current, level, 'Toggle');
      return at(t + '\n', 'Toggle');
    }
    default: {
      const pre = prefixFor(kind) ?? '';
      const text = pre + current;
      return { text, select: [text.length, text.length] };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// toggles

export interface ToggleInfo {
  /** 1-based line numbers. */
  open: number;
  /** The `<summary>` line, when it is on its own line after `<details>`. */
  summary: number;
  close: number;
  /** 0 = toggle list, 1-3 = toggle heading. */
  level: 0 | 1 | 2 | 3;
  title: string;
  /** The `open` attribute is set. */
  isOpen: boolean;
  depth: number;
}

const DETAILS_OPEN = /^\s*<details(\s+open)?\s*>\s*$/i;
const DETAILS_CLOSE = /^\s*<\/details>\s*$/i;
const SUMMARY = /^\s*<summary>(.*?)<\/summary>\s*$/i;

/**
 * Find toggles in a document given as lines. Only well-formed ones count: a `<details>` line, a `<summary>` line,
 * and a matching `</details>`. Anything else stays ordinary text so half-typed tags never swallow the page.
 * Lines inside fenced code are ignored.
 */
export function findToggles(lines: string[]): ToggleInfo[] {
  const out: ToggleInfo[] = [];
  const stack: {
    open: number;
    isOpen: boolean;
    summary?: number;
    title: string;
    level: 0 | 1 | 2 | 3;
  }[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1]![0]!.repeat(f[1]!.length);
      else if (f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const o = DETAILS_OPEN.exec(line);
    if (o) {
      const s = SUMMARY.exec(lines[i + 1] ?? '');
      if (s) {
        const h = /^<h([1-3])>(.*?)<\/h\1>$/i.exec(s[1]!.trim());
        const level = h ? (Number(h[1]) as 1 | 2 | 3) : 0;
        const title = (h ? h[2]! : s[1]!).replace(/<[^>]+>/g, '').trim();
        stack.push({ open: i + 1, isOpen: !!o[1], summary: i + 2, title, level });
        i++; // the summary line belongs to this toggle
      }
      continue;
    }
    if (DETAILS_CLOSE.test(line) && stack.length) {
      const t = stack.pop()!;
      out.push({
        open: t.open,
        summary: t.summary!,
        close: i + 1,
        level: t.level,
        title: t.title,
        isOpen: t.isOpen,
        depth: stack.length,
      });
    }
  }
  return out.sort((a, b) => a.open - b.open);
}
