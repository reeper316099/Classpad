/** Text for the block-level things the note toolbar inserts, and where the cursor should land. */
export interface Insert {
  text: string;
  /** Selection inside `text` (offsets from its start). */
  select: [number, number];
}

/** Languages the note renderer can highlight (a practical subset; any other name still renders as plain text). */
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

/** A fenced code block. The fence is made longer than any run of backticks in the code, so it can't end early. */
export function codeBlock(selection: string, lang: string): Insert {
  const longest = Math.max(0, ...[...selection.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const head = `${fence}${lang.replace(/[^\w+#-]/g, '')}\n`;
  return {
    text: `${head}${selection}\n${fence}\n`,
    select: [head.length, head.length + selection.length],
  };
}

export type ToggleLevel = 0 | 1 | 2 | 3;

/** A collapsible toggle: a list toggle (0) or a toggle heading 1, 2 or 3. The title is left selected to type over. */
export function toggleBlock(selection: string, level: ToggleLevel): Insert {
  const title = level ? `<h${level}>Title</h${level}>` : 'Title';
  const head = `<details>\n<summary>${title}</summary>\n\n`;
  const at = head.indexOf('Title');
  return {
    text: `${head}${selection}${selection ? '\n' : ''}\n</details>\n`,
    select: [at, at + 'Title'.length],
  };
}
