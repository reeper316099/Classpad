import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openZip, previewNotion } from './index.js';

// Optional: runs only when a real export exists locally (private-fixtures/ is gitignored, absent in CI).
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../private-fixtures');
const zips = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.zip')) : [];

describe.skipIf(!zips.length)('real export parity (local only)', () => {
  const previews = zips.map((z) => previewNotion(openZip(readFileSync(path.join(dir, z)))));
  it('recomputed % Grade matches the exported value (within 0.01) for every class with graded work', () => {
    for (const p of previews)
      expect(
        p.validation.filter((v) => v.status === 'mismatch' || v.status === 'exported-only'),
      ).toEqual([]);
  });
  it('recognizes the databases in the export', () => {
    for (const p of previews)
      expect(p.warnings.filter((w) => w.code === 'NO_DATABASES')).toEqual([]);
  });
});
