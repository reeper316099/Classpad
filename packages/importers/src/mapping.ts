import type { MappingPlugin } from '@classpad/shared';
import Papa from 'papaparse';
import { parseCsv } from './csv.js';
import { previewCsv } from './csvImport.js';
import type { ImportPreview, Warning } from './types.js';

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const NUM = /^-?\d+(\.\d+)?$/;
const FRACTION = /^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/;
const CANON = [
  'title',
  'class',
  'due',
  'weight',
  'score',
  'points_possible',
  'status',
  'priority',
  'type',
  'link',
  'notes',
];
/** Columns that are never assignments in a wide gradebook. */
const WIDE_SKIP = new Set(
  [
    'student',
    'name',
    'id',
    'student id',
    'sis user id',
    'sis login id',
    'section',
    'final grade',
    'final score',
    'current grade',
    'current score',
    'total',
    'overall',
    'letter grade',
  ].map(norm),
);

export interface MapOptions {
  /** Class name to use when the file has no class column. */
  className?: string;
}

function matches(f: { column: string; equals?: string; contains?: string }, v: string): boolean {
  const x = norm(v);
  return f.equals !== undefined ? x === norm(f.equals) : x.includes(norm(f.contains ?? ''));
}

/** Turn a score cell into canonical `score` + `points_possible`, or explain why not. */
function readScore(
  raw: string,
  pp: string,
  fmt: MappingPlugin['scoreFormat'],
  warn: (m: string) => void,
): { score: string; pp: string } {
  const v = raw.trim();
  if (!v || v === '-' || v === '—') return { score: '', pp };
  const frac = FRACTION.exec(v);
  if (frac) return { score: frac[1]!, pp: frac[2]! };
  if (v.endsWith('%')) return { score: v, pp };
  if (NUM.test(v)) {
    if (fmt === 'percent') return { score: `${v}%`, pp: '' };
    if (fmt === 'points' && !pp) {
      warn(`"${v}" is in points but points possible is unknown; read as a percent`);
      return { score: `${v}%`, pp: '' };
    }
    return { score: v, pp };
  }
  warn(`Score "${v}" is not a number (excused or missing?); left ungraded`);
  return { score: '', pp };
}

/** Internal hand-off to the CSV importer: plain quoting, no spreadsheet-formula escaping. */
const toCsv = (fields: string[], data: Record<string, string>[]) =>
  Papa.unparse({ fields, data: data.map((r) => fields.map((f) => r[f] ?? '')) });

/** Rewrite someone else's gradebook CSV into Classpad's own assignments CSV. */
export function mapGradebook(
  text: string,
  p: MappingPlugin,
  opts: MapOptions = {},
): { csv: string; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const warn = (code: string, message: string, where?: string) =>
    warnings.push({ code, message, where });
  const t = parseCsv(text);
  const byName = new Map(t.fields.map((f) => [norm(f), f]));
  const cell = (r: Record<string, string>, header: string) =>
    r[byName.get(norm(header)) ?? ''] ?? '';
  const className = opts.className?.trim() || p.className || '';
  const rows: Record<string, string>[] = [];
  const skipped = (r: Record<string, string>) =>
    p.skipRows.some((f) => byName.has(norm(f.column)) && matches(f, cell(r, f.column)));

  if (p.layout === 'long') {
    const pick = (field: keyof MappingPlugin['columns']): string | undefined =>
      (p.columns[field] ?? []).find((h) => byName.has(norm(h)));
    const h = {
      title: pick('title'),
      class: pick('class'),
      due: pick('due'),
      score: pick('score'),
      pp: pick('pointsPossible'),
      weight: pick('weight'),
      status: pick('status'),
      type: pick('type'),
      notes: pick('notes'),
    };
    if (!h.title) {
      warn(
        'MISSING_COLUMN',
        `None of the title columns (${(p.columns.title ?? []).join(', ') || 'none set'}) are in the file`,
      );
      return { csv: toCsv(CANON, []), warnings };
    }
    const mapped = new Set(
      Object.values(h)
        .filter(Boolean)
        .map((x) => norm(x!)),
    );
    for (const f of t.fields)
      if (!mapped.has(norm(f)))
        warn('COLUMN', `Column "${f}" is not used by this format and was ignored`);
    t.rows.forEach((r, i) => {
      if (skipped(r)) return;
      const title = h.title ? cell(r, h.title).trim() : '';
      if (!title) return;
      const s = readScore(
        h.score ? cell(r, h.score) : '',
        h.pp ? cell(r, h.pp) : '',
        p.scoreFormat,
        (m) => warn('SCORE', m, `row ${i + 2}`),
      );
      const status = h.status ? cell(r, h.status) : '';
      rows.push({
        title,
        class: (h.class ? cell(r, h.class).trim() : '') || className,
        due: h.due ? cell(r, h.due) : '',
        weight: h.weight ? cell(r, h.weight) : '',
        score: s.score,
        points_possible: s.pp,
        status: status || (s.score ? 'complete' : 'not_started'),
        priority: '',
        type: h.type ? cell(r, h.type) : '',
        link: '',
        notes: h.notes ? cell(r, h.notes) : '',
      });
    });
  } else {
    const { studentColumn, studentValue, skipColumns, pointsRow, pointsInHeader } = p.wide;
    const candidates = t.rows.filter(
      (r) => !skipped(r) && !(pointsRow && matches(pointsRow, cell(r, pointsRow.column))),
    );
    let row = candidates[0];
    if (studentColumn && studentValue !== undefined)
      row = candidates.find((r) => norm(cell(r, studentColumn)) === norm(studentValue));
    else if (candidates.length > 1)
      warn(
        'MULTIPLE_ROWS',
        `The file has ${candidates.length} student rows; the first was used. Set wide.studentColumn and wide.studentValue to pick one.`,
      );
    if (!row) {
      warn('NO_ROW', 'Could not find the student row in this file');
      return { csv: toCsv(CANON, []), warnings };
    }
    const ptsRow = pointsRow
      ? t.rows.find((r) => matches(pointsRow, cell(r, pointsRow.column)))
      : undefined;
    const skip = new Set([
      ...WIDE_SKIP,
      ...skipColumns.map(norm),
      ...(studentColumn ? [norm(studentColumn)] : []),
    ]);
    for (const f of t.fields) {
      if (skip.has(norm(f))) continue;
      let title = f.trim();
      let pp = ptsRow ? (ptsRow[f] ?? '').trim() : '';
      const m = /^(.*?)\s*[([]\s*(\d+(?:\.\d+)?)\s*(?:pts?|points?)?\s*[)\]]\s*$/i.exec(title);
      if (pointsInHeader && m && m[1]) {
        title = m[1].trim();
        pp ||= m[2]!;
      }
      if (!title) continue;
      const raw = (row[f] ?? '').trim();
      const s = readScore(raw, pp, p.scoreFormat, (msg) => warn('SCORE', msg, `"${f}"`));
      rows.push({
        title,
        class: className,
        due: '',
        weight: '',
        score: s.score,
        points_possible: s.pp,
        status: s.score ? 'complete' : 'not_started',
        priority: '',
        type: '',
        link: '',
        notes: '',
      });
    }
    if (!className)
      warn('NO_CLASS', 'No class name was given; assignments will be imported without a class');
  }
  if (!rows.length) warn('EMPTY', 'No assignments were found in this file');
  return { csv: toCsv(CANON, rows), warnings };
}

export function previewGradebook(
  text: string,
  p: MappingPlugin,
  opts: MapOptions = {},
): ImportPreview {
  const { csv, warnings } = mapGradebook(text, p, opts);
  const out = previewCsv(csv, 'assignments');
  out.warnings = [...warnings, ...out.warnings];
  return out;
}
