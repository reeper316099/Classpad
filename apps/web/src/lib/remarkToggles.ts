import type { Html, Parent, Root, RootContent } from 'mdast';

/**
 * Collapsible toggles, the way Notion has them (toggle list and toggle heading 1/2/3), stored as the
 * portable `<details>` HTML that GitHub and most Markdown apps also understand:
 *
 *   <details>
 *   <summary>Title</summary>            a toggle list
 *   <summary><h2>Title</h2></summary>   a toggle heading (h1, h2 or h3)
 *
 *   Body in Markdown, including nested toggles.
 *
 *   </details>
 *
 * Raw HTML is never rendered: these blocks are recognised and rebuilt as `details`/`summary` elements, and
 * every other HTML node is still dropped by the renderer.
 */
const OPEN = /^<details(\s+open)?\s*>\s*(?:<summary>([\s\S]*?)<\/summary>)?\s*([\s\S]*)$/i;
const CLOSE = /^([\s\S]*?)<\/details>\s*$/i;

export interface ToggleTitle {
  level: 0 | 1 | 2 | 3;
  text: string;
}

export function parseSummary(inner: string | undefined): ToggleTitle {
  const raw = (inner ?? '').trim();
  const h = /^<h([1-3])>([\s\S]*?)<\/h\1>$/i.exec(raw);
  const level = h ? (Number(h[1]) as 1 | 2 | 3) : 0;
  const text = (h ? h[2]! : raw).replace(/<[^>]+>/g, '').trim();
  return { level, text: text || 'Toggle' };
}

function build(title: ToggleTitle, open: boolean, body: RootContent[]): RootContent {
  return {
    type: 'toggle',
    data: { hName: 'details', hProperties: open ? { open: true } : {} },
    children: [
      {
        type: 'toggleSummary',
        data: {
          hName: 'summary',
          hProperties: { className: [title.level ? `toggle-h${title.level}` : 'toggle-list'] },
        },
        children: [{ type: 'text', value: title.text }],
      },
      ...body,
    ],
  } as unknown as RootContent;
}

function group(children: RootContent[]): RootContent[] {
  const out: RootContent[] = [];
  const stack: { title: ToggleTitle; open: boolean; body: RootContent[] }[] = [];
  const push = (n: RootContent) => (stack.length ? stack.at(-1)!.body : out).push(n);
  const closeOne = () => {
    const f = stack.pop()!;
    push(build(f.title, f.open, f.body));
  };
  for (const n of children) {
    if (n.type !== 'html') {
      push(n);
      continue;
    }
    const value = (n as Html).value.trim();
    const open = OPEN.exec(value);
    if (open) {
      const title = parseSummary(open[2]);
      let rest = open[3] ?? '';
      const frame = { title, open: !!open[1], body: [] as RootContent[] };
      // a toggle written on one line: <details><summary>T</summary>body</details>
      const whole = CLOSE.exec(rest);
      if (whole) {
        rest = whole[1]!.trim();
        if (rest) frame.body.push({ type: 'paragraph', children: [{ type: 'text', value: rest }] });
        push(build(frame.title, frame.open, frame.body));
        continue;
      }
      if (rest.trim())
        frame.body.push({ type: 'paragraph', children: [{ type: 'text', value: rest.trim() }] });
      stack.push(frame);
      continue;
    }
    if (stack.length && CLOSE.test(value)) {
      const before = CLOSE.exec(value)![1]!.trim();
      if (before)
        stack.at(-1)!.body.push({ type: 'paragraph', children: [{ type: 'text', value: before }] });
      closeOne();
      continue;
    }
    push(n);
  }
  while (stack.length) closeOne(); // an unclosed toggle still shows its content
  return out;
}

function walk(node: Parent): void {
  for (const c of node.children) if ('children' in c) walk(c as Parent);
  if (node.children.some((c) => c.type === 'html' && /<\/?details/i.test((c as Html).value)))
    node.children = group(node.children as RootContent[]) as typeof node.children;
}

export function remarkToggles() {
  return (tree: Root) => walk(tree);
}
