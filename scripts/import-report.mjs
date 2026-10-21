#!/usr/bin/env node
// Prints an import + parity summary for a Notion export zip (counts and statuses only, no content).
// Usage: node scripts/import-report.mjs private-fixtures/<export>.zip
import { readFileSync } from 'node:fs';
import { openZip, previewNotion } from '../packages/importers/dist/index.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: import-report.mjs <export.zip>');
  process.exit(2);
}
const p = previewNotion(openZip(readFileSync(file)));
const n = (a) => a.length;
console.log('Imports:', {
  semesters: n(p.semesters),
  classes: n(p.classes),
  assignments: n(p.assignments),
  tasks: n(p.tasks),
  readings: n(p.readings),
  notes: n(p.notes),
  templates: n(p.templates),
  attachments: n(p.attachments),
});
console.log('Skipped:', p.skipped.map((s) => `${s.kind} x${s.count}`).join(', ') || 'none');
console.log(
  'Databases:',
  p.mapping
    .filter((m) => m.chosen)
    .map((m) => `${m.kind} (${m.rows} rows)`)
    .join(', '),
);
const tally = {};
for (const v of p.validation) tally[v.status] = (tally[v.status] ?? 0) + 1;
console.log('Grade parity:', tally);
const w = {};
for (const x of p.warnings) w[x.code] = (w[x.code] ?? 0) + 1;
console.log('Warnings by type:', w);
