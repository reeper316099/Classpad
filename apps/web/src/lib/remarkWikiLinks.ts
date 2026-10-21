import type { Link, Parent, PhrasingContent, Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

const RE = /\[\[([^[\]|#\n]+?)(?:#([^[\]|\n]+?))?(?:\|([^[\]\n]+?))?\]\]/g;

/** Turns `[[Title|alias]]` in text into links with a `wiki:` URL (never inside code). */
export function remarkWikiLinks() {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index, parent: Parent | undefined) => {
      if (!parent || index === undefined || !node.value.includes('[[')) return;
      const out: PhrasingContent[] = [];
      let last = 0;
      for (const m of node.value.matchAll(RE)) {
        if (m.index! > last) out.push({ type: 'text', value: node.value.slice(last, m.index) });
        const target = m[1]!.trim();
        const heading = m[2]?.trim();
        const url = `wiki:${encodeURIComponent(target)}${heading ? '#' + encodeURIComponent(heading) : ''}`;
        const link: Link = {
          type: 'link',
          url,
          title: null,
          children: [{ type: 'text', value: (m[3] ?? target).trim() }],
        };
        out.push(link);
        last = m.index! + m[0].length;
      }
      if (!out.length) return;
      if (last < node.value.length) out.push({ type: 'text', value: node.value.slice(last) });
      parent.children.splice(index, 1, ...out);
      return index + out.length;
    });
  };
}

export const parseWikiHref = (href: string): { target: string; heading?: string } | null => {
  const m = /^wiki:([^#]*)(?:#(.*))?$/.exec(href);
  if (!m) return null;
  try {
    return {
      target: decodeURIComponent(m[1]!),
      heading: m[2] ? decodeURIComponent(m[2]) : undefined,
    };
  } catch {
    return null;
  }
};
