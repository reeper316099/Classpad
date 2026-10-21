import { describe, expect, it } from 'vitest';
import {
  buildIcs,
  csvTemplate,
  fold,
  openMemory,
  parseBackup,
  previewCsv,
  previewIcs,
  previewMarkdownFolder,
  toCsv,
  parseCsv,
} from './index.js';

describe('CSV import/export', () => {
  it('templates round-trip through the importer', () => {
    for (const c of ['semesters', 'classes', 'assignments', 'tasks', 'readings'] as const) {
      const p = previewCsv(csvTemplate(c), c);
      expect(p.warnings.filter((w) => w.code !== 'COLUMN')).toEqual([]);
      expect(p[c]).toHaveLength(1);
    }
  });
  it('maps aliases, percent and points scores, statuses and priorities', () => {
    const p = previewCsv(
      'Assignment,Course,Due Date,Weight,Grade,Points Possible,Status,Priority\nHW 1,Lorem Studies,2031-10-01,10%,45,50,Done,⚡ Mid\nHW 2,,,,,,,\n',
      'assignments',
    );
    expect(p.assignments[0]).toMatchObject({
      title: 'HW 1',
      due: '2031-10-01',
      weight: 10,
      status: 'complete',
      priority: 'mid',
      score: { percent: 90 },
    });
    expect(p.assignments[0]!.classRef).toBe('name:class:lorem studies');
    expect(p.assignments[1]!.status).toBe('not_started');
  });
  it('reports missing required columns, unknown columns and bad rows', () => {
    expect(previewCsv('foo,bar\n1,2\n', 'assignments').warnings[0]!.code).toBe('COLUMN');
    expect(previewCsv('foo\n1\n', 'assignments').warnings.map((w) => w.code)).toContain(
      'MISSING_COLUMN',
    );
    const p = previewCsv('title,due\n,2031-01-01\nX,not a date\n', 'assignments');
    expect(p.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['EMPTY_ROW', 'DATE']));
  });
  it('duplicate titles get distinct refs', () => {
    const p = previewCsv('title\nA\nA\n', 'tasks');
    expect(new Set(p.tasks.map((t) => t.ref)).size).toBe(2);
  });
  it('toCsv escapes quotes/newlines and neutralizes spreadsheet formulas', () => {
    const csv = toCsv(
      ['a', 'b'],
      [
        { a: 'x,"y"\nz', b: '=HYPERLINK("http://e")' },
        { a: '-5', b: '-sum' },
      ],
    );
    expect(csv).toContain('"x,""y""\nz"');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('\r\n-5,');
    expect(parseCsv(csv).rows[0]!.a).toBe('x,"y"\nz');
  });
});

describe('ICS', () => {
  const ics = buildIcs({
    now: new Date('2031-01-01T00:00:00Z'),
    deadlines: [
      {
        id: 'd1',
        title: 'Essay, draft; final',
        due: '2031-10-01',
        className: 'Lorem Studies',
        notes: 'line1\nline2',
      },
      { id: 'd2', title: 'Exam', due: '2031-10-20T09:00/2031-10-20T10:30' },
    ],
    meetings: [
      {
        classId: 'c1',
        className: 'Lorem Studies',
        day: 'wed',
        start: '09:15',
        end: '10:30',
        location: 'Hall 1',
        from: '2031-09-01',
        until: '2031-12-12',
      },
    ],
  });
  it('produces RFC-shaped output with CRLF and escaping', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('SUMMARY:Essay\\, draft\; final');
    expect(ics).toContain('DTSTART;VALUE=DATE:20311001');
    expect(ics).toContain('DTEND;VALUE=DATE:20311002');
    expect(ics).toContain('DTSTART:20310903T091500'); // first Wednesday on/after Sep 1 2031
    expect(ics).toContain('RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20311212T235959');
    expect(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  });
  it('folds long lines without splitting characters', () => {
    const folded = fold('DESCRIPTION:' + 'é'.repeat(100));
    expect(folded.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe('DESCRIPTION:' + 'é'.repeat(100));
  });
  it('export -> import round-trips deadlines as tasks or assignments', () => {
    const t = previewIcs(ics);
    expect(t.tasks.map((x) => x.title)).toEqual(['Essay, draft; final', 'Exam', 'Lorem Studies']);
    expect(t.tasks[0]).toMatchObject({ date: '2031-10-01' });
    expect(t.tasks[1]).toMatchObject({ date: '2031-10-20T09:00/2031-10-20T10:30' });
    expect(t.warnings.map((w) => w.code)).toContain('RECURRING');
    const a = previewIcs(ics, { as: 'assignments', className: 'Lorem Studies' });
    expect(a.assignments[0]!.classRef).toBe('name:class:lorem studies');
  });
  it('rejects garbage gracefully', () => {
    expect(previewIcs('not a calendar').warnings[0]!.code).toBe('ICS_PARSE');
  });
});

describe('Markdown folder', () => {
  const a = openMemory({
    'Lorem Studies/Intro.md':
      '---\ntitle: Intro Note\ntags: [alpha, "#beta"]\ndate: 2031-09-02\n---\nSee [[Other]] and ![[pic.png]]\n',
    'Lorem Studies/Other.md': '# Other Heading\n\nbody\n',
    'loose.md': 'plain',
    'assets/pic.png': Buffer.from([1, 2, 3]),
    '.obsidian/config.md': 'ignored',
  });
  const p = previewMarkdownFolder(a);
  it('maps folders to classes, reads frontmatter, keeps wiki-links, imports embeds', () => {
    expect(p.notes).toHaveLength(3);
    const intro = p.notes.find((n) => n.title === 'Intro Note')!;
    expect(intro).toMatchObject({ classRef: 'name:class:lorem studies', date: '2031-09-02' });
    expect(intro.tags).toEqual(['imported', 'alpha', 'beta']);
    expect(intro.markdown).toContain('[[Other]]');
    expect(intro.markdown).toContain('attachment-ref:assets/pic.png');
    expect(p.attachments).toEqual([{ archivePath: 'assets/pic.png', filename: 'pic.png' }]);
    expect(p.notes.find((n) => n.title === 'Other Heading')).toBeTruthy();
    expect(p.notes.find((n) => n.title === 'loose')!.classRef).toBeUndefined();
  });
  it('warns on bad frontmatter instead of failing', () => {
    const q = previewMarkdownFolder(openMemory({ 'x.md': '---\n: : :\n  - [\n---\nbody' }));
    expect(q.warnings.some((w) => w.code === 'FRONTMATTER')).toBe(true);
    expect(q.notes).toHaveLength(1);
  });
});

describe('JSON backup parsing', () => {
  it('validates the envelope', () => {
    expect(() => parseBackup('nope')).toThrow(/JSON/);
    expect(() => parseBackup('{"format":"x"}')).toThrow(/Classpad backup/);
    expect(() => parseBackup('{"format":"classpad-backup","schemaVersion":9}')).toThrow(/version/);
    expect(parseBackup('{"format":"classpad-backup","schemaVersion":1}').notes).toEqual([]);
  });
});
