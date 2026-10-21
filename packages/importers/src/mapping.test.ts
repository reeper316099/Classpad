import { MappingPluginSchema } from '@classpad/shared';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN_MAPPINGS } from './builtinMappings.js';
import { mapGradebook, previewGradebook } from './mapping.js';

const rows = BUILTIN_MAPPINGS.find((m) => m.id === 'gradebook-rows')!;
const cols = BUILTIN_MAPPINGS.find((m) => m.id === 'gradebook-columns')!;

describe('gradebook with one row per assignment', () => {
  const csv = [
    'Assignment,Course,Due Date,Score,Points Possible,Category,Weight',
    'Quiz 1,Lorem 101,2031-09-12,18,20,quiz,10',
    'Essay,Lorem 101,2031-10-01,45/50,,essay,20',
    'Midterm,Lorem 101,2031-10-20,,100,exam,30',
    'Lab,Lorem 101,2031-10-22,EX,10,lab,5',
  ].join('\n');
  const p = previewGradebook(csv, rows);
  it('reads points, fractions and ungraded work', () => {
    const a = Object.fromEntries(p.assignments.map((x) => [x.title, x]));
    expect(a['Quiz 1']!.score?.percent).toBeCloseTo(90);
    expect(a['Essay']!.score?.percent).toBeCloseTo(90);
    expect(a['Midterm']!.score).toBeUndefined();
    expect(a['Midterm']!.status).toBe('not_started');
    expect(a['Lab']!.score).toBeUndefined();
    expect(a['Quiz 1']!.weight).toBe(10);
    expect(a['Quiz 1']!.classRef).toContain('lorem 101');
  });
  it('explains what it could not read', () => {
    expect(p.warnings.some((w) => w.code === 'SCORE' && /EX/.test(w.message))).toBe(true);
  });
  it('warns about columns it ignored instead of dropping them silently', () => {
    const w = mapGradebook('Assignment,Score,Mystery\nA,5,x', rows).warnings;
    expect(w.some((x) => x.code === 'COLUMN' && /Mystery/.test(x.message))).toBe(true);
  });
  it('fails clearly without a title column', () => {
    const r = previewGradebook('Foo,Bar\n1,2', rows);
    expect(r.assignments).toHaveLength(0);
    expect(r.warnings[0]!.code).toBe('MISSING_COLUMN');
  });
  it('does not mangle titles that look like spreadsheet formulas', () => {
    const r = previewGradebook('Assignment,Score\n=Bonus,5', rows);
    expect(r.assignments[0]!.title).toBe('=Bonus');
  });
});

describe('gradebook with one column per assignment', () => {
  const csv = [
    'Student,Section,Essay 1 (50),Quiz [20 pts],Project,Final Grade',
    'Placeholder Person,A,45,17,80%,88',
  ].join('\n');
  it('uses the single student row and the points in headers', () => {
    const p = previewGradebook(csv, cols, { className: 'Dolor Lab' });
    const a = Object.fromEntries(p.assignments.map((x) => [x.title, x]));
    expect(Object.keys(a).sort()).toEqual(['Essay 1', 'Project', 'Quiz']);
    expect(a['Essay 1']!.score?.percent).toBeCloseTo(90);
    expect(a['Quiz']!.score?.percent).toBeCloseTo(85);
    expect(a['Project']!.score?.percent).toBeCloseTo(80);
    expect(a['Essay 1']!.classRef).toContain('dolor lab');
  });
  it('asks which student when there are several, and can pick one', () => {
    const multi = 'Student,Quiz (10)\nPerson A,5\nPerson B,9';
    expect(mapGradebook(multi, cols).warnings.some((w) => w.code === 'MULTIPLE_ROWS')).toBe(true);
    const pick = {
      ...cols,
      wide: { ...cols.wide, studentColumn: 'Student', studentValue: 'Person B' },
    };
    expect(previewGradebook(multi, pick).assignments[0]!.score?.percent).toBeCloseTo(90);
  });
  it('reads points possible from a points row', () => {
    const plug = {
      ...cols,
      wide: { ...cols.wide, pointsRow: { column: 'Student', equals: 'Points Possible' } },
    };
    const p = previewGradebook('Student,Quiz\nPoints Possible,40\nPerson A,30', plug);
    expect(p.assignments[0]!.score?.percent).toBeCloseTo(75);
  });
});

describe('plugin files are validated and never execute anything', () => {
  it('rejects unknown kinds and filters without a condition', () => {
    expect(
      MappingPluginSchema.safeParse({ pluginVersion: 1, id: 'x1', name: 'x', kind: 'script' })
        .success,
    ).toBe(false);
    expect(
      MappingPluginSchema.safeParse({
        pluginVersion: 1,
        id: 'ok-id',
        name: 'x',
        kind: 'gradebook-csv',
        skipRows: [{ column: 'a' }],
      }).success,
    ).toBe(false);
  });
  it('accepts a single header string as shorthand', () => {
    const r = MappingPluginSchema.parse({
      pluginVersion: 1,
      id: 'ok-id',
      name: 'x',
      kind: 'gradebook-csv',
      columns: { title: 'Task' },
    });
    expect(r.columns.title).toEqual(['Task']);
  });
  it('filters rows by exact or partial match only (no regular expressions)', () => {
    const plug = MappingPluginSchema.parse({
      pluginVersion: 1,
      id: 'f-1',
      name: 'f',
      kind: 'gradebook-csv',
      columns: { title: 'T', score: 'S' },
      skipRows: [{ column: 'T', contains: 'total' }],
    });
    const r = previewGradebook('T,S\nQuiz,5\nClass Total,9', plug);
    expect(r.assignments.map((a) => a.title)).toEqual(['Quiz']);
  });
});

describe('the documented example plugin', () => {
  it('stays valid and works', () => {
    const file = new URL('../../../docs/examples/plugins/marks-sheet.json', import.meta.url);
    const p = MappingPluginSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    const r = previewGradebook('Task,Mark,Out of\nQuiz,8,10\nClass total,1,1', p);
    expect(r.assignments.map((a) => a.title)).toEqual(['Quiz']);
    expect(r.assignments[0]!.score?.percent).toBeCloseTo(80);
  });
});
