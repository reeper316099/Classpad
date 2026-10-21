import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from './app.js';

let dir: string;
let out: string;
let app: App;
const call = async (method: string, url: string, payload?: unknown) => {
  const r = await app.fastify.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    headers: { authorization: 'Bearer t' },
    payload: payload as never,
  });
  const text = r.body;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: r.statusCode, body: body as never as Record<string, never>, text };
};
const exists = (p: string) =>
  readFile(p).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'classpad-sync-'));
  out = await mkdtemp(path.join(tmpdir(), 'classpad-sync-out-'));
  await mkdir(path.join(dir, 'plugins'), { recursive: true });
  await writeFile(
    path.join(dir, 'plugins', 'my-format.json'),
    JSON.stringify({
      pluginVersion: 1,
      id: 'my-format',
      name: 'My format',
      kind: 'gradebook-csv',
      columns: { title: 'Task', score: 'Mark', pointsPossible: 'Out of' },
    }),
  );
  await writeFile(
    path.join(dir, 'plugins', 'broken.json'),
    JSON.stringify({ pluginVersion: 1, id: 'Bad Id', kind: 'script' }),
  );
  await writeFile(
    path.join(dir, 'plugins', 'dupe.json'),
    JSON.stringify({ pluginVersion: 1, id: 'gradebook-rows', name: 'dupe', kind: 'gradebook-csv' }),
  );
  app = await createApp({ dataDir: dir, token: 't' });
});
afterAll(async () => {
  await app.fastify.close();
  await rm(dir, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

describe('mapping plugins', () => {
  it('lists built-in and valid user plugins, and reports bad ones without failing', async () => {
    const r = await call('GET', '/plugins');
    expect(r.status).toBe(200);
    const b = r.body as never as {
      builtin: { id: string }[];
      user: { id: string }[];
      errors: { file: string; message: string }[];
    };
    expect(b.builtin.map((p) => p.id)).toContain('gradebook-rows');
    expect(b.user.map((p) => p.id)).toEqual(['my-format']);
    expect(b.errors.map((e) => e.file).sort()).toEqual([
      'plugins/broken.json',
      'plugins/dupe.json',
    ]);
    expect(b.errors.find((e) => e.file.endsWith('dupe.json'))!.message).toMatch(/already used/);
  });

  it('imports a foreign CSV through a user plugin, then commits it', async () => {
    const sem = (await call('POST', '/semesters', { name: 'Sync Term' })).body as { id: string };
    await call('POST', '/classes', { name: 'Lorem 101', semesterId: sem.id });
    const csv = 'Task,Mark,Out of\nQuiz A,17,20\nEssay B,,50\n';
    const pv = await call('POST', '/import/preview', {
      kind: 'csv',
      pluginId: 'my-format',
      className: 'Lorem 101',
      text: csv,
    });
    expect(pv.status).toBe(200);
    const id = (pv.body as { previewId: string }).previewId;
    expect((await call('POST', '/import/commit', { previewId: id, strategy: 'skip' })).status).toBe(
      200,
    );
    const list = (await call('GET', '/assignments?limit=100')).body as never as {
      items: { title: string; score?: { percent: number } }[];
    };
    const quiz = list.items.find((a) => a.title === 'Quiz A')!;
    expect(quiz.score?.percent).toBeCloseTo(85);
    expect(list.items.find((a) => a.title === 'Essay B')!.score).toBeUndefined();
  });

  it('rejects an unknown plugin id', async () => {
    const r = await call('POST', '/import/preview', {
      kind: 'csv',
      pluginId: 'nope-x',
      text: 'a\n1',
    });
    expect(r.status).toBe(404);
  });
});

describe('gradebook export', () => {
  it('has one row per assignment with the class grade', async () => {
    const r = await call('GET', '/export/gradebook');
    expect(r.status).toBe(200);
    const lines = r.text.trim().split(/\r?\n/);
    expect(lines[0]).toContain('class_percent');
    expect(lines.some((l) => l.includes('Quiz A') && l.includes('Lorem 101'))).toBe(true);
  });
});

describe('sync folder', () => {
  it('writes a self-contained export into a folder it owns', async () => {
    const r = await call('POST', '/sync/export', { dir: out });
    expect(r.status).toBe(200);
    const target = path.join(out, 'Classpad Export');
    for (const f of [
      'README.txt',
      'classpad-backup.json',
      'gradebook.csv',
      'csv/assignments.csv',
      'calendar/deadlines.ics',
      '.classpad-export.json',
    ])
      expect(await exists(path.join(target, f)), f).toBe(true);
    expect(
      JSON.parse(await readFile(path.join(target, 'classpad-backup.json'), 'utf8')).format,
    ).toBe('classpad-backup');
  });

  it('removes only files a previous export wrote', async () => {
    const target = path.join(out, 'Classpad Export');
    await call('POST', '/notes', { title: 'Temp Note', markdown: 'x' });
    await call('POST', '/sync/export', { dir: out });
    expect(
      (await readdir(path.join(target, 'notes'), { recursive: true })).some((f) =>
        String(f).includes('temp-note'),
      ),
    ).toBe(true);
    await writeFile(path.join(out, 'mine.txt'), 'keep');
    const notes = (await call('GET', '/notes?limit=100')).body as never as {
      items: { id: string; title: string }[];
    };
    await call('DELETE', `/notes/${notes.items.find((n) => n.title === 'Temp Note')!.id}`);
    await call('POST', '/sync/export', { dir: out });
    expect(
      (await readdir(path.join(target, 'notes'), { recursive: true })).some((f) =>
        String(f).includes('temp-note'),
      ),
    ).toBe(false);
    expect(await exists(path.join(out, 'mine.txt'))).toBe(true);
  });

  it('refuses unsafe targets', async () => {
    expect((await call('POST', '/sync/export', { dir: 'relative/path' })).status).toBe(422);
    expect((await call('POST', '/sync/export', { dir: dir })).status).toBe(422);
    expect((await call('POST', '/sync/export', { dir: path.join(dir, 'data') })).status).toBe(422);
    expect((await call('POST', '/sync/export', { dir: path.join(out, 'missing') })).status).toBe(
      422,
    );
    expect((await call('POST', '/sync/export', { dir: path.parse(out).root })).status).toBe(422);
  });

  it('will not take over a folder it did not create', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'classpad-sync-other-'));
    await mkdir(path.join(other, 'Classpad Export'));
    await writeFile(path.join(other, 'Classpad Export', 'precious.txt'), 'mine');
    const r = await call('POST', '/sync/export', { dir: other });
    expect(r.status).toBe(409);
    expect(await exists(path.join(other, 'Classpad Export', 'precious.txt'))).toBe(true);
    await rm(other, { recursive: true, force: true });
  });

  it('asks for confirmation before writing plaintext when encryption is on', async () => {
    await call('POST', '/lock/setup', {
      passphrase: 'correct horse battery',
      collections: ['notes'],
    });
    const r = await call('POST', '/sync/export', { dir: out });
    expect(r.status).toBe(409);
    expect((r.body as never as { error: { code: string } }).error.code).toBe('NEEDS_ACK');
    expect(
      (await call('POST', '/sync/export', { dir: out, acknowledgePlaintext: true })).status,
    ).toBe(200);
  });
});
