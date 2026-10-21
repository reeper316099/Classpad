import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  JsonStore,
  KeyedMutex,
  StoreError,
  migrate,
  stableStringify,
  type Versioned,
} from './index.js';

let dir: string;
let store: JsonStore;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'jsonstore-'));
  store = await JsonStore.open(dir);
});
afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

const Schema = z.object({
  schemaVersion: z.number(),
  items: z.array(z.object({ id: z.string() })),
});
const fallback = () => ({ schemaVersion: 1, items: [] as { id: string }[] });

describe('atomic writes and stable output', () => {
  it('writes sorted, pretty JSON with trailing newline and leaves no tmp files', async () => {
    await store.writeJson('a/b.json', { z: 1, a: { y: 2, b: 3 } });
    const text = await readFile(path.join(dir, 'a/b.json'), 'utf8');
    expect(text).toBe('{\n  "a": {\n    "b": 3,\n    "y": 2\n  },\n  "z": 1\n}\n');
    expect((await readdir(path.join(dir, 'a'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
  it('rejects invalid data and leaves the old file intact', async () => {
    await store.writeJson('x.json', fallback(), { schema: Schema });
    await expect(
      store.writeJson('x.json', { schemaVersion: 'no' } as never, { schema: Schema }),
    ).rejects.toThrow();
    expect((await store.readJson('x.json', { schema: Schema })).items).toEqual([]);
  });
  it('refuses path traversal', async () => {
    await expect(store.writeText('../evil.txt', 'x')).rejects.toBeInstanceOf(StoreError);
    expect(() => store.resolve('a/../../x')).toThrow();
  });
  it('stableStringify drops undefined', () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{\n  "b": 1\n}\n');
  });
});

describe('concurrency', () => {
  it('serializes read-modify-write so no updates are lost', async () => {
    await store.writeJson('c.json', { n: 0 });
    await Promise.all(
      Array.from({ length: 50 }, () =>
        store.update('c.json', (c: { n: number }) => ({ n: c.n + 1 }), {
          fallback: () => ({ n: 0 }),
        }),
      ),
    );
    expect((await store.readJson<{ n: number }>('c.json')).n).toBe(50);
  });
  it('KeyedMutex runs per key in order', async () => {
    const m = new KeyedMutex();
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((i) =>
        m.run('k', async () => {
          await new Promise((r) => setTimeout(r, 10 - i * 3));
          order.push(i);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });
  it('a failed op does not block the queue', async () => {
    const m = new KeyedMutex();
    await expect(
      m.run('k', async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow();
    await expect(m.run('k', async () => 5)).resolves.toBe(5);
  });
});

describe('corruption recovery', () => {
  it('quarantines a corrupt file and restores the last good backup', async () => {
    await store.writeJson('d.json', { schemaVersion: 1, items: [{ id: 'good' }] });
    await store.backup('test');
    await writeFile(path.join(dir, 'd.json'), '{ not json');
    const events: string[] = [];
    store.on('restored', () => events.push('restored'));
    store.on('quarantined', () => events.push('quarantined'));
    const v = await store.readJson('d.json', { schema: Schema });
    expect(v.items[0]!.id).toBe('good');
    expect(events).toEqual(['quarantined', 'restored']);
    expect((await readdir(path.join(dir, 'quarantine'))).length).toBe(1);
  });
  it('falls back (not crash) when there is no backup and a fallback exists; throws otherwise', async () => {
    await writeFile(path.join(dir, 'e.json'), '{ nope');
    expect((await store.readJson('e.json', { schema: Schema, fallback })).items).toEqual([]);
    await writeFile(path.join(dir, 'f.json'), '{ nope');
    await expect(store.readJson('f.json', { schema: Schema })).rejects.toMatchObject({
      code: 'CORRUPT',
    });
  });
  it('treats schema-invalid files as corrupt', async () => {
    await writeFile(path.join(dir, 'g.json'), '{"schemaVersion":"x"}');
    await expect(store.readJson('g.json', { schema: Schema })).rejects.toMatchObject({
      code: 'CORRUPT',
    });
  });
});

describe('migrations', () => {
  const migrations = {
    1: (d: Versioned) => ({
      ...d,
      items: (d.items as object[]).map((i) => ({ ...i, v2: true })),
    }),
  };
  it('migrate chains versions and rejects newer files', () => {
    const out = migrate({ schemaVersion: 1, items: [{ id: 'a' }] }, 2, migrations);
    expect(out.schemaVersion).toBe(2);
    expect((out.items as { v2: boolean }[])[0]!.v2).toBe(true);
    expect(() => migrate({ schemaVersion: 9 }, 2, migrations)).toThrow(/newer/);
    expect(() => migrate({ schemaVersion: 0 }, 2, migrations)).toThrow(/no migration/);
  });
  it('readVersioned migrates on disk and takes a pre-migration backup', async () => {
    await store.writeJson('m.json', { schemaVersion: 1, items: [{ id: 'a' }] });
    const doc = await store.readVersioned('m.json', {
      version: 2,
      migrations,
      fallback: () => ({ schemaVersion: 2, items: [] }),
    });
    expect(doc.schemaVersion).toBe(2);
    expect(
      (await readdir(path.join(dir, 'backups'))).some((f) => f.includes('pre-migration')),
    ).toBe(true);
    expect(JSON.parse(await readFile(path.join(dir, 'm.json'), 'utf8')).schemaVersion).toBe(2);
  });
});

describe('batch with rollback', () => {
  it('applies all ops', async () => {
    await store.writeText('a.txt', 'A');
    await store.batch([
      { type: 'move', from: 'a.txt', to: 'sub/b.txt' },
      { type: 'write', rel: 'c.txt', text: 'C' },
    ]);
    expect(await store.readText('a.txt')).toBeNull();
    expect(await store.readText('sub/b.txt')).toBe('A');
  });
  it('rolls everything back when an op fails', async () => {
    await store.writeText('a.txt', 'A');
    await expect(
      store.batch([
        { type: 'write', rel: 'a.txt', text: 'CHANGED' },
        { type: 'write', rel: 'n.txt', text: 'N' },
        { type: 'move', from: 'missing.txt', to: 'z.txt' },
      ]),
    ).rejects.toThrow();
    expect(await store.readText('a.txt')).toBe('A');
    expect(await store.readText('n.txt')).toBeNull();
  });
});

describe('backups and lock', () => {
  it('keeps only the newest N backups and skips backups/attachments', async () => {
    await store.writeText('x.txt', '1');
    await store.writeText('attachments/big.bin', 'zzz');
    for (let i = 0; i < 4; i++) {
      await store.backup('r' + i, 3);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await readdir(path.join(dir, 'backups'))).length).toBe(3);
  });
  it('backupIfStale only backs up when needed', async () => {
    await store.writeText('x.txt', '1');
    expect(await store.backupIfStale()).toBeTruthy();
    expect(await store.backupIfStale()).toBeNull();
  });
  it('a second instance on the same dir is rejected while the first is alive', async () => {
    // simulate a live foreign process: parent pid is always alive
    await writeFile(path.join(dir, '.lock'), String(process.ppid));
    await expect(JsonStore.open(dir)).rejects.toMatchObject({ code: 'LOCKED' });
  });
  it('stale locks are taken over', async () => {
    await writeFile(path.join(dir, '.lock'), '999999999');
    const s2 = await JsonStore.open(dir);
    await s2.close();
  });
});

describe('watching', () => {
  it('emits external changes, ignores own writes, and flags invalid edits without clobbering', async () => {
    store.registerValidator(
      (r) => r.endsWith('.json'),
      (t) => {
        Schema.parse(JSON.parse(t));
      },
    );
    await store.writeJson('w.json', fallback());
    await store.watch();
    const ext: string[] = [];
    const bad: { rel: string; line?: number }[] = [];
    store.on('external-change', (e) => ext.push(e.rel));
    store.on('invalid-edit', (e) => bad.push(e));
    await store.writeJson('w.json', { schemaVersion: 1, items: [{ id: 'own' }] }); // own write
    await new Promise((r) => setTimeout(r, 400));
    expect(ext).toEqual([]);
    await writeFile(
      path.join(dir, 'w.json'),
      JSON.stringify({ schemaVersion: 1, items: [{ id: 'hand' }] }),
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(ext).toContain('w.json');
    await writeFile(path.join(dir, 'w.json'), '{\n  "schemaVersion": 1,\n  oops\n}');
    await new Promise((r) => setTimeout(r, 500));
    expect(bad.length).toBeGreaterThan(0);
    expect(bad[0]!.line).toBeGreaterThan(0);
  });
});
