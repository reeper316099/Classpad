import AdmZip from 'adm-zip';
import {
  toCsv,
  buildIcs,
  type CsvCollection,
  type IcsDeadline,
  type IcsMeeting,
  WEEKDAYS,
} from '@classpad/importers';
import { computeGrade, gpaReport, type Step } from '@classpad/grades';
import { stringifyFrontmatter, type Assignment, type ClassEntity } from '@classpad/shared';
import type { Context } from './context.js';
import { toEngineScheme, toGradeItem } from './grading.js';
import { extOf } from './attachments.js';
import { slugify, uniqueSlug } from './slug.js';

const DAY_NAME = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

export function exportCsv(ctx: Context, c: CsvCollection): string {
  const sem = (id?: string) => ctx.semesters.get(id ?? '')?.name ?? '';
  const cls = (id?: string) => ctx.classes.get(id ?? '')?.name ?? '';
  if (c === 'semesters')
    return toCsv(
      ['name', 'start', 'end'],
      ctx.semesters.list().map((s) => ({ name: s.name, start: s.start, end: s.end })),
    );
  if (c === 'classes') {
    return toCsv(
      [
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
      ctx.classes.list().map((k) => {
        const days = [...new Set(k.meetings.map((m) => m.day))].sort(
          (a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b),
        );
        const ranges = [...new Set(k.meetings.map((m) => `${m.start}-${m.end}`))];
        const times =
          ranges.length <= 1
            ? (ranges[0] ?? '')
            : k.meetings.map((m) => `${DAY_NAME[m.day]} ${m.start}-${m.end}`).join('\n');
        return {
          name: k.name,
          semester: sem(k.semesterId),
          code: k.code,
          credits: k.credits,
          type: k.type,
          delivery: k.delivery,
          days: days.map((d) => DAY_NAME[d]).join(', '),
          times,
          location: k.location,
          instructor: k.instructor,
        };
      }),
    );
  }
  if (c === 'assignments') {
    return toCsv(
      [
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
      ctx.assignments.list().map((a) => ({
        title: a.title,
        class: cls(a.classId),
        due: a.due,
        weight: a.weight,
        score: a.score ? ('percent' in a.score ? `${a.score.percent}%` : a.score.earned) : '',
        points_possible:
          a.pointsPossible ?? (a.score && 'earned' in a.score ? a.score.possible : ''),
        status: a.status,
        priority: a.priority,
        type: a.type.join(', '),
        link: a.link,
        notes: a.quickNotes,
      })),
    );
  }
  if (c === 'tasks')
    return toCsv(
      ['title', 'class', 'date', 'priority', 'done', 'target_hours', 'actual_hours'],
      ctx.tasks.list().map((t) => ({
        title: t.title,
        class: cls(t.classId),
        date: t.date,
        priority: t.priority,
        done: t.done ? 'yes' : 'no',
        target_hours: t.targetHours,
        actual_hours: t.actualHours,
      })),
    );
  return toCsv(
    ['title', 'class', 'status', 'format', 'total_pages', 'pages_read', 'date_read'],
    ctx.readings.list().map((r) => ({
      title: r.title,
      class: cls(r.classId),
      status: r.status,
      format: r.format,
      total_pages: r.totalPages,
      pages_read: r.pagesRead,
      date_read: r.dateRead,
    })),
  );
}

export function exportIcs(ctx: Context, kind: 'deadlines' | 'timetable' | 'all'): string {
  const deadlines: IcsDeadline[] = [];
  const meetings: IcsMeeting[] = [];
  if (kind !== 'timetable')
    for (const a of ctx.assignments.list())
      if (a.due)
        deadlines.push({
          id: a.id,
          title: a.title,
          due: a.due,
          className: ctx.classes.get(a.classId)?.name,
          notes: a.quickNotes,
        });
  if (kind !== 'deadlines')
    for (const c of ctx.classes.list()) {
      const sem = ctx.semesters.get(c.semesterId);
      const from = c.dates?.start ?? sem?.start;
      const until = c.dates?.end ?? sem?.end;
      if (!from || !until) continue;
      for (const m of c.meetings)
        meetings.push({
          classId: c.id,
          className: c.name,
          day: m.day,
          start: m.start,
          end: m.end,
          location: m.location ?? c.location,
          from,
          until,
        });
    }
  return buildIcs({ deadlines, meetings });
}

export function exportJson(ctx: Context) {
  return {
    format: 'classpad-backup',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    semesters: ctx.semesters.list(),
    classes: ctx.classes.list(),
    assignments: ctx.assignments.list(),
    tasks: ctx.tasks.list(),
    readings: ctx.readings.list(),
    notes: ctx.notes.list(),
    journal: ctx.journal.list(),
    contacts: ctx.contacts.list(),
    activities: ctx.activities.list(),
    jobs: ctx.jobs.list(),
    admissions: ctx.admissions.list(),
    budget: ctx.budget.list(),
    flashcards: ctx.cards.list(),
    attachments: ctx.attachments.list(),
    gradingSchemes: ctx.config.schemes,
    gpaScales: ctx.config.scales,
  };
}

/** A folder of Markdown notes (frontmatter + wiki-links) grouped by class, with referenced attachments. */
export async function exportMarkdownVault(ctx: Context): Promise<Buffer> {
  const zip = new AdmZip();
  const taken = new Map<string, Set<string>>();
  const addedAttachments = new Set<string>();
  for (const n of ctx.notes.list()) {
    const cls = ctx.classes.get(n.classId ?? '');
    const folder = cls ? slugify(cls.name) : '';
    const names = taken.get(folder) ?? new Set<string>();
    taken.set(folder, names);
    const file = uniqueSlug(slugify(n.title), names);
    names.add(file);
    let body = n.markdown;
    const up = folder ? '../' : '';
    for (const m of body.matchAll(/attachment:\/\/([0-9a-f]{64}\.[a-z0-9]{1,8})/g)) {
      const hash = m[1]!.split('.')[0]!;
      const att = ctx.attachments.list().find((a) => a.hash === hash);
      if (att && !addedAttachments.has(att.id)) {
        addedAttachments.add(att.id);
        zip.addFile(
          `attachments/${hash}.${extOf(att.path)}`,
          (await ctx.store.readBinary(att.path)) ?? Buffer.alloc(0),
        );
      }
    }
    body = body.replace(/attachment:\/\//g, `${up}attachments/`);
    const fm = {
      title: n.title,
      date: n.date,
      tags: n.tags,
      class: cls?.name,
      assignments: n.assignmentIds.map((id) => ctx.assignments.get(id)?.title).filter(Boolean),
      created: n.createdAt,
      updated: n.updatedAt,
    };
    zip.addFile(
      `${folder ? folder + '/' : ''}${file}.md`,
      Buffer.from(stringifyFrontmatter(body, fm)),
    );
  }
  return zip.toBuffer();
}

// ------------------------------ printable grade report ------------------------------
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const stepHtml = (s: Step) =>
  `<div class="step"><div class="lbl">${esc(s.label)}${s.value !== undefined ? ` <b>${esc(s.value)}</b>` : ''}${s.formula ? ` <code>${esc(s.formula)}</code>` : ''}</div>` +
  (s.terms?.length
    ? `<table><tr><th>Item</th><th>Score</th><th>Weight</th><th>Product</th><th></th></tr>${s.terms.map((t) => `<tr><td>${esc(t.label)}</td><td>${esc(t.score)}</td><td>${esc(t.weight)}</td><td>${esc(t.product)}</td><td>${esc(t.note)}</td></tr>`).join('')}</table>`
    : '') +
  (s.note ? `<div class="note">${esc(s.note)}</div>` : '') +
  '</div>';

export function gradeReportHtml(ctx: Context, opts: { hideGrades?: boolean } = {}): string {
  const sems = [...ctx.semesters.list()].sort((a, b) =>
    (b.start ?? '').localeCompare(a.start ?? ''),
  );
  const parts: string[] = [];
  const grade = (c: ClassEntity, asg: Assignment[]) =>
    computeGrade(toEngineScheme(ctx.config.scheme(c.gradingSchemeId), c), asg.map(toGradeItem));
  for (const s of sems) {
    parts.push(`<h2>${esc(s.name)}</h2>`);
    for (const c of ctx.classes.list().filter((x) => x.semesterId === s.id && !x.archived)) {
      const g = grade(
        c,
        ctx.assignments.list().filter((a) => a.classId === c.id),
      );
      parts.push(
        `<section class="class"><h3>${esc(c.name)}${c.code && c.code !== c.name ? ` <small>${esc(c.code)}</small>` : ''}<span class="grade">${g.status === 'none' ? esc(g.summary) : `${esc(g.percentRounded)}% · ${esc(g.letter)}`}</span></h3>` +
          `<div class="meta">${c.credits != null ? `${esc(c.credits)} credits · ` : ''}scheme: ${esc(ctx.config.scheme(c.gradingSchemeId).name)}</div>` +
          (g.status === 'graded'
            ? `<details open><summary>How this was calculated</summary>${g.steps.map(stepHtml).join('')}</details>`
            : '') +
          (g.warnings.length
            ? `<ul class="warn">${g.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
            : '') +
          '</section>',
      );
    }
  }
  const scale = ctx.config.scale(undefined);
  const courses = ctx.classes
    .list()
    .filter((c) => !c.archived)
    .map((c) => {
      const g = grade(
        c,
        ctx.assignments.list().filter((a) => a.classId === c.id),
      );
      return {
        id: c.id,
        name: c.name,
        semesterId: c.semesterId,
        credits: c.credits ?? null,
        letter: g.letter,
        honorsLevel: String(c.honorsLevel),
        passFail: c.passFail,
        includeInGpa: c.includeInGpa,
        courseKey: c.code,
      };
    });
  const rep = gpaReport(courses, scale);
  const row = (label: string, r: typeof rep.cumulative) =>
    `<tr><td>${esc(label)}</td><td>${esc(r.unweighted.gpa?.toDecimalPlaces(2) ?? '—')}</td><td>${esc(r.weighted.gpa?.toDecimalPlaces(2) ?? '—')}</td><td>${esc(r.unweighted.credits)}</td></tr>`;
  const transcript = `<h2>GPA</h2><table><tr><th></th><th>Unweighted</th><th>Weighted</th><th>Credits</th></tr>${rep.semesters.map((x) => row(ctx.semesters.get(x.semesterId)?.name ?? '—', x)).join('')}${row('Cumulative', rep.cumulative)}</table><div class="note">Scale: ${esc(scale.name)}. Each figure is the credit-weighted average of class grade points.</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Grade report</title><style>
  body{font:14px/1.5 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#111}h1{margin-bottom:0}h3{display:flex;justify-content:space-between;margin:1.2rem 0 .2rem}
  .grade{font-weight:700}.meta,.note{color:#555;font-size:12px}table{border-collapse:collapse;width:100%;margin:.4rem 0}td,th{border-bottom:1px solid #ddd;text-align:left;padding:.25rem .5rem}
  .class{break-inside:avoid}.warn{color:#8a5a00}code{background:#f3f3f3;padding:0 .25rem}${opts.hideGrades ? '.grade,td,code,b{filter:blur(6px)}' : ''}@media print{details>summary{display:none}}</style></head><body>
  <h1>Grade report</h1><div class="note">Generated ${esc(new Date().toISOString().slice(0, 10))} by Classpad. Print this page to save as PDF.</div>${parts.join('')}${transcript}</body></html>`;
}
