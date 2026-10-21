import type { JsonStore } from '@classpad/jsonstore';
import { StudySessionSchema, newId, type StudySession } from '@classpad/shared';
import type { Bus } from './bus.js';
import type { Collection } from './collection.js';
import { ApiError, notFound } from './errors.js';

const DIR = 'data/study';
const ACTIVE = `${DIR}/active.json`;

export interface ActiveTimer {
  start: string;
  kind: 'pomodoro' | 'manual';
  classId?: string;
  taskId?: string;
  assignmentId?: string;
}

const monthFile = (s: Pick<StudySession, 'start'>) => `${DIR}/${s.start.slice(0, 7)}.jsonl`;

/** Study sessions, one JSONL file per month (`data/study/YYYY-MM.jsonl`), plus the running timer. */
export class StudyRepo implements Collection<StudySession> {
  readonly name = 'study-sessions';
  private items = new Map<string, StudySession>();
  private files = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  active: ActiveTimer | null = null;
  readonly loadErrors: string[] = [];

  constructor(
    private store: JsonStore,
    private bus: Bus,
  ) {}

  private enqueue<R>(fn: () => Promise<R>): Promise<R> {
    const r = this.queue.then(fn, fn);
    this.queue = r.catch(() => undefined);
    return r;
  }

  owns(rel: string): boolean {
    return rel.startsWith(`${DIR}/`) && rel.endsWith('.jsonl');
  }

  validateText(text: string): void {
    for (const line of text.split('\n').filter((l) => l.trim()))
      StudySessionSchema.parse(JSON.parse(line));
  }

  async load(): Promise<void> {
    this.items.clear();
    this.files.clear();
    for (const rel of await this.store.list(DIR, { ext: '.jsonl' })) await this.loadFile(rel);
    this.active = await this.store
      .readJson<ActiveTimer | null>(ACTIVE, { fallback: () => null })
      .catch(() => null);
  }

  private async loadFile(rel: string): Promise<void> {
    for (const [id, f] of [...this.files])
      if (f === rel) {
        this.items.delete(id);
        this.files.delete(id);
      }
    const text = await this.store.readText(rel);
    if (text === null) return;
    text.split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const s = StudySessionSchema.parse(JSON.parse(line)) as StudySession;
        this.items.set(s.id, s);
        this.files.set(s.id, rel);
      } catch (e) {
        this.loadErrors.push(`${rel}:${i + 1}: ${(e as Error).message.split('\n')[0]}`);
      }
    });
  }

  async reloadFile(rel: string): Promise<boolean> {
    if (rel === ACTIVE) {
      this.active = await this.store
        .readJson<ActiveTimer | null>(ACTIVE, { fallback: () => null })
        .catch(() => null);
      return true;
    }
    if (!this.owns(rel)) return false;
    return this.enqueue(async () => {
      await this.loadFile(rel);
      return true;
    });
  }

  list(): StudySession[] {
    return [...this.items.values()];
  }
  get(id: string): StudySession | undefined {
    return this.items.get(id);
  }

  private async writeMonth(
    rel: string,
    items: Map<string, StudySession>,
    files: Map<string, string>,
  ) {
    const lines = [...files]
      .filter(([, f]) => f === rel)
      .map(([id]) => items.get(id)!)
      .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))
      .map((s) =>
        JSON.stringify(
          Object.fromEntries(
            Object.entries(s)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => a.localeCompare(b)),
          ),
        ),
      );
    if (lines.length) await this.store.writeText(rel, lines.join('\n') + '\n');
    else await this.store.remove(rel);
  }

  private async commit(put: StudySession[], del: string[]) {
    const items = new Map(this.items);
    const files = new Map(this.files);
    const dirty = new Set<string>();
    for (const id of del) {
      const f = files.get(id);
      if (f) dirty.add(f);
      items.delete(id);
      files.delete(id);
    }
    for (const s of put) {
      const old = files.get(s.id);
      if (old) dirty.add(old);
      const f = monthFile(s);
      dirty.add(f);
      items.set(s.id, s);
      files.set(s.id, f);
    }
    for (const rel of dirty) await this.writeMonth(rel, items, files);
    this.items = items;
    this.files = files;
  }

  private parse(input: Record<string, unknown>, base: Partial<StudySession> = {}): StudySession {
    const now = new Date().toISOString();
    const s = StudySessionSchema.parse({
      createdAt: now,
      updatedAt: now,
      ...base,
      ...input,
    }) as StudySession;
    if (Number.isNaN(Date.parse(s.start)) || Number.isNaN(Date.parse(s.end)))
      throw new ApiError(422, 'VALIDATION', 'start and end must be valid dates');
    if (Date.parse(s.end) < Date.parse(s.start))
      throw new ApiError(422, 'VALIDATION', 'end is before start');
    if (s.minutes > 24 * 60)
      throw new ApiError(422, 'VALIDATION', 'a session cannot be longer than 24 hours');
    return s;
  }

  create(input: Record<string, unknown>): Promise<StudySession> {
    return this.enqueue(async () => {
      let data = { ...input };
      if (
        data.minutes === undefined &&
        typeof data.start === 'string' &&
        typeof data.end === 'string'
      )
        data = {
          ...data,
          minutes: Math.round((Date.parse(data.end) - Date.parse(data.start)) / 60000),
        };
      const s = this.parse({ ...data, id: newId() });
      await this.commit([s], []);
      this.bus.publish({ kind: 'created', collection: this.name, entityId: s.id });
      return s;
    });
  }

  update(id: string, patch: Record<string, unknown>): Promise<StudySession> {
    return this.enqueue(async () => {
      const cur = this.items.get(id);
      if (!cur) throw notFound(this.name, id);
      const s = this.parse(
        { ...patch, id, createdAt: cur.createdAt, updatedAt: new Date().toISOString() },
        cur,
      );
      await this.commit([s], []);
      this.bus.publish({ kind: 'updated', collection: this.name, entityId: id });
      return s;
    });
  }

  deleteMany(ids: string[]): Promise<void> {
    return this.enqueue(async () => {
      const present = ids.filter((i) => this.items.has(i));
      if (!present.length) return;
      await this.commit([], present);
      for (const id of present)
        this.bus.publish({ kind: 'deleted', collection: this.name, entityId: id });
    });
  }

  delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.items.has(id)) throw notFound(this.name, id);
      await this.commit([], [id]);
      this.bus.publish({ kind: 'deleted', collection: this.name, entityId: id });
    });
  }

  // ---- running timer ----
  startTimer(t: Omit<ActiveTimer, 'start'>, now = new Date()): Promise<ActiveTimer> {
    return this.enqueue(async () => {
      if (this.active)
        throw new ApiError(409, 'ALREADY_RUNNING', 'A study timer is already running');
      this.active = { ...t, start: now.toISOString() };
      await this.store.writeJson(ACTIVE, this.active);
      this.bus.publish({ kind: 'updated', collection: this.name });
      return this.active;
    });
  }

  /** Stops the timer and logs the session. Anything under 30 seconds is discarded (returns null). */
  stopTimer(now = new Date()): Promise<StudySession | null> {
    return this.enqueue(async () => {
      const a = this.active;
      if (!a) throw new ApiError(409, 'NOT_RUNNING', 'No study timer is running');
      this.active = null;
      await this.store.remove(ACTIVE);
      const ms = now.getTime() - Date.parse(a.start);
      if (ms < 30_000) {
        this.bus.publish({ kind: 'updated', collection: this.name });
        return null;
      }
      const s = this.parse({
        id: newId(),
        start: a.start,
        end: now.toISOString(),
        minutes: Math.max(1, Math.round(ms / 60000)),
        classId: a.classId,
        taskId: a.taskId,
        assignmentId: a.assignmentId,
        kind: a.kind,
      });
      await this.commit([s], []);
      this.bus.publish({ kind: 'created', collection: this.name, entityId: s.id });
      return s;
    });
  }
}
