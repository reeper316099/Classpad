import type { JsonStore } from '@classpad/jsonstore';
import {
  NoteSchema,
  newId,
  parseFrontmatter,
  stringifyFrontmatter,
  type Note,
} from '@classpad/shared';
import path from 'node:path';
import type { Bus } from './bus.js';
import type { Collection } from './collection.js';
import { notFound } from './errors.js';
import { slugify, uniqueSlug } from './slug.js';

const NOTES_DIR = 'data/notes';
const iso = (v: unknown): string | undefined =>
  v instanceof Date
    ? v.toISOString().slice(0, v.getUTCHours() || v.getUTCMinutes() ? 19 : 10)
    : v == null
      ? undefined
      : String(v);

/** Notes are real Markdown files with YAML frontmatter, organised by class. */
export class NoteRepo implements Collection<Note> {
  readonly name = 'notes';
  private items = new Map<string, Note>();
  private files = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  readonly loadErrors: { rel: string; message: string }[] = [];

  constructor(
    private store: JsonStore,
    private bus: Bus,
    private classSlug: (classId: string | undefined) => string | undefined,
  ) {}

  private enqueue<R>(fn: () => Promise<R>): Promise<R> {
    const r = this.queue.then(fn, fn);
    this.queue = r.catch(() => undefined);
    return r;
  }

  private parse(rel: string, text: string): Note {
    const m = parseFrontmatter(text);
    const d = m.data as Record<string, unknown>;
    const now = new Date().toISOString();
    return NoteSchema.parse({
      ...d,
      id: d.id ? String(d.id) : newId(),
      title: d.title ? String(d.title) : path.basename(rel, '.md'),
      date: iso(d.date),
      createdAt: iso(d.createdAt) ?? now,
      updatedAt: iso(d.updatedAt) ?? now,
      markdown: m.content.replace(/^\n/, ''),
    });
  }

  private serialize(n: Note): string {
    const { markdown, ...fm } = n;
    return stringifyFrontmatter(markdown, fm);
  }

  schemaForRestore() {
    return NoteSchema;
  }

  owns(rel: string): boolean {
    return rel.startsWith(NOTES_DIR + '/') && rel.endsWith('.md');
  }

  validateText(text: string, rel: string): void {
    this.parse(rel, text);
  }

  async load(): Promise<void> {
    this.items.clear();
    this.files.clear();
    this.loadErrors.length = 0;
    for (const rel of await this.store.list(NOTES_DIR, { ext: '.md', recursive: true }))
      await this.loadFile(rel);
  }

  private async loadFile(rel: string): Promise<void> {
    const text = await this.store.readText(rel);
    if (text === null) return;
    try {
      const hadId = /^id:/m.test(text.split(/^---\s*$/m)[1] ?? '');
      const n = this.parse(rel, text);
      this.items.set(n.id, n);
      this.files.set(n.id, rel);
      if (!hadId) await this.store.writeText(rel, this.serialize(n));
    } catch (e) {
      this.loadErrors.push({ rel, message: (e as Error).message });
    }
  }

  async reloadFile(rel: string): Promise<boolean> {
    if (!rel.startsWith(NOTES_DIR + '/') || !rel.endsWith('.md')) return false;
    return this.enqueue(async () => {
      for (const [id, f] of [...this.files])
        if (f === rel) {
          this.items.delete(id);
          this.files.delete(id);
        }
      await this.loadFile(rel);
      return true;
    });
  }

  list(): Note[] {
    return [...this.items.values()];
  }
  get(id: string): Note | undefined {
    return this.items.get(id);
  }

  private dirFor(n: Note): string {
    return `${NOTES_DIR}/${this.classSlug(n.classId) ?? '_unfiled'}`;
  }

  private freeFile(dir: string, base: string, ignoreId?: string): string {
    const taken = new Set(
      [...this.files]
        .filter(([id, f]) => id !== ignoreId && path.posix.dirname(f) === dir)
        .map(([, f]) => path.posix.basename(f, '.md')),
    );
    return `${dir}/${uniqueSlug(base, taken)}.md`;
  }

  create(input: Record<string, unknown>): Promise<Note> {
    return this.enqueue(async () => {
      const now = new Date().toISOString();
      const n = NoteSchema.parse({ ...input, id: newId(), createdAt: now, updatedAt: now });
      const rel = this.freeFile(this.dirFor(n), slugify(n.title));
      await this.store.writeText(rel, this.serialize(n));
      this.items.set(n.id, n);
      this.files.set(n.id, rel);
      this.bus.publish({ kind: 'created', collection: this.name, entityId: n.id });
      return n;
    });
  }

  update(id: string, patch: Record<string, unknown>): Promise<Note> {
    return this.enqueue(async () => {
      const cur = this.items.get(id);
      if (!cur) throw notFound('notes', id);
      const n = NoteSchema.parse({
        ...cur,
        ...patch,
        id: cur.id,
        createdAt: cur.createdAt,
        updatedAt: new Date().toISOString(),
      });
      const oldRel = this.files.get(id)!;
      const dir = this.dirFor(n);
      const rel =
        path.posix.dirname(oldRel) === dir
          ? oldRel
          : this.freeFile(dir, path.posix.basename(oldRel, '.md'), id);
      await this.store.batch(
        rel === oldRel
          ? [{ type: 'write', rel, text: this.serialize(n) }]
          : [
              { type: 'write', rel, text: this.serialize(n) },
              { type: 'remove', rel: oldRel },
            ],
      );
      this.items.set(id, n);
      this.files.set(id, rel);
      this.bus.publish({ kind: 'updated', collection: this.name, entityId: id });
      return n;
    });
  }

  /** Insert or replace a whole note (import/undo/restore). */
  put(note: Note): Promise<Note> {
    return this.enqueue(async () => {
      const n = NoteSchema.parse(note);
      const oldRel = this.files.get(n.id);
      const dir = this.dirFor(n);
      const rel =
        oldRel && path.posix.dirname(oldRel) === dir
          ? oldRel
          : this.freeFile(
              dir,
              oldRel ? path.posix.basename(oldRel, '.md') : slugify(n.title),
              n.id,
            );
      await this.store.batch(
        oldRel && rel !== oldRel
          ? [
              { type: 'write', rel, text: this.serialize(n) },
              { type: 'remove', rel: oldRel },
            ]
          : [{ type: 'write', rel, text: this.serialize(n) }],
      );
      this.items.set(n.id, n);
      this.files.set(n.id, rel);
      this.bus.publish({
        kind: oldRel ? 'updated' : 'created',
        collection: this.name,
        entityId: n.id,
      });
      return n;
    });
  }

  delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      const rel = this.files.get(id);
      if (!rel) throw notFound('notes', id);
      await this.store.remove(rel);
      this.items.delete(id);
      this.files.delete(id);
      this.bus.publish({ kind: 'deleted', collection: this.name, entityId: id });
    });
  }

  fileOf(id: string): string | undefined {
    return this.files.get(id);
  }
}
