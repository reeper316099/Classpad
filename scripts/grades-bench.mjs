#!/usr/bin/env node
// Times the TypeScript grade engine on the same work as the Go benchmarks in
// internal/grades/bench_test.go, for docs/go-port/README.md.
//
//   npx tsc -b packages/grades && node scripts/grades-bench.mjs
//   go test -run - -bench . -benchtime 2s ./internal/grades
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as G from '../packages/grades/dist/index.js';

const data = JSON.parse(
  gunzipSync(readFileSync(new URL('../internal/grades/testdata/parity.json.gz', import.meta.url))),
);
const { scheme, items, target } = data.bench;

const work = {
  // What the class page asks for: the grade, the "what matters most" list and the projection.
  ClassPage: () => {
    G.computeGrade(scheme, items);
    G.sensitivity(scheme, items);
    G.project(scheme, items);
  },
  // "What do I need for a 90?", overall and per remaining item.
  Needed: () => G.neededScore(scheme, items, { target, perItem: true }),
  // Every function on every generated case.
  AllCases: () => {
    for (const c of data.gradeCases) {
      G.computeGrade(c.scheme, c.items);
      G.whatIf(c.scheme, c.items, c.overrides);
      try {
        G.neededScore(c.scheme, c.items, c.needed);
      } catch {
        /* unknown letter target: part of the cases */
      }
      G.sensitivity(c.scheme, c.items, c.includeGraded);
      G.project(c.scheme, c.items);
    }
    for (const c of data.gpaCases) {
      G.computeGpa(c.courses, c.scale, c.options);
      const { weighted: _w, ...base } = c.options;
      G.gpaReport(c.courses, c.scale, base);
      G.planGpa(c.plan);
    }
  },
};

for (const [name, f] of Object.entries(work)) {
  for (let i = 0; i < 20; i++) f(); // warm up the JIT
  const times = [];
  for (let round = 0; round < 7; round++) {
    let n = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 1000) {
      f();
      n++;
    }
    times.push((performance.now() - t0) / n);
  }
  times.sort((a, b) => a - b);
  console.log(
    `${name.padEnd(10)} ${times[3].toFixed(3)} ms per run (median of 7 one-second rounds)`,
  );
}
console.log(`heap used: ${(process.memoryUsage().heapUsed / 1e6).toFixed(1)} MB`);
