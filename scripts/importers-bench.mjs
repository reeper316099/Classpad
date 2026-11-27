#!/usr/bin/env node
// Times the TypeScript importers on the same work as the Go benchmarks in
// internal/importers/bench_test.go, for docs/go-port/README.md. Inputs are the synthetic cases in
// internal/importers/testdata/parity.json.gz and fixtures/synthetic/notion-export.
//
//   npx tsc -b packages/importers && node scripts/importers-bench.mjs
//   go test -run - -bench . ./internal/importers
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

process.env.TZ = 'America/New_York';
console.warn = () => {};
const I = await import('../packages/importers/dist/index.js');
const data = JSON.parse(
  gunzipSync(
    readFileSync(new URL('../internal/importers/testdata/parity.json.gz', import.meta.url)),
  ),
);
// The synthetic export, read into memory once: the timing is the import, not the disk.
const fixtureDir = I.openDir(
  fileURLToPath(new URL('../fixtures/synthetic/notion-export', import.meta.url)),
);
const fixture = Object.fromEntries(fixtureDir.files.map((f) => [f, fixtureDir.read(f)]));
const exports = data.notion.map((c) =>
  c.input.zip ? Buffer.from(c.input.zip, 'base64') : c.input.files,
);

const work = {
  // Build the preview of the synthetic Notion export (57 files).
  NotionFixture: () => I.previewNotion(I.openMemory(fixture), { today: '2031-10-15' }),
  // Build previews for the 60 generated Notion exports (some zipped).
  NotionExports: () => {
    for (const e of exports)
      I.previewNotion(Buffer.isBuffer(e) ? I.openZip(e) : I.openMemory(e), { today: '2031-10-15' });
  },
  // Parse every generated CSV file and preview every CSV import.
  CSV: () => {
    for (const c of data.csv) I.parseCsv(c.text);
    for (const c of data.csvImports) I.previewCsv(c.text, c.collection);
  },
  // Read every generated calendar.
  Calendars: () => {
    for (const c of data.calendars)
      try {
        I.previewIcs(c.text, c.opts);
      } catch {
        /* some calendars are meant to fail */
      }
  },
};

for (const [name, f] of Object.entries(work)) {
  for (let i = 0; i < 10; i++) f();
  const times = [];
  for (let round = 0; round < 7; round++) {
    let n = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 700) {
      f();
      n++;
    }
    times.push((performance.now() - t0) / n);
  }
  times.sort((a, b) => a - b);
  console.log(`${name.padEnd(14)} ${times[3].toFixed(3)} ms`);
}
