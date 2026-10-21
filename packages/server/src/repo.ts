import { type JsonStore, type Op, stableStringify } from '@classpad/jsonstore';
import { newId } from '@classpad/shared';
import { z, type ZodType } from 'zod';
import type { Bus } from './bus.js';
import type { Collection } from './collection.js';
import { notFound } from './errors.js';

export interface Base {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoSpec<T extends Base> {
  name: string;
  schema: ZodType<T>;
  /** Directory (sharded) or single file that holds this collection. */
  location: string;
  fileFor: (e: T) => string;
  /** Runs on a draft before validation on create (assign slugs etc). */
  beforeCreate?: (draft: Record<string, unknown>) => Record<string, unknown>;
  /** Runs on the validated entity before it is written (referential checks). */
  validate?: (e: T) => void;
}

const FILE_VERSION = 1;

/**
 * In-memory collection persisted as `{ schemaVersion, items }` JSON files. The map is the source
 * of truth; each mutation rewrites only the affected files in one atomic batch.
 */
export class Repo<T extends Base> implements Collection<T> {
  private items = new Map<string, T>();
  private files = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private fileSchema: ZodType<{ schemaVersion: number; items: T[] }>;

  constructor(
    private store: JsonStore,
    private bus: Bus,
    private spec: RepoSpec<T>,
  ) {
    this.fileSchema = z.object({ schemaVersion: z.number(), items: z.array(spec.schema) }) as never;
  }

  get name(): string {
    return this.spec.name;
  }

  private isFile(): boolean {
    return this.spec.location.endsWith('.json');
  }

  /** The entity schema, for validating restored backup entries. */
  schemaForRestore(): ZodType<T> {
    return this.spec.schema;
  }

  owns(rel: string): boolean {
    return this.isFile()
      ? rel === this.spec.location
      : rel.startsWith(this.spec.location + '/') && rel.endsWith('.json');
  }

  /** Throws if `text` is not a valid file for this collection (used for hand-edit checks). */
  validateText(text: string): void {
    this.fileSchema.parse(JSON.parse(text));
  }

  async load(): Promise<void> {
    this.items.clear();
    this.files.clear();
    const rels = this.isFile()
      ? [this.spec.location]
      : await this.store.list(this.spec.location, { ext: '.json', recursive: true });
    for (const rel of rels) await this.loadFile(rel);
  }

  private async loadFile(rel: string): Promise<void> {
    const doc = await this.store.readJson(rel, {
      schema: this.fileSchema,
      fallback: () => ({ schemaVersion: FILE_VERSION, items: [] as T[] }),
    });
    for (const [id, f] of [...this.files])
      if (f === rel) {
        this.items.delete(id);
        this.files.delete(id);
      }
    for (const it of doc.items) {
      this.items.set(it.id, it);
      this.files.set(it.id, rel);
    }
  }

  /** Reload one file after an external (hand) edit. */
  async reloadFile(rel: string): Promise<boolean> {
    const inScope = this.isFile()
      ? rel === this.spec.location
      : rel.startsWith(this.spec.location + '/') && rel.endsWith('.json');
    if (!inScope) return false;
    return this.enqueue(async () => {
      const exists = await this.store.exists(rel);
      if (!exists) {
        for (const [id, f] of [...this.files])
          if (f === rel) {
            this.items.delete(id);
            this.files.delete(id);
          }
      } else await this.loadFile(rel);
      return true;
    });
  }

  list(): T[] {
    return [...this.items.values()];
  }
  get(id: string): T | undefined {
    return this.items.get(id);
  }

  private enqueue<R>(fn: () => Promise<R>): Promise<R> {
    const r = this.queue.then(fn, fn);
    this.queue = r.catch(() => undefined);
    return r;
  }

  /** Persist a set of puts/deletes atomically, then swap them into memory. */
  private async commit(put: T[], del: string[]): Promise<void> {
    const nextItems = new Map(this.items);
    const nextFiles = new Map(this.files);
    const dirty = new Set<string>();
    for (const id of del) {
      const f = nextFiles.get(id);
      if (f) dirty.add(f);
      nextItems.delete(id);
      nextFiles.delete(id);
    }
    for (const e of put) {
      const old = nextFiles.get(e.id);
      if (old) dirty.add(old);
      const f = this.spec.fileFor(e);
      dirty.add(f);
      nextItems.set(e.id, e);
      nextFiles.set(e.id, f);
    }
    const ops: Op[] = [];
    for (const f of dirty) {
      const inFile = [...nextFiles].filter(([, ff]) => ff === f).map(([id]) => nextItems.get(id)!);
      if (!inFile.length && !this.isFile()) ops.push({ type: 'remove', rel: f });
      else {
        inFile.sort((a, b) => a.id.localeCompare(b.id));
        ops.push({
          type: 'write',
          rel: f,
          text: stableStringify({ schemaVersion: FILE_VERSION, items: inFile }),
        });
      }
    }
    await this.store.batch(ops);
    this.items = nextItems;
    this.files = nextFiles;
  }

  create(input: Record<string, unknown>): Promise<T> {
    return this.enqueue(async () => {
      const now = new Date().toISOString();
      const draft = this.spec.beforeCreate ? this.spec.beforeCreate({ ...input }) : { ...input };
      const e = this.spec.schema.parse({ ...draft, id: newId(), createdAt: now, updatedAt: now });
      this.spec.validate?.(e);
      await this.commit([e], []);
      this.bus.publish({ kind: 'created', collection: this.name, entityId: e.id });
      return e;
    });
  }

  update(id: string, patch: Record<string, unknown>): Promise<T> {
    return this.enqueue(async () => {
      const cur = this.items.get(id);
      if (!cur) throw notFound(this.name, id);
      const e = this.spec.schema.parse({
        ...cur,
        ...patch,
        id: cur.id,
        createdAt: cur.createdAt,
        updatedAt: new Date().toISOString(),
      });
      this.spec.validate?.(e);
      await this.commit([e], []);
      this.bus.publish({ kind: 'updated', collection: this.name, entityId: id });
      return e;
    });
  }

  /** Insert or replace a whole entity (used by import/undo/backup restore). Keeps id and timestamps. */
  put(entity: T): Promise<T> {
    return this.enqueue(async () => {
      const e = this.spec.schema.parse(entity);
      this.spec.validate?.(e);
      const existed = this.items.has(e.id);
      await this.commit([e], []);
      this.bus.publish({
        kind: existed ? 'updated' : 'created',
        collection: this.name,
        entityId: e.id,
      });
      return e;
    });
  }

  delete(id: string): Promise<void> {
    return this.deleteMany([id]);
  }

  deleteMany(ids: string[]): Promise<void> {
    return this.enqueue(async () => {
      const present = ids.filter((i) => this.items.has(i));
      if (!present.length) {
        if (ids.length === 1) throw notFound(this.name, ids[0]!);
        return;
      }
      await this.commit([], present);
      for (const id of present)
        this.bus.publish({ kind: 'deleted', collection: this.name, entityId: id });
    });
  }

  /** Apply the same patch to many entities in one atomic write. */
  patchMany(ids: string[], patch: (e: T) => Record<string, unknown>): Promise<void> {
    return this.enqueue(async () => {
      const now = new Date().toISOString();
      const puts = ids
        .filter((i) => this.items.has(i))
        .map((i) => {
          const cur = this.items.get(i)!;
          return this.spec.schema.parse({
            ...cur,
            ...patch(cur),
            id: cur.id,
            createdAt: cur.createdAt,
            updatedAt: now,
          });
        });
      if (puts.length) await this.commit(puts, []);
      for (const p of puts)
        this.bus.publish({ kind: 'updated', collection: this.name, entityId: p.id });
    });
  }
}
