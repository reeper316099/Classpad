import { JsonStore } from '@classpad/jsonstore';
import {
  AssignmentSchema,
  AttachmentSchema,
  ClassSchema,
  ReadingSchema,
  SemesterSchema,
  TaskSchema,
  type Assignment,
  type Attachment,
  type ClassEntity,
  type Reading,
  type Semester,
  type Task,
} from '@classpad/shared';
import { Bus } from './bus.js';
import { ConfigService } from './config.js';
import { ApiError } from './errors.js';
import { GradingService } from './grading.js';
import { NoteRepo } from './notes.js';
import { Repo } from './repo.js';
import { StudyRepo } from './study.js';
import { SearchIndex, type SearchDoc } from './search.js';
import { slugify, uniqueSlug } from './slug.js';

export interface Context {
  store: JsonStore;
  bus: Bus;
  config: ConfigService;
  semesters: Repo<Semester>;
  classes: Repo<ClassEntity>;
  assignments: Repo<Assignment>;
  tasks: Repo<Task>;
  readings: Repo<Reading>;
  notes: NoteRepo;
  attachments: Repo<Attachment>;
  study: StudyRepo;
  grading: GradingService;
  search: SearchIndex;
  searchDocs(): SearchDoc[];
  close(): Promise<void>;
}

const ref = (cond: boolean, msg: string) => {
  if (!cond) throw new ApiError(422, 'BAD_REFERENCE', msg);
};

export async function createContext(
  dataDir: string,
  opts: { watch?: boolean } = {},
): Promise<Context> {
  const store = await JsonStore.open(dataDir);
  await store.backupIfStale().catch(() => null);
  const bus = new Bus();
  const config = new ConfigService(store);
  await config.load();

  const semesters: Repo<Semester> = new Repo<Semester>(store, bus, {
    name: 'semesters',
    schema: SemesterSchema as never,
    location: 'data/semesters.json',
    fileFor: () => 'data/semesters.json',
    beforeCreate: (d) => ({
      ...d,
      slug: uniqueSlug(
        slugify(String(d.name ?? '')),
        new Set(semesters.list().map((s) => s.slug!)),
      ),
    }),
  });
  const semSlug = (id: string) => semesters.get(id)?.slug ?? id;
  const classes: Repo<ClassEntity> = new Repo<ClassEntity>(store, bus, {
    name: 'classes',
    schema: ClassSchema as never,
    location: 'data/classes',
    fileFor: (c) => `data/classes/${semSlug(c.semesterId)}.json`,
    beforeCreate: (d) => ({
      ...d,
      slug: uniqueSlug(
        slugify(String(d.code ?? d.name ?? '')),
        new Set(
          classes
            .list()
            .filter((c) => c.semesterId === d.semesterId)
            .map((c) => c.slug!),
        ),
      ),
    }),
    validate: (c) =>
      ref(!!semesters.get(c.semesterId), `semester "${c.semesterId}" does not exist`),
  });
  const classSlug = (id: string) => classes.get(id)?.slug ?? id;
  const assignments = new Repo<Assignment>(store, bus, {
    name: 'assignments',
    schema: AssignmentSchema as never,
    location: 'data/assignments',
    fileFor: (a) => {
      const c = classes.get(a.classId);
      return `data/assignments/${c ? semSlug(c.semesterId) : '_orphans'}/${c ? classSlug(c.id) : a.classId}.json`;
    },
    validate: (a) => ref(!!classes.get(a.classId), `class "${a.classId}" does not exist`),
  });
  const tasks = new Repo<Task>(store, bus, {
    name: 'tasks',
    schema: TaskSchema as never,
    location: 'data/tasks/tasks.json',
    fileFor: () => 'data/tasks/tasks.json',
  });
  const readings = new Repo<Reading>(store, bus, {
    name: 'readings',
    schema: ReadingSchema as never,
    location: 'data/readings/readings.json',
    fileFor: () => 'data/readings/readings.json',
  });
  const attachments = new Repo<Attachment>(store, bus, {
    name: 'attachments',
    schema: AttachmentSchema as never,
    location: 'data/attachments.json',
    fileFor: () => 'data/attachments.json',
  });
  const study = new StudyRepo(store, bus);
  const notes = new NoteRepo(store, bus, (id) => (id ? classes.get(id)?.slug : undefined));

  for (const r of [semesters, classes, assignments, tasks, readings, attachments]) await r.load();
  await notes.load();
  await study.load();

  const grading = new GradingService({
    config,
    classes: () => classes.list(),
    semesters: () => semesters.list(),
    assignments: () => assignments.list(),
  });

  const search = new SearchIndex();
  const searchDocs = (): SearchDoc[] => [
    ...notes.list().map((n): SearchDoc => ({
      id: n.id,
      kind: 'note',
      title: n.title,
      body: n.markdown,
      classId: n.classId,
      tags: n.tags,
      types: [],
      due: n.date,
    })),
    ...assignments.list().map((a): SearchDoc => ({
      id: a.id,
      kind: 'assignment',
      title: a.title,
      body: a.quickNotes ?? '',
      classId: a.classId,
      tags: [],
      types: a.type,
      due: a.due,
    })),
    ...tasks.list().map((t): SearchDoc => ({
      id: t.id,
      kind: 'task',
      title: t.title,
      body: '',
      classId: t.classId,
      tags: [],
      types: [],
      due: t.date,
    })),
    ...readings.list().map((r): SearchDoc => ({
      id: r.id,
      kind: 'reading',
      title: r.title,
      body: r.quickNotes ?? '',
      classId: r.classId,
      tags: [],
      types: [],
      due: undefined,
    })),
  ];
  search.rebuild(searchDocs());

  bus.on('event', (ev: { kind: string; collection: string; entityId?: string }) => {
    const id = ev.entityId;
    if (!id) return;
    if (ev.kind === 'deleted') return search.remove(id);
    const mk: Record<string, () => SearchDoc | undefined> = {
      notes: () => {
        const n = notes.get(id);
        return (
          n && {
            id,
            kind: 'note',
            title: n.title,
            body: n.markdown,
            classId: n.classId,
            tags: n.tags,
            types: [],
            due: n.date,
          }
        );
      },
      assignments: () => {
        const a = assignments.get(id);
        return (
          a && {
            id,
            kind: 'assignment',
            title: a.title,
            body: a.quickNotes ?? '',
            classId: a.classId,
            tags: [],
            types: a.type,
            due: a.due,
          }
        );
      },
      tasks: () => {
        const t = tasks.get(id);
        return (
          t && {
            id,
            kind: 'task',
            title: t.title,
            body: '',
            classId: t.classId,
            tags: [],
            types: [],
            due: t.date,
          }
        );
      },
      readings: () => {
        const r = readings.get(id);
        return (
          r && {
            id,
            kind: 'reading',
            title: r.title,
            body: r.quickNotes ?? '',
            classId: r.classId,
            tags: [],
            types: [],
          }
        );
      },
    };
    const d = mk[ev.collection]?.();
    if (d) search.upsert(d);
  });

  // hand-edit validation + live reload
  store.registerValidator(
    (rel) => [semesters, classes, assignments, tasks, readings].some((r) => r.owns(rel)),
    (text, rel) => {
      [semesters, classes, assignments, tasks, readings]
        .find((r) => r.owns(rel))!
        .validateText(text);
    },
  );
  store.registerValidator(
    (rel) => notes.owns(rel),
    (text, rel) => notes.validateText(text, rel),
  );
  store.on('invalid-edit', (e: { rel: string; message: string; line?: number }) =>
    bus.publish({
      kind: 'invalid-edit',
      collection: 'files',
      message: `${e.rel}${e.line ? `:${e.line}` : ''}: ${e.message}`,
    }),
  );
  store.on('external-change', async ({ rel }: { rel: string }) => {
    try {
      let handled = false;
      for (const r of [semesters, classes, assignments, tasks, readings])
        handled = (await r.reloadFile(rel)) || handled;
      handled = (await notes.reloadFile(rel)) || handled;
      handled = (await study.reloadFile(rel)) || handled;
      if (rel.startsWith('config/')) {
        await config.load();
        handled = true;
      }
      if (handled) {
        search.rebuild(searchDocs());
        bus.publish({ kind: 'external', collection: 'files', message: rel });
      }
    } catch (e) {
      bus.publish({
        kind: 'invalid-edit',
        collection: 'files',
        message: `${rel}: ${(e as Error).message}`,
      });
    }
  });
  if (opts.watch) await store.watch();

  return {
    store,
    bus,
    config,
    semesters,
    classes,
    assignments,
    tasks,
    readings,
    notes,
    attachments,
    study,
    grading,
    search,
    searchDocs,
    close: () => store.close(),
  };
}
