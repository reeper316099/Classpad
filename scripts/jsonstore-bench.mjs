#!/usr/bin/env node
// Times the TypeScript store on the same work as the Go benchmarks in
// internal/jsonstore/bench_test.go, for docs/go-port/README.md. The data is synthetic.
//
//   npx tsc -b packages/jsonstore && node scripts/jsonstore-bench.mjs
//   go test -run - -bench . ./internal/jsonstore
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonStore, deriveKey, stableStringify } from '../packages/jsonstore/dist/index.js';

// The same document the Go benchmark builds: 2,000 assignment-like records (about 600 KB).
export function benchDoc() {
  const items = [];
  for (let i = 0; i < 2000; i++)
    items.push({
      id: `A${String(i).padStart(5, '0')}`,
      title: `Assignment ${i}`,
      points: ((i * 7) % 100) + 0.5,
      done: i % 3 === 0,
      tags: ['homework', `week ${i % 15}`],
      notes: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.',
      score: i % 4 === 0 ? null : { earned: i % 50, possible: 50 },
    });
  return { schemaVersion: 1, items };
}

const dir = await mkdtemp(path.join(tmpdir(), 'jsonstore-bench-'));
const store = await JsonStore.open(dir);
const doc = benchDoc();
for (let i = 0; i < 200; i++)
  await store.writeText(`data/notes/note-${i}.md`, `# Note ${i}\n\n${'Some text. '.repeat(40)}\n`);
await store.writeJson('data/items.json', doc);
const key = await deriveKey('bench passphrase', Buffer.alloc(16));

const work = {
  Stringify: async () => stableStringify(doc),
  WriteJSON: () => store.writeJson('data/items.json', doc),
  ReadJSON: () => store.readJson('data/items.json'),
  EncryptedWriteRead: async () => {
    store.setCrypto({ key, shouldEncrypt: () => true });
    await store.writeJson('data/secret.json', doc);
    await store.readJson('data/secret.json');
    store.setCrypto(null);
  },
  Backup: () => store.backup('bench', 3),
};

for (const [name, f] of Object.entries(work)) {
  for (let i = 0; i < 5; i++) await f(); // warm up
  const times = [];
  for (let round = 0; round < 7; round++) {
    let n = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 700) {
      await f();
      n++;
    }
    times.push((performance.now() - t0) / n);
  }
  times.sort((a, b) => a - b);
  console.log(`${name.padEnd(19)} ${times[3].toFixed(3)} ms`);
}
console.log(`document: ${(stableStringify(doc).length / 1e3).toFixed(0)} KB`);
await store.close();
await rm(dir, { recursive: true, force: true });
