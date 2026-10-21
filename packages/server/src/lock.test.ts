import AdmZip from 'adm-zip';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from './app.js';

let dir: string;
let app: App;
const SECRET = 'zebra-secret-diary-text';
const mk = async (d = dir) => createApp({ dataDir: d, token: 't' });
const call = async (a: App, method: string, url: string, payload?: unknown) => {
  const r = await a.fastify.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    headers: { authorization: 'Bearer t' },
    payload: payload as never,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
};
const walk = async (d: string): Promise<string[]> => {
  const out: string[] = [];
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
};
/** Does `needle` appear anywhere on disk, including inside backup zips? */
async function leaks(needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const f of await walk(dir)) {
    if (f.endsWith('.zip')) {
      for (const e of new AdmZip(f).getEntries())
        if (e.getData().toString('utf8').includes(needle))
          hits.push(`${path.relative(dir, f)}!${e.entryName}`);
    } else if ((await readFile(f, 'utf8').catch(() => '')).includes(needle))
      hits.push(path.relative(dir, f));
  }
  return hits;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'classpad-lock-'));
  app = await mk();
});
afterAll(async () => {
  await app.fastify.close();
  await rm(dir, { recursive: true, force: true });
});

describe('app lock + encryption at rest', () => {
  it('starts with no lock; weak passphrases are refused', async () => {
    expect((await call(app, 'GET', '/lock/status')).body).toMatchObject({
      enabled: false,
      locked: false,
    });
    expect((await call(app, 'POST', '/lock/setup', { passphrase: 'abc' })).status).toBe(422);
    await call(app, 'POST', '/journal', { date: '2031-03-05', markdown: SECRET });
    await call(app, 'POST', '/notes', { title: 'Diary note', markdown: `# ${SECRET}` });
    await call(app, 'POST', '/contacts', { name: 'Plain Person' });
    expect((await leaks(SECRET)).length).toBeGreaterThan(0); // plaintext before encryption
  });

  it('encrypts the chosen collections at rest and leaves no plaintext anywhere, backups included', async () => {
    const r = await call(app, 'POST', '/lock/setup', {
      passphrase: 'correct horse',
      collections: ['journal', 'notes'],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      enabled: true,
      locked: false,
      encryptedCollections: ['journal', 'notes'],
    });
    expect(await leaks(SECRET)).toEqual([]);
    expect(await readFile(path.join(dir, 'data/contacts/contacts.json'), 'utf8')).toContain(
      'Plain Person',
    ); // not chosen
    expect(
      (await readFile(path.join(dir, 'data/journal/2031-03.json'), 'utf8')).startsWith(
        '{"classpad":"enc1"',
      ),
    ).toBe(true);
    // the app still works normally while unlocked, and new writes are encrypted too
    expect((await call(app, 'GET', '/journal')).body.items[0].markdown).toBe(SECRET);
    await call(app, 'POST', '/journal', { date: '2031-03-06', markdown: 'second-secret' });
    expect(await leaks('second-secret')).toEqual([]);
    expect(
      (await readdir(path.join(dir, 'backups'))).some((f) => f.includes('post-encryption')),
    ).toBe(true);
  });

  it('locking blocks every data route (but not health/status), unlocking restores them', async () => {
    expect((await call(app, 'POST', '/lock/lock')).body.locked).toBe(true);
    for (const [m, u] of [
      ['GET', '/notes'],
      ['GET', '/semesters'],
      ['GET', '/export/json'],
      ['POST', '/assignments'],
      ['GET', '/events'],
      ['GET', '/grades/class/x'],
      ['PUT', '/settings'],
    ] as const)
      expect((await call(app, m, u, m === 'GET' ? undefined : {})).status, `${m} ${u}`).toBe(423);
    expect((await call(app, 'GET', '/health')).status).toBe(200);
    expect((await call(app, 'GET', '/lock/status')).body.locked).toBe(true);
    expect((await call(app, 'POST', '/lock/unlock', { passphrase: 'nope nope' })).status).toBe(403);
    expect(
      (await call(app, 'POST', '/lock/unlock', { passphrase: 'correct horse' })).body.locked,
    ).toBe(false);
    expect((await call(app, 'GET', '/notes')).status).toBe(200);
  });

  it('after a restart nothing is readable until unlock; wrong passphrases never touch the data', async () => {
    await app.fastify.close();
    app = await mk();
    expect((await call(app, 'GET', '/lock/status')).body).toMatchObject({
      enabled: true,
      locked: true,
    });
    expect(app.ctx.loaded).toBe(false); // encrypted data was not even loaded into memory
    expect((await call(app, 'GET', '/journal')).status).toBe(423);
    expect((await call(app, 'POST', '/lock/unlock', { passphrase: 'wrong' })).status).toBe(403);
    expect(app.ctx.loaded).toBe(false);
    expect((await call(app, 'POST', '/lock/unlock', { passphrase: 'correct horse' })).status).toBe(
      200,
    );
    expect(app.ctx.loaded).toBe(true);
    expect((await call(app, 'GET', '/journal')).body.total).toBe(2);
    expect((await call(app, 'GET', `/search?q=${SECRET}`)).body.hits.length).toBeGreaterThan(0);
    expect(await leaks(SECRET)).toEqual([]);
    await expect(stat(path.join(dir, 'quarantine'))).rejects.toThrow(); // a wrong key must never quarantine your files
  });

  it('five wrong guesses trigger a lockout that grows', async () => {
    await call(app, 'POST', '/lock/lock');
    for (let i = 0; i < 5; i++)
      expect((await call(app, 'POST', '/lock/unlock', { passphrase: 'bad ' + i })).status).toBe(
        403,
      );
    const blocked = await call(app, 'POST', '/lock/unlock', { passphrase: 'correct horse' });
    expect(blocked.status).toBe(429); // even the right passphrase is refused during the lockout
    expect(blocked.body.error.details.retryAfterMs).toBeGreaterThan(0);
    expect((await call(app, 'GET', '/lock/status')).body.retryAfterMs).toBeGreaterThan(0);
    // reset for the following tests by restarting (the counter lives in memory)
    await app.fastify.close();
    app = await mk();
    expect((await call(app, 'POST', '/lock/unlock', { passphrase: 'correct horse' })).status).toBe(
      200,
    );
  });

  it('changing the passphrase needs the current one and re-encrypts under the new key', async () => {
    expect((await call(app, 'POST', '/lock/setup', { passphrase: 'new passphrase' })).status).toBe(
      403,
    );
    expect(
      (await call(app, 'POST', '/lock/setup', { passphrase: 'new passphrase', current: 'bad' }))
        .status,
    ).toBe(403);
    expect(
      (
        await call(app, 'POST', '/lock/setup', {
          passphrase: 'new passphrase',
          current: 'correct horse',
        })
      ).status,
    ).toBe(200);
    await call(app, 'POST', '/lock/lock');
    expect((await call(app, 'POST', '/lock/unlock', { passphrase: 'correct horse' })).status).toBe(
      403,
    );
    expect((await call(app, 'POST', '/lock/unlock', { passphrase: 'new passphrase' })).status).toBe(
      200,
    );
    expect((await call(app, 'GET', '/journal')).body.total).toBe(2);
    expect(await leaks(SECRET)).toEqual([]);
  });

  it('collections can be changed; turning encryption off writes plain files again', async () => {
    expect(
      (await call(app, 'POST', '/lock/collections', { collections: ['journal', 'contacts'] })).body
        .encryptedCollections,
    ).toEqual(['journal', 'contacts']);
    expect(
      (await readFile(path.join(dir, 'data/contacts/contacts.json'), 'utf8')).startsWith(
        '{"classpad"',
      ),
    ).toBe(true);
    expect(
      await readFile(
        path.join(
          dir,
          'data/notes',
          (await readdir(path.join(dir, 'data/notes')))[0]!,
          'diary-note.md',
        ),
        'utf8',
      ),
    ).toContain(SECRET); // notes now plain
    expect(
      (await call(app, 'POST', '/lock/collections', { collections: [] })).body.encryptedCollections,
    ).toEqual([]);
    expect(await readFile(path.join(dir, 'data/journal/2031-03.json'), 'utf8')).toContain(SECRET);
    // enabling again after the key was dropped needs the passphrase
    expect(
      (await call(app, 'POST', '/lock/collections', { collections: ['journal'] })).status,
    ).toBe(403);
    expect(
      (
        await call(app, 'POST', '/lock/collections', {
          collections: ['journal'],
          passphrase: 'new passphrase',
        })
      ).status,
    ).toBe(200);
    // only the journal is encrypted now: it must not leak anywhere (backups included); the plain notes do, by choice
    const hits = await leaks(SECRET);
    expect(hits.filter((h) => h.includes('journal'))).toEqual([]);
    expect(hits.some((h) => h.includes('notes'))).toBe(true);
  });

  it('disable removes the lock and decrypts everything', async () => {
    expect((await call(app, 'POST', '/lock/disable', { passphrase: 'wrong' })).status).toBe(403);
    expect(
      (await call(app, 'POST', '/lock/disable', { passphrase: 'new passphrase' })).body,
    ).toMatchObject({ enabled: false, locked: false });
    expect(await readFile(path.join(dir, 'data/journal/2031-03.json'), 'utf8')).toContain(SECRET);
    await expect(stat(path.join(dir, 'config/privacy.json'))).rejects.toThrow();
    await app.fastify.close();
    app = await mk();
    expect((await call(app, 'GET', '/journal')).body.total).toBe(2); // opens normally, no lock
  });

  it('a lock without encryption still blocks access and keeps data loaded', async () => {
    await call(app, 'POST', '/lock/setup', {
      passphrase: 'just a lock',
      autoLockMinutes: 10,
      lockOnHide: true,
    });
    expect((await call(app, 'GET', '/lock/status')).body).toMatchObject({
      enabled: true,
      encryptedCollections: [],
      autoLockMinutes: 10,
      lockOnHide: true,
    });
    await call(app, 'POST', '/lock/lock');
    expect((await call(app, 'GET', '/journal')).status).toBe(423);
    await call(app, 'POST', '/lock/unlock', { passphrase: 'just a lock' });
    expect((await call(app, 'GET', '/journal')).status).toBe(200);
    expect(
      (await call(app, 'PATCH', '/lock/settings', { autoLockMinutes: 0 })).body.autoLockMinutes,
    ).toBe(0);
  });
});
