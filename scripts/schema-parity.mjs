#!/usr/bin/env node
// Runs the zod schemas of packages/shared on generated values (valid, broken, odd) and saves the
// results to internal/schema/testdata/parity.json.gz. The Go schema engine must give the same
// output (keys in the same order) or the same issues (path and message, in order).
//
//   npx tsc -b packages/shared && node scripts/schema-parity.mjs [--seed N] [--count K] [--out FILE]
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as S from '../packages/shared/dist/index.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const OUT =
  arg('out') ??
  fileURLToPath(new URL('../internal/schema/testdata/parity.json.gz', import.meta.url));
const COUNT = Number(arg('count', 60));
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

const base = {
  id: '01JTEST',
  createdAt: '2031-01-01T00:00:00.000Z',
  updatedAt: '2031-01-02T00:00:00.000Z',
};
const VALID = {
  Semester: { ...base, name: 'Autumn', start: '2031-09-01', goals: ['a'] },
  Class: {
    ...base,
    semesterId: 's',
    name: 'Bio',
    meetings: [{ day: 'mon', start: '09:00', end: '10:15' }],
    credits: 3,
    honorsLevel: 'ap',
    dates: { start: '2031-09-01', end: '2031-12-12' },
  },
  Assignment: {
    ...base,
    classId: 'c',
    title: 'Essay',
    weight: 20,
    score: { earned: 18, possible: 20 },
    type: ['essay'],
  },
  Task: { ...base, title: 'Read', priority: 'high', targetHours: 2 },
  Note: { ...base, title: 'Lecture', markdown: '# x', tags: ['t'] },
  Reading: { ...base, title: 'Book', totalPages: 200, pagesRead: 40 },
  StudySession: {
    ...base,
    start: '2031-01-01T10:00:00.000Z',
    end: '2031-01-01T11:00:00.000Z',
    minutes: 60,
  },
  Attachment: {
    ...base,
    filename: 'a.pdf',
    mime: 'application/pdf',
    size: 3,
    hash: 'h',
    path: 'attachments/h.pdf',
  },
  GradingScheme: {
    id: 'x',
    name: 'X',
    mode: 'category_weights',
    categories: [{ id: 'q', name: 'Q', weight: 30, dropLowest: 1, countMode: 'mean' }],
    scale: { cutoffs: [{ letter: 'A', min: 90, gpa: 4 }] },
    curve: { kind: 'flat', add: 2 },
    latePolicy: { perDayPercent: 5 },
  },
  GpaScale: { id: 'g', name: 'G', points: [{ letter: 'A', gpa: 4 }], weightedBonus: { ap: 1 } },
  JournalEntry: { ...base, date: '2031-01-01', mood: ['happy'] },
  Contact: { ...base, name: 'Prof', email: 'a@example.com' },
  Activity: { ...base, name: 'Club', hoursPerWeek: 3 },
  Job: { ...base, position: 'Intern', status: 'applied', priority: 'mid' },
  Admission: { ...base, school: 'Uni', fee: 50, checklist: [{ text: 'Essay' }] },
  BudgetItem: { ...base, purchase: 'Book', cost: 12.5, date: '2031-01-01' },
  Card: { ...base, front: 'Q', srs: { dueAt: '2031-01-01T00:00:00.000Z' } },
  MappingPlugin: {
    pluginVersion: 1,
    id: 'my-lms',
    name: 'LMS',
    kind: 'gradebook-csv',
    columns: { title: 'Assignment', score: ['Score', 'Points'] },
    wide: { pointsRow: { column: 'Student', equals: 'Points' } },
    skipRows: [{ column: 'x', contains: 'y' }],
  },
};
const OMIT = [
  'Semester',
  'Class',
  'Assignment',
  'Task',
  'Note',
  'Reading',
  'StudySession',
  'JournalEntry',
  'Contact',
  'Activity',
  'Job',
  'Admission',
  'BudgetItem',
  'Card',
];
const WEIRD = [
  undefined,
  null,
  '',
  'x',
  0,
  -1,
  1.5,
  1e9,
  true,
  false,
  [],
  ['a', 1],
  {},
  { a: 1 },
  'mon',
  '09:00',
  '9:00',
  'pomodoro',
  'ap',
  'complete',
  'flat',
  'gradebook-csv',
  'Ab',
  'a'.repeat(120),
];

function mutate(v, depth = 0) {
  if (Array.isArray(v)) {
    const a = v.map((x) => (chance(0.3) ? mutate(x, depth + 1) : x));
    if (chance(0.2)) a.push(pick(WEIRD.filter((w) => w !== undefined))); // JSON has no undefined
    if (chance(0.1)) a.length = 0;
    return a;
  }
  if (v && typeof v === 'object') {
    const o = { ...v };
    for (const k of Object.keys(o)) {
      if (chance(0.15)) delete o[k];
      else if (chance(0.2)) o[k] = depth < 2 && chance(0.5) ? mutate(o[k], depth + 1) : pick(WEIRD);
    }
    if (chance(0.2))
      o[pick(['extra', 'zzz', 'importRef', 'slug', 'percent', 'earned'])] = pick(WEIRD);
    return o;
  }
  return chance(0.5) ? pick(WEIRD) : v;
}

const cases = [];
const run = (name, schema, raw) => {
  // zod sees exactly the JSON the Go side reads (undefined inside arrays becomes null, etc.)
  const value = raw === undefined ? undefined : JSON.parse(JSON.stringify(raw));
  const r = schema.safeParse(value);
  cases.push({
    name,
    value: value === undefined ? { $undefined: true } : value,
    want: r.success
      ? { ok: r.data }
      : { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
  });
};
for (const [name, valid] of Object.entries(VALID)) {
  const schema = S[`${name}Schema`];
  run(name, schema, valid);
  for (let i = 0; i < COUNT; i++) run(name, schema, mutate(valid));
  if (OMIT.includes(name)) {
    const body = schema.omit({ id: true, createdAt: true, updatedAt: true });
    for (let i = 0; i < COUNT / 2; i++) run(`${name}Body`, body, mutate(valid));
  }
}
// JSON.stringify keeps key order: the Go side must produce keys in the same order.
writeFileSync(OUT, gzipSync(JSON.stringify(cases)));
console.log(`wrote ${cases.length} schema cases`);
