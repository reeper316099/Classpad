#!/usr/bin/env node
// Records what stringifyFrontmatter (packages/shared, the npm "yaml" package) writes for generated
// note front matter, to internal/frontmatter/testdata/parity.json.gz. The Go writer must match.
//
//   npx tsc -b packages/shared && node scripts/frontmatter-parity.mjs [--seed N] [--count K] [--out FILE]
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { stringifyFrontmatter } from '../packages/shared/dist/index.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const OUT =
  arg('out') ??
  fileURLToPath(new URL('../internal/frontmatter/testdata/parity.json.gz', import.meta.url));
const COUNT = Number(arg('count', 600));
let seed = Number(arg('seed', 20261126));
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const chance = (p) => rand() < p;
const BITS = [
  'Lecture',
  ' ',
  '  ',
  '\t',
  '\n',
  '\n\n',
  ': ',
  ':',
  '#',
  ' #',
  '- ',
  '-',
  '?',
  '"',
  "'",
  '---',
  '...',
  '%',
  '@',
  '`',
  '[',
  ']',
  '{',
  '}',
  ',',
  '&',
  '*',
  '!',
  '|',
  '>',
  'null',
  'true',
  'False',
  '12',
  '-3.5',
  '1e3',
  '0x1F',
  '0o7',
  '.inf',
  '~',
  '😀',
  'Café',
  '\u0001',
  '\u001b',
  '\u0085',
  ' ',
  ' ',
  'a',
  'x'.repeat(50),
];
const str = () =>
  chance(0.1) ? '' : Array.from({ length: 1 + Math.floor(rand() * 5) }, () => pick(BITS)).join('');
const cases = [];
for (let i = 0; i < COUNT; i++) {
  const data = {
    id: '01JTEST' + i,
    createdAt: '2031-01-01T00:00:00.000Z',
    title: str(),
    ...(chance(0.5) ? { classId: str() } : {}),
    tags: Array.from({ length: Math.floor(rand() * 3) }, str),
    assignmentIds: [],
    ...(chance(0.3) ? { date: pick(['2031-01-01', '2031-01-01T10:00', str()]) } : {}),
    ...(chance(0.2) ? { n: pick([1, 2.5, -0, 1e21, true, false, null]) } : {}),
    ...(chance(0.1) ? { undef: undefined } : {}),
  };
  const content = pick(['', '# Hi', 'Body\n', 'a\n\nb']);
  cases.push({ data, content, want: stringifyFrontmatter(content, data) });
}
cases.push({ data: {}, content: 'x', want: stringifyFrontmatter('x', {}) });
writeFileSync(OUT, gzipSync(JSON.stringify(cases)));
console.log(`wrote ${cases.length} front matter cases`);
