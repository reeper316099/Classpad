#!/usr/bin/env node
// LOCAL-ONLY safety check: confirms nothing from private-fixtures/ ended up in fixtures/synthetic/.
// Reads the private export in memory only; prints counts and synthetic file names, never content.
import AdmZip from 'adm-zip';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const priv = join(repo, 'private-fixtures');
const synth = join(repo, 'fixtures', 'synthetic');
const norm = (s) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const zips = existsSync(priv) ? readdirSync(priv).filter((f) => f.endsWith('.zip')) : [];
if (!zips.length) {
  console.log('No private export found; nothing to compare.');
  process.exit(0);
}

const needles = new Set();
const grams = new Set();
const addText = (t, minLen) => {
  const n = norm(t);
  if (n.length >= minLen) needles.add(n);
  const w = n.split(' ');
  for (let i = 0; i + 5 <= w.length; i++) grams.add(w.slice(i, i + 5).join(' '));
};
for (const z of zips) {
  for (const e of new AdmZip(join(priv, z)).getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName.replace(/[0-9a-f]{32}/g, '');
    addText(
      name
        .split('/')
        .pop()
        .replace(/\.(md|csv)$/i, ''),
      5,
    ); // page and file titles
    if (/\.csv$/i.test(e.entryName)) {
      for (const row of Papa.parse(e.getData().toString('utf8').replace(/^﻿/, ''), {
        header: false,
      }).data)
        for (const cell of row) if (cell) addText(String(cell), 5);
    } else if (/\.md$/i.test(e.entryName)) {
      for (const line of e.getData().toString('utf8').split('\n')) addText(line, 8);
    }
  }
}
// Database/column names listed in the project spec; shared vocabulary, not content.
const STRUCTURAL = [
  'assignments deliverables all',
  'active to dos',
  'weighted grade sum',
  'internships job applications',
  'internships job applications all',
  'pgs read display',
  'total pgs display',
  'simple budget tracker',
  'school crm all',
  'notebook all',
  'readings all',
  'classes all',
  'semesters all',
  'month all',
  'tasks all',
];
const generic = new Set([
  ...STRUCTURAL,
  'untitled',
  'default',
  'notes',
  'classes',
  'tasks',
  'journal',
  'readings',
  'semesters',
  'notebook',
  'introduction',
  'intro',
]);
for (const t of STRUCTURAL) grams.delete(t);
for (const g of generic) needles.delete(g);

const walk = (d) =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
let hits = 0;
for (const f of walk(synth)) {
  if (!/\.(md|csv|json|mjs)$/i.test(f)) continue;
  const text = norm(
    readFileSync(f, 'utf8') + ' ' + relative(synth, f).replace(/[0-9a-f]{32}/g, ''),
  );
  // 1-2 word matches are shared schema vocabulary (column names, option labels); flag 3+ word overlaps.
  // only fragments that exist in OUR fixture are printed, so no private text is revealed
  const found = [
    ...new Set(
      [...needles]
        .filter((n) => n.split(' ').length >= 3 && ` ${text} `.includes(` ${n} `))
        .concat([...grams].filter((g) => text.includes(g))),
    ),
  ];
  if (found.length) {
    hits += found.length;
    console.log(
      `LEAK? ${relative(repo, f).replace(/[0-9a-f]{32}/g, '<id>')}: ${found
        .slice(0, 6)
        .map((x) => JSON.stringify(x))
        .join(' | ')}`,
    );
  }
}
console.log(
  `Compared ${needles.size} strings + ${grams.size} 5-word windows from the private export against fixtures/synthetic.`,
);
console.log(
  hits ? `FAIL: ${hits} overlap(s) found (content not printed).` : 'PASS: no overlap found.',
);
process.exit(hits ? 1 : 0);
