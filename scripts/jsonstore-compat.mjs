#!/usr/bin/env node
// Records what the TypeScript store (packages/jsonstore) writes, so the Go store
// (internal/jsonstore, compat_test.go) can check it writes the same bytes and reads the same files:
// stable JSON for tricky values, scrypt keys, encrypted envelopes, and a backup zip.
//
//   npx tsc -b packages/jsonstore && node scripts/jsonstore-compat.mjs
//
// Everything here is synthetic and comes from a fixed seed.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonStore,
  decryptText,
  deriveKey,
  encryptText,
  stableStringify,
} from '../packages/jsonstore/dist/index.js';

// --verify DIR: open a folder the Go store wrote (see TestCompatExport) and check every file.
if (process.argv.includes('--verify')) {
  const dir = process.argv[process.argv.indexOf('--verify') + 1];
  const { default: AdmZip } = await import('adm-zip');
  const { readdir } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const store = await JsonStore.open(dir, { lock: false });
  const key = Buffer.from(manifest.key, 'hex');
  store.setCrypto({ key, shouldEncrypt: (r) => r.startsWith('data/journal/') });
  const zips = (await readdir(path.join(dir, 'backups'))).filter((f) => f.endsWith('.zip'));
  const zip = new AdmZip(path.join(dir, 'backups', zips[0]));
  let n = 0;
  for (const [rel, want] of Object.entries(manifest.files)) {
    const got = await store.readText(rel);
    if (got !== want) throw new Error(`${rel}: the TypeScript store read ${JSON.stringify(got)}`);
    if (rel.endsWith('.json') && stableStringify(JSON.parse(got)) !== got)
      throw new Error(`${rel} is not what the TypeScript store would write`);
    const raw = await readFile(path.join(dir, rel), 'utf8');
    const inZip = zip.getEntry(rel)?.getData().toString('utf8');
    if (inZip !== raw) throw new Error(`${rel} differs in the Go-made backup`);
    n++;
  }
  await store.close();
  console.log(`the TypeScript store read all ${n} files and the backup the Go store wrote`);
  process.exit(0);
}

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const OUT =
  arg('out') ??
  fileURLToPath(new URL('../internal/jsonstore/testdata/compat.json', import.meta.url));
let seed = Number(arg('seed', 20261126));
const COUNT = Number(arg('count', 300));

const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

// Strings that stress escaping and key order (UTF-16 order differs from code point order above U+FFFF).
const STRINGS = [
  '',
  'plain',
  'quote " and backslash \\',
  'tab\tnew\nline\rcr',
  '\u0000\u0001\u001f\u007f',
  '\b\f',
  'line sep   para sep  ',
  '</script><b>&amp;</b>',
  'café',
  'café',
  '日本語',
  '😀 emoji',
  '￿',
  ' private use',
  '𝔘𝔫𝔦𝔠𝔬𝔡𝔢',
  'Z',
  'a',
  '10',
  '2',
  '__proto__x',
];
const NUMBERS = [
  0,
  -0,
  1,
  -1,
  0.1,
  0.1 + 0.2,
  1 / 3,
  100,
  1e21,
  1e20,
  123456789012345680000,
  1e-6,
  1e-7,
  1.5e-7,
  5e-324,
  1.7976931348623157e308,
  -2.5e-10,
  4.35,
  2 ** 53,
  2 ** 53 + 2,
  99.99999999999999,
  3.7,
];

function value(depth) {
  const k = rand();
  if (depth > 3 || k < 0.35) {
    const p = rand();
    if (p < 0.4) return pick(NUMBERS) * (rand() < 0.2 ? int(1, 1000) : 1);
    if (p < 0.75) return pick(STRINGS);
    if (p < 0.85) return null;
    return rand() < 0.5;
  }
  if (k < 0.65) return Array.from({ length: int(0, 4) }, () => value(depth + 1));
  const o = {};
  for (let i = int(0, 5); i > 0; i--)
    o[pick(STRINGS) + (rand() < 0.3 ? String(int(0, 99)) : '')] = value(depth + 1);
  return o;
}

const stable = [];
for (let i = 0; i < COUNT; i++) {
  const v = value(0);
  stable.push({ input: JSON.stringify(v), output: stableStringify(v) });
}
// Duplicate keys (the last one wins) and spacing in the input.
for (const input of ['{"a":1,"a":2}', ' [ 1 , {"b" : -0 } ] ', '{"x":1e400}', '"\\ud83d\\ude00"']) {
  stable.push({ input, output: stableStringify(JSON.parse(input)) });
}

const hex = (b) => Buffer.from(b).toString('hex');
const keys = [];
for (const [pass, saltHex] of [
  ['correct horse', '000102030405060708090a0b0c0d0e0f'],
  ['café', 'ffeeddccbbaa99887766554433221100'],
  ['café', 'ffeeddccbbaa99887766554433221100'],
  ['ﬁle Ⅸ', '0123456789abcdef0123456789abcdef'],
  ['', '00000000000000000000000000000000'],
]) {
  keys.push({ pass, salt: saltHex, key: hex(await deriveKey(pass, Buffer.from(saltHex, 'hex'))) });
}

const key = Buffer.from(keys[0].key, 'hex');
const envelopes = [];
for (const [rel, text] of [
  ['data/journal/2031-01.json', '{\n  "note": "a synthetic diary line"\n}\n'],
  ['data/notes/n.md', '# Heading\n\nSome *text* with ünïcödé and 😀.\n'],
  ['data/empty.txt', ''],
]) {
  const envelope = encryptText(key, rel, text);
  if (decryptText(key, rel, envelope) !== text) throw new Error('round trip failed');
  envelopes.push({ key: keys[0].key, rel, text, envelope });
}

// A backup made by the TypeScript store (AdmZip), with nested folders and an excluded one.
const dir = await mkdtemp(path.join(tmpdir(), 'jsonstore-compat-'));
const store = await JsonStore.open(dir);
const files = {
  'data/tasks/tasks.json': stableStringify({ schemaVersion: 1, items: [{ id: 'T1' }] }),
  'data/notes/a note.md': '# A note\n',
  'config.json': stableStringify({ theme: 'dark' }),
};
for (const [rel, text] of Object.entries(files)) await store.writeText(rel, text);
await store.writeText('attachments/skip.bin', 'not backed up');
const zipPath = await store.backup('compat');
const backup = { zip: (await readFile(zipPath)).toString('base64'), files };
await store.close();
await rm(dir, { recursive: true, force: true });

writeFileSync(OUT, JSON.stringify({ stable, keys, envelopes, backup }, null, 1) + '\n');
console.log(
  `wrote ${stable.length} JSON cases, ${keys.length} keys, ${envelopes.length} envelopes and a backup`,
);
