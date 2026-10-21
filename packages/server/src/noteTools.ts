import { extractWikiLinks, normalizeTitle, type Note } from '@classpad/shared';

/** Find the note a `[[link]]` points at. Same-class notes win ties; then most recently edited. */
export function resolveLink(notes: Note[], target: string, fromClassId?: string): Note | undefined {
  const want = normalizeTitle(target);
  const matches = notes.filter((n) => normalizeTitle(n.title) === want);
  return matches.sort(
    (a, b) =>
      Number(b.classId === fromClassId && !!fromClassId) -
        Number(a.classId === fromClassId && !!fromClassId) ||
      b.updatedAt.localeCompare(a.updatedAt),
  )[0];
}

export interface Backlink {
  id: string;
  title: string;
  classId?: string;
  snippet: string;
}

/** Notes whose `[[links]]` resolve to `note` (never the note itself). */
export function backlinksFor(notes: Note[], note: Note): Backlink[] {
  const out: Backlink[] = [];
  for (const other of notes) {
    if (other.id === note.id) continue;
    for (const link of extractWikiLinks(other.markdown)) {
      if (resolveLink(notes, link.target, other.classId)?.id !== note.id) continue;
      const from = Math.max(0, link.index - 50);
      const snippet = other.markdown
        .slice(from, link.index + link.raw.length + 50)
        .replace(/\s+/g, ' ')
        .trim();
      out.push({ id: other.id, title: other.title, classId: other.classId, snippet });
      break;
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}
