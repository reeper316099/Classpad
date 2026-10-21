import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ZodType } from 'zod';
import { createBackup, listBackups, readFromLatestBackup } from './backup.js';
import { StoreError } from './errors.js';
import { KeyedMutex } from './mutex.js';
import { migrate, type Migrations, type Versioned } from './migrate.js';
import { jsonErrorLine, stableStringify } from './stable.js';

export type Op =
  | { type: 'write'; rel: string; text: string }
  | { type: 'remove'; rel: string }
  | { type: 'move'; from: string; to: string };

export interface ReadOptions<T> {
  schema?: ZodType<T>;
  fallback?: () => T;
}

export interface VersionedOptions<T> {
  version: number;
  migrations?: Migrations;
  schema?: ZodType<T>;
  fallback: () => T;
}

export interface StoreEvents {
  'external-change': [{ rel: string }];
  'invalid-edit': [{ rel: string; message: string; line?: number }];
  restored: [{ rel: string; from: 'backup' }];
  quarantined: [{ rel: string; to: string }];
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const isNotFound = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

export class JsonStore extends EventEmitter {
  readonly root: string;
  private mutex = new KeyedMutex();
  private selfWrites = new Map<string, string>();
  private validators: { match: (rel: string) => boolean; validate: (text: string) => void }[] = [];
  private watcher?: FSWatcher;
  private locked = false;

  private constructor(root: string) {
    super();
    this.root = path.resolve(root);
  }

  /** Opens (and locks) a data directory. Throws LOCKED if another live instance holds it. */
  static async open(root: string, opts: { lock?: boolean } = {}): Promise<JsonStore> {
    const s = new JsonStore(root);
    await fs.mkdir(s.root, { recursive: true });
    if (opts.lock !== false) await s.acquireLock();
    return s;
  }

  private async acquireLock(): Promise<void> {
    const lock = path.join(this.root, '.lock');
    try {
      const pid = Number((await fs.readFile(lock, 'utf8')).trim());
      if (pid && pid !== process.pid) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code === 'EPERM';
        }
        if (alive)
          throw new StoreError(`data directory is in use by process ${pid}`, 'LOCKED', lock);
      }
    } catch (e) {
      if (e instanceof StoreError) throw e;
    }
    await fs.writeFile(lock, String(process.pid));
    this.locked = true;
  }

  /** Resolve a relative path, refusing anything that escapes the root. */
  resolve(rel: string): string {
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep))
      throw new StoreError(`path escapes data directory: ${rel}`, 'PATH', rel);
    return abs;
  }

  registerValidator(match: (rel: string) => boolean, validate: (text: string) => void): void {
    this.validators.push({ match, validate });
  }

  // ---------- raw IO (no locking) ----------
  private async rawRead(rel: string): Promise<string | null> {
    try {
      return await fs.readFile(this.resolve(rel), 'utf8');
    } catch (e) {
      if (isNotFound(e)) return null;
      throw new StoreError(`cannot read ${rel}: ${(e as Error).message}`, 'IO', rel);
    }
  }

  private async rawWrite(rel: string, text: string): Promise<void> {
    const abs = this.resolve(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(text, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      for (let i = 0; ; i++) {
        try {
          await fs.rename(tmp, abs);
          break;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (i < 5 && (code === 'EPERM' || code === 'EBUSY'))
            await new Promise((r) => setTimeout(r, 20 * (i + 1)));
          else throw e;
        }
      }
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    this.selfWrites.set(abs, sha(text));
  }

  private async rawRemove(rel: string): Promise<void> {
    const abs = this.resolve(rel);
    this.selfWrites.delete(abs);
    await fs.rm(abs, { force: true });
  }

  private async withLocks<T>(rels: string[], fn: () => Promise<T>): Promise<T> {
    const keys = [...new Set(rels.map((r) => this.resolve(r)))].sort();
    const go = (i: number): Promise<T> =>
      i >= keys.length ? fn() : this.mutex.run(keys[i]!, () => go(i + 1));
    return go(0);
  }

  // ---------- text ----------
  readText(rel: string): Promise<string | null> {
    return this.withLocks([rel], () => this.rawRead(rel));
  }

  writeText(rel: string, text: string): Promise<void> {
    return this.withLocks([rel], () => this.rawWrite(rel, text));
  }

  remove(rel: string): Promise<void> {
    return this.withLocks([rel], () => this.rawRemove(rel));
  }

  async exists(rel: string): Promise<boolean> {
    return (await this.rawRead(rel)) !== null;
  }

  async list(relDir: string, opts: { ext?: string; recursive?: boolean } = {}): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(this.resolve(rel), { withFileTypes: true });
      } catch (e) {
        if (isNotFound(e)) return;
        throw e;
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.name.endsWith('.tmp')) continue;
        if (e.isDirectory()) {
          if (opts.recursive) await walk(r);
        } else if (!opts.ext || e.name.endsWith(opts.ext)) out.push(r);
      }
    };
    await walk(relDir.replace(/\/+$/, ''));
    return out.sort();
  }

  // ---------- JSON ----------
  private parseAndValidate<T>(text: string, rel: string, schema?: ZodType<T>): T {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new StoreError(
        `invalid JSON in ${rel}: ${(e as Error).message}`,
        'CORRUPT',
        rel,
        jsonErrorLine(text, e),
      );
    }
    if (!schema) return raw as T;
    const r = schema.safeParse(raw);
    if (!r.success)
      throw new StoreError(
        `${rel} failed validation: ${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}`,
        'CORRUPT',
        rel,
      );
    return r.data;
  }

  /** Move a bad file aside and try to restore the last good backup of it. */
  private async quarantine(rel: string): Promise<string | null> {
    const abs = this.resolve(rel);
    const dest = `quarantine/${new Date().toISOString().replace(/[:.]/g, '-')}-${rel.replace(/[\\/]/g, '__')}`;
    await fs.mkdir(path.dirname(this.resolve(dest)), { recursive: true });
    await fs.rename(abs, this.resolve(dest)).catch(() => undefined);
    this.emit('quarantined', { rel, to: dest });
    return readFromLatestBackup(this.root, rel.replace(/\\/g, '/'));
  }

  async readJson<T>(rel: string, opts: ReadOptions<T> = {}): Promise<T> {
    return this.withLocks([rel], async () => {
      const text = await this.rawRead(rel);
      if (text === null) {
        if (opts.fallback) return opts.fallback();
        throw new StoreError(`${rel} does not exist`, 'IO', rel);
      }
      try {
        return this.parseAndValidate(text, rel, opts.schema);
      } catch (e) {
        if (!(e instanceof StoreError) || e.code !== 'CORRUPT') throw e;
        const good = await this.quarantine(rel);
        if (good !== null) {
          try {
            const v = this.parseAndValidate(good, rel, opts.schema);
            await this.rawWrite(rel, good);
            this.emit('restored', { rel, from: 'backup' });
            return v;
          } catch {
            /* backup is bad too */
          }
        }
        if (opts.fallback) return opts.fallback();
        throw e;
      }
    });
  }

  async writeJson<T>(rel: string, data: T, opts: { schema?: ZodType<T> } = {}): Promise<void> {
    const checked = opts.schema ? opts.schema.parse(data) : data;
    await this.withLocks([rel], () => this.rawWrite(rel, stableStringify(checked)));
  }

  /** Read-modify-write under the file lock. */
  async update<T>(
    rel: string,
    fn: (cur: T) => T | Promise<T>,
    opts: ReadOptions<T> & { fallback: () => T },
  ): Promise<T> {
    return this.withLocks([rel], async () => {
      const text = await this.rawRead(rel);
      const cur = text === null ? opts.fallback() : this.parseAndValidate(text, rel, opts.schema);
      const next = await fn(cur);
      const checked = opts.schema ? opts.schema.parse(next) : next;
      await this.rawWrite(rel, stableStringify(checked));
      return checked;
    });
  }

  /** Read a `{ schemaVersion, ... }` document, migrating (with a pre-migration backup). */
  async readVersioned<T extends Versioned>(rel: string, opts: VersionedOptions<T>): Promise<T> {
    const text = await this.readText(rel);
    if (text === null) return opts.fallback();
    let doc: Versioned;
    try {
      doc = JSON.parse(text) as Versioned;
    } catch (e) {
      return this.readJson<T>(rel, { fallback: opts.fallback, schema: opts.schema }).catch(() => {
        throw e;
      });
    }
    if ((doc.schemaVersion ?? 0) < opts.version) {
      await this.backup('pre-migration');
      doc = migrate(doc, opts.version, opts.migrations ?? {});
      await this.writeJson(rel, doc);
    }
    return this.readJson<T>(rel, { schema: opts.schema, fallback: opts.fallback });
  }

  // ---------- multi-file ----------
  /** Apply several writes/removes/moves; on failure everything is restored. */
  async batch(ops: Op[]): Promise<void> {
    const rels = ops.flatMap((o) => (o.type === 'move' ? [o.from, o.to] : [o.rel]));
    await this.withLocks(rels, async () => {
      const prior = new Map<string, string | null>();
      for (const r of rels) prior.set(r, await this.rawRead(r));
      try {
        for (const o of ops) {
          if (o.type === 'write') await this.rawWrite(o.rel, o.text);
          else if (o.type === 'remove') await this.rawRemove(o.rel);
          else {
            const t = await this.rawRead(o.from);
            if (t === null)
              throw new StoreError(`cannot move missing file ${o.from}`, 'IO', o.from);
            await this.rawWrite(o.to, t);
            await this.rawRemove(o.from);
          }
        }
      } catch (e) {
        for (const [r, t] of prior) {
          if (t === null) await this.rawRemove(r).catch(() => undefined);
          else await this.rawWrite(r, t).catch(() => undefined);
        }
        throw e;
      }
    });
  }

  // ---------- backups ----------
  backup(reason: string, keep = 20): Promise<string> {
    return createBackup(this.root, reason, keep);
  }

  /** Create a launch backup when the newest one is older than maxAgeMs (default 6h). */
  async backupIfStale(maxAgeMs = 6 * 3600_000): Promise<string | null> {
    const all = await listBackups(this.root);
    const newest = all[all.length - 1];
    if (newest) {
      const st = await fs.stat(path.join(this.root, 'backups', newest));
      if (Date.now() - st.mtimeMs < maxAgeMs) return null;
    }
    return this.backup('launch');
  }

  // ---------- watching ----------
  async watch(): Promise<void> {
    if (this.watcher) return;
    const ignored = (p: string) =>
      /(^|[\\/])(backups|quarantine|logs|attachments|exports|imports)([\\/]|$)|\.tmp$|\.lock$/.test(
        path.relative(this.root, p),
      );
    this.watcher = chokidarWatch(this.root, {
      ignoreInitial: true,
      ignored,
      awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
    });
    const onFile = async (abs: string) => {
      const rel = path.relative(this.root, abs).split(path.sep).join('/');
      let text: string | null;
      try {
        text = await fs.readFile(abs, 'utf8');
      } catch {
        text = null;
      }
      if (text !== null && this.selfWrites.get(abs) === sha(text)) return;
      if (text !== null) {
        for (const v of this.validators) {
          if (!v.match(rel)) continue;
          try {
            v.validate(text);
          } catch (e) {
            const err = e as StoreError;
            // keep the user's broken edit for them, but never let it replace what's in memory
            const copy = `quarantine/${new Date().toISOString().replace(/[:.]/g, '-')}-${rel.replace(/\//g, '__')}`;
            await fs.mkdir(path.dirname(this.resolve(copy)), { recursive: true });
            await fs.writeFile(this.resolve(copy), text);
            this.emit('invalid-edit', {
              rel,
              message: err.message,
              line: err.line ?? jsonErrorLine(text, e),
            });
            return;
          }
        }
      }
      this.emit('external-change', { rel });
    };
    this.watcher
      .on('add', onFile)
      .on('change', onFile)
      .on('unlink', (abs) =>
        this.emit('external-change', {
          rel: path.relative(this.root, abs).split(path.sep).join('/'),
        }),
      );
    await new Promise<void>((res) => this.watcher!.once('ready', () => res()));
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
    if (this.locked) await fs.rm(path.join(this.root, '.lock'), { force: true });
    this.locked = false;
  }
}
