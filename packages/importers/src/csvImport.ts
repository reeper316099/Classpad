import { parseCsv, toCsv } from './csv.js';
import {
  cleanLabel,
  formatInterval,
  normalizePriority,
  normalizeTaskPriority,
  normTitle,
  parseBool,
  parseDays,
  parseNotionDate,
  parseNumber,
  parsePercent,
  parseTimes,
  slugOption,
  splitMulti,
} from './parse.js';
import { emptyPreview, type ImportPreview } from './types.js';

export type CsvCollection = 'semesters' | 'classes' | 'assignments' | 'tasks' | 'readings';
export const CSV_COLLECTIONS: CsvCollection[] = [
  'semesters',
  'classes',
  'assignments',
  'tasks',
  'readings',
];

const TEMPLATES: Record<CsvCollection, { headers: string[]; example: string[] }> = {
  semesters: {
    headers: ['name', 'start', 'end'],
    example: ['Autumn Term', '2031-09-01', '2031-12-12'],
  },
  classes: {
    headers: [
      'name',
      'semester',
      'code',
      'credits',
      'type',
      'delivery',
      'days',
      'times',
      'location',
      'instructor',
    ],
    example: [
      'Intro Course',
      'Autumn Term',
      'ABC 101',
      '3',
      'core',
      'in_person',
      'Mon, Wed',
      '9:15a-10:30a',
      'Hall 1',
      '',
    ],
  },
  assignments: {
    headers: [
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
    ],
    example: [
      'Essay 1',
      'Intro Course',
      '2031-10-01',
      '20',
      '',
      '',
      'not_started',
      'mid',
      'essay',
      '',
      '',
    ],
  },
  tasks: {
    headers: ['title', 'class', 'date', 'priority', 'done', 'target_hours', 'actual_hours'],
    example: ['Read chapter 2', 'Intro Course', '2031-09-20', 'medium', 'no', '2', ''],
  },
  readings: {
    headers: ['title', 'class', 'status', 'format', 'total_pages', 'pages_read', 'date_read'],
    example: ['Sample Book', '', 'reading', 'library', '200', '40', ''],
  },
};

export const csvTemplate = (c: CsvCollection): string =>
  toCsv(TEMPLATES[c].headers, [
    Object.fromEntries(TEMPLATES[c].headers.map((h, i) => [h, TEMPLATES[c].example[i]])),
  ]);

const ALIASES: Record<string, string> = {
  assignment: 'title',
  name: 'title',
  course: 'class',
  'due date': 'due',
  date: 'due',
  grade: 'score',
  'final grade': 'score',
  'points possible': 'points_possible',
  'total points': 'points_possible',
  note: 'notes',
  'quick notes': 'notes',
  'target hrs': 'target_hours',
  'actual hrs': 'actual_hours',
  'target (hrs)': 'target_hours',
  'actual (hrs)': 'actual_hours',
  'total pages': 'total_pages',
  'pages read': 'pages_read',
  'date read': 'date_read',
  professor: 'instructor',
  teacher: 'instructor',
};
const canon = (h: string, collection: CsvCollection) => {
  const k = h.trim().toLowerCase().replace(/\s+/g, ' ');
  if (collection === 'tasks' && (k === 'date' || k === 'due')) return 'date';
  if (
    (collection === 'classes' || collection === 'semesters' || collection === 'readings') &&
    (k === 'name' || k === 'class' || (k === 'semester' && collection === 'semesters'))
  )
    return collection === 'readings' ? 'title' : 'name';
  if (collection === 'readings' && k === 'title') return 'title';
  return ALIASES[k] ?? k.replace(/ /g, '_');
};

/** Reference to an entity that may already exist, resolved by name at commit time. */
export const nameRef = (kind: string, name: string): string => `name:${kind}:${normTitle(name)}`;

export function previewCsv(text: string, collection: CsvCollection): ImportPreview {
  const out = emptyPreview('csv');
  const t = parseCsv(text);
  const fields = t.fields.map((f) => canon(f, collection));
  const used = new Set<string>();
  const warn = (code: string, message: string, where?: string) =>
    out.warnings.push({ code, message, where });
  const known = new Set(TEMPLATES[collection].headers);
  fields.forEach((f, i) => {
    if (!known.has(f)) warn('COLUMN', `Column "${t.fields[i]}" is not recognized and was ignored`);
    else used.add(f);
  });
  const col = (r: Record<string, string>, name: string) => {
    for (let i = 0; i < t.fields.length; i++)
      if (fields[i] === name) return (r[t.fields[i]!] ?? '').trim();
    return '';
  };
  const requiredKey =
    collection === 'assignments' || collection === 'tasks' || collection === 'readings'
      ? 'title'
      : 'name';
  if (!fields.includes(requiredKey)) {
    warn('MISSING_COLUMN', `Missing required column "${requiredKey}"`);
    return out;
  }
  const seen = new Set<string>();
  t.rows.forEach((r, i) => {
    const key = col(r, requiredKey);
    const where = `row ${i + 2}`;
    if (!key) {
      warn('EMPTY_ROW', 'Row has no title/name; skipped', where);
      return;
    }
    const mk = (kind: string, scope = '') => {
      let ref = `csv:${kind}:${normTitle(key)}${scope ? '@' + normTitle(scope) : ''}`;
      for (let n = 2; seen.has(ref); n++) ref = `${ref.replace(/#\d+$/, '')}#${n}`;
      seen.add(ref);
      return ref;
    };
    const date = (c: string) => {
      const d = parseNotionDate(c);
      if (!d && c) warn('DATE', `Unreadable date "${c}"`, where);
      return d;
    };
    const cls = col(r, 'class');
    if (collection === 'semesters') {
      const s = date(col(r, 'start')),
        e = date(col(r, 'end'));
      out.semesters.push({
        ref: mk('semester'),
        name: key,
        start: s?.start.slice(0, 10),
        end: e?.start.slice(0, 10),
        isCurrent: false,
        goals: [],
      });
    } else if (collection === 'classes') {
      const days = parseDays(col(r, 'days')),
        times = col(r, 'times'),
        tr = parseTimes(times, days);
      tr.warnings.forEach((w) => warn('TIMES', w, where));
      const sem = col(r, 'semester');
      const delivery = slugOption(col(r, 'delivery'));
      out.classes.push({
        ref: mk('class'),
        name: key,
        code: col(r, 'code') || undefined,
        semesterRef: sem ? nameRef('semester', sem) : undefined,
        credits: parseNumber(col(r, 'credits')) ?? undefined,
        type: slugOption(col(r, 'type')) || undefined,
        delivery:
          delivery === 'in_person' || delivery === 'online' || delivery === 'hybrid'
            ? delivery
            : undefined,
        location: col(r, 'location') || undefined,
        instructor: col(r, 'instructor') || undefined,
        meetings: tr.meetings,
        rawTimes: times || undefined,
        color: '#6366f1',
      });
    } else if (collection === 'assignments') {
      const d = date(col(r, 'due'));
      const pri = normalizePriority(col(r, 'priority'));
      const st = slugOption(col(r, 'status'));
      const score = parsePercent(col(r, 'score'));
      const pp = parseNumber(col(r, 'points_possible'));
      out.assignments.push({
        ref: mk('assignment', cls),
        title: key,
        classRef: cls ? nameRef('class', cls) : undefined,
        type: splitMulti(col(r, 'type')).map(slugOption).filter(Boolean),
        status:
          st === 'complete' || st === 'done'
            ? 'complete'
            : st === 'in_progress'
              ? 'in_progress'
              : 'not_started',
        priority: pri?.value,
        priorityLabel: pri?.label,
        due: d ? formatInterval(d) : undefined,
        weight: parsePercent(col(r, 'weight')) ?? undefined,
        score:
          score === null
            ? undefined
            : {
                percent:
                  pp && pp > 0 && /^-?\d+(\.\d+)?$/.test(col(r, 'score'))
                    ? (score / pp) * 100
                    : score,
              },
        link: col(r, 'link') || undefined,
        quickNotes: col(r, 'notes') || undefined,
        filePaths: [],
      });
    } else if (collection === 'tasks') {
      const d = date(col(r, 'date'));
      out.tasks.push({
        ref: mk('task', cls),
        title: key,
        classRef: cls ? nameRef('class', cls) : undefined,
        date: d ? formatInterval(d) : undefined,
        priority: normalizeTaskPriority(col(r, 'priority')) ?? 'medium',
        done: parseBool(col(r, 'done')),
        targetHours: parseNumber(col(r, 'target_hours')) ?? undefined,
        actualHours: parseNumber(col(r, 'actual_hours')) ?? undefined,
      });
    } else {
      const s = slugOption(col(r, 'status'));
      const d = date(col(r, 'date_read'));
      out.readings.push({
        ref: mk('reading'),
        title: key,
        classRef: cls ? nameRef('class', cls) : undefined,
        status: s === 'complete' ? 'complete' : s === 'reading' ? 'reading' : 'to_read',
        format: slugOption(col(r, 'format')) || undefined,
        totalPages: parseNumber(col(r, 'total_pages')) ?? undefined,
        pagesRead: parseNumber(col(r, 'pages_read')) ?? undefined,
        dateRead: d?.start.slice(0, 10),
      });
    }
  });
  void cleanLabel;
  return out;
}
