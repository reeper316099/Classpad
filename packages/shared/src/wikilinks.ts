/** `[[Title]]`, `[[Title|alias]]`, `[[Title#Heading]]`; ignores code spans and fenced code. */
export interface WikiLink {
  raw: string;
  target: string;
  heading?: string;
  alias?: string;
  index: number;
}

const LINK = /\[\[([^[\]|#\n]+?)(?:#([^[\]|\n]+?))?(?:\|([^[\]\n]+?))?\]\]/g;

/** Blank out code so links inside it are not picked up (indices stay aligned). */
function maskCode(md: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return md.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, blank).replace(/`[^`\n]*`/g, blank);
}

export function extractWikiLinks(md: string): WikiLink[] {
  const out: WikiLink[] = [];
  const masked = maskCode(md);
  for (const m of masked.matchAll(LINK))
    out.push({
      raw: m[0],
      target: m[1]!.trim(),
      heading: m[2]?.trim(),
      alias: m[3]?.trim(),
      index: m.index!,
    });
  return out;
}

export const normalizeTitle = (s: string): string =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
