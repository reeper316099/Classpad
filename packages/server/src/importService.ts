import {
  openZip,
  parseBackup,
  previewCsv,
  previewGradebook,
  previewIcs,
  previewMarkdownFolder,
  previewNotion,
  normTitle,
  type Archive,
  type BackupV1,
  type CsvCollection,
  type ImportPreview,
} from '@classpad/importers';
import { newId } from '@classpad/shared';
import { findPlugin } from './plugins.js';
import { z } from 'zod';
import { AttachmentService } from './attachments.js';
import type { Context } from './context.js';
import { ApiError } from './errors.js';
import type { Repo } from './repo.js';
import { slugify } from './slug.js';

export const STRATEGIES = ['skip', 'update_empty', 'overwrite', 'keep_both'] as const;
export type Strategy = (typeof STRATEGIES)[number];
export type ImportKind = 'notion' | 'csv' | 'ics' | 'markdown' | 'json';

interface Session {
  id: string;
  kind: ImportKind;
  preview: ImportPreview;
  archive?: Archive;
  backup?: BackupV1;
  at: number;
}

type Kind =
  | 'semesters'
  | 'classes'
  | 'assignments'
  | 'tasks'
  | 'readings'
  | 'notes'
  | 'journal'
  | 'contacts'
  | 'activities'
  | 'jobs'
  | 'admissions'
  | 'budget'
  | 'cards';
const ALL_KINDS: Kind[] = [
  'semesters',
  'classes',
  'assignments',
  'tasks',
  'readings',
  'notes',
  'journal',
  'contacts',
  'activities',
  'jobs',
  'admissions',
  'budget',
  'cards',
];
/** Backups call the flashcards collection `flashcards`. */
const backupKey = (k: Kind) => (k === 'cards' ? 'flashcards' : k);
type Entity = { id: string; importRef?: string } & Record<string, unknown>;

export interface Manifest {
  id: string;
  source: string;
  strategy: Strategy;
  at: string;
  undoneAt?: string;
  created: Record<Kind, string[]>;
  updated: Record<Kind, Record<string, unknown>>;
  attachments: string[];
  templates: { created: string[]; overwritten: Record<string, string> };
  config?: { schemes: unknown; scales: unknown };
  warnings: string[];
}
const emptyKinds = <T>(f: () => T): Record<Kind, T> =>
  Object.fromEntries(ALL_KINDS.map((k) => [k, f()])) as Record<Kind, T>;

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const isZip = (b: Buffer) => b.length > 3 && b[0] === 0x50 && b[1] === 0x4b;

export interface PreviewInput {
  kind: ImportKind;
  data?: Buffer;
  text?: string;
  collection?: CsvCollection;
  /** A mapping plugin (built-in or from the plugins folder) that reads a foreign CSV. */
  pluginId?: string;
  icsAs?: 'tasks' | 'assignments';
  className?: string;
  dropTooltips?: boolean;
}

export class ImportService {
  private sessions = new Map<string, Session>();
  constructor(
    private ctx: Context,
    private atts: AttachmentService,
  ) {}

  private repo(k: Kind): Repo<never> | Context['notes'] {
    return this.ctx[k] as never;
  }

  // -------------------------------------------------------------- preview
  async preview(input: PreviewInput) {
    let preview: ImportPreview;
    let archive: Archive | undefined;
    let backup: BackupV1 | undefined;
    try {
      if (input.kind === 'notion' || input.kind === 'markdown') {
        if (!input.data || !isZip(input.data))
          throw new ApiError(422, 'BAD_INPUT', 'Expected a .zip export');
        archive = openZip(input.data);
        preview =
          input.kind === 'notion'
            ? previewNotion(archive, { dropTooltips: input.dropTooltips })
            : previewMarkdownFolder(archive);
      } else if (input.kind === 'csv' && input.pluginId) {
        const plugin = await findPlugin(this.ctx.store, input.pluginId);
        if (!plugin) throw new ApiError(404, 'NOT_FOUND', `plugin "${input.pluginId}" not found`);
        preview = previewGradebook(input.text ?? input.data?.toString('utf8') ?? '', plugin, {
          className: input.className,
        });
      } else if (input.kind === 'csv') {
        if (!input.collection)
          throw new ApiError(422, 'BAD_INPUT', '"collection" is required for CSV imports');
        preview = previewCsv(input.text ?? input.data?.toString('utf8') ?? '', input.collection);
      } else if (input.kind === 'ics') {
        preview = previewIcs(input.text ?? input.data?.toString('utf8') ?? '', {
          as: input.icsAs,
          className: input.className,
        });
      } else {
        backup = parseBackup(input.text ?? input.data?.toString('utf8') ?? '');
        preview = this.backupPreview(backup);
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(422, 'BAD_INPUT', (e as Error).message);
    }
    const id = newId();
    this.sessions.set(id, { id, kind: input.kind, preview, archive, backup, at: Date.now() });
    for (const [k, s] of this.sessions)
      if (this.sessions.size > 5 || Date.now() - s.at > 3600_000) this.sessions.delete(k);
    return { previewId: id, ...this.summarize(preview) };
  }

  private backupPreview(b: BackupV1): ImportPreview {
    const p: ImportPreview = {
      source: 'json',
      semesters: [],
      classes: [],
      assignments: [],
      tasks: [],
      readings: [],
      notes: [],
      journal: [],
      contacts: [],
      jobs: [],
      budget: [],
      templates: [],
      attachments: [],
      skipped: [],
      mapping: [],
      warnings: [],
      validation: [],
    };
    p.warnings.push({
      code: 'BACKUP',
      message: `Backup from ${b.exportedAt || 'unknown date'}: ${b.semesters.length} semesters, ${b.classes.length} classes, ${b.assignments.length} assignments, ${b.notes.length} notes`,
    });
    return p;
  }

  summarize(p: ImportPreview) {
    const titles = (xs: { title?: string; name?: string }[]) =>
      xs.slice(0, 500).map((x) => x.title ?? x.name ?? '');
    return {
      source: p.source,
      counts: {
        semesters: p.semesters.length,
        classes: p.classes.length,
        assignments: p.assignments.length,
        tasks: p.tasks.length,
        readings: p.readings.length,
        notes: p.notes.length,
        journal: p.journal.length,
        contacts: p.contacts.length,
        jobs: p.jobs.length,
        budget: p.budget.length,
        templates: p.templates.length,
        attachments: p.attachments.length,
      },
      items: {
        semesters: titles(p.semesters),
        classes: titles(p.classes),
        assignments: titles(p.assignments),
        tasks: titles(p.tasks),
        readings: titles(p.readings),
        notes: titles(p.notes),
        journal: titles(p.journal),
        contacts: titles(p.contacts),
        jobs: p.jobs.map((j) => `${j.position}${j.company ? ' @ ' + j.company : ''}`),
        budget: p.budget.map((b) => b.purchase),
        templates: p.templates.map((t) => `${t.kind}: ${t.name}`),
      },
      skipped: p.skipped,
      mapping: p.mapping,
      warnings: p.warnings,
      validation: p.validation,
    };
  }

  // -------------------------------------------------------------- commit
  async commit(previewId: string, strategy: Strategy) {
    const s = this.sessions.get(previewId);
    if (!s) throw new ApiError(404, 'NOT_FOUND', 'preview expired; run the preview again');
    this.sessions.delete(previewId);
    const id = newId();
    await this.ctx.store.backup('pre-import');
    const m: Manifest = {
      id,
      source: s.kind,
      strategy,
      at: new Date().toISOString(),
      created: emptyKinds(() => []),
      updated: emptyKinds(() => ({})),
      attachments: [],
      templates: { created: [], overwritten: {} },
      warnings: [],
    };
    await this.ctx.store.writeJson(`imports/${id}/manifest.json`, m);
    try {
      if (s.backup) await this.restoreBackup(s.backup, strategy, m);
      else await this.commitDrafts(s, strategy, m);
    } finally {
      await this.ctx.store.writeJson(`imports/${id}/manifest.json`, m);
    }
    const n = (r: Record<string, unknown[]>) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.length]));
    return {
      importId: id,
      strategy,
      created: n(m.created),
      updated: Object.fromEntries(
        Object.entries(m.updated).map(([k, v]) => [k, Object.keys(v).length]),
      ),
      attachments: m.attachments.length,
      templates: m.templates.created.length,
      warnings: [...s.preview.warnings.map((w) => w.message), ...m.warnings],
    };
  }

  private async commitDrafts(s: Session, strategy: Strategy, m: Manifest) {
    const { ctx } = this;
    const p = s.preview;
    const existing = new Map<string, Entity>();
    for (const k of ALL_KINDS)
      for (const e of this.repo(k).list() as Entity[])
        if (e.importRef) existing.set(e.importRef, e);
    const refToId = new Map<string, string>();
    const copySuffix = `#copy-${m.id.slice(-6).toLowerCase()}`;

    const apply = async (
      kind: Kind,
      ref: string,
      input: Record<string, unknown>,
    ): Promise<string | undefined> => {
      const repo = this.repo(kind) as Repo<never>;
      const found = existing.get(ref);
      const data = { ...input, importRef: ref };
      if (!found || strategy === 'keep_both') {
        const e = (await repo.create(
          strategy === 'keep_both' && found ? { ...data, importRef: ref + copySuffix } : data,
        )) as Entity;
        m.created[kind].push(e.id);
        refToId.set(ref, e.id);
        return e.id;
      }
      refToId.set(ref, found.id);
      if (strategy === 'skip') return found.id;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) {
        if (v === undefined) continue;
        if (strategy === 'overwrite' || (isEmpty(found[k]) && !isEmpty(v))) patch[k] = v;
      }
      if (Object.keys(patch).length) await this.touch(kind, found.id, patch, m);
      return found.id;
    };

    const byName = (kind: 'class' | 'semester', ref: string): string | undefined => {
      const want = ref.split(':').slice(2).join(':');
      const list = (kind === 'class' ? ctx.classes.list() : ctx.semesters.list()) as {
        id: string;
        name: string;
        code?: string;
      }[];
      return list.find((x) => normTitle(x.name) === want || (x.code && normTitle(x.code) === want))
        ?.id;
    };
    const resolve = (
      kind: 'class' | 'semester' | 'assignment' | 'reading',
      ref?: string,
    ): string | undefined => {
      if (!ref) return undefined;
      if (ref.startsWith('name:')) return refToId.get(ref) ?? byName(kind as 'class', ref);
      return refToId.get(ref);
    };

    // attachments
    const linkFor = new Map<string, string>();
    const attIdFor = new Map<string, string>();
    for (const a of p.attachments) {
      if (!s.archive) break;
      try {
        const { record, created } = await this.atts.add(a.filename, s.archive.read(a.archivePath));
        if (created) m.attachments.push(record.id);
        linkFor.set(a.archivePath, AttachmentService.link(record));
        attIdFor.set(a.archivePath, record.id);
      } catch (e) {
        m.warnings.push(`Attachment "${a.filename}" skipped: ${(e as Error).message}`);
      }
    }
    const rewrite = (md: string) =>
      md.replace(/\(attachment-ref:([^)\s]+)\)/g, (x, enc: string) => {
        let path = enc;
        try {
          path = decodeURI(enc);
        } catch {
          /* keep */
        }
        const l = linkFor.get(path);
        return l ? `(${l})` : x;
      });

    // semesters
    for (const d of p.semesters)
      await apply('semesters', d.ref, {
        name: d.name,
        start: d.start,
        end: d.end,
        isCurrent: d.isCurrent,
        goals: d.goals,
      });
    let fallbackSemester: string | undefined;
    const defaultSemester = async () => {
      if (fallbackSemester) return fallbackSemester;
      const cur = ctx.semesters.list().find((x) => x.isCurrent) ?? ctx.semesters.list()[0];
      fallbackSemester =
        cur?.id ?? (await apply('semesters', 'import:default-semester', { name: 'Imported' }));
      return fallbackSemester;
    };
    // classes
    for (const d of p.classes) {
      const semesterId = resolve('semester', d.semesterRef) ?? (await defaultSemester());
      const { ref, semesterRef, syllabusPath, ...rest } = d;
      void semesterRef;
      await apply('classes', ref, {
        ...rest,
        semesterId,
        syllabusAttachmentId: syllabusPath ? attIdFor.get(syllabusPath) : undefined,
      });
    }
    // assignments (ones without a resolvable class are kept in an "Unassigned" class)
    let unassigned: string | undefined;
    const unassignedClass = async () => {
      unassigned ??= await apply('classes', 'import:unassigned-class', {
        name: 'Unassigned',
        semesterId: await defaultSemester(),
        color: '#94a3b8',
        includeInGpa: false,
        quickNotes: 'Imported items that had no class. Move them to the right class.',
      });
      return unassigned!;
    };
    for (const d of p.assignments) {
      let classId = resolve('class', d.classRef);
      if (!classId) {
        classId = await unassignedClass();
        m.warnings.push(`Assignment "${d.title}" has no matching class; placed in "Unassigned"`);
      }
      const { ref, classRef, filePaths, ...rest } = d;
      void classRef;
      await apply('assignments', ref, {
        ...rest,
        classId,
        attachmentIds: filePaths.map((f) => attIdFor.get(f)).filter(Boolean),
      });
    }
    for (const d of p.readings) {
      const { ref, classRef, ...rest } = d;
      await apply('readings', ref, { ...rest, classId: resolve('class', classRef) });
    }
    for (const d of p.tasks) {
      const { ref, classRef, assignmentRef, ...rest } = d;
      await apply('tasks', ref, {
        ...rest,
        classId: resolve('class', classRef),
        assignmentId: assignmentRef ? refToId.get(assignmentRef) : undefined,
      });
    }
    const noteLinks: [string, string][] = [];
    for (const d of p.notes) {
      const { ref, classRef, assignmentRefs, readingRefs, markdown, ...rest } = d;
      const assignmentIds = assignmentRefs
        .map((r) => refToId.get(r))
        .filter((x): x is string => !!x);
      const nid = await apply('notes', ref, {
        ...rest,
        markdown: rewrite(markdown),
        classId: resolve('class', classRef),
        assignmentIds,
        readingIds: readingRefs.map((r) => refToId.get(r)).filter((x): x is string => !!x),
      });
      if (nid) for (const a of assignmentIds) noteLinks.push([a, nid]);
    }
    for (const [aid, nid] of noteLinks) {
      const a = ctx.assignments.get(aid);
      if (a && !a.noteIds.includes(nid))
        await this.touch('assignments', aid, { noteIds: [...a.noteIds, nid] }, m);
    }

    // optional modules
    for (const d of p.journal) {
      const { ref, ...rest } = d;
      await apply('journal', ref, rest);
    }
    for (const d of p.contacts) {
      const { ref, classRefs, ...rest } = d;
      await apply('contacts', ref, {
        ...rest,
        classIds: classRefs.map((r) => refToId.get(r)).filter((x): x is string => !!x),
      });
    }
    for (const d of p.jobs) {
      const { ref, ...rest } = d;
      await apply('jobs', ref, rest);
    }
    for (const d of p.budget) {
      const { ref, ...rest } = d;
      await apply('budget', ref, rest);
    }

    // templates
    for (const t of p.templates) {
      const rel = `config/templates/${t.kind}/${slugify(t.name)}.md`;
      const prev = await ctx.store.readText(rel);
      if (prev !== null && (strategy === 'skip' || strategy === 'update_empty')) continue;
      let target = rel;
      if (prev !== null && strategy === 'keep_both')
        target = rel.replace(/\.md$/, `-${m.id.slice(-6).toLowerCase()}.md`);
      else if (prev !== null) m.templates.overwritten[rel] = prev;
      if (prev === null || target !== rel) m.templates.created.push(target);
      await ctx.store.writeText(target, t.markdown);
    }
  }

  private async touch(kind: Kind, id: string, patch: Record<string, unknown>, m: Manifest) {
    const repo = this.repo(kind) as Repo<never>;
    if (!m.created[kind].includes(id) && !(id in m.updated[kind]))
      m.updated[kind][id] = structuredClone(repo.get(id));
    await repo.update(id, patch);
  }

  // -------------------------------------------------------------- JSON backup restore
  private async restoreBackup(b: BackupV1, strategy: Strategy, m: Manifest) {
    const { ctx } = this;
    const schemaOf: Record<Kind, z.ZodTypeAny> = {
      semesters: ctx.semesters.schemaForRestore(),
      classes: ctx.classes.schemaForRestore(),
      assignments: ctx.assignments.schemaForRestore(),
      tasks: ctx.tasks.schemaForRestore(),
      readings: ctx.readings.schemaForRestore(),
      notes: ctx.notes.schemaForRestore(),
      journal: ctx.journal.schemaForRestore(),
      contacts: ctx.contacts.schemaForRestore(),
      activities: ctx.activities.schemaForRestore(),
      jobs: ctx.jobs.schemaForRestore(),
      admissions: ctx.admissions.schemaForRestore(),
      budget: ctx.budget.schemaForRestore(),
      cards: ctx.cards.schemaForRestore(),
    };
    for (const kind of ALL_KINDS) {
      const repo = this.repo(kind);
      for (const raw of (b as unknown as Record<string, unknown[]>)[backupKey(kind)] ?? []) {
        const parsed = schemaOf[kind].safeParse(raw);
        if (!parsed.success) {
          m.warnings.push(`Skipped invalid ${kind} entry: ${parsed.error.issues[0]?.message}`);
          continue;
        }
        const e = parsed.data as Entity;
        const cur = repo.get(e.id) as Entity | undefined;
        try {
          if (!cur) {
            await (repo as Repo<never>).put(e as never);
            m.created[kind].push(e.id);
          } else if (strategy === 'skip') continue;
          else if (strategy === 'keep_both') {
            const copy = {
              ...e,
              id: newId(),
              importRef: `${e.importRef ?? e.id}#copy-${m.id.slice(-6).toLowerCase()}`,
            };
            await (repo as Repo<never>).put(copy as never);
            m.created[kind].push(copy.id);
          } else {
            m.updated[kind][e.id] = structuredClone(cur);
            const next =
              strategy === 'overwrite'
                ? e
                : Object.fromEntries(
                    Object.entries({
                      ...e,
                      ...Object.fromEntries(Object.entries(cur).filter(([, v]) => !isEmpty(v))),
                    }),
                  );
            await (repo as Repo<never>).put(next as never);
          }
        } catch (err) {
          m.warnings.push(`Could not restore ${kind} "${e.id}": ${(err as Error).message}`);
        }
      }
    }
    if (strategy === 'overwrite' && (b.gradingSchemes.length || b.gpaScales.length)) {
      m.config = {
        schemes: structuredClone(ctx.config.schemes),
        scales: structuredClone(ctx.config.scales),
      };
      if (b.gradingSchemes.length) await ctx.config.putSchemes(b.gradingSchemes as never);
      if (b.gpaScales.length) await ctx.config.putScales(b.gpaScales as never);
    }
    if (b.attachments.length)
      m.warnings.push(
        'Attachment files are not part of JSON backups; restore them from a zip backup if needed',
      );
  }

  // -------------------------------------------------------------- undo & history
  async history() {
    const files = await this.ctx.store.list('imports', { ext: 'manifest.json', recursive: true });
    const out: { id: string; source: string; at: string; strategy: string; undoneAt?: string }[] =
      [];
    for (const f of files) {
      const m = await this.ctx.store.readJson<Manifest>(f).catch(() => null);
      if (m)
        out.push({
          id: m.id,
          source: m.source,
          at: m.at,
          strategy: m.strategy,
          undoneAt: m.undoneAt,
        });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  async undo(importId: string) {
    if (!/^[0-9A-Za-z]{26}$/.test(importId)) throw new ApiError(400, 'BAD_ID', 'invalid import id');
    const rel = `imports/${importId}/manifest.json`;
    const m = await this.ctx.store.readJson<Manifest>(rel, { fallback: () => null as never });
    if (!m) throw new ApiError(404, 'NOT_FOUND', 'import not found');
    if (m.undoneAt) throw new ApiError(409, 'ALREADY_UNDONE', 'this import was already undone');
    const { ctx } = this;
    const warnings: string[] = [];
    await ctx.store.backup('pre-undo');
    // restore edited entities first (they may be parents of created ones), then delete created, children first
    for (const kind of ALL_KINDS)
      for (const prev of Object.values(m.updated[kind] ?? {}))
        await (this.repo(kind) as Repo<never>).put(prev as never);
    const mine = (k: Kind) => new Set(m.created[k] ?? []);
    for (const kind of [
      'cards',
      'notes',
      'journal',
      'contacts',
      'activities',
      'jobs',
      'admissions',
      'budget',
      'tasks',
      'readings',
      'assignments',
      'classes',
      'semesters',
    ] as Kind[]) {
      for (const id of [...(m.created[kind] ?? [])].reverse()) {
        if (!this.repo(kind).get(id)) continue;
        if (
          kind === 'classes' &&
          ctx.assignments.list().some((a) => a.classId === id && !mine('assignments').has(a.id))
        ) {
          warnings.push('Kept a class that now has assignments you added');
          continue;
        }
        if (
          kind === 'semesters' &&
          ctx.classes.list().some((c) => c.semesterId === id && !mine('classes').has(c.id))
        ) {
          warnings.push('Kept a semester that now has classes you added');
          continue;
        }
        await this.repo(kind).delete(id);
      }
    }
    for (const aid of m.attachments) {
      const a = ctx.attachments.get(aid);
      if (a) await this.atts.remove(a);
    }
    for (const t of m.templates.created) await ctx.store.remove(t);
    for (const [path, text] of Object.entries(m.templates.overwritten))
      await ctx.store.writeText(path, text);
    if (m.config) {
      await ctx.config.putSchemes(m.config.schemes as never);
      await ctx.config.putScales(m.config.scales as never);
    }
    m.undoneAt = new Date().toISOString();
    await ctx.store.writeJson(rel, m);
    return { importId, undone: true, warnings };
  }
}
