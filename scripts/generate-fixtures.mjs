#!/usr/bin/env node
// Generates PUBLIC synthetic fixtures: a fake Notion-style export (reproducing real export quirks
// with invented lorem-ipsum content) and a fake Classpad demo backup. Deterministic (seeded).
// Never copy real data in here.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'synthetic');
const OUT = join(root, 'notion-export');

let seed = 20310101;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const hex = (n) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
const WORDS =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat'.split(
    ' ',
  );
const words = (n) =>
  Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
const sentence = () => {
  const s = words(6 + Math.floor(rnd() * 6));
  return s[0].toUpperCase() + s.slice(1) + '.';
};
const para = () => Array.from({ length: 2 + Math.floor(rnd() * 2) }, sentence).join(' ');

const HUB = 'Sample Hub';
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (headers, rows) =>
  '\ufeff' +
  [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))]
    .map((r) => r.map(csvCell).join(','))
    .join('\n') +
  '\n';
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const files = new Map();
const put = (p, content) => files.set(p, content);

// ---------- invented data ----------
const ids = {};
const idOf = (key) => (ids[key] ??= hex(32));
const pagePath = (dir, title, key) => `${HUB}/${dir}/${title} ${idOf(key)}.md`;
const rel = (title, path) => `${title} (${enc(path)})`;

const semesters = [
  { key: 'sem-a', name: 'Autumn Block A', dates: 'September 1, 2031 → December 12, 2031' },
  { key: 'sem-b', name: 'Winter Block B', dates: 'January 10, 2032 → April 30, 2032' },
  { key: 'sem-c', name: 'Sandbox Term', dates: 'January 3, 2029 → April 30, 2032' }, // suspicious span on purpose
];
const classes = [
  {
    key: 'c1',
    title: 'LOREM 101',
    sem: 'sem-a',
    type: 'Core',
    cat: 'In Person',
    credits: '3',
    days: 'Wednesday, Monday',
    times: '9:15a-10:30a',
    loc: 'Hall Z-12',
    contacts: ['Pat Placeholder'],
  },
  {
    key: 'c2',
    title: 'IPSUM 202',
    sem: 'sem-a',
    type: 'Gen Ed',
    cat: 'Online',
    credits: '4',
    days: 'Tuesday, Thursday',
    times: '10:00 AM - 11:15 AM\n1:00 PM - 2:15 PM',
    loc: '',
    contacts: ['Sam Sample'],
  },
  {
    key: 'c3',
    title: 'DOLOR 150',
    sem: 'sem-a',
    type: 'Elective',
    cat: 'Hybrid',
    credits: '2',
    days: 'Friday',
    times: '2p-4:50p',
    loc: 'Annex 3',
    contacts: [],
  },
  {
    key: 'c4',
    title: 'AMET 310',
    sem: 'sem-b',
    type: '',
    cat: 'In Person',
    credits: '',
    days: 'Monday, Wednesday, Friday',
    times: 'Mon 8:00 AM - 8:50 AM\nWed 8:00 AM - 8:50 AM\nFri 8:00 AM - 8:50 AM',
    loc: 'Room 4',
    contacts: [],
  },
  {
    key: 'c5',
    title: 'SITAM 099',
    sem: 'sem-b',
    type: 'Gen Ed',
    cat: 'In Person',
    credits: '3',
    days: 'Thursday',
    times: '6p-8:45p',
    loc: '',
    contacts: [],
  },
];
const P = {
  imp: '\u200e🔥\u00a0Important\u200f',
  mid: '\u200e⚡ Mid\u200f',
  low: '\u202a🌿 Low\u202c',
};
const A = (key, title, cls, type, status, pri, date, weight, grade, extra = {}) => ({
  key,
  title,
  cls,
  type,
  status,
  pri,
  date,
  weight,
  grade,
  ...extra,
});
const assignments = [
  A(
    'a1',
    'Reading Response 1',
    'c1',
    'Essay',
    'Complete',
    P.mid,
    'September 15, 2031',
    '20%',
    '90',
  ),
  A(
    'a2',
    'Midterm Exam',
    'c1',
    'Exam',
    'Complete',
    P.imp,
    'October 20, 2031 9:00 AM (PDT)',
    '30%',
    '80',
  ),
  A('a3', 'Final Exam', 'c1', 'Exam', 'Not Started', P.imp, 'December 10, 2031 1:00 PM', '50%', ''),
  A(
    'a4',
    'Lab Report',
    'c2',
    'Essay, In-Class',
    'Complete',
    P.low,
    'September 22, 2031',
    '10%',
    '100',
  ),
  A('a5', 'Quiz Block', 'c2', 'In-Class', 'Complete', P.mid, 'October 3, 2031', '10%', '70'),
  A(
    'a6',
    'Group Presentation',
    'c2',
    'Presentation, Group Project',
    'Complete',
    P.imp,
    'November 5, 2031 → November 6, 2031',
    '20%',
    '85',
  ),
  A('a7', 'Capstone Draft', 'c2', 'Essay', 'In Progress', P.imp, 'December 1, 2031', '40%', ''),
  A('a8', 'Worksheet Set', 'c3', 'In-Class', 'Complete', P.low, 'September 30, 2031', '25%', '88'),
  A('a9', 'Project Pitch', 'c3', 'Presentation', 'In Progress', '', 'November 11, 2031', '75%', ''),
  A(
    'a10',
    'Sketch Portfolio',
    'c4',
    'Group Project',
    'Not Started',
    P.mid,
    'February 20, 2032',
    '',
    '',
  ),
  A('a11', 'Seminar Notes Check', 'c5', 'In-Class', 'Not Started', P.low, '', '', ''),
  A('a12', 'Stray Worksheet', 'none', 'In-Class', 'Not Started', '', '', '', ''), // class relation points outside the export
];
const clsOf = (k) =>
  classes.find((c) => c.key === k) ?? { title: 'Untitled', key: 'none', sem: 'sem-a' };
const wmean = (cs) => {
  const g = assignments.filter((a) => a.cls === cs && a.grade && a.weight);
  const W = g.reduce((s, a) => s + parseFloat(a.weight), 0);
  const N = g.reduce((s, a) => s + parseFloat(a.weight) * parseFloat(a.grade), 0);
  return g.length ? { W, N, pct: N / W } : null;
};

// ---------- Semesters ----------
{
  const hdr = ['Semester', 'Activities', 'Average Grade', 'Classes', 'Credits', 'Dates'];
  const rows = semesters.map((s) => ({
    Semester: s.name,
    Dates: s.dates,
    Classes: classes
      .filter((c) => c.sem === s.key)
      .map((c) => rel(c.title, pagePath('Classes/Classes', c.title, c.key)))
      .join(', '),
    Credits: String(
      classes.filter((c) => c.sem === s.key).reduce((t, c) => t + (+c.credits || 0), 0),
    ),
    'Average Grade': '',
  }));
  put(`${HUB}/Semesters ${idOf('db-sem')}_all.csv`, csv(hdr, rows));
  put(
    `${HUB}/Semesters ${idOf('db-sem')}.csv`,
    csv(['Semester', 'Classes', 'Activities', 'Dates', 'Credits', 'Average Grade'], rows),
  );
  for (const s of semesters)
    put(pagePath('Semesters', s.name, s.key), `# ${s.name}\n\nDates: ${s.dates}\n\n${para()}\n`);
}
// ---------- Classes ----------
{
  const hdrAll = [
    'Class',
    '% Grade',
    'Active To-Dos',
    'Assignments',
    'Category',
    'Contacts',
    'Credits',
    'Dates',
    'Days',
    'Grade (#)',
    'Letter Grade',
    'Location',
    'Notes',
    'Quick Notes',
    'Readings',
    'Semester',
    'Syllabus',
    'Times',
    'Type',
    'Weight Sum',
    'Weighted Grade Sum',
  ];
  const rows = classes.map((c) => {
    const g = wmean(c.key);
    const sem = semesters.find((s) => s.key === c.sem);
    const shown = c.key === 'c3' && g ? (g.pct + 1).toFixed(1) : g ? g.pct.toFixed(1) : '';
    return {
      Class: c.title,
      '% Grade': shown ? `${shown}%` : '',
      'Active To-Dos': '0',
      Assignments: assignments
        .filter((a) => a.cls === c.key)
        .map((a) =>
          rel(
            a.title,
            pagePath('Assignments & Deliverables/Assignments & Deliverables', a.title, a.key),
          ),
        )
        .join(', '),
      Category: c.cat,
      Contacts: c.contacts
        .map((n) => rel(n, `${HUB}/Student CRM/School CRM/${n} ${idOf('ct-' + n)}.md`))
        .join(', '),
      Credits: c.credits,
      Dates: '',
      Days: c.days,
      'Grade (#)': shown,
      'Letter Grade': '',
      Location: c.loc,
      Notes: '',
      'Quick Notes': c.key === 'c1' ? sentence() : '',
      Readings: '',
      Semester: rel(sem.name, pagePath('Semesters', sem.name, sem.key)),
      Syllabus: '',
      Times: c.times,
      Type: c.type,
      'Weight Sum': g ? String(g.W) : '0',
      'Weighted Grade Sum': g ? String(g.N) : '0',
    };
  });
  put(`${HUB}/Classes/Classes ${idOf('db-cls')}_all.csv`, csv(hdrAll, rows));
  put(
    `${HUB}/Classes/Classes ${idOf('db-cls')}.csv`,
    csv(
      [
        'Class',
        'Semester',
        'Days',
        'Category',
        'Location',
        'Dates',
        'Times',
        'Type',
        'Credits',
        'Quick Notes',
        'Notes',
        'Assignments',
        'Contacts',
      ],
      rows,
    ),
  );
  put(`${HUB}/Classes ${idOf('pg-cls')}.md`, `# Classes\n\n${para()}\n`);
  for (const c of classes) {
    const p = pagePath('Classes/Classes', c.title, c.key);
    put(
      p,
      `# ${c.title}\n\nSemester: ${rel(semesters.find((s) => s.key === c.sem).name, 'x.md')}\nCredits: ${c.credits}\n\n${c.key === 'c1' ? para() : ''}\n\n[Assignments view](${enc(c.title)}/Untitled%20${hex(32)}.csv)\n`,
    );
    // embedded per-class view: same headers as assignments, must be ignored
    put(
      `${HUB}/Classes/Classes/${c.title} ${idOf(c.key)}/Untitled ${hex(32)}.csv`,
      csv(
        ['Assignment', 'Type', 'Class', 'Date', 'Status'],
        assignments
          .filter((a) => a.cls === c.key)
          .map((a) => ({
            Assignment: a.title,
            Type: a.type,
            Class: c.title,
            Date: a.date,
            Status: a.status,
          })),
      ),
    );
  }
  put(
    pagePath('Classes/Classes', 'New Class', 'tpl-class'),
    `# New Class\n\n<aside>\n💡 Tooltip: lorem ipsum template hint that is not user data.\n</aside>\n\n## Syllabus\n\n- [ ] ${words(4)}\n`,
  );
}
// ---------- Assignments ----------
{
  const hdrAll = [
    'Assignment',
    'Class',
    'Date',
    'Days Left',
    'File',
    'Final Grade',
    'Impact Weight',
    'Link',
    'Notes',
    'Priority',
    'Quick Notes',
    'Semester',
    'Status',
    'Type',
    'Weight',
    'Weighted Grade',
  ];
  const rows = assignments.map((a) => {
    const c = clsOf(a.cls);
    return {
      Assignment: a.title,
      Class:
        c.key === 'none'
          ? `Untitled (https://example.invalid/p/${hex(32)}?pvs=21)`
          : rel(c.title, pagePath('Classes/Classes', c.title, c.key)),
      Date: a.date,
      'Days Left': a.date ? '-120' : '',
      File: '',
      'Final Grade': a.grade,
      'Impact Weight': a.grade ? a.weight : '',
      Link: a.key === 'a7' ? 'https://example.invalid/draft' : '',
      Notes: '',
      Priority: a.pri,
      'Quick Notes': '',
      Semester: rel(
        semesters.find((s) => s.key === c.sem).name,
        pagePath('Semesters', semesters.find((s) => s.key === c.sem).name, c.sem),
      ),
      Status: a.status,
      Type: a.type,
      Weight: a.weight,
      'Weighted Grade':
        a.grade && a.weight ? String(parseFloat(a.grade) * parseFloat(a.weight)) : '',
    };
  });
  put(
    `${HUB}/Assignments & Deliverables/Assignments & Deliverables ${idOf('db-asg')}_all.csv`,
    csv(hdrAll, rows),
  );
  put(
    `${HUB}/Assignments & Deliverables/Assignments & Deliverables ${idOf('db-asg')}.csv`,
    csv(
      [
        'Assignment',
        'Type',
        'Class',
        'Semester',
        'Date',
        'Days Left',
        'Status',
        'Priority',
        'Final Grade',
        'Weight',
        'File',
        'Link',
        'Notes',
        'Quick Notes',
      ],
      rows,
    ),
  );
  put(
    `${HUB}/Assignments & Deliverables ${idOf('pg-asg')}.md`,
    `# Assignments & Deliverables\n\n${para()}\n`,
  );
  for (const a of assignments)
    put(
      pagePath('Assignments & Deliverables/Assignments & Deliverables', a.title, a.key),
      `# ${a.title}\n\nClass: ${clsOf(a.cls).title}\nStatus: ${a.status}\n\n${a.key === 'a7' ? para() : ''}\n`,
    );
  put(
    pagePath(
      'Assignments & Deliverables/Assignments & Deliverables',
      'Essay Template',
      'tpl-essay',
    ),
    `# Essay Template\n\n<aside>\n💡 Tooltip: lorem ipsum hint written by a template author.\n</aside>\n\n## Outline\n\n- \\[ \\] ${words(3)}\n- \\[ \\] ${words(3)}\n\n## Draft\n\n${words(8)}\n`,
  );
  put(
    pagePath('Assignments & Deliverables/Assignments & Deliverables', 'Group Project', 'tpl-group'),
    `# Group Project\n\n- [ ] ${words(3)}\n- [ ] ${words(3)}\n`,
  );
}
// ---------- Notebook ----------
const notebook = [
  {
    key: 'n1',
    title: 'Lecture 1 - Lorem Basics',
    cls: 'c1',
    date: 'September 3, 2031',
    related: ['a1'],
    body: () =>
      `## Key ideas\n\n${para()}\n\n| Term | Meaning |\n| --- | --- |\n| ${words(1)} | ${words(3)} |\n| ${words(1)} | ${words(3)} |\n\nInline equation $\`E = mc^2\`$ and a block:\n\n$$\n\\int_0^1 x^2\\,dx = \\tfrac{1}{3}\n$$\n\n\`\`\`python\nprint("lorem ipsum")\n\`\`\`\n\n<aside>\n📌 Remember: ${sentence()}\n</aside>\n\n<details>\n<summary>Toggle ${words(2)}</summary>\n\n${sentence()}\n\n</details>\n\n- \\[ \\] ${words(3)}\n- \\[x\\] ${words(3)}\n\n![Figure 1](${enc(`${HUB}/Notebook/Notebook/Figure 1.png`)})\n\nSee also [Lecture 2 - Ipsum Deep Dive](${enc(`${HUB}/Notebook/Notebook/Lecture 2 - Ipsum Deep Dive ${idOf('n2')}.md`)}).\n`,
  },
  {
    key: 'n2',
    title: 'Lecture 2 - Ipsum Deep Dive',
    cls: 'c2',
    date: 'September 10, 2031',
    related: [],
    body: () => `${para()}\n\n### Steps\n\n1. ${sentence()}\n2. ${sentence()}\n`,
  },
  { key: 'n3', title: 'Untitled', cls: '', date: '', related: [], body: () => '' },
  {
    key: 'n4',
    title: 'Default',
    cls: '',
    date: '',
    related: [],
    body: () => `<aside>\n💡 Tooltip: lorem ipsum default template hint.\n</aside>\n\n## Notes\n`,
  },
];
{
  const hdr = ['Title', 'Class', 'Date', 'Readings', 'Related Assignments', 'Semester'];
  const rows = notebook.map((n) => ({
    Title: n.title,
    Class: n.cls
      ? rel(clsOf(n.cls).title, pagePath('Classes/Classes', clsOf(n.cls).title, n.cls))
      : '',
    Date: n.date,
    Readings: '',
    'Related Assignments': n.related
      .map((k) => {
        const a = assignments.find((x) => x.key === k);
        return rel(
          a.title,
          pagePath('Assignments & Deliverables/Assignments & Deliverables', a.title, k),
        );
      })
      .join(', '),
    Semester: '',
  }));
  put(`${HUB}/Notebook/Notebook ${idOf('db-nb')}_all.csv`, csv(hdr, rows));
  put(
    `${HUB}/Notebook/Notebook ${idOf('db-nb')}.csv`,
    csv(['Title', 'Date', 'Class', 'Related Assignments', 'Semester', 'Readings'], rows),
  );
  put(`${HUB}/Notebook ${idOf('pg-nb')}.md`, `# Notebook\n\n${para()}\n`);
  for (const n of notebook)
    put(
      pagePath('Notebook/Notebook', n.title, n.key),
      `# ${n.title}\n\n${n.cls ? `Class: ${rel(clsOf(n.cls).title, 'x.md')}\n` : ''}${n.date ? `Date: ${n.date}\n` : ''}\n${n.body()}`,
    );
  put(
    `${HUB}/Notebook/Notebook/Figure 1.png`,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  put(
    `${HUB}/hub_logo2x.png`,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    ),
  ); // unreferenced decoy
}
// ---------- Readings / Tasks / Journal / CRM / Jobs / Budget ----------
put(
  `${HUB}/Reading Tracker/Readings ${idOf('db-rd')}_all.csv`,
  csv(
    [
      'Title',
      'Class',
      'Date Read',
      'Format',
      'Notes',
      'Pages Read',
      'Pgs Read [DISPLAY]',
      'Progress',
      'Quick Notes',
      'Status',
      'Total Pages',
      'Total Pgs [DISPLAY]',
    ],
    [
      {
        Title: 'Lorem Treatise',
        Class: rel('LOREM 101', pagePath('Classes/Classes', 'LOREM 101', 'c1')),
        'Date Read': '',
        Format: 'Library',
        'Pages Read': '40',
        'Pgs Read [DISPLAY]': '40',
        Progress: '20%',
        Status: 'Reading',
        'Total Pages': '200',
        'Total Pgs [DISPLAY]': '200',
      },
      {
        Title: 'Ipsum Anthology',
        Class: '',
        'Date Read': 'October 1, 2031',
        Format: 'Digital',
        'Pages Read': '90',
        'Pgs Read [DISPLAY]': '90',
        Progress: '100%',
        'Quick Notes': sentence(),
        Status: 'Complete',
        'Total Pages': '90',
        'Total Pgs [DISPLAY]': '90',
      },
    ],
  ),
);
put(`${HUB}/Tasks & Planner ${idOf('pg-tk')}.md`, `# Tasks & Planner\n\n${para()}\n`);
put(
  `${HUB}/Tasks & Planner/Tasks ${idOf('db-tk')}_all.csv`,
  csv(
    [
      'Task',
      'Class',
      'Date',
      'Deliverable',
      'Done',
      'Priority',
      'Target (Hrs)',
      'Actual (Hrs)',
      'Outcome',
    ],
    [
      {
        Task: 'Outline capstone',
        Class: 'IPSUM 202',
        Date: 'November 20, 2031',
        Deliverable: rel(
          'Capstone Draft',
          pagePath('Assignments & Deliverables/Assignments & Deliverables', 'Capstone Draft', 'a7'),
        ),
        Done: 'No',
        Priority: 'High',
        'Target (Hrs)': '3',
        'Actual (Hrs)': '',
        Outcome: '',
      },
      {
        Task: 'Review midterm notes',
        Class: 'LOREM 101',
        Date: 'October 15, 2031',
        Deliverable: '',
        Done: 'Yes',
        Priority: 'Medium',
        'Target (Hrs)': '2',
        'Actual (Hrs)': '2.5',
        Outcome: 'Over',
      },
      {
        Task: 'Tidy desk',
        Class: '',
        Date: '',
        Deliverable: '',
        Done: 'No',
        Priority: 'Low',
        'Target (Hrs)': '',
        'Actual (Hrs)': '',
        Outcome: '',
      },
    ],
  ),
);
put(
  `${HUB}/School Journal/School Journal ${idOf('db-jr')}_all.csv`,
  csv(
    ['Name', 'Date', 'Mood'],
    [
      { Name: 'Lorem day', Date: 'September 5, 2031', Mood: 'Happy, Focused' },
      { Name: 'Ipsum evening', Date: 'September 6, 2031', Mood: 'Tired' },
    ],
  ),
);
put(
  `${HUB}/School Journal/School Journal/Lorem day ${idOf('jr1')}.md`,
  `# Lorem day\n\nDate: September 5, 2031\nMood: Happy, Focused\n\n${para()}\n`,
);
put(
  `${HUB}/Student CRM/School CRM ${idOf('db-crm')}_all.csv`,
  csv(
    ['Name', 'Activities', 'Category', 'Class', 'Email', 'Notes', 'Phone'],
    [
      {
        Name: 'Pat Placeholder',
        Category: 'Instructor',
        Class: 'LOREM 101',
        Email: 'pat@example.invalid',
        Phone: '555-0100',
      },
      {
        Name: 'Sam Sample',
        Category: 'Instructor',
        Class: 'IPSUM 202',
        Email: 'sam@example.invalid',
        Phone: '555-0101',
      },
    ],
  ),
);
put(
  `${HUB}/Internships & Jobs/Internships & Job Applications ${idOf('db-jb')}_all.csv`,
  csv(
    ['Position', 'Company', 'Compensation', 'Priority', 'Status', 'Type', 'URL'],
    [
      {
        Position: 'Lorem Intern',
        Company: 'Example Co',
        Compensation: 'Unpaid',
        Priority: '',
        Status: 'Applied',
        Type: 'Internship',
        URL: 'https://example.invalid/job',
      },
    ],
  ),
);
put(
  `${HUB}/Simple Budget Tracker/Month ${idOf('db-bd')}_all.csv`,
  csv(
    ['Purchase', 'Category', 'Cost', 'Date', 'Receipt', 'Sentiment', 'Vendor'],
    [
      {
        Purchase: 'Notebook',
        Category: 'Supplies',
        Cost: '$4.50',
        Date: 'September 2, 2031',
        Sentiment: 'Worth it',
        Vendor: 'Example Shop',
      },
      {
        Purchase: 'Snack',
        Category: 'Food',
        Cost: '$2.00',
        Date: 'September 3, 2031',
        Sentiment: 'Meh',
        Vendor: 'Example Cafe',
      },
    ],
  ),
);
put(`${HUB}/Sample Checklist ${idOf('pg-pk')}.md`, `# Sample Checklist\n\n- ${words(2)}\n`);
put(`${HUB} ${idOf('hub')}.md`, `# ${HUB}\n\n${para()}\n`);

// ---------- write ----------
rmSync(OUT, { recursive: true, force: true });
for (const [p, c] of files) {
  const f = join(OUT, p);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, c);
}
writeFileSync(
  join(root, 'notion-export.expected.json'),
  JSON.stringify(
    {
      note: 'Expected importer results for fixtures/synthetic/notion-export (all data invented).',
      counts: {
        semesters: 3,
        classes: 5,
        assignments: 12,
        notes: 4,
        templates: 4,
        readings: 2,
        tasks: 3,
        attachments: 1,
      },
      parity: { mismatchClasses: ['DOLOR 150'], okClasses: ['LOREM 101', 'IPSUM 202'] },
    },
    null,
    2,
  ) + '\n',
);
console.log(`Wrote ${files.size} files to fixtures/synthetic/notion-export`);
