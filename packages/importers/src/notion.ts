import { computeGrade, defaultScheme, type GradeItem } from '@classpad/grades';
import type { Archive } from './archive.js';
import { parseCsv, type Table } from './csv.js';
import { convertNotionMarkdown } from './notionBody.js';
import {
  formatInterval,
  normalizePriority,
  normalizeTaskPriority,
  normTitle,
  parseBool,
  parseDays,
  parseNotionDate,
  parseNumber,
  parsePercent,
  parseRelation,
  parseTimes,
  slugOption,
  splitMulti,
  splitName,
  cleanLabel,
  type RelationRef,
} from './parse.js';
import {
  emptyPreview,
  type DraftAssignment,
  type DraftClass,
  type DraftNote,
  type ImportPreview,
  type MappingEntry,
  type Warning,
} from './types.js';

type Kind =
  | 'semesters'
  | 'classes'
  | 'assignments'
  | 'notebook'
  | 'readings'
  | 'tasks'
  | 'journal'
  | 'contacts'
  | 'jobs'
  | 'budget';

const lc = (a: string[]) => new Set(a.map((x) => x.trim().toLowerCase()));

export function detectKind(fields: string[]): Kind | null {
  const h = lc(fields);
  const has = (...k: string[]) => k.every((x) => h.has(x));
  if (has('assignment') && (h.has('weight') || h.has('final grade') || h.has('priority')))
    return 'assignments';
  if (has('class') && (h.has('credits') || h.has('times') || h.has('days'))) return 'classes';
  if (has('semester', 'dates') && !h.has('class')) return 'semesters';
  if (has('task') && (h.has('target (hrs)') || h.has('actual (hrs)') || h.has('done')))
    return 'tasks';
  if (h.has('total pages') || h.has('pages read')) return 'readings';
  if (has('mood')) return 'journal';
  if (has('title') && (h.has('related assignments') || h.has('readings'))) return 'notebook';
  if (has('position', 'company')) return 'jobs';
  if (has('purchase') && h.has('cost')) return 'budget';
  if (has('name') && (h.has('phone') || h.has('email'))) return 'contacts';
  return null;
}

const COLUMNS: Record<Kind, { used: string[]; computed: string[] }> = {
  semesters: {
    used: ['semester', 'dates'],
    computed: ['average grade', 'credits', 'classes', 'activities'],
  },
  classes: {
    used: [
      'class',
      'semester',
      'type',
      'category',
      'credits',
      'days',
      'times',
      'location',
      'dates',
      'syllabus',
      'quick notes',
      'contacts',
    ],
    computed: [
      '% grade',
      'grade (#)',
      'letter grade',
      'weight sum',
      'weighted grade sum',
      'active to-dos',
      'assignments',
      'notes',
      'readings',
    ],
  },
  assignments: {
    used: [
      'assignment',
      'class',
      'type',
      'status',
      'priority',
      'date',
      'weight',
      'final grade',
      'link',
      'file',
      'quick notes',
    ],
    computed: ['days left', 'impact weight', 'weighted grade', 'semester', 'notes'],
  },
  notebook: {
    used: ['title', 'class', 'date', 'readings', 'related assignments'],
    computed: ['semester'],
  },
  readings: {
    used: [
      'title',
      'class',
      'status',
      'format',
      'total pages',
      'pages read',
      'date read',
      'quick notes',
    ],
    computed: ['progress', 'pgs read [display]', 'total pgs [display]', 'notes'],
  },
  tasks: {
    used: [
      'task',
      'deliverable',
      'class',
      'date',
      'priority',
      'done',
      'target (hrs)',
      'actual (hrs)',
    ],
    computed: ['outcome'],
  },
  journal: { used: [], computed: [] },
  contacts: { used: [], computed: [] },
  jobs: { used: [], computed: [] },
  budget: { used: [], computed: [] },
};
const COLORS = [
  '#6366f1',
  '#ec4899',
  '#10b981',
  '#f59e0b',
  '#06b6d4',
  '#8b5cf6',
  '#ef4444',
  '#84cc16',
];
const TEMPLATE_NAME = /template|^(new class|default|new note|new entry|new page)$/i;
const MODULE_NOTES: Partial<Record<Kind, string>> = {
  journal: 'Journal module is not available yet; re-importing later will pick these up',
  contacts: 'Contacts module is not available yet',
  jobs: 'Internships & jobs module is not available yet',
  budget: 'Budget module is not available yet',
};

interface Csv {
  path: string;
  dir: string;
  isAll: boolean;
  kind: Kind;
  table: Table;
}

export interface NotionOptions {
  today?: string;
  dropTooltips?: boolean;
}

export function previewNotion(archive: Archive, opts: NotionOptions = {}): ImportPreview {
  const out = emptyPreview('notion');
  const warn = (code: string, message: string, where?: string) =>
    out.warnings.push({ code, message, where } as Warning);
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const dropTooltips = opts.dropTooltips ?? true;
  const safe = (p: string) => p.replace(/\s[0-9a-f]{32}/g, '');

  // ---- find and choose databases ----
  const csvs: Csv[] = [];
  for (const f of archive.files.filter((x) => /\.csv$/i.test(x))) {
    const table = parseCsv(archive.read(f).toString('utf8'));
    const kind = detectKind(table.fields);
    const parts = f.split('/');
    const sn = splitName(parts[parts.length - 1]!);
    if (kind)
      csvs.push({
        path: f,
        dir: parts.slice(0, -1).join('/'),
        isAll: sn.suffix.toLowerCase().startsWith('_all'),
        kind,
        table,
      });
  }
  const chosen = new Map<Kind, Csv>();
  const byKind = new Map<Kind, Csv[]>();
  for (const c of csvs) byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c]);
  for (const [kind, list] of byKind) {
    list.sort(
      (a, b) =>
        Number(b.isAll) - Number(a.isAll) ||
        a.dir.split('/').length - b.dir.split('/').length ||
        b.table.rows.length - a.table.rows.length,
    );
    chosen.set(kind, list[0]!);
    for (const c of list) {
      const cols = COLUMNS[kind];
      const f = c.table.fields.map((x) => x.toLowerCase());
      out.mapping.push({
        file: safe(c.path),
        kind,
        chosen: c === list[0],
        rows: c.table.rows.length,
        used: f.filter((x) => cols.used.includes(x)),
        computed: f.filter((x) => cols.computed.includes(x)),
        ignored: f.filter((x) => !cols.used.includes(x) && !cols.computed.includes(x)),
        note:
          c === list[0]
            ? undefined
            : 'duplicate or embedded view; skipped in favour of the main database',
      } satisfies MappingEntry);
    }
  }
  if (!chosen.size)
    warn('NO_DATABASES', 'No recognizable databases (CSV files) found in this export');

  // ---- page index ----
  interface Page {
    path: string;
    title: string;
    id?: string;
    dir: string;
  }
  const pages: Page[] = archive.files
    .filter((f) => /\.md$/i.test(f))
    .map((p) => {
      const parts = p.split('/');
      const sn = splitName(parts[parts.length - 1]!.replace(/\.md$/i, ''));
      return { path: p, title: cleanLabel(sn.base), id: sn.id, dir: parts.slice(0, -1).join('/') };
    });
  const pageById = new Map(pages.filter((p) => p.id).map((p) => [p.id!, p]));
  const usedPages = new Set<string>();
  const pageFor = (dbDir: string, title: string, relId?: string): Page | undefined => {
    if (relId && pageById.has(relId)) return pageById.get(relId);
    const n = normTitle(title);
    const c = pages.filter((p) => normTitle(p.title) === n);
    return (
      c.find((p) => p.dir.startsWith(dbDir) || p.dir === dbDir) ??
      c.find((p) => p.dir.includes(dbDir.split('/').pop() ?? '\0'))
    );
  };

  // ---- reference registry ----
  const registry = new Map<string, string>();
  const refs = new Set<string>();
  const mkRef = (kind: string, title: string, id: string | undefined, scope = ''): string => {
    const base = `notion:${kind}:${id ?? '-'}:${normTitle(title)}${scope ? `@${normTitle(scope)}` : ''}`;
    let r = base;
    for (let n = 2; refs.has(r); n++) r = `${base}#${n}`;
    refs.add(r);
    if (id) registry.set(`${kind}|id|${id}`, r);
    if (!registry.has(`${kind}|t|${normTitle(title)}`))
      registry.set(`${kind}|t|${normTitle(title)}`, r);
    return r;
  };
  const resolve = (kind: string, rel: RelationRef): string | undefined =>
    (rel.id && registry.get(`${kind}|id|${rel.id}`)) ||
    registry.get(`${kind}|t|${normTitle(rel.title)}`);

  const propNames = new Set(csvs.flatMap((c) => c.table.fields.map((f) => f.toLowerCase())));
  const body = (page: Page | undefined) => {
    if (!page) return { markdown: '', attachments: [] as string[] };
    usedPages.add(page.path);
    const r = convertNotionMarkdown(archive.read(page.path).toString('utf8'), {
      pagePath: page.path,
      propertyNames: propNames,
      hasFile: (p) => archive.has(p),
      dropTooltips,
    });
    for (const w of r.warnings) warn('BODY', w, safe(page.path));
    for (const a of r.attachments)
      if (!out.attachments.some((x) => x.archivePath === a))
        out.attachments.push({ archivePath: a, filename: a.split('/').pop()! });
    return r;
  };
  const baseIndex = new Map<string, string[]>();
  for (const f of archive.files)
    baseIndex.set(f.split('/').pop()!, [...(baseIndex.get(f.split('/').pop()!) ?? []), f]);
  /** Resolve file-cell entries ("a.pdf, b.png", optionally with paths) to archive paths. */
  const findFiles = (cell: string, dir: string): string[] => {
    const found: string[] = [];
    for (const raw of cell
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)) {
      const tok = raw.replace(/\s*\([^)]*\)\s*$/, '');
      let dec = tok;
      try {
        dec = decodeURIComponent(tok);
      } catch {
        /* keep */
      }
      const hit =
        [dec, `${dir}/${dec}`].find((c) => archive.has(c)) ??
        baseIndex.get(dec.split('/').pop()!)?.[0];
      if (hit) found.push(hit);
      else warn('FILE', `Attachment "${dec}" is not in the export; skipped`, 'Assignments');
    }
    return found;
  };
  const tzSeen = new Set<string>();
  const date = (cell: string, where: string) => {
    const d = parseNotionDate(cell);
    if (!d && cell.trim()) warn('DATE', `Unreadable date "${cell}"`, where);
    if (d?.timezoneLabel && !tzSeen.has(where)) {
      tzSeen.add(where);
      warn(
        'TIMEZONE',
        `Time zone labels (${d.timezoneLabel}) are ignored; local wall time kept`,
        where,
      );
    }
    return d;
  };

  // ---- semesters ----
  const semCsv = chosen.get('semesters');
  for (const r of semCsv?.table.rows ?? []) {
    const name = cleanLabel(r['Semester'] ?? '');
    if (!name) continue;
    const page = pageFor(semCsv!.dir, name);
    const d = date(r['Dates'] ?? '', `Semesters: ${name}`);
    const b = page ? body(page).markdown : '';
    const goals = b
      .split('\n')
      .map((l) => /^\s*[-*]\s+(?:\[[ x]\]\s*)?(.+)$/.exec(l)?.[1]?.trim())
      .filter((x): x is string => !!x);
    if (d?.end && d.end < d.start)
      warn('DATES', `Semester "${name}" ends before it starts`, 'Semesters');
    else if (d?.end && (Date.parse(d.end) - Date.parse(d.start)) / 86400000 > 400)
      warn(
        'DATES',
        `Semester "${name}" spans more than a year (${d.start.slice(0, 10)} to ${d.end.slice(0, 10)}); check the dates`,
        'Semesters',
      );
    out.semesters.push({
      ref: mkRef('semester', name, page?.id),
      name,
      start: d?.start.slice(0, 10),
      end: d?.end?.slice(0, 10),
      goals,
      isCurrent:
        !!d &&
        d.start.slice(0, 10) <= today &&
        (d.end ?? d.start).slice(0, 10) >= today &&
        !(d.end && (Date.parse(d.end) - Date.parse(d.start)) / 86400000 > 400),
    });
  }

  // ---- classes ----
  const clsCsv = chosen.get('classes');
  const classRows = clsCsv?.table.rows ?? [];
  const classExported = new Map<string, string>();
  classRows.forEach((r, idx) => {
    const name = cleanLabel(r['Class'] ?? '');
    if (!name) return;
    const where = `Classes: ${name}`;
    const page = pageFor(clsCsv!.dir, name);
    const sem = parseRelation(r['Semester'])[0];
    const days = parseDays(r['Days'] ?? '');
    const times = (r['Times'] ?? '').trim();
    const tr = parseTimes(times, days);
    for (const w of times ? tr.warnings : []) warn('TIMES', w, where);
    const dates = date(r['Dates'] ?? '', where);
    const credits = parseNumber(r['Credits']);
    const cat = slugOption(r['Category'] ?? '');
    const contacts = parseRelation(r['Contacts'])
      .map((c) => c.title)
      .filter(Boolean);
    const c: DraftClass = {
      ref: mkRef('class', name, page?.id),
      name,
      color: COLORS[idx % COLORS.length]!,
      semesterRef: sem ? resolve('semester', sem) : undefined,
      code: /^[A-Za-z]{2,8}\s?-?\s?\d{2,4}[A-Za-z]?$/.test(name) ? name : undefined,
      type: slugOption(r['Type'] ?? '') || undefined,
      delivery: cat === 'in_person' || cat === 'online' || cat === 'hybrid' ? cat : undefined,
      credits: credits ?? undefined,
      instructor: contacts.join(', ') || undefined,
      location: (r['Location'] ?? '').trim() || undefined,
      meetings: tr.meetings,
      rawTimes: times || undefined,
      dates: dates?.end
        ? { start: dates.start.slice(0, 10), end: dates.end.slice(0, 10) }
        : undefined,
      quickNotes: (r['Quick Notes'] ?? '').trim() || undefined,
      syllabusPath:
        parseRelation(r['Syllabus'])[0]?.path ?? ((r['Syllabus'] ?? '').trim() || undefined),
    };
    if (cat && !c.delivery) warn('OPTION', `Unknown delivery "${r['Category']}"`, where);
    if (sem && !c.semesterRef) warn('RELATION', `Semester "${sem.title}" not found`, where);
    if (credits === null)
      warn(
        'CREDITS',
        'No credits set; this class will be left out of GPA until credits are added',
        where,
      );
    out.classes.push(c);
    if ((r['% Grade'] ?? '').trim() || true) classExported.set(c.ref, r['% Grade'] ?? '');
    const b = body(page);
    if (b.markdown.trim())
      out.notes.push({
        ref: mkRef('note', `${name} page`, page?.id),
        title: `${name} page`,
        classRef: c.ref,
        markdown: b.markdown,
        tags: ['imported'],
        assignmentRefs: [],
        readingRefs: [],
      });
    if (c.syllabusPath && !archive.has(c.syllabusPath)) c.syllabusPath = undefined;
    else if (c.syllabusPath)
      out.attachments.push({
        archivePath: c.syllabusPath,
        filename: c.syllabusPath.split('/').pop()!,
      });
  });

  // ---- assignments ----
  const asgCsv = chosen.get('assignments');
  const classTitleToRef = (rel?: RelationRef) => (rel ? resolve('class', rel) : undefined);
  for (const r of asgCsv?.table.rows ?? []) {
    const title = cleanLabel(r['Assignment'] ?? '');
    if (!title) continue;
    const classRel = parseRelation(r['Class'])[0];
    const where = `Assignments: ${title}`;
    const page = pageFor(asgCsv!.dir, title);
    const st = slugOption(r['Status'] ?? '');
    const status =
      st === 'complete' || st === 'done'
        ? 'complete'
        : st === 'in_progress'
          ? 'in_progress'
          : 'not_started';
    if (st && !['complete', 'done', 'in_progress', 'not_started'].includes(st))
      warn('OPTION', `Unknown status "${r['Status']}"`, where);
    const pri = normalizePriority(r['Priority']);
    if ((r['Priority'] ?? '').trim() && !pri)
      warn('OPTION', `Unknown priority "${cleanLabel(r['Priority']!)}"`, where);
    const d = date(r['Date'] ?? '', where);
    const weight = parsePercent(r['Weight']);
    const grade = parsePercent(r['Final Grade']);
    if ((r['Weight'] ?? '').trim() && weight === null)
      warn('PERCENT', `Unreadable weight "${r['Weight']}"`, where);
    const files = findFiles(r['File'] ?? '', asgCsv!.dir);
    const a: DraftAssignment = {
      ref: mkRef('assignment', title, page?.id, classRel?.title),
      title,
      classRef: classTitleToRef(classRel),
      type: splitMulti(r['Type']).map(slugOption).filter(Boolean),
      status,
      priority: pri?.value,
      priorityLabel: pri?.label,
      due: d ? formatInterval(d) : undefined,
      weight: weight ?? undefined,
      score: grade === null ? undefined : { percent: grade },
      link: (r['Link'] ?? '').trim() || undefined,
      quickNotes: (r['Quick Notes'] ?? '').trim() || undefined,
      filePaths: files,
    };
    for (const f of files)
      if (!out.attachments.some((x) => x.archivePath === f))
        out.attachments.push({ archivePath: f, filename: f.split('/').pop()! });
    if (classRel && !a.classRef)
      warn(
        'RELATION',
        classRel.url
          ? 'Class relation points to a page outside the export; it will go to the Unassigned class'
          : `Class "${classRel.title}" not found; it will go to the Unassigned class`,
        where,
      );
    else if (!classRel) warn('RELATION', 'No class set; it will go to the Unassigned class', where);
    out.assignments.push(a);
    const b = body(page);
    if (b.markdown.trim())
      out.notes.push({
        ref: mkRef('note', `${title} page`, page?.id, classRel?.title),
        title: `${title} page`,
        classRef: a.classRef,
        markdown: b.markdown,
        tags: ['imported'],
        assignmentRefs: [a.ref],
        readingRefs: [],
      });
  }

  // ---- readings ----
  const rdCsv = chosen.get('readings');
  for (const r of rdCsv?.table.rows ?? []) {
    const title = cleanLabel(r['Title'] ?? '');
    if (!title) continue;
    const classRel = parseRelation(r['Class'])[0];
    const s = slugOption(r['Status'] ?? '');
    const d = date(r['Date Read'] ?? '', `Readings: ${title}`);
    const page = pageFor(rdCsv!.dir, title);
    out.readings.push({
      ref: mkRef('reading', title, page?.id),
      title,
      classRef: classTitleToRef(classRel),
      status: s === 'complete' ? 'complete' : s === 'reading' ? 'reading' : 'to_read',
      format: slugOption(r['Format'] ?? '') || undefined,
      totalPages: parseNumber(r['Total Pages']) ?? undefined,
      pagesRead: parseNumber(r['Pages Read']) ?? undefined,
      dateRead: d?.start.slice(0, 10),
      quickNotes: (r['Quick Notes'] ?? '').trim() || undefined,
    });
    const b = body(page);
    if (b.markdown.trim())
      out.notes.push({
        ref: mkRef('note', `${title} page`, page?.id, 'reading'),
        title: `${title} page`,
        classRef: classTitleToRef(classRel),
        markdown: b.markdown,
        tags: ['imported'],
        assignmentRefs: [],
        readingRefs: [out.readings[out.readings.length - 1]!.ref],
      });
  }

  // ---- tasks ----
  const tkCsv = chosen.get('tasks');
  for (const r of tkCsv?.table.rows ?? []) {
    const title = cleanLabel(r['Task'] ?? '');
    if (!title) continue;
    const deliv = parseRelation(r['Deliverable'])[0];
    const classRel = parseRelation(r['Class'])[0];
    const d = date(r['Date'] ?? '', `Tasks: ${title}`);
    out.tasks.push({
      ref: mkRef('task', title, undefined, r['Date']),
      title,
      assignmentRef: deliv ? resolve('assignment', deliv) : undefined,
      classRef: classRel
        ? (resolve('class', classRel) ??
          out.classes.find((c) => normTitle(c.name) === normTitle(classRel.title))?.ref)
        : undefined,
      date: d ? formatInterval(d) : undefined,
      priority: normalizeTaskPriority(r['Priority']) ?? 'medium',
      done: parseBool(r['Done']),
      targetHours: parseNumber(r['Target (Hrs)']) ?? undefined,
      actualHours: parseNumber(r['Actual (Hrs)']) ?? undefined,
    });
  }

  // ---- notebook ----
  const nbCsv = chosen.get('notebook');
  for (const r of nbCsv?.table.rows ?? []) {
    const title = cleanLabel(r['Title'] ?? '');
    if (!title) continue;
    const page = pageFor(nbCsv!.dir, title);
    if (TEMPLATE_NAME.test(title)) continue; // handled as template below
    const b = body(page);
    const classRel = parseRelation(r['Class'])[0];
    if (!b.markdown.trim() && !classRel) {
      warn('EMPTY_PAGE', `Skipped empty page "${title}"`, 'Notebook');
      continue;
    }
    const d = date(r['Date'] ?? '', `Notebook: ${title}`);
    out.notes.push({
      ref: mkRef('note', title, page?.id, classRel?.title),
      title,
      classRef: classTitleToRef(classRel),
      date: d?.start.slice(0, 10),
      markdown: b.markdown,
      tags: ['imported'],
      assignmentRefs: parseRelation(r['Related Assignments'])
        .map((x) => resolve('assignment', x))
        .filter((x): x is string => !!x),
      readingRefs: parseRelation(r['Readings'])
        .map((x) => resolve('reading', x))
        .filter((x): x is string => !!x),
    } satisfies DraftNote);
  }

  // ---- templates: pages in a database's folder that are not rows (or are named like templates) ----
  const tplOwners: {
    kind: Kind;
    pageDir: string;
    target: 'notes' | 'assignments' | 'classes';
    titles: Set<string>;
    titleCol: string;
  }[] = [];
  for (const [kind, c] of chosen) {
    if (!['classes', 'assignments', 'notebook', 'readings', 'tasks'].includes(kind)) continue;
    const base = splitName(
      c.path
        .split('/')
        .pop()!
        .replace(/\.csv$/i, ''),
    ).base;
    const col =
      kind === 'classes'
        ? 'Class'
        : kind === 'assignments'
          ? 'Assignment'
          : kind === 'tasks'
            ? 'Task'
            : 'Title';
    tplOwners.push({
      kind,
      pageDir: `${c.dir}/${base}`,
      target: kind === 'classes' ? 'classes' : kind === 'assignments' ? 'assignments' : 'notes',
      titles: new Set(c.table.rows.map((r) => normTitle(r[col] ?? ''))),
      titleCol: col,
    });
  }
  for (const p of pages) {
    if (usedPages.has(p.path)) continue;
    const o = tplOwners.find((x) => p.dir === x.pageDir);
    if (!o) continue;
    if (TEMPLATE_NAME.test(p.title) || !o.titles.has(normTitle(p.title))) {
      out.templates.push({ kind: o.target, name: p.title, markdown: body(p).markdown });
    }
  }
  // Template-named rows (e.g. a default entry) that have no page file still become (empty) templates
  for (const o of tplOwners) {
    for (const r of chosen.get(o.kind)!.table.rows) {
      const title = cleanLabel(r[o.titleCol] ?? '');
      if (
        title &&
        TEMPLATE_NAME.test(title) &&
        !out.templates.some((t) => normTitle(t.name) === normTitle(title))
      )
        out.templates.push({ kind: o.target, name: title, markdown: '' });
    }
  }

  // ---- optional modules + unmapped pages ----
  for (const [kind, c] of chosen) {
    const reason = MODULE_NOTES[kind];
    if (reason) out.skipped.push({ kind, count: c.table.rows.length, reason });
  }
  const unmapped = pages.filter(
    (p) =>
      !usedPages.has(p.path) &&
      !out.templates.some((t) => normTitle(t.name) === normTitle(p.title)),
  ).length;
  if (unmapped)
    out.skipped.push({
      kind: 'pages',
      count: unmapped,
      reason: 'Pages outside the mapped databases (hub pages, module pages) were not imported',
    });

  // ---- grade parity ----
  const scheme = defaultScheme();
  for (const c of out.classes) {
    const items: GradeItem[] = out.assignments
      .filter((a) => a.classRef === c.ref)
      .map((a) => ({
        id: a.ref,
        weight: a.weight,
        score: a.score ? { kind: 'percent', percent: a.score.percent } : null,
      }));
    const res = computeGrade(scheme, items);
    const exportedRaw = (classExported.get(c.ref) ?? '').trim();
    const exported = parsePercent(exportedRaw);
    const recomputed = res.percentRaw;
    if (exported === null && !recomputed)
      out.validation.push({
        className: c.name,
        exported: '',
        recomputed: null,
        status: 'both-empty',
      });
    else if (exported === null)
      out.validation.push({
        className: c.name,
        exported: '',
        recomputed: recomputed!.toString(),
        status: 'recomputed-only',
      });
    else if (!recomputed)
      out.validation.push({
        className: c.name,
        exported: exportedRaw,
        recomputed: null,
        status: 'exported-only',
      });
    else {
      const diff = recomputed.minus(exported).abs();
      const diffFraction = recomputed.minus(exported * 100).abs(); // exports as fractions (0.84)
      const best = diff.lt(diffFraction) ? diff : diffFraction;
      out.validation.push({
        className: c.name,
        exported: exportedRaw,
        recomputed: recomputed.toString(),
        status: best.lte('0.01') ? 'ok' : 'mismatch',
        diff: best.toString(),
      });
    }
  }
  return out;
}
