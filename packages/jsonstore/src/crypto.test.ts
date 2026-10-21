import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  JsonStore,
  StoreError,
  decryptText,
  deriveKey,
  encryptText,
  isEnvelope,
  newSalt,
  verifyHash,
} from './index.js';

let dir: string;
let store: JsonStore;
let key: Buffer;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'jsonstore-enc-'));
  store = await JsonStore.open(dir);
  key = await deriveKey('correct horse', newSalt());
});
afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});
const onDisk = (rel: string) => readFile(path.join(dir, rel), 'utf8');
const SECRET = 'my very private diary line';
const policy = (...prefixes: string[]) => ({
  key,
  shouldEncrypt: (rel: string) => prefixes.some((p) => rel.startsWith(p)),
});

describe('primitives', () => {
  it('round-trips text, uses a fresh IV each time, and never leaks the plaintext', () => {
    const a = encryptText(key, 'data/x.json', SECRET),
      b = encryptText(key, 'data/x.json', SECRET);
    expect(a).not.toBe(b);
    expect(a).not.toContain('private');
    expect(isEnvelope(a)).toBe(true);
    expect(decryptText(key, 'data/x.json', a)).toBe(SECRET);
  });
  it('rejects the wrong key, tampering, and a ciphertext moved to another file', async () => {
    const env = encryptText(key, 'data/x.json', SECRET);
    const other = await deriveKey('wrong', newSalt());
    expect(() => decryptText(other, 'data/x.json', env)).toThrow(/cannot decrypt/);
    const t = JSON.parse(env);
    t.data = Buffer.from(
      Buffer.from(t.data, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b)),
    ).toString('base64');
    expect(() => decryptText(key, 'data/x.json', JSON.stringify(t))).toThrow(StoreError);
    expect(() => decryptText(key, 'data/y.json', env)).toThrow(/cannot decrypt/); // bound to its path
  });
  it('verifies passphrases against a stored hash', async () => {
    const salt = newSalt();
    const hash = await deriveKey('pass phrase', salt);
    expect(await verifyHash('pass phrase', salt, hash)).toBe(true);
    expect(await verifyHash('pass phrase ', salt, hash)).toBe(false);
    expect(await verifyHash('PASS PHRASE', salt, hash)).toBe(false);
  });
  it('normalizes unicode so the same passphrase typed differently still works', async () => {
    const salt = newSalt();
    expect((await deriveKey('café', salt)).equals(await deriveKey('café', salt))).toBe(true);
  });
});

describe('store with encryption on', () => {
  it('encrypts only the chosen paths, transparently, and leaves binaries alone', async () => {
    store.setCrypto(policy('data/journal/'));
    await store.writeJson('data/journal/2031-01.json', { note: SECRET });
    await store.writeJson('data/tasks/tasks.json', { note: 'not secret' });
    await store.writeBinary('data/journal/pic.bin', Buffer.from([1, 2, 3]));
    expect(await onDisk('data/journal/2031-01.json')).not.toContain('private');
    expect(await onDisk('data/tasks/tasks.json')).toContain('not secret');
    expect((await store.readJson<{ note: string }>('data/journal/2031-01.json')).note).toBe(SECRET);
    expect(await store.readBinary('data/journal/pic.bin')).toEqual(Buffer.from([1, 2, 3]));
  });
  it('locked (no key): encrypted files refuse to read, plain ones still work, nothing gets quarantined', async () => {
    store.setCrypto(policy('data/journal/'));
    await store.writeJson('data/journal/a.json', { v: 1 });
    await store.writeJson('data/plain.json', { v: 2 });
    store.setCrypto(null);
    await expect(store.readJson('data/journal/a.json')).rejects.toMatchObject({
      code: 'ENCRYPTED',
    });
    expect(await store.readJson('data/plain.json')).toEqual({ v: 2 });
    store.setCrypto({ key: await deriveKey('wrong', newSalt()), shouldEncrypt: () => true });
    await expect(store.readJson('data/journal/a.json')).rejects.toMatchObject({ code: 'DECRYPT' });
    expect((await onDisk('data/journal/a.json')).startsWith('{"classpad":"enc1"')).toBe(true); // untouched
    await expect(rm(path.join(dir, 'quarantine'), { recursive: false })).rejects.toThrow(); // never quarantined
  });
  it('batch with rollback keeps encrypted files encrypted', async () => {
    store.setCrypto(policy('data/'));
    await store.writeText('data/a.txt', 'A');
    await expect(
      store.batch([
        { type: 'write', rel: 'data/a.txt', text: 'B' },
        { type: 'move', from: 'data/missing', to: 'data/z' },
      ]),
    ).rejects.toThrow();
    expect(await store.readText('data/a.txt')).toBe('A');
    expect(isEnvelope(await onDisk('data/a.txt'))).toBe(true);
  });
  it('reencryptAll migrates plain → encrypted → plain and to a new key, with a backup first', async () => {
    await store.writeJson('data/journal/a.json', { v: SECRET });
    await store.writeText('data/notes/n.md', '# hi\n');
    await store.reencryptAll(policy('data/journal/'));
    expect(isEnvelope(await onDisk('data/journal/a.json'))).toBe(true);
    expect(await onDisk('data/notes/n.md')).toBe('# hi\n');
    const newKey = await deriveKey('another', newSalt());
    await store.reencryptAll({ key: newKey, shouldEncrypt: (r) => r.startsWith('data/') });
    expect(isEnvelope(await onDisk('data/notes/n.md'))).toBe(true);
    expect(await store.readText('data/notes/n.md')).toBe('# hi\n');
    await store.reencryptAll(null);
    expect(await onDisk('data/journal/a.json')).toContain('private');
    expect((await store.list('backups')).filter((f) => f.includes('pre-encryption')).length).toBe(
      3,
    );
  });
  it('hand edits to an encrypted file are decrypted for validation by the watcher', async () => {
    store.setCrypto(policy('data/'));
    await store.writeJson('data/c.json', { ok: true });
    store.registerValidator(
      (r) => r === 'data/c.json',
      (text) => {
        if (!JSON.parse(text).ok) throw new Error('not ok');
      },
    );
    await store.watch();
    const events: string[] = [];
    store.on('external-change', (e) => events.push(e.rel));
    store.on('invalid-edit', (e) => events.push('invalid:' + e.rel));
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(
      path.join(dir, 'data/c.json'),
      encryptText(key, 'data/c.json', '{"ok":true,"extra":1}'),
    );
    for (let i = 0; i < 40 && !events.includes('data/c.json'); i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(events).toContain('data/c.json');
  });
});
