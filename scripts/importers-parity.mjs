#!/usr/bin/env node
// Runs the TypeScript importers (packages/importers) on generated inputs and saves inputs and
// results to internal/importers/testdata/parity.json.gz. The Go importers' test runs the same
// inputs and must give the same JSON. Every input is synthetic and comes from a fixed seed.
//
//   npx tsc -b packages/importers && node scripts/importers-parity.mjs [--seed N] [--scale K] [--out FILE]
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

// Calendar times in UTC are shown in local time, and Date.parse reads local times: fix the zone.
process.env.TZ = 'America/New_York';
console.warn = () => {}; // papaparse warns about every duplicate header
const I = await import('../packages/importers/dist/index.js');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const OUT =
  arg('out') ??
  fileURLToPath(new URL('../internal/importers/testdata/parity.json.gz', import.meta.url));
const SCALE = Number(arg('scale', 1));
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
const some = (xs, n) => Array.from({ length: n }, () => pick(xs));
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[int(0, 15)]).join('');

const attempt = (f) => {
  try {
    return { ok: f() };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
};

// ---------------- messy cell fragments ----------------
const SPACES = [
  ' ',
  '  ',
  '\t',
  '\u00a0',
  '\u2007',
  '\u200b',
  '\u202f',
  '\u3000',
  '\ufeff',
  '\u00ad',
  '\u200e',
];
const WORDS = [
  'Lorem',
  'ipsum',
  'Dolor',
  'sit',
  'amet',
  'Café',
  'naïve',
  'Ünïcödé',
  'Ⅸ',
  'ﬁle',
  '日本',
  'Ελλάδα',
  'x',
  'X',
  'and',
  'And',
];
const EMOJI = ['🔥', '⭐', '✅', '❗', '🟢', '1️⃣', '👍🏽', '❤️', '©', '‼'];
const sp = () => (chance(0.3) ? pick(SPACES) : ' ');
const words = (n) => some(WORDS, n).join(sp());
const messy = (s) => (chance(0.2) ? pick(SPACES) : '') + s + (chance(0.2) ? pick(SPACES) : '');

const DAY_CELLS = () =>
  messy(
    some(
      [
        'Mon',
        'monday',
        'Tue',
        'Tues.',
        'wed',
        'Weds',
        'Thu',
        'Thurs',
        'fri',
        'SAT',
        'sun',
        'M',
        'xyz',
        'and',
        'Thursday:',
      ],
      int(0, 4),
    ).join(pick([', ', '/', ' & ', ' and ', ';', ' AND ', ','])),
  );
const PERCENTS = () =>
  messy(
    pick([
      '20%',
      '20',
      ' 0.5 %',
      '1,000',
      '-3.5%',
      '87.25',
      '12.%',
      'abc',
      '',
      '%',
      '1e2',
      '0x10',
      '7 %',
      '٣',
    ]),
  );
const NUMBERS = () =>
  messy(
    pick([
      '3',
      '3.5',
      '1,234',
      '',
      '0x1F',
      '0b101',
      '0o17',
      '1e3',
      '.5',
      '5.',
      '+4',
      '-0',
      'Infinity',
      'NaN',
      'abc',
      ' 12 ',
      '1_000',
      '00012',
    ]),
  );
const MONTHS = [
  'January',
  'Feb',
  'Mar.',
  'april',
  'MAY',
  'June',
  'Jul',
  'Aug',
  'Sept',
  'September',
  'Octob',
  'Nov',
  'Dec',
  'Smarch',
  'Ju',
];
const time12 = () =>
  `${int(1, 12)}:${String(int(0, 59)).padStart(2, '0')}${pick(['', ' ', ''])}${pick(['AM', 'PM', 'am', 'pm', 'a', 'p', 'a.m.', 'P.M.', ''])}`;
const oneDate = () => {
  const y = int(2020, 2035);
  const m = int(0, 14);
  const d = int(0, 33);
  const base = pick([
    `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    `${y}/${m}/${d}`,
    `${m}/${d}/${y}`,
    `${pick(MONTHS)} ${d}${pick(['', 'st', 'th', 'nd'])}${pick([',', ''])} ${y}`,
  ]);
  const t = chance(0.4)
    ? pick([' ', 'T', ' ']) +
      pick([
        time12(),
        `${int(0, 25)}:${String(int(0, 61)).padStart(2, '0')}`,
        `${int(0, 23)}:00:00`,
      ])
    : '';
  const tz = chance(0.15) ? ` (${pick(['EST', 'GMT+1', 'Pacific Time', ''])})` : '';
  return base + t + tz;
};
const DATES = () =>
  messy(
    chance(0.25)
      ? `${oneDate()}${pick([' → ', '->', ' — ', '–', ' - '])}${oneDate()}`
      : chance(0.05)
        ? pick(['', 'soon', '2026', '→ 2026-01-01'])
        : oneDate(),
  );
const TIMES = () => {
  const r = () =>
    `${int(1, 13)}${chance(0.6) ? ':' + String(int(0, 60)).padStart(2, '0') : ''}${pick(['', 'a', 'p', 'am', 'pm', ' AM', ' p.m.'])}${pick(['-', ' - ', '–', '—', ' to '])}${int(1, 13)}${chance(0.6) ? ':' + String(int(0, 59)).padStart(2, '0') : ''}${pick(['', 'a', 'p', 'pm', ' PM'])}`;
  const n = int(0, 3);
  return Array.from(
    { length: n },
    () =>
      (chance(0.4) ? pick(['Mon ', 'Tue: ', 'wed, ', 'Thu. ', 'Fri- ', 'Foo ']) : '') +
      (chance(0.9) ? r() : 'TBA'),
  ).join(pick(['\n', '; ', '\r\n']));
};
const OPTION = (choices) =>
  messy((chance(0.3) ? pick(EMOJI) + ' ' : '') + pick(choices) + (chance(0.1) ? pick(EMOJI) : ''));
const PRIORITIES = () =>
  OPTION([
    'High',
    'important',
    'Medium',
    'mid',
    'Low',
    'urgent!',
    'Someday',
    'whatever',
    '',
    'Normal',
  ]);
const ASG_STATUS = () =>
  OPTION([
    'Done',
    'Not started',
    'In progress',
    'In Review',
    'turned in',
    'Graded',
    'To-do',
    'Late',
    'Blocked',
    '',
    'WIP',
    'started',
  ]);
const READ_STATUS = () =>
  OPTION([
    'Read',
    'Reading',
    'To read',
    'Currently reading',
    'Want to',
    'done',
    'Abandoned',
    '',
    'Finished',
  ]);
const RELATIONS = () => {
  const one = () =>
    pick([
      () => `${words(2)} (${encodeURIComponent(`${words(1)} ${hex(32)}`)}.md)`,
      () => `${words(2)} (../Classes/${encodeURIComponent(words(2))}%20${hex(32)}.md)`,
      () =>
        `${words(1)} (https://www.notion.so/${words(1)}-${hex(32)}${pick(['', '?pvs=21', '#x'])})`,
      () => `${words(1)} (bad%E0%A4%A.md)`,
      () => words(2),
    ])();
  return Array.from({ length: int(0, 3) }, one).join(pick([', ', ',', ' , ']));
};
const TITLES = () =>
  messy(
    words(int(1, 4)) + (chance(0.2) ? ' ' + pick(EMOJI) : '') + (chance(0.1) ? ` ${hex(32)}` : ''),
  );

// ---------------- unit cases ----------------
const n = (k) => Math.ceil(k * SCALE);
const unit = [];
const U = (fn, args) => unit.push({ fn, args, want: attempt(() => I[fn](...args)) });
for (let i = 0; i < n(150); i++) {
  U('parseDays', [DAY_CELLS()]);
  U('parsePercent', [PERCENTS()]);
  U('parseNumber', [NUMBERS()]);
  U('parseBool', [
    messy(pick(['yes', 'YES', 'true', 'x', 'X', '1', 'checked', 'no', '', '0', 'y'])),
  ]);
  U('parseNotionDate', [DATES()]);
  U('parseTimeRange', [TIMES()]);
  U('parseTimes', [TIMES(), I.parseDays(DAY_CELLS())]);
  U('cleanLabel', [messy(words(int(0, 3)) + pick(SPACES) + words(1))]);
  U('normalizePriority', [PRIORITIES()]);
  U('normalizeAssignmentStatus', [ASG_STATUS()]);
  U('normalizeReadingStatus', [READ_STATUS()]);
  U('normalizeTaskPriority', [PRIORITIES()]);
  U('slugOption', [OPTION(['In-Class', 'Group Project', 'Café Talk', '--x--', '', '日本'])]);
  U('splitMulti', [some([OPTION(['Essay', 'Quiz', 'Lab']), '', ' '], int(0, 4)).join(',')]);
  U('parseRelation', [RELATIONS()]);
  U('normTitle', [TITLES()]);
  U('splitName', [
    `${words(2)}${pick([' ', '', '  '])}${hex(pick([31, 32, 33]))}${pick(['', '_all', ' 1', '_all.csv'])}`,
  ]);
  U('detectKind', [
    some(
      [
        'Assignment',
        'Weight',
        'Class',
        'Credits',
        'Semester',
        'Dates',
        'Task',
        'Done',
        'Total Pages',
        'Mood',
        'Title',
        'Readings',
        'Position',
        'Company',
        'Purchase',
        'Cost',
        'Name',
        'Email',
        ' times ',
      ],
      int(1, 5),
    ),
  ]);
}

// ---------------- CSV text ----------------
const csvCell = (q) => {
  const v = pick([
    '',
    'plain',
    'a,b',
    'say "hi"',
    'multi\nline',
    'cr\rline',
    ' spaced ',
    '"',
    'tab\there',
    'x',
    'Café',
    '\ufeffbom',
    '=SUM(A1)',
    '-5',
    '  ',
  ]);
  if (q || /[",\n\r]/.test(v))
    return chance(0.95) ? `"${v.replace(/"/g, '""')}"` + (chance(0.05) ? ' ' : '') : `"${v}`;
  return v;
};
const csvText = () => {
  const delim = pick([',', ',', ';', '\t', '|']);
  const nl = pick(['\n', '\r\n', '\r']);
  const cols = int(1, 5);
  const header = Array.from({ length: cols }, () =>
    pick(['Name', 'name', ' Title ', 'Due', 'Score', 'Name', '', '\ufeffName', 'A_1', 'A', 'A']),
  ).join(delim);
  const rows = Array.from({ length: int(0, 6) }, () =>
    chance(0.1)
      ? pick(['', ' ', delim, `${delim}${delim}`])
      : Array.from({ length: cols + int(-1, 1) }, () => csvCell(chance(0.2))).join(delim),
  );
  return (
    (chance(0.2) ? '\ufeff' : '') +
    (chance(0.05) ? nl : '') +
    [header, ...rows].join(nl) +
    (chance(0.5) ? nl : '')
  );
};
const csv = [];
for (let i = 0; i < n(300); i++) {
  const text = csvText();
  csv.push({ text, want: I.parseCsv(text) });
}

// ---------------- CSV imports ----------------
const HEADERS = {
  semesters: ['name', 'Name', 'start', 'end', 'Semester', 'extra'],
  classes: [
    'name',
    'Class',
    'semester',
    'code',
    'credits',
    'type',
    'delivery',
    'days',
    'times',
    'location',
    'Professor',
    'teacher',
  ],
  assignments: [
    'title',
    'Assignment',
    'class',
    'Course',
    'due',
    'Due Date',
    'weight',
    'score',
    'Grade',
    'points_possible',
    'Points Possible',
    'status',
    'priority',
    'type',
    'link',
    'notes',
    'Quick Notes',
  ],
  tasks: ['title', 'class', 'date', 'due', 'priority', 'done', 'target_hours', 'Actual (Hrs)'],
  readings: [
    'title',
    'Name',
    'class',
    'status',
    'format',
    'Total Pages',
    'pages_read',
    'Date Read',
  ],
};
const valueFor = (h) => {
  const k = h.toLowerCase();
  if (/name|title|assignment|class|course|semester/.test(k)) return chance(0.1) ? '' : TITLES();
  if (/due|date|start|end/.test(k)) return DATES();
  if (/days/.test(k)) return DAY_CELLS();
  if (/times/.test(k)) return TIMES();
  if (/weight|score|grade/.test(k)) return chance(0.3) ? `${int(0, 20)}/${int(1, 20)}` : PERCENTS();
  if (/points|credits|pages|hours|hrs/.test(k)) return NUMBERS();
  if (/status/.test(k)) return chance(0.5) ? ASG_STATUS() : READ_STATUS();
  if (/priority/.test(k)) return PRIORITIES();
  if (/done/.test(k)) return pick(['yes', 'no', 'x', '']);
  if (/delivery|type|format/.test(k))
    return OPTION(['In person', 'online', 'Hybrid', 'Lab, Essay', 'library', 'zoom']);
  return words(int(0, 3));
};
const q = (v) => (/[",\n\r]/.test(v) || chance(0.1) ? `"${String(v).replace(/"/g, '""')}"` : v);
const csvFile = (headers, rows) =>
  [headers.map(q).join(','), ...rows.map((r) => headers.map((h) => q(r[h] ?? '')).join(','))].join(
    pick(['\n', '\r\n']),
  );
const csvImports = [];
for (let i = 0; i < n(80); i++) {
  const collection = pick(I.CSV_COLLECTIONS);
  const headers = [...new Set(some(HEADERS[collection], int(1, 8)))];
  if (chance(0.85))
    headers.unshift(collection === 'classes' || collection === 'semesters' ? 'name' : 'title');
  const rows = Array.from({ length: int(0, 8) }, () =>
    Object.fromEntries(headers.map((h) => [h, valueFor(h)])),
  );
  const text = csvFile(headers, rows);
  csvImports.push({ text, collection, want: I.previewCsv(text, collection) });
}

// ---------------- gradebooks ----------------
const plugins = [...I.BUILTIN_MAPPINGS];
plugins.push({
  ...I.BUILTIN_MAPPINGS[1],
  id: 'wide-picked',
  wide: {
    studentColumn: 'Student',
    studentValue: 'Sample Student',
    skipColumns: ['Section'],
    pointsRow: { column: 'Student', equals: 'Points Possible' },
    pointsInHeader: true,
  },
  scoreFormat: 'points',
  className: 'Default Class',
  skipRows: [{ column: 'Student', contains: 'test' }],
});
plugins.push({
  ...I.BUILTIN_MAPPINGS[0],
  id: 'long-percent',
  scoreFormat: 'percent',
  columns: { title: ['Item'], score: ['Mark'] },
});
plugins.push({
  ...I.BUILTIN_MAPPINGS[0],
  id: 'long-points',
  scoreFormat: 'points',
  skipRows: [{ column: 'Status', equals: 'Excused' }],
});
const gradebooks = [];
for (let i = 0; i < n(80); i++) {
  const p = pick(plugins);
  let headers, rows;
  if (p.layout === 'long') {
    headers = [
      ...new Set(
        some(
          [
            'Assignment',
            'Item',
            'Course',
            'Due',
            'Score',
            'Mark',
            'Points Possible',
            'Out Of',
            'Weight',
            'Status',
            'Category',
            'Comments',
            'Extra',
          ],
          int(2, 7),
        ),
      ),
    ];
    rows = Array.from({ length: int(0, 6) }, () =>
      Object.fromEntries(
        headers.map((h) => [
          h,
          /score|mark/i.test(h)
            ? pick(['18', '18/20', '90%', '-', '—', 'EX', '', ' 7.5 '])
            : /points|out of/i.test(h)
              ? pick(['20', '', '100'])
              : /status/i.test(h)
                ? pick(['Excused', 'Graded', ''])
                : valueFor(h),
        ]),
      ),
    );
  } else {
    headers = [
      'Student',
      'Section',
      ...some(
        [
          'Essay 1 (50)',
          'Quiz [20 pts]',
          'Lab 2',
          'Final Score',
          'Midterm (100 points)',
          ' (10)',
          'HW',
        ],
        int(1, 5),
      ),
    ];
    rows = Array.from({ length: int(0, 4) }, (_, k) =>
      Object.fromEntries(
        headers.map((h) => [
          h,
          h === 'Student'
            ? pick(['Sample Student', 'Points Possible', 'test user', `Student ${k}`])
            : pick(['45', '18/20', '', 'EX', '88%', '10']),
        ]),
      ),
    );
  }
  const text = csvFile(headers, rows);
  const className = chance(0.3) ? pick(['  Biology  ', 'Algebra', '']) : undefined;
  gradebooks.push({
    text,
    plugin: p,
    className,
    want: I.mapGradebook(text, p, { className }),
    preview: I.previewGradebook(text, p, { className }),
  });
}

// ---------------- calendars ----------------
const icsTime = () => {
  const y = int(2025, 2032),
    m = int(1, 12),
    d = int(1, 28);
  const date = `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
  return pick([
    () => [`;VALUE=DATE`, date],
    () => ['', date],
    () => [
      '',
      `${date}T${String(int(0, 23)).padStart(2, '0')}${String(int(0, 59)).padStart(2, '0')}00Z`,
    ],
    () => ['', `${date}T${String(int(0, 23)).padStart(2, '0')}3000`],
    () => [`;TZID=${pick(['America/Chicago', '"Europe/Berlin"', 'UTC', 'GMT'])}`, `${date}T090000`],
  ])();
};
const icsText = (s) =>
  s.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');
const fold = (line) =>
  line.length > 60 && chance(0.5) ? line.slice(0, 40) + '\r\n ' + line.slice(40) : line;
const calendar = () => {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0'];
  if (chance(0.2)) L.push('BEGIN:VTIMEZONE', 'TZID:America/Chicago', 'END:VTIMEZONE');
  for (let i = int(0, 5); i > 0; i--) {
    L.push('BEGIN:VEVENT');
    if (chance(0.85)) L.push(`UID:${pick(['', `${hex(8)}@example`, 'same-uid'])}`);
    if (chance(0.92))
      L.push(
        `SUMMARY${pick(['', ';LANGUAGE=en'])}:${icsText(chance(0.1) ? '  ' : words(int(1, 4)) + (chance(0.2) ? ', with; escapes\\' : ''))}`,
      );
    const [p, v] = icsTime();
    L.push(`DTSTART${p}:${v}`);
    if (chance(0.5)) {
      const [p2, v2] = icsTime();
      L.push(`DTEND${p2}:${v2}`);
    } else if (chance(0.5))
      L.push(`DURATION:${pick(['PT1H', 'PT1H30M', 'P1D', 'P1W', '-PT15M', 'PT45M'])}`);
    if (chance(0.3)) L.push(`DESCRIPTION:${icsText(`Line one\n${words(5)}`)}`);
    if (chance(0.2)) L.push('RRULE:FREQ=WEEKLY;COUNT=3');
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  let text = L.map(fold).join(pick(['\r\n', '\n']));
  if (chance(0.05))
    text = pick([
      'not a calendar',
      'BEGIN:VCALENDAR\r\nSUMMARY\r\nEND:VCALENDAR',
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:x\nDTSTART:20260101\n',
      '  \n' + text,
    ]);
  return text;
};
const calendars = [];
for (let i = 0; i < n(80); i++) {
  const text = calendar();
  const opts = chance(0.4)
    ? { as: 'assignments', className: chance(0.5) ? 'Biology' : undefined }
    : {};
  calendars.push({ text, opts, want: attempt(() => I.previewIcs(text, opts)) });
}
const icsExports = [];
for (let i = 0; i < n(20); i++) {
  const input = {
    now: new Date(Date.UTC(2031, int(0, 11), int(1, 28), int(0, 23), int(0, 59), int(0, 59))),
    name: chance(0.5) ? `My, calendar; ${words(2)}` : undefined,
    deadlines: Array.from({ length: int(0, 3) }, () => ({
      id: hex(26),
      title: words(int(1, 30)),
      due: pick([
        '2031-10-01',
        '2031-10-01/2031-10-03',
        '2031-10-01T09:30',
        '2031-10-01T09:30/2031-10-01T11:00',
        '2031-12-31',
      ]),
      className: chance(0.5) ? words(2) : undefined,
      notes: chance(0.5) ? `Notes\n${words(20)}` : undefined,
    })),
    meetings: Array.from({ length: int(0, 2) }, () => ({
      classId: hex(26),
      className: words(3),
      day: pick(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
      start: '09:15',
      end: '10:30',
      location: chance(0.5) ? 'Hall 1, Room 2' : undefined,
      from: `2031-0${int(1, 9)}-0${int(1, 9)}`,
      until: '2031-12-12',
    })),
  };
  icsExports.push({ input: { ...input, now: input.now.toISOString() }, want: I.buildIcs(input) });
}
const folds = Array.from({ length: n(40) }, () => {
  const line = some([...WORDS, ...EMOJI, 'ascii-only-text '], int(1, 40)).join(pick(['', ' ']));
  return { line, want: I.fold(line) };
});
const toCsvCases = Array.from({ length: n(30) }, () => {
  const headers = some(['a', 'b', 'c', 'd'], int(1, 4));
  const rows = Array.from({ length: int(0, 3) }, () =>
    Object.fromEntries(
      headers.map((h) => [
        h,
        pick(['', '=1+1', '+x', '-5', '-5.5', '@me', '\tx', 'a,b', 'q"q', 'line\nbreak', 'plain']),
      ]),
    ),
  );
  return { headers, rows, want: I.toCsv(headers, rows) };
});
const templates = I.CSV_COLLECTIONS.map((c) => ({ collection: c, want: I.csvTemplate(c) }));

// ---------------- Markdown folders ----------------
const mdFolders = [];
for (let i = 0; i < n(40); i++) {
  const files = {};
  for (let k = int(0, 6); k > 0; k--) {
    const dir = pick([
      '',
      'Biology/',
      'Algebra II/',
      'Biology/Week 1/',
      '.obsidian/',
      'Art/.hidden/',
    ]);
    const name = `${dir}${words(int(1, 2))}${pick(['.md', '.MD', '.md', '.txt'])}`;
    const fm = pick([
      '',
      `---\ntitle: ${words(2)}\ntags: [${some(['#a', 'b', '1', 'b'], int(0, 3)).join(', ')}]\ndate: 2031-0${int(1, 9)}-1${int(0, 9)}T10:00\n---\n`,
      `---\ntag: "#x, y z"\ndate: 20310101\n---\n`,
      '---\ntitle: null\n---\n',
      '---\n: bad: yaml: [\n---\n',
      '---\n- a\n- b\n---\n',
      '---\ntitle: 42\ntags:\n  - 1\n  - true\n---\n',
      '\ufeff---\ntitle: Bom\n---\n',
    ]);
    const body = pick([
      `# ${words(3)}\n\n${words(10)}\n`,
      `#   \n  ${words(2)}\n`,
      `Text ![[pic.png]] and ![[missing.png|200]] and ![alt](pic%20two.png) and ![w](https://x.y/z.png)\n`,
      `![rel](img/a.png)\n`,
      '',
      '#\n',
      `Some text\n# Later heading\n`,
    ]);
    files[name] = fm + body;
  }
  if (chance(0.6)) files['pic.png'] = 'PNG';
  if (chance(0.4)) files['Biology/pic two.png'] = 'PNG';
  if (chance(0.3)) files['Biology/img/a.png'] = 'PNG';
  mdFolders.push({ files, want: I.previewMarkdownFolder(I.openMemory(files)) });
}

// ---------------- backups ----------------
const backups = [
  '',
  'not json',
  '[]',
  'null',
  '{"format":"other"}',
  '{"format":"classpad-backup"}',
  '{"format":"classpad-backup","schemaVersion":2}',
  '{"format":"classpad-backup","schemaVersion":null}',
  '{"format":"classpad-backup","schemaVersion":"1"}',
  '{"format":"classpad-backup","schemaVersion":1,"exportedAt":"2031-01-01","semesters":[{"id":"S1","n":1.5}],"notes":{"x":1},"journal":[null]}',
  '{"format":"classpad-backup","schemaVersion":1,"exportedAt":12}',
].map((text) => ({ text, want: attempt(() => I.parseBackup(text)) }));

// ---------------- Notion page bodies ----------------
const BODY_PARTS = [
  () => `# ${words(3)}\n`,
  () => `Class: ${words(2)}\nStatus: Done\nWeight: 20%\n`,
  () => `\n${words(12)}\n`,
  () =>
    `<aside>\n${pick(['💡', '⚠️', '👍🏽', ''])} ${pick(['Tip: use this', 'Tooltip - delete me', 'How to use this', 'Note', 'template hint: x', 'Hint'])} ${words(5)}\n</aside>\n`,
  () =>
    `<details>\n<summary>${pick(['Toggle', '<h2>Heading <b>x</b></h2>', '', '<H3 class="x">Big</h3>', `${words(2)}`])}</summary>\n${words(6)}\n${chance(0.3) ? `<details><summary>Inner</summary>deep</details>` : ''}\n</details>\n`,
  () => `\\[ \\] todo\n\\[x\\] done\n`,
  () => 'Equation $`x^2`$ inline\n',
  () => 'Break<br>here<br/>and<BR />there <!-- hidden -->\n',
  () =>
    `[Link](${encodeURIComponent(words(2))}%20${hex(32)}.md) and [](${hex(4)}/Other%20Page%20${hex(32)}.md)\n`,
  () =>
    `![img](${pick(['Page/Figure%201.png', 'pic.png', '../up.png', 'missing.png', 'https://x.y/a.png'])}) [db](View%20${hex(32)}.csv) [site](https://example.com) [mail](mailto:a@b) [anchor](#x)\n`,
  () => `[bad](%E0%A4%A.png)\n`,
  () => '\n\n\n\n',
  () => '\r\nWindows\r\nlines\r',
];
const notionBodies = [];
for (let i = 0; i < n(120); i++) {
  const input =
    (chance(0.1) ? '\ufeff' : '') +
    some(BODY_PARTS, int(1, 6))
      .map((f) => f())
      .join('');
  const files = ['Hub/Page/Figure 1.png', 'Hub/pic.png', 'up.png', 'pic.png'];
  const ctx = {
    pagePath: 'Hub/Page.md',
    propertyNames: ['class', 'status', 'weight'],
    files,
    dropTooltips: chance(0.7),
  };
  const want = I.convertNotionMarkdown(input, {
    pagePath: ctx.pagePath,
    propertyNames: new Set(ctx.propertyNames),
    hasFile: (p) => files.includes(p),
    dropTooltips: ctx.dropTooltips,
  });
  notionBodies.push({ input, ctx, want });
}

// ---------------- whole Notion exports ----------------
const notionCsv = (headers, rows) =>
  '\ufeff' +
  [headers.join(','), ...rows.map((r) => headers.map((h) => q(r[h] ?? '')).join(','))].join('\n') +
  '\n';
function notionExport() {
  const files = {};
  const hub = pick(['Hub', 'Student OS', 'Sample Hub']);
  const page = (dir, title, body) => {
    const id = hex(32);
    files[`${dir}/${title} ${id}.md`] = `# ${title}\n\n${body}`;
    return `${title} (${encodeURIComponent(`${title} ${id}`)}.md)`;
  };
  const sems = Array.from({ length: int(0, 3) }, (_, k) => `Term ${k + 1}`);
  const semRel = {};
  const semDir = `${hub}/Semesters`;
  for (const s of sems)
    semRel[s] = chance(0.8)
      ? page(semDir, s, `- Goal ${words(2)}\n- [x] Done goal\n* ${words(1)}\n`)
      : s;
  files[`${hub}/Semesters ${hex(32)}${pick(['_all', ''])}.csv`] = notionCsv(
    ['Semester', 'Dates', 'Average Grade'],
    sems.map((s) => ({
      Semester: s,
      Dates: pick([
        `September 1, 2031 → December 12, 2031`,
        '2031-01-05 → 2033-01-05',
        '2031-10-01',
        '2031-12-01 → 2031-09-01',
        'whenever',
        `2031-10-01 3:00 PM (EST) → 2031-12-01`,
      ]),
    })),
  );
  const classes = Array.from({ length: int(0, 4) }, () =>
    pick(['BIO 101', 'Algebra II', 'Art History', 'CHEM-210L', 'Physics', 'Template', '']),
  );
  const clsDir = `${hub}/Classes`;
  const classRel = {};
  const asgTitles = Array.from({ length: int(0, 6) }, () =>
    pick(['Essay 1', 'Quiz', 'Lab Report', 'Final', 'Midterm', 'New Entry', '']),
  );
  for (const c of classes)
    if (c)
      classRel[c] = chance(0.8)
        ? page(clsDir, c, chance(0.5) ? `Some class notes ${words(4)}\n![syl](Syllabus.pdf)` : '')
        : c;
  files[`${hub}/Classes/Classes ${hex(32)}_all.csv`] = notionCsv(
    [
      'Class',
      'Semester',
      'Type',
      'Category',
      'Credits',
      'Days',
      'Times',
      'Location',
      'Dates',
      'Syllabus',
      'Quick Notes',
      'Contacts',
      '% Grade',
      'Assignments',
      'Notes',
      'Readings',
    ],
    classes.map((c) => ({
      Class: c,
      Semester: sems.length && chance(0.8) ? semRel[pick(sems)] : chance(0.2) ? 'Ghost Term' : '',
      Type: OPTION(['Core', 'Elective', '']),
      Category: OPTION(['In Person', 'Online', 'Hybrid', 'Zoom', '']),
      Credits: pick(['3', '4', '', '1.5', 'three']),
      Days: DAY_CELLS(),
      Times: TIMES(),
      Location: pick(['Hall 1', '', ' Room 2 ']),
      Dates: chance(0.5) ? DATES() : '',
      Syllabus: pick([
        '',
        `Syllabus (${clsDir}/Syllabus.pdf)`,
        `Classes/Syllabus.pdf`,
        `${hub}/Classes/Syllabus.pdf`,
      ]),
      'Quick Notes': chance(0.3) ? words(4) : '',
      Contacts: chance(0.3) ? RELATIONS() : '',
      '% Grade': pick(['', '84%', '0.84', '91.5', '100%', 'abc', '84.004']),
      Assignments: asgTitles.filter(() => chance(0.3)).join(', '),
      Notes: chance(0.3) ? 'Lecture 1 (x.md)' : '',
    })),
  );
  if (chance(0.5)) files[`${clsDir}/Syllabus.pdf`] = 'PDF';
  if (chance(0.3))
    files[`${clsDir}/Classes ${hex(32)}.csv`] = notionCsv(
      ['Class', 'Credits'],
      [{ Class: 'Embedded', Credits: '3' }],
    );
  const asgDir = `${hub}/Assignments`;
  const asgRel = {};
  for (const a of asgTitles)
    if (a)
      asgRel[a] = chance(0.6)
        ? page(asgDir, a, chance(0.5) ? `Prompt ${words(6)}\n[Spec](Spec%20${hex(32)}.md)` : '')
        : a;
  files[`${asgDir}/Assignments ${hex(32)}_all.csv`] = notionCsv(
    [
      'Assignment',
      'Class',
      'Type',
      'Status',
      'Priority',
      'Date',
      'Weight',
      'Final Grade',
      'Link',
      'File',
      'Quick Notes',
    ],
    asgTitles.map((a) => ({
      Assignment: a,
      Class:
        classes.filter(Boolean).length && chance(0.8)
          ? classRel[pick(classes.filter(Boolean))]
          : chance(0.3)
            ? `Outside (https://www.notion.so/x-${hex(32)})`
            : '',
      Type: some(['Essay', 'Quiz', 'Lab'], int(0, 2)).join(', '),
      Status: ASG_STATUS(),
      Priority: PRIORITIES(),
      Date: chance(0.8) ? DATES() : '',
      Weight: pick(['20%', '10', '', '5.5%', 'lots']),
      'Final Grade': pick(['', '88%', '92', '0.9', 'A']),
      Link: chance(0.2) ? 'https://example.com/x' : '',
      File: pick([
        '',
        'brief.pdf',
        'brief.pdf, missing.png',
        `${encodeURIComponent('My File.pdf')} (${asgDir}/My%20File.pdf)`,
      ]),
      'Quick Notes': chance(0.2) ? words(3) : '',
    })),
  );
  if (chance(0.6)) files[`${asgDir}/brief.pdf`] = 'PDF';
  if (chance(0.3)) files[`${asgDir}/My File.pdf`] = 'PDF';
  const nbDir = `${hub}/Notebook`;
  const notes = Array.from({ length: int(0, 4) }, () =>
    pick(['Lecture 1', 'Lecture 2', 'Default', 'Template: Note', 'Empty']),
  );
  const noteRel = {};
  for (const t of notes)
    noteRel[t] = chance(0.7)
      ? page(
          `${nbDir}/Notebook`,
          t,
          t === 'Empty' ? '' : `${words(8)}\n<aside>💡 Tip: ${words(2)}</aside>\n`,
        )
      : t;
  files[`${nbDir}/Notebook ${hex(32)}_all.csv`] = notionCsv(
    ['Title', 'Class', 'Date', 'Readings', 'Related Assignments'],
    notes.map((t) => ({
      Title: t,
      Class:
        chance(0.5) && classes.filter(Boolean).length
          ? classRel[pick(classes.filter(Boolean))]
          : '',
      Date: chance(0.5) ? DATES() : '',
      'Related Assignments':
        chance(0.4) && asgTitles.filter(Boolean).length
          ? asgRel[pick(asgTitles.filter(Boolean))]
          : '',
    })),
  );
  if (chance(0.4)) page(`${nbDir}/Notebook`, 'Orphan Template', 'template body');
  if (chance(0.4)) page(hub, 'Hub Home', 'Welcome');
  if (chance(0.5))
    files[`${hub}/Readings ${hex(32)}_all.csv`] = notionCsv(
      [
        'Title',
        'Class',
        'Status',
        'Format',
        'Total Pages',
        'Pages Read',
        'Date Read',
        'Quick Notes',
      ],
      Array.from({ length: int(0, 3) }, () => ({
        Title: TITLES(),
        Class: chance(0.5) && classes[0] ? (classRel[classes[0]] ?? '') : '',
        Status: READ_STATUS(),
        Format: OPTION(['Library', 'eBook']),
        'Total Pages': NUMBERS(),
        'Pages Read': NUMBERS(),
        'Date Read': DATES(),
      })),
    );
  if (chance(0.5))
    files[`${hub}/Tasks ${hex(32)}_all.csv`] = notionCsv(
      ['Task', 'Deliverable', 'Class', 'Date', 'Priority', 'Done', 'Target (Hrs)', 'Actual (Hrs)'],
      Array.from({ length: int(0, 3) }, () => ({
        Task: TITLES(),
        Deliverable: asgTitles[0] ? (asgRel[asgTitles[0]] ?? '') : '',
        Class: classes[0] ? (classRel[classes[0]] ?? classes[0]) : 'Nowhere',
        Date: DATES(),
        Priority: PRIORITIES(),
        Done: pick(['Yes', 'No']),
        'Target (Hrs)': NUMBERS(),
        'Actual (Hrs)': NUMBERS(),
      })),
    );
  if (chance(0.4))
    files[`${hub}/Journal ${hex(32)}_all.csv`] = notionCsv(
      ['Name', 'Date', 'Mood'],
      Array.from({ length: int(0, 3) }, () => ({
        Name: pick(['Day one', 'Template', 'Thoughts', '']),
        Date: chance(0.8) ? DATES() : '',
        Mood: some(['Happy 😀', 'Tired', 'ok'], int(0, 2)).join(', '),
      })),
    );
  if (chance(0.4))
    files[`${hub}/CRM ${hex(32)}_all.csv`] = notionCsv(
      ['Name', 'Category', 'Phone', 'Email', 'Class'],
      Array.from({ length: int(0, 3) }, () => ({
        Name: TITLES(),
        Category: OPTION(['Professor', 'TA']),
        Phone: '555-0100',
        Email: 'a@example.com',
        Class: classes[0] ? (classRel[classes[0]] ?? '') : '',
      })),
    );
  if (chance(0.4))
    files[`${hub}/Jobs ${hex(32)}_all.csv`] = notionCsv(
      ['Position', 'Company', 'Compensation', 'Priority', 'Status', 'Type', 'URL'],
      Array.from({ length: int(0, 3) }, () => ({
        Position: TITLES(),
        Company: TITLES(),
        Status: pick(['Applied', 'Interviewing', 'Offer!', 'Rejected', 'Wishlist', 'Ghosted', '']),
        Priority: PRIORITIES(),
        Type: 'Internship',
        URL: '',
      })),
    );
  if (chance(0.4))
    files[`${hub}/Budget ${hex(32)}_all.csv`] = notionCsv(
      pick([
        ['Purchase', 'Category', 'Cost', 'Date', 'Vendor', 'Sentiment'],
        ['Purchase', 'Cost'],
      ]),
      Array.from({ length: int(0, 4) }, () => ({
        Purchase: TITLES(),
        Category: 'Food',
        Cost: pick(['$12.50', '(5.00)', '-3', '1,234.5', 'free', '', 'USD 7']),
        Date: DATES(),
        Vendor: 'Shop',
        Sentiment: '🙂 fine',
      })),
    );
  if (chance(0.1))
    files[`${hub}/random ${hex(32)}.csv`] = notionCsv(['Foo', 'Bar'], [{ Foo: '1', Bar: '2' }]);
  files[`${hub}/.DS_Store`] = 'x';
  return files;
}
const notion = [];
for (let i = 0; i < n(60); i++) {
  const files = notionExport();
  const opts = {
    today: pick(['2031-10-15', '2032-03-01', '2030-01-01']),
    dropTooltips: chance(0.8),
  };
  const asZip = chance(0.3);
  let input = { files };
  let archive = I.openMemory(files);
  if (asZip) {
    const zip = new AdmZip();
    for (const [k, v] of Object.entries(files)) zip.addFile(k, Buffer.from(v));
    if (chance(0.3)) zip.addFile('__MACOSX/._junk', Buffer.from('x'));
    let buf = zip.toBuffer();
    if (chance(0.3)) {
      const outer = new AdmZip();
      outer.addFile('export.zip', buf);
      buf = outer.toBuffer();
    }
    input = { zip: buf.toString('base64') };
    archive = I.openZip(buf);
  }
  notion.push({ input, opts, want: I.previewNotion(archive, opts) });
}

// The repo's own synthetic export (fixtures/synthetic/notion-export), read from disk.
const fixtureDir = fileURLToPath(new URL('../fixtures/synthetic/notion-export', import.meta.url));
const notionFixture = ['2031-10-15', '2032-02-01'].map((today) => ({
  today,
  want: I.previewNotion(I.openDir(fixtureDir), { today }),
}));

const json = JSON.stringify({
  notionFixture,
  tz: process.env.TZ,
  unit,
  csv,
  csvImports,
  gradebooks,
  calendars,
  icsExports,
  folds,
  toCsvCases,
  templates,
  mdFolders,
  backups,
  notionBodies,
  notion,
});
writeFileSync(OUT, gzipSync(json, { level: 9 }));
console.log(
  `wrote ${unit.length} unit, ${csv.length} CSV, ${csvImports.length} CSV import, ${gradebooks.length} gradebook, ${calendars.length} calendar, ${mdFolders.length} Markdown folder, ${notionBodies.length} page body and ${notion.length} Notion export cases (${(json.length / 1e6).toFixed(1)} MB of JSON)`,
);
