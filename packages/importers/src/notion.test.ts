import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import {
  openDir,
  openMemory,
  openZip,
  previewNotion,
  convertNotionMarkdown,
  detectKind,
} from './index.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/synthetic');
const expected = JSON.parse(readFileSync(path.join(FIX, 'notion-export.expected.json'), 'utf8'));
const preview = () =>
  previewNotion(openDir(path.join(FIX, 'notion-export')), { today: '2031-10-01' });

describe('synthetic Notion export', () => {
  const p = preview();
  it('finds everything the generator wrote', () => {
    for (const [k, n] of Object.entries(expected.counts))
      expect((p as never as Record<string, unknown[]>)[k]).toHaveLength(n as number);
  });
  it('prefers *_all CSVs and skips embedded per-class views', () => {
    const chosen = p.mapping.filter((m) => m.chosen);
    expect(
      chosen.every(
        (m) =>
          /_all\.csv$/.test(m.file) ||
          !p.mapping.some((o) => o.kind === m.kind && o !== m && /_all/.test(o.file)),
      ),
    ).toBe(true);
    expect(p.mapping.filter((m) => !m.chosen).length).toBeGreaterThanOrEqual(4);
    expect(p.assignments).toHaveLength(12); // not 12 + embedded copies
  });
  it('resolves relations to typed references', () => {
    const lorem = p.classes.find((c) => c.name === 'LOREM 101')!;
    expect(lorem.semesterRef).toBe(p.semesters[0]!.ref);
    expect(p.assignments.filter((a) => a.classRef === lorem.ref)).toHaveLength(3);
    const lecture = p.notes.find((n) => n.title.startsWith('Lecture 1'))!;
    expect(lecture.classRef).toBe(lorem.ref);
    expect(lecture.assignmentRefs).toEqual([p.assignments[0]!.ref]);
    expect(p.tasks[0]!.assignmentRef).toBe(
      p.assignments.find((a) => a.title === 'Capstone Draft')!.ref,
    );
  });
  it('parses times, days, percents, option marks and dates', () => {
    const ipsum = p.classes.find((c) => c.name === 'IPSUM 202')!;
    expect(ipsum.meetings).toEqual([
      { day: 'tue', start: '10:00', end: '11:15' },
      { day: 'thu', start: '13:00', end: '14:15' },
    ]);
    expect(ipsum.rawTimes).toContain('\n');
    const mid = p.assignments.find((a) => a.title === 'Midterm Exam')!;
    expect(mid).toMatchObject({
      priority: 'important',
      priorityLabel: '🔥 Important',
      weight: 30,
      score: { percent: 80 },
      due: '2031-10-20T09:00',
    });
    expect(p.assignments.find((a) => a.title === 'Group Presentation')!.due).toBe(
      '2031-11-05/2031-11-06',
    );
    expect(p.assignments.find((a) => a.title === 'Lab Report')!.type).toEqual([
      'essay',
      'in_class',
    ]);
    expect(p.assignments.find((a) => a.title === 'Project Pitch')!.priority).toBeUndefined();
    expect(p.classes.find((c) => c.name === 'AMET 310')).toMatchObject({
      credits: undefined,
      type: undefined,
    });
  });
  it('marks the current semester and warns on suspicious ranges', () => {
    expect(p.semesters.find((s) => s.name === 'Autumn Block A')!.isCurrent).toBe(true);
    expect(p.semesters.find((s) => s.name === 'Sandbox Term')!.isCurrent).toBe(false);
    expect(p.warnings.some((w) => w.code === 'DATES')).toBe(true);
    expect(p.warnings.some((w) => w.code === 'CREDITS')).toBe(true);
  });
  it('converts bodies: math, callouts, toggles, tasks, wiki-links, images, tooltips dropped', () => {
    const md = p.notes.find((n) => n.title.startsWith('Lecture 1'))!.markdown;
    expect(md).toContain('$E = mc^2$');
    expect(md).toContain('\\int_0^1');
    expect(md).toContain('> 📌 Remember');
    expect(md).toMatch(/<details>\n<summary>Toggle [^<]+<\/summary>/); // toggles stay collapsible
    expect(md).toMatch(/- \[ \] /);
    expect(md).toMatch(/- \[x\] /);
    expect(md).not.toContain('\\[');
    expect(md).toContain('[[Lecture 2 - Ipsum Deep Dive]]');
    expect(md).toMatch(/!\[Figure 1\]\(attachment-ref:/);
    expect(md).not.toMatch(/<aside|Class:|Date:/);
    expect(p.attachments.map((a) => a.filename)).toEqual(['Figure 1.png']); // logo decoy is not imported
    for (const t of p.templates) expect(t.markdown).not.toMatch(/Tooltip|template author/i);
  });
  it('assignments whose class lives outside the export are kept and flagged', () => {
    const stray = p.assignments.find((a) => a.title === 'Stray Worksheet')!;
    expect(stray.classRef).toBeUndefined();
    expect(
      p.warnings.some((w) => w.code === 'RELATION' && /outside the export/.test(w.message)),
    ).toBe(true);
  });
  it('links to embedded database views are dropped without warnings', () => {
    const md = p.notes.find((n) => n.title === 'LOREM 101 page')!.markdown;
    expect(md).not.toMatch(/\.csv|Assignments view/);
    expect(p.warnings.some((w) => w.code === 'BODY')).toBe(false);
  });
  it('imports template pages as templates, not entries', () => {
    expect(p.templates.map((t) => `${t.kind}:${t.name}`).sort()).toEqual([
      'assignments:Essay Template',
      'assignments:Group Project',
      'classes:New Class',
      'notes:Default',
    ]);
    expect(p.assignments.some((a) => /template/i.test(a.title))).toBe(false);
    const essay = p.templates.find((t) => t.name === 'Essay Template')!;
    expect(essay.markdown).toContain('- [ ]');
  });
  it('imports journal, contacts, jobs and budget (previously skipped)', () => {
    expect(p.journal.map((j) => [j.title, j.date, j.mood])).toEqual([
      ['Lorem day', '2031-09-05', ['happy', 'focused']],
      ['Ipsum evening', '2031-09-06', ['tired']],
    ]);
    expect(p.journal[0]!.markdown.length).toBeGreaterThan(20); // page body merged in, property header lines removed
    expect(p.journal[0]!.markdown).not.toMatch(/Mood:|Date:/);
    expect(p.contacts).toHaveLength(2);
    expect(p.contacts[0]).toMatchObject({
      name: 'Pat Placeholder',
      role: 'Instructor',
      email: 'pat@example.invalid',
      phone: '555-0100',
    });
    expect(p.contacts[0]!.classRefs).toEqual([p.classes.find((c) => c.name === 'LOREM 101')!.ref]);
    expect(p.jobs).toEqual([
      expect.objectContaining({
        position: 'Lorem Intern',
        company: 'Example Co',
        status: 'applied',
        type: 'internship',
      }),
    ]);
    expect(p.budget.map((b) => [b.purchase, b.cost, b.type, b.date])).toEqual([
      ['Notebook', 4.5, 'expense', '2031-09-02'],
      ['Snack', 2, 'expense', '2031-09-03'],
    ]);
    expect(p.skipped.map((s) => s.kind)).toEqual(['pages']); // only hub/module pages outside the databases remain
  });
  it('validation report: parity ok, deliberate mismatch listed, blanks handled', () => {
    const by = Object.fromEntries(p.validation.map((v) => [v.className, v.status]));
    for (const n of expected.parity.okClasses) expect(by[n]).toBe('ok');
    for (const n of expected.parity.mismatchClasses) expect(by[n]).toBe('mismatch');
    expect(by['AMET 310']).toBe('both-empty');
  });
  it('is deterministic and identical via zip', () => {
    const zip = new AdmZip();
    const dir = openDir(path.join(FIX, 'notion-export'));
    for (const f of dir.files) zip.addFile(f, dir.read(f));
    const viaZip = previewNotion(openZip(zip.toBuffer()), { today: '2031-10-01' });
    expect(JSON.stringify(viaZip)).toBe(JSON.stringify(preview()));
  });
});

describe('body converter and detection edge cases', () => {
  const ctx = {
    pagePath: 'a/b.md',
    propertyNames: new Set(['class']),
    hasFile: () => false,
    dropTooltips: true,
  };
  it('keeps non-tooltip callouts, drops tooltips, and keeps body lines that look like properties but are not', () => {
    const r = convertNotionMarkdown(
      '# T\n\nClass: x\n\nNote: keep me\n\n<aside>\n💡 Tip: hide\n</aside>\n\n<aside>\n⚠️ Real warning\n</aside>\n',
      ctx,
    );
    expect(r.markdown).toContain('Note: keep me');
    expect(r.markdown).not.toContain('Class: x');
    expect(r.markdown).not.toContain('hide');
    expect(r.markdown).toContain('> ⚠️ Real warning');
    expect(r.droppedTooltips).toBe(1);
  });
  it('can keep tooltips when asked', () => {
    expect(
      convertNotionMarkdown('<aside>\n💡 Tip: hello\n</aside>', { ...ctx, dropTooltips: false })
        .markdown,
    ).toContain('> 💡 Tip: hello');
  });
  it('warns on unresolved relative files', () => {
    expect(convertNotionMarkdown('![x](missing.png)', ctx).warnings.length).toBe(1);
  });
  it('detects database kinds from headers only', () => {
    expect(detectKind(['Assignment', 'Weight'])).toBe('assignments');
    expect(detectKind(['Class', 'Credits'])).toBe('classes');
    expect(detectKind(['Semester', 'Dates', 'Classes'])).toBe('semesters');
    expect(detectKind(['Foo', 'Bar'])).toBeNull();
  });
  it('an export with no databases warns instead of crashing', () => {
    const p = previewNotion(openMemory({ 'readme.txt': 'hi' }));
    expect(p.warnings[0]!.code).toBe('NO_DATABASES');
  });
});
