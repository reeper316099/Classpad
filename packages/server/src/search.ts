import MiniSearch from 'minisearch';

export type Kind = 'note' | 'assignment' | 'task' | 'reading';
export interface SearchDoc {
  id: string;
  kind: Kind;
  title: string;
  body: string;
  classId?: string;
  tags: string[];
  types: string[];
  due?: string;
}

export interface SearchHit {
  id: string;
  kind: Kind;
  title: string;
  classId?: string;
  score: number;
}

const OPERATORS = /\b(class|type|tag|due):("[^"]*"|\S+)/gi;

export function parseQuery(q: string): { text: string; ops: Record<string, string[]> } {
  const ops: Record<string, string[]> = {};
  const text = q
    .replace(OPERATORS, (_m, k: string, v: string) => {
      (ops[k.toLowerCase()] ??= []).push(v.replace(/^"|"$/g, '').toLowerCase());
      return ' ';
    })
    .trim();
  return { text, ops };
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export class SearchIndex {
  private ms = new MiniSearch<SearchDoc>({
    fields: ['title', 'body', 'tags'],
    storeFields: ['kind', 'title', 'classId'],
    searchOptions: { prefix: true, fuzzy: 0.15, boost: { title: 3, tags: 2 } },
    extractField: (doc, field) => {
      const v = (doc as unknown as Record<string, unknown>)[field];
      return Array.isArray(v) ? v.join(' ') : (v as string);
    },
  });
  private docs = new Map<string, SearchDoc>();

  get size(): number {
    return this.docs.size;
  }

  rebuild(docs: SearchDoc[]): void {
    this.ms.removeAll();
    this.docs.clear();
    this.ms.addAll(docs);
    for (const d of docs) this.docs.set(d.id, d);
  }

  upsert(doc: SearchDoc): void {
    if (this.docs.has(doc.id)) this.ms.replace(doc);
    else this.ms.add(doc);
    this.docs.set(doc.id, doc);
  }

  remove(id: string): void {
    if (this.docs.delete(id)) this.ms.discard(id);
  }

  /** `classMatches(term)` resolves a `class:` operator value to class ids. */
  search(
    q: string,
    classMatches: (term: string) => Set<string>,
    limit = 50,
    now = new Date(),
  ): SearchHit[] {
    const { text, ops } = parseQuery(q);
    const classSets = (ops.class ?? []).map(classMatches);
    const today = day(now);
    const week = day(new Date(now.getTime() + 7 * 86400_000));
    const tomorrow = day(new Date(now.getTime() + 86400_000));
    const ok = (d: SearchDoc): boolean => {
      for (const s of classSets) if (!d.classId || !s.has(d.classId)) return false;
      for (const t of ops.type ?? [])
        if (d.kind !== t && !d.types.some((x) => x.toLowerCase() === t)) return false;
      for (const t of ops.tag ?? [])
        if (!d.tags.some((x) => x.toLowerCase() === t.replace(/^#/, ''))) return false;
      for (const t of ops.due ?? []) {
        const due = d.due?.slice(0, 10);
        if (!due) return false;
        if (
          t === 'today'
            ? due !== today
            : t === 'tomorrow'
              ? due !== tomorrow
              : t === 'week'
                ? due < today || due > week
                : t === 'overdue'
                  ? due >= today
                  : due !== t
        )
          return false;
      }
      return true;
    };
    if (!text) {
      return [...this.docs.values()]
        .filter(ok)
        .slice(0, limit)
        .map((d) => ({ id: d.id, kind: d.kind, title: d.title, classId: d.classId, score: 0 }));
    }
    return this.ms
      .search(text, { filter: (r) => ok(this.docs.get(r.id)!) })
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        kind: r.kind as Kind,
        title: r.title as string,
        classId: r.classId as string | undefined,
        score: r.score,
      }));
  }
}
