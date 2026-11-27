#!/usr/bin/env node
// Runs the TypeScript grade engine (packages/grades) on generated cases and saves the inputs and
// answers to internal/grades/testdata/parity.json.gz. The Go engine's test (parity_test.go) runs
// the same inputs and must give the same JSON, field for field.
//
//   npx tsc -b packages/grades && node scripts/grades-parity.mjs
//
// The cases are synthetic and come from a fixed seed, so the file only changes when the engine does.
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as G from '../packages/grades/dist/index.js';

// Options for a bigger one-off check: --seed N --scale K (K times as many cases) --out FILE.
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const OUT =
  arg('out') ??
  fileURLToPath(new URL('../internal/grades/testdata/parity.json.gz', import.meta.url));
const SCALE = Number(arg('scale', 1));

// mulberry32: small, seeded, the same everywhere.
let seed = Number(arg('seed', 20261126));
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const chance = (p) => rand() < p;
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const ULID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = () => Array.from({ length: 26 }, () => pick([...ULID])).join('');

/** A number the way people type them: whole, one or two decimals, sometimes as a string. */
const num = (lo, hi) => {
  const v = pick([0, 0, 1, 2]);
  const n = Number((lo + rand() * (hi - lo)).toFixed(v));
  return chance(0.15) ? String(n) : n;
};

const TITLES = [
  'Quiz 1',
  'Lab "A"',
  'Essay — draft',
  'Midterm',
  'Final exam',
  'HW 3',
  'Projekt ü',
  '',
];

function scheme() {
  const mode = pick(['assignment_weights', 'category_weights', 'points']);
  const s = G.defaultScheme(mode);
  if (mode === 'category_weights') {
    const n = int(1, 4);
    s.categories = Array.from({ length: n }, (_, i) => ({
      id: `c${i}`,
      name: pick(['Quizzes', 'Exams', 'Labs', 'Homework', 'Participation']),
      weight: chance(0.8) ? pick([10, 15, 20, 25, 30, 40, 50]) : num(0, 60),
      ...(chance(0.5) ? { dropLowest: int(0, 3) } : {}),
      ...(chance(0.7) ? { countMode: pick(['pooled', 'mean']) } : {}),
    }));
  }
  s.rounding = {
    mode: pick(['half_up', 'half_up', 'truncate']),
    decimals: int(0, 3),
    letterOn: pick(['raw', 'rounded']),
  };
  if (chance(0.25)) s.normalizeOverGradedOnly = false;
  if (chance(0.15)) s.extraCreditAllowed = false;
  if (chance(0.25)) s.extraCreditCapPercent = num(0, 10);
  if (chance(0.3))
    s.latePolicy = {
      perDayPercent: num(1, 15),
      ...(chance(0.6) ? { maxPercent: num(10, 50) } : {}),
    };
  if (chance(0.2))
    s.curve = chance(0.5)
      ? { kind: 'flat', add: num(0, 8) }
      : { kind: 'scale_to_max', max: num(60, 100) };
  if (chance(0.3)) s.maxScore = pick([100, 105, 110]);
  if (chance(0.1)) s.passFail = { threshold: pick([60, 65, 70]) };
  if (chance(0.15))
    s.scale = {
      cutoffs: [
        { letter: 'A', min: 90, gpa: 4 },
        { letter: 'B', min: 80, gpa: 3 },
        { letter: 'C', min: 70, gpa: 2 },
        { letter: 'D', min: 60 },
        { letter: 'F', min: 0, gpa: 0 },
      ].sort(() => rand() - 0.5),
    };
  return s;
}

function score() {
  const k = rand();
  if (k < 0.5) return { kind: 'percent', percent: chance(0.05) ? '92.995' : num(0, 110) };
  if (k < 0.8) {
    const possible = num(1, 50);
    return {
      kind: 'points',
      earned: num(0, Number(possible) * 1.1),
      ...(chance(0.5) ? { possible } : chance(0.1) ? { possible: 0 } : {}),
    };
  }
  return { kind: 'letter', letter: pick(['A', 'a-', 'B+', ' b ', 'C', 'F', 'D-', 'Z']) };
}

function items(s) {
  const n = int(0, 9);
  const ulids = chance(0.5);
  return Array.from({ length: n }, (_, i) => {
    const it = { id: ulids ? ulid() : `i${i}` };
    if (chance(0.6)) it.title = pick(TITLES);
    if (s.mode === 'category_weights')
      it.categoryId = chance(0.92) ? `c${int(0, (s.categories?.length ?? 1) - 1)}` : 'nope';
    if (s.mode === 'assignment_weights' ? chance(0.9) : chance(0.2)) it.weight = num(1, 40);
    if (chance(0.6)) it.pointsPossible = num(1, 100);
    it.score = chance(0.7) ? score() : chance(0.5) ? null : undefined;
    if (chance(0.1)) it.extraCredit = true;
    if (chance(0.08)) it.excused = true;
    if (chance(0.05)) it.dropped = true;
    if (chance(0.1)) it.latePenalty = num(0, 30);
    else if (chance(0.15)) it.lateDays = int(0, 6);
    return it;
  });
}

const target = (s) =>
  chance(0.3)
    ? { letter: pick([...s.scale.cutoffs.map((c) => c.letter), 'a', 'Q']) }
    : chance(0.2)
      ? String(num(50, 100))
      : num(50, 100);

function attempt(f) {
  try {
    return f();
  } catch (e) {
    return { error: e.message };
  }
}

const gradeCases = [];
for (let n = 0; n < 400 * SCALE; n++) {
  const s = scheme();
  const its = items(s);
  const overrides = {};
  for (const it of its) if (chance(0.3)) overrides[it.id] = chance(0.8) ? score() : null;
  const opts = { target: target(s) };
  if (chance(0.2)) opts.remainingIds = its.filter(() => chance(0.4)).map((i) => i.id);
  if (chance(0.2)) opts.maxPerItem = pick([100, 110, 120]);
  if (chance(0.3)) opts.perItem = true;
  if (opts.perItem && chance(0.5)) opts.assume = num(50, 100);
  const includeGraded = chance(0.3);
  gradeCases.push({
    scheme: s,
    items: its,
    overrides,
    needed: opts,
    includeGraded,
    want: {
      grade: G.computeGrade(s, its),
      whatIf: G.whatIf(s, its, overrides),
      needed: attempt(() => G.neededScore(s, its, opts)),
      sensitivity: G.sensitivity(s, its, includeGraded),
      projection: G.project(s, its),
    },
  });
}

const LETTERS = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F', 'P', ''];
const gpaCases = [];
const scaleIds = Object.keys(G.GPA_SCALES);
for (let n = 0; n < 200 * SCALE; n++) {
  const scaleId = pick(scaleIds);
  const scale = G.GPA_SCALES[scaleId];
  const courses = Array.from({ length: int(0, 8) }, (_, i) => {
    const c = { id: chance(0.5) ? ulid() : `k${i}` };
    if (chance(0.7)) c.name = pick(['Biology', 'Algebra II', 'History', 'Art', 'Chem "H"']);
    if (chance(0.8)) c.semesterId = pick(['s1', 's2', 's3']);
    c.credits = chance(0.85) ? pick([0.5, 1, 3, 4, '3.5', 4.25]) : chance(0.5) ? null : 0;
    if (chance(0.92)) c.letter = pick(LETTERS);
    else c.letter = null;
    if (chance(0.6)) c.honorsLevel = pick(['regular', 'honors', 'ap', 'ib', 'dual', 'other']);
    if (chance(0.08)) c.passFail = true;
    if (chance(0.08)) c.includeInGpa = false;
    if (chance(0.4)) c.courseKey = pick(['MATH', 'ENG', 'SCI']);
    if (chance(0.5)) c.termIndex = int(0, 4);
    return c;
  });
  const opts = { weighted: chance(0.5) };
  if (chance(0.5)) opts.repeatRule = pick(['none', 'replace_latest', 'keep_best']);
  if (chance(0.3))
    opts.rounding = { mode: pick(['half_up', 'truncate']), decimals: int(1, 4), letterOn: 'raw' };
  const { weighted: _w, ...base } = opts;
  const plan = {
    currentQualityPoints: num(0, 120),
    currentCredits: num(0, 40),
    plannedCredits: chance(0.1) ? 0 : num(1, 30),
    targetGpa: num(1, 4.5),
    maxGpa: pick([4, 4.3, 5]),
  };
  gpaCases.push({
    scale,
    courses,
    options: opts,
    plan,
    want: {
      gpa: G.computeGpa(courses, scale, opts),
      report: G.gpaReport(courses, scale, base),
      plan: G.planGpa(plan),
    },
  });
}

// A realistic class for scripts/grades-bench.mjs and the Go benchmarks: 60 assignments in four
// weighted categories with drop-lowest, 15 of them not graded yet.
const benchScheme = {
  ...G.defaultScheme('category_weights'),
  categories: [
    { id: 'hw', name: 'Homework', weight: 20, dropLowest: 2, countMode: 'pooled' },
    { id: 'qz', name: 'Quizzes', weight: 20, dropLowest: 1, countMode: 'mean' },
    { id: 'lab', name: 'Labs', weight: 20, countMode: 'pooled' },
    { id: 'ex', name: 'Exams', weight: 40, countMode: 'pooled' },
  ],
  latePolicy: { perDayPercent: 5, maxPercent: 30 },
};
const cats = ['hw', 'hw', 'hw', 'qz', 'qz', 'lab', 'ex'];
const benchItems = Array.from({ length: 60 }, (_, i) => {
  const categoryId = cats[i % cats.length];
  const possible = categoryId === 'ex' ? 100 : categoryId === 'lab' ? 25 : 10;
  const it = { id: ulid(), title: `${categoryId} ${i + 1}`, categoryId, pointsPossible: possible };
  if (i < 45)
    it.score = { kind: 'points', earned: Number((possible * (0.6 + rand() * 0.4)).toFixed(1)) };
  if (i % 11 === 3) it.lateDays = 1;
  return it;
});
const bench = { scheme: benchScheme, items: benchItems, target: 90 };

// decimal.js writes a negative zero as "-0" in JSON; Go has no negative zero.
const json = JSON.stringify({ gradeCases, gpaCases, scales: G.GPA_SCALES, bench }, (_k, v) =>
  v === '-0' ? '0' : v,
);
writeFileSync(OUT, gzipSync(json, { level: 9 }));
console.log(
  `wrote ${gradeCases.length} grade cases and ${gpaCases.length} GPA cases (${(json.length / 1e6).toFixed(1)} MB of JSON, ${(gzipSync(json, { level: 9 }).length / 1e3).toFixed(0)} KB gzipped)`,
);
