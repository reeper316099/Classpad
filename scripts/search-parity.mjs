#!/usr/bin/env node
// Runs the server's SearchIndex (MiniSearch) on generated documents, edits and queries, and saves
// the hits (scores included) to internal/search/testdata/parity.json.gz for the Go port to match.
//
//   npx tsc -b packages/server && node scripts/search-parity.mjs [--seed N] [--count K] [--out FILE]
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { SearchIndex } from '../packages/server/dist/search.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const OUT =
  arg('out') ??
  fileURLToPath(new URL('../internal/search/testdata/parity.json.gz', import.meta.url));
const COUNT = Number(arg('count', 40));
let seed = Number(arg('seed', 20261126));
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const WORDS = [
  'lorem',
  'ipsum',
  'dolor',
  'sit',
  'amet',
  'photosynthesis',
  'photon',
  'photograph',
  'calculus',
  'calculate',
  'cell',
  'cells',
  'mitosis',
  'meiosis',
  'essay',
  'Essay',
  'quiz',
  'quizzes',
  'café',
  'naïve',
  'ΣΟΦΙΑ',
  'İstanbul',
  '日本語',
  'emoji😀',
  'x',
  'a1',
  '2031',
  'end-of-term',
  "don't",
  'e.g.',
  '—',
  '...',
  '#tag',
];
const words = (n) =>
  Array.from({ length: n }, () => pick(WORDS)).join(pick([' ', '  ', ', ', '\n', '. ']));
const KINDS = ['note', 'assignment', 'task', 'reading'];
const doc = (i) => ({
  id: `D${String(i).padStart(4, '0')}`,
  kind: pick(KINDS),
  title: words(int(1, 4)),
  body: rand() < 0.2 ? '' : words(int(0, 40)),
  classId: rand() < 0.7 ? pick(['C1', 'C2', 'C3']) : undefined,
  tags: Array.from({ length: int(0, 3) }, () => pick(['exam', 'Review', 'lab', 'x'])),
  types: Array.from({ length: int(0, 2) }, () => pick(['essay', 'Quiz', 'lab'])),
  due:
    rand() < 0.5
      ? pick([
          '2031-10-14',
          '2031-10-15',
          '2031-10-16',
          '2031-10-20T09:00',
          '2031-11-30',
          '2031-10-01/2031-10-02',
        ])
      : undefined,
});
const QUERIES = () => {
  const q = [
    words(int(1, 3)),
    Array.from(pick(WORDS)).slice(0, int(1, 6)).join(''),
    'photosinthesis',
    'calclus',
    'class:bio',
    'type:essay',
    'tag:#exam',
    'due:today',
    'due:week',
    'due:overdue',
    'due:2031-10-16',
    `"${words(1)}" ${words(1)}`,
    'TAG:Review cell',
    'class:"intro bio" lorem',
    '',
    '   ',
  ];
  return pick(q) + (rand() < 0.3 ? ' ' + pick(q) : '');
};
const classMatches = (term) =>
  new Set(
    ['C1', 'C2', 'C3'].filter((c) =>
      ({ C1: 'intro bio', C2: 'calculus i', C3: 'art' })[c].includes(term),
    ),
  );
const now = new Date('2031-10-15T12:00:00Z');
const cases = [];
for (let c = 0; c < COUNT; c++) {
  const idx = new SearchIndex();
  let docs = Array.from({ length: int(0, 30) }, (_, i) => doc(i));
  const ops = [{ op: 'rebuild', docs }];
  idx.rebuild(docs);
  const steps = [];
  for (let s = 0; s < 40; s++) {
    const r = rand();
    if (r < 0.25 && docs.length) {
      const d = { ...doc(int(0, 60)) };
      idx.upsert(d);
      steps.push({ op: 'upsert', doc: d });
    } else if (r < 0.4 && docs.length) {
      const id = `D${String(int(0, 60)).padStart(4, '0')}`;
      idx.remove(id);
      steps.push({ op: 'remove', id });
    } else {
      const q = QUERIES();
      const limit = pick([5, 50]);
      steps.push({ op: 'search', q, limit, want: idx.search(q, classMatches, limit, now) });
    }
  }
  cases.push({ ops, steps });
}
writeFileSync(OUT, gzipSync(JSON.stringify(cases)));
console.log(`wrote ${cases.length} search scenarios`);
