import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fastify, { type FastifyInstance } from 'fastify';
import { StoreError } from '@classpad/jsonstore';
import {
  APP_NAME,
  AssignmentSchema,
  ClassSchema,
  GpaScaleSchema,
  GradingSchemeSchema,
  NoteSchema,
  ReadingSchema,
  ActivitySchema,
  AdmissionSchema,
  BudgetItemSchema,
  CardSchema,
  ContactSchema,
  JobSchema,
  JournalEntrySchema,
  SemesterSchema,
  extractClozeCards,
  isDue,
  schedule,
  StudySessionSchema,
  TaskSchema,
} from '@classpad/shared';
import { z, ZodError, type ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CSV_COLLECTIONS, csvTemplate, type CsvCollection } from '@classpad/importers';
import { AttachmentService, isInlineSafe } from './attachments.js';
import {
  exportCsv,
  exportGradebook,
  exportIcs,
  exportJson,
  exportMarkdownVault,
  gradeReportHtml,
} from './exportService.js';
import path from 'node:path';
import { clearDemo, hasDemo, loadDemo } from './demo.js';
import { listPlugins } from './plugins.js';
import { syncToFolder } from './syncService.js';
import { LockService, readPrivacySync } from './lock.js';
import { agenda, deadlines, stats, timetable } from './planner.js';
import { APP_CSP, readStatic } from './static.js';
import { backlinksFor, resolveLink } from './noteTools.js';
import { TemplateService } from './templates.js';
import { ImportService, STRATEGIES } from './importService.js';
import { settingsPath } from './config.js';
import type { Collection } from './collection.js';
import { createContext, type Context } from './context.js';
import { ApiError, notFound } from './errors.js';
import type { Base } from './repo.js';

export interface AppOptions {
  dataDir: string;
  token?: string;
  dev?: boolean;
  logger?: boolean;
  watch?: boolean;
  /** Directory with the built web UI; when set, the server also serves it (same origin as the API). */
  staticDir?: string;
  /** Accepted Host header values (DNS-rebinding guard). Defaults to loopback names on the listening port. */
  allowedHosts?: string[];
}

export interface App {
  fastify: FastifyInstance;
  ctx: Context;
  token: string;
}

/** PATCH treats null as "clear this field". */
const nullsToUndefined = (b: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v === null ? undefined : v]));

const OPEN_WHEN_LOCKED = new Set(['/api/v1/health', '/api/v1/lock/status', '/api/v1/lock/unlock']);

const Id = z.object({ id: z.string().min(1).max(64) });
const Paging = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.string().max(40).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
});
const ScoreInputSchema = z.union([
  z.object({ kind: z.literal('percent'), percent: z.number() }),
  z.object({ kind: z.literal('points'), earned: z.number(), possible: z.number().optional() }),
  z.object({ kind: z.literal('letter'), letter: z.string().min(1).max(5) }),
]);
const digest = (s: string) => createHash('sha256').update(s).digest();

function applyList<T extends Base>(items: T[], query: Record<string, unknown>) {
  const { limit, offset, sort, order, ...filters } = Paging.passthrough().parse(query) as z.infer<
    typeof Paging
  > &
    Record<string, unknown>;
  let out = items.filter((it) =>
    Object.entries(filters).every(([k, v]) => {
      if (
        (k === 'from' || k === 'to') &&
        typeof (it as Record<string, unknown>).start === 'string'
      ) {
        const d = String((it as Record<string, unknown>).start).slice(0, 10);
        return k === 'from' ? d >= String(v) : d <= String(v);
      }
      const f = (it as Record<string, unknown>)[k];
      if (Array.isArray(f)) return f.map(String).includes(String(v));
      return String(f ?? '') === String(v);
    }),
  );
  if (sort) {
    const dir = order === 'desc' ? -1 : 1;
    out = [...out].sort((a, b) => {
      const x = (a as Record<string, unknown>)[sort],
        y = (b as Record<string, unknown>)[sort];
      return (
        (x == null
          ? 1
          : y == null
            ? -1
            : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir
      );
    });
  }
  return { items: out.slice(offset, offset + limit), total: out.length, limit, offset };
}

export async function createApp(opts: AppOptions): Promise<App> {
  const token = opts.token ?? randomBytes(24).toString('hex');
  // With encrypted collections, nothing is read from disk until the passphrase is entered.
  const privacy = readPrivacySync(opts.dataDir);
  const ctx = await createContext(opts.dataDir, {
    watch: opts.watch,
    lazy: !!privacy?.enc?.collections.length,
  });
  const lock = new LockService(ctx, privacy);
  const app = fastify({
    logger: opts.logger
      ? {
          level: 'info',
          redact: ['req.headers.authorization'],
          serializers: {
            req: (r) => ({ method: r.method, url: r.url?.split('?')[0], id: r.id }),
            res: (r) => ({ statusCode: r.statusCode }),
          },
        }
      : false,
    genReqId: (req) => String(req.headers['x-request-id'] ?? randomBytes(8).toString('hex')),
    bodyLimit: 10 * 1024 * 1024,
    // long-lived live-update (SSE) connections must not keep the server (and the app) from shutting down
    forceCloseConnections: true,
  });
  const routes: { method: string; path: string; summary: string; body?: ZodType }[] = [];
  const api = '/api/v1';

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    const url = req.url.split('?')[0]!;
    // DNS-rebinding guard: a web page on another origin must not be able to reach this server by name.
    const addr = app.server.address();
    const host = String(req.headers.host ?? '');
    // Loopback names only. In production the port must also be ours; in dev any loopback port is fine so a
    // dev-server proxy on another port keeps working.
    const hostName = host.replace(/:\d+$/, '');
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(hostName);
    const portOk = opts.dev || !addr || typeof addr !== 'object' || host.endsWith(`:${addr.port}`);
    const allowed =
      opts.allowedHosts ??
      (loopback && portOk ? [host] : addr && typeof addr === 'object' ? [] : null);
    if (allowed && !allowed.includes(host))
      throw new ApiError(403, 'BAD_HOST', 'unexpected Host header');
    // the UI bundle itself is public (it holds no data); everything under /api needs the token
    if (
      opts.staticDir &&
      !url.startsWith(`${api}/`) &&
      (req.method === 'GET' || req.method === 'HEAD')
    )
      return;
    let given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!given && url === `${api}/events`)
      given = String((req.query as Record<string, string>)?.access_token ?? '');
    if (!given || !timingSafeEqual(digest(given), digest(token)))
      throw new ApiError(401, 'UNAUTHORIZED', 'missing or invalid bearer token');
    // while locked, only the lock endpoints and the health check answer
    if (lock.locked && !OPEN_WHEN_LOCKED.has(url))
      throw new ApiError(423, 'LOCKED', 'Classpad is locked');
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    const requestId = req.id;
    const send = (status: number, code: string, message: string, details?: unknown) =>
      reply
        .status(status)
        .send({ error: { code, message, requestId, ...(details ? { details } : {}) } });
    if (err instanceof ApiError) return send(err.status, err.code, err.message, err.details);
    if (err instanceof ZodError || (err as { name?: string })?.name === 'ZodError')
      return send(
        422,
        'VALIDATION',
        'request failed validation',
        (err as ZodError).issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    if (err instanceof StoreError)
      return send(
        err.code === 'PATH' ? 400 : err.code === 'LOCKED' ? 409 : 500,
        `STORE_${err.code}`,
        err.message,
      );
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode < 500)
      return send(e.statusCode, 'BAD_REQUEST', e.message ?? 'bad request');
    req.log.error({ msg: e.message }, 'unhandled error');
    return send(500, 'INTERNAL', 'internal error');
  });
  app.setNotFoundHandler(async (req, reply) => {
    const url = req.url.split('?')[0]!;
    if (
      opts.staticDir &&
      (req.method === 'GET' || req.method === 'HEAD') &&
      !url.startsWith(`${api}/`)
    ) {
      const f = await readStatic(opts.staticDir, url);
      if (f) {
        return reply
          .header('content-type', f.type)
          .header('cache-control', f.immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
          .header('content-security-policy', APP_CSP)
          .header('x-content-type-options', 'nosniff')
          .header('referrer-policy', 'no-referrer')
          .header('x-frame-options', 'DENY')
          .send(req.method === 'HEAD' ? '' : f.body);
      }
    }
    return reply
      .status(404)
      .send({ error: { code: 'NOT_FOUND', message: 'route not found', requestId: req.id } });
  });

  const route = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    summary: string,
    handler: (req: { params: unknown; query: unknown; body: unknown }) => unknown,
    body?: ZodType,
  ) => {
    routes.push({ method, path: api + path, summary, body });
    app.route({
      method,
      url: api + path,
      handler: async (req, reply) => {
        const out = await handler(req as never);
        return out === undefined ? reply.status(204).send() : out;
      },
    });
  };

  function crud<T extends Base>(
    path: string,
    col: Collection<T>,
    schema: ZodType,
    hooks: {
      omit?: string[];
      after?: (e: T, kind: 'create' | 'update') => Promise<void>;
      remove?: (id: string) => Promise<void>;
    } = {},
  ) {
    const strip = (b: Record<string, unknown>) => {
      for (const k of ['id', 'createdAt', 'updatedAt', ...(hooks.omit ?? [])]) delete b[k];
      return b;
    };
    const bodySchema = z.record(z.unknown());
    route('GET', path, `List ${col.name}`, (r) =>
      applyList(col.list(), r.query as Record<string, unknown>),
    );
    route('GET', `${path}/:id`, `Get ${col.name} item`, (r) => {
      const { id } = Id.parse(r.params);
      const e = col.get(id);
      if (!e) throw notFound(col.name, id);
      return e;
    });
    route(
      'POST',
      path,
      `Create ${col.name} item`,
      async (r) => {
        const e = await col.create(nullsToUndefined(strip({ ...bodySchema.parse(r.body) })));
        await hooks.after?.(e, 'create');
        return e;
      },
      schema,
    );
    route(
      'PATCH',
      `${path}/:id`,
      `Update ${col.name} item`,
      async (r) => {
        const { id } = Id.parse(r.params);
        const e = await col.update(id, nullsToUndefined(strip({ ...bodySchema.parse(r.body) })));
        await hooks.after?.(e, 'update');
        return e;
      },
      schema,
    );
    route('DELETE', `${path}/:id`, `Delete ${col.name} item`, async (r) => {
      const { id } = Id.parse(r.params);
      if (!col.get(id)) throw notFound(col.name, id);
      if (hooks.remove) await hooks.remove(id);
      else await col.delete(id);
    });
  }

  const {
    semesters,
    classes,
    assignments,
    tasks,
    readings,
    notes,
    grading,
    search,
    config,
    store,
    bus,
    study,
    journal,
    contacts,
    activities,
    jobs,
    admissions,
    budget,
    cards,
  } = ctx;

  // cascades: removing a parent never leaves dangling children
  async function removeClass(id: string, alreadyBackedUp = false) {
    const asg = assignments
      .list()
      .filter((a) => a.classId === id)
      .map((a) => a.id);
    if (asg.length > 1 && !alreadyBackedUp) await store.backup('pre-bulk-delete');
    await assignments.deleteMany(asg);
    await tasks.patchMany(
      tasks
        .list()
        .filter((t) => t.classId === id)
        .map((t) => t.id),
      () => ({ classId: undefined }),
    );
    await readings.patchMany(
      readings
        .list()
        .filter((t) => t.classId === id)
        .map((t) => t.id),
      () => ({ classId: undefined }),
    );
    for (const n of notes.list().filter((n) => n.classId === id))
      await notes.update(n.id, { classId: undefined });
    await classes.delete(id);
  }
  async function removeAssignment(id: string) {
    await tasks.patchMany(
      tasks
        .list()
        .filter((t) => t.assignmentId === id)
        .map((t) => t.id),
      () => ({ assignmentId: undefined }),
    );
    for (const n of notes.list().filter((n) => n.assignmentIds.includes(id)))
      await notes.update(n.id, { assignmentIds: n.assignmentIds.filter((x) => x !== id) });
    await assignments.delete(id);
  }

  crud(
    '/semesters',
    semesters,
    SemesterSchema.omit({ id: true, createdAt: true, updatedAt: true }),
    {
      omit: ['slug'],
      remove: async (id) => {
        await store.backup('pre-bulk-delete');
        for (const c of classes.list().filter((c) => c.semesterId === id))
          await removeClass(c.id, true);
        await semesters.delete(id);
      },
    },
  );
  crud('/classes', classes, ClassSchema.omit({ id: true, createdAt: true, updatedAt: true }), {
    omit: ['slug'],
    after: async (c, kind) => {
      if (kind === 'update')
        await assignments.patchMany(
          assignments
            .list()
            .filter((a) => a.classId === c.id)
            .map((a) => a.id),
          () => ({}),
        );
    },
    remove: (id) => removeClass(id),
  });
  crud(
    '/assignments',
    assignments,
    AssignmentSchema.omit({ id: true, createdAt: true, updatedAt: true }),
    { remove: removeAssignment },
  );
  crud('/tasks', tasks, TaskSchema.omit({ id: true, createdAt: true, updatedAt: true }));
  crud('/readings', readings, ReadingSchema.omit({ id: true, createdAt: true, updatedAt: true }));
  crud('/notes', notes, NoteSchema.omit({ id: true, createdAt: true, updatedAt: true }), {
    // a deleted note takes its generated flashcards with it
    remove: async (id) => {
      await notes.delete(id);
      await cards.deleteMany(
        cards
          .list()
          .filter((c) => c.noteId === id)
          .map((c) => c.id),
      );
    },
  });

  // ---- optional modules ----
  const body = <S extends z.ZodObject<z.ZodRawShape>>(S: S) =>
    S.omit({ id: true, createdAt: true, updatedAt: true });
  crud('/journal', journal, body(JournalEntrySchema));
  crud('/contacts', contacts, body(ContactSchema));
  crud('/activities', activities, body(ActivitySchema));
  crud('/jobs', jobs, body(JobSchema));
  crud('/admissions', admissions, body(AdmissionSchema));
  crud('/budget', budget, body(BudgetItemSchema));
  crud('/flashcards', cards, body(CardSchema));

  // flashcards generated from {{c1::cloze}} text in a note: create new, drop stale, keep the rest (and your progress)
  route(
    'POST',
    '/flashcards/sync-note/:id',
    'Create/update cloze flashcards from a note',
    async (r) => {
      const { id } = Id.parse(r.params);
      const n = notes.get(id);
      if (!n) throw notFound('notes', id);
      const want = extractClozeCards(n.markdown);
      const have = cards.list().filter((c) => c.noteId === id && c.cloze !== undefined);
      const fresh = want.filter((w) => !have.some((h) => h.sourceKey === w.sourceKey));
      const stale = have.filter((h) => !want.some((w) => w.sourceKey === h.sourceKey));
      for (const w of fresh)
        await cards.create({
          noteId: id,
          classId: n.classId,
          front: w.front,
          back: w.back,
          cloze: w.cloze,
          sourceKey: w.sourceKey,
        });
      await cards.deleteMany(stale.map((c) => c.id));
      return { created: fresh.length, removed: stale.length, kept: have.length - stale.length };
    },
  );

  const isNew = (c: { srs: { reps: number; lapses: number } }) =>
    c.srs.reps === 0 && c.srs.lapses === 0;
  route('GET', '/study/queue', 'Flashcards to review now', (r) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(30),
        newLimit: z.coerce.number().int().min(0).max(100).default(10),
        classId: z.string().max(64).optional(),
        noteId: z.string().max(64).optional(),
      })
      .parse(r.query);
    const now = new Date();
    const pool = cards
      .list()
      .filter(
        (c) => (!q.classId || c.classId === q.classId) && (!q.noteId || c.noteId === q.noteId),
      );
    const review = pool
      .filter((c) => !isNew(c) && isDue(c.srs, now))
      .sort((a, b) => a.srs.dueAt.localeCompare(b.srs.dueAt) || a.id.localeCompare(b.id));
    const fresh = pool
      .filter(isNew)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return {
      cards: [...review.slice(0, q.limit), ...fresh.slice(0, q.newLimit)].slice(0, q.limit),
      counts: { due: review.length, new: fresh.length, total: pool.length },
    };
  });
  route('GET', '/study/decks', 'Flashcard counts per class', () => {
    const now = new Date();
    const by = new Map<
      string,
      { classId: string | null; total: number; due: number; new: number }
    >();
    for (const c of cards.list()) {
      const k = c.classId ?? '';
      const d = by.get(k) ?? { classId: c.classId ?? null, total: 0, due: 0, new: 0 };
      d.total++;
      if (isNew(c)) d.new++;
      else if (isDue(c.srs, now)) d.due++;
      by.set(k, d);
    }
    return [...by.values()];
  });
  const Answer = z.object({
    cardId: z.string().min(1).max(64),
    rating: z.enum(['again', 'hard', 'good', 'easy']),
  });
  route(
    'POST',
    '/study/answer',
    'Rate a flashcard and schedule its next review',
    async (r) => {
      const a = Answer.parse(r.body);
      const c = cards.get(a.cardId);
      if (!c) throw notFound('flashcards', a.cardId);
      return cards.update(a.cardId, { srs: schedule(c.srs, a.rating) });
    },
    Answer,
  );

  crud(
    '/study-sessions',
    study,
    StudySessionSchema.omit({ id: true, createdAt: true, updatedAt: true }),
  );

  // ---- planner and stats ----
  const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const WeekStart = z.enum(['mon', 'sun']).default('mon');
  route('GET', '/agenda', 'Deadlines, tasks, classes and study sessions in a date range', (r) => {
    const q = z.object({ from: Day, to: Day }).parse(r.query);
    return agenda(ctx, q.from, q.to);
  });
  route('GET', '/timetable', 'One week of classes and deadlines', (r) => {
    const q = z.object({ week: Day, weekStart: WeekStart }).parse(r.query);
    return timetable(ctx, q.week, q.weekStart);
  });
  route('GET', '/deadlines', 'Open deadlines with urgency', () => deadlines(ctx));
  route(
    'GET',
    '/stats/overview',
    'Dashboard data: study vs targets, workload forecast, grade trends',
    (r) => stats(ctx, new Date(), z.object({ weekStart: WeekStart }).parse(r.query).weekStart),
  );
  const Timer = z.object({
    classId: z.string().max(64).optional(),
    taskId: z.string().max(64).optional(),
    assignmentId: z.string().max(64).optional(),
    kind: z.enum(['pomodoro', 'manual']).default('pomodoro'),
  });
  route('GET', '/study-sessions/active', 'The running study timer (or null)', () => study.active);
  route(
    'POST',
    '/study-sessions/start',
    'Start a study timer',
    (r) => study.startTimer(Timer.parse(r.body)),
    Timer,
  );
  route('POST', '/study-sessions/stop', 'Stop the timer and log the session', async (r) => {
    // `at` lets a client that was closed while a Pomodoro ended log its true end time (never in the future)
    const b = z
      .object({ at: z.string().datetime({ offset: true }).optional() })
      .parse(r.body ?? {});
    const at = b.at ? new Date(Math.min(Date.parse(b.at), Date.now())) : new Date();
    return { session: await study.stopTimer(at) };
  });

  // grades & GPA
  const needed = z.object({
    classId: z.string(),
    target: z.union([z.number(), z.object({ letter: z.string() })]),
    remainingIds: z.array(z.string()).optional(),
    maxPerItem: z.number().optional(),
    perItem: z.boolean().optional(),
    assume: z.number().optional(),
  });
  route('GET', '/grades/class/:id', 'Current grade with full breakdown', (r) =>
    grading.classGrade(Id.parse(r.params).id),
  );
  route('POST', '/grades/what-if', 'Hypothetical scores (never persisted)', (r) => {
    const b = z
      .object({ classId: z.string(), overrides: z.record(ScoreInputSchema.nullable()) })
      .parse(r.body);
    return grading.whatIf(b.classId, b.overrides);
  });
  route(
    'POST',
    '/grades/needed',
    'Score needed to reach a target',
    (r) => {
      const { classId, ...o } = needed.parse(r.body);
      return grading.needed(classId, o);
    },
    needed,
  );
  route('GET', '/grades/semester/:id', 'Semester grade summary', (r) =>
    grading.semester(Id.parse(r.params).id),
  );
  route('GET', '/gpa', 'Per-semester and cumulative GPA', (r) =>
    grading.gpa(
      z
        .object({ scaleId: z.string().optional(), semesterId: z.string().optional() })
        .parse(r.query),
    ),
  );
  route('POST', '/gpa/plan', 'Target GPA planner', (r) =>
    grading.plan(
      z
        .object({
          targetGpa: z.number().min(0),
          plannedCredits: z.number().positive(),
          weighted: z.boolean().optional(),
          scaleId: z.string().optional(),
        })
        .parse(r.body),
    ),
  );
  route('GET', '/grading-schemes', 'List grading schemes', () => config.schemes);
  route(
    'PUT',
    '/grading-schemes',
    'Replace grading schemes',
    (r) => config.putSchemes(z.array(GradingSchemeSchema).parse(r.body)),
    z.array(GradingSchemeSchema),
  );
  route(
    'PUT',
    '/grading-schemes/:id',
    'Create or replace one grading scheme (for example a class’s own category weights)',
    async (r) => {
      const id = z.object({ id: z.string().min(1).max(80) }).parse(r.params).id;
      const body = GradingSchemeSchema.parse(r.body);
      if (body.id !== id)
        throw new ApiError(422, 'BAD_REFERENCE', 'The scheme id must match the URL');
      const next = config.schemes.some((s) => s.id === id)
        ? config.schemes.map((s) => (s.id === id ? body : s))
        : [...config.schemes, body];
      await config.putSchemes(next);
      return body;
    },
    GradingSchemeSchema,
  );
  route('GET', '/gpa-scales', 'List GPA scales', () => config.scales);
  route(
    'PUT',
    '/gpa-scales',
    'Replace GPA scales',
    (r) => config.putScales(z.array(GpaScaleSchema).parse(r.body)),
    z.array(GpaScaleSchema),
  );

  // search, activity, events, health
  route('GET', '/search', 'Search notes, assignments, tasks, readings', (r) => {
    const q = z
      .object({
        q: z.string().max(500),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(r.query);
    const hits = search.search(
      q.q,
      (term) =>
        new Set(
          classes
            .list()
            .filter((c) => `${c.name} ${c.code ?? ''}`.toLowerCase().includes(term))
            .map((c) => c.id),
        ),
      q.limit,
    );
    return { query: q.q, hits };
  });
  route('GET', '/activity', 'Recent changes (metadata only)', () => bus.recent());
  route('GET', '/health', 'Health check', () => ({ ok: true, app: APP_NAME }));
  app.get(`${api}/events`, (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-request-id': req.id,
    });
    reply.raw.write(': connected\n\n');
    const on = (ev: unknown) => reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    const beat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    bus.on('event', on);
    req.raw.on('close', () => {
      clearInterval(beat);
      bus.off('event', on);
    });
  });

  // ---- note links and templates ----
  const templates = new TemplateService(store);
  await templates.seed();
  route('GET', '/notes/resolve', 'Resolve a [[wiki link]] to a note', (r) => {
    const q = z
      .object({ title: z.string().min(1).max(300), classId: z.string().max(64).optional() })
      .parse(r.query);
    const n = resolveLink(notes.list(), q.title, q.classId);
    return n ? { id: n.id, title: n.title, classId: n.classId } : null;
  });
  route('GET', '/notes/:id/backlinks', 'Notes that link to this note', (r) => {
    const { id } = Id.parse(r.params);
    const n = notes.get(id);
    if (!n) throw notFound('notes', id);
    return backlinksFor(notes.list(), n);
  });
  const TplBody = z.object({ name: z.string().min(1).max(80), markdown: z.string().max(200_000) });
  route('GET', '/templates/notes', 'Note templates', () => templates.list());
  route(
    'POST',
    '/templates/notes',
    'Create a note template',
    (r) => {
      const b = TplBody.parse(r.body);
      return templates.save(b.name, b.markdown);
    },
    TplBody,
  );
  route(
    'PUT',
    '/templates/notes/:id',
    'Update a note template',
    (r) => {
      const b = TplBody.parse(r.body);
      return templates.save(b.name, b.markdown, Id.parse(r.params).id);
    },
    TplBody,
  );
  route('DELETE', '/templates/notes/:id', 'Delete a note template', async (r) => {
    await templates.remove(Id.parse(r.params).id);
  });

  // ---- app lock and encryption at rest ----
  const Pass = z.string().min(1).max(500);
  route('GET', '/lock/status', 'Lock state', () => lock.status());
  route('POST', '/lock/unlock', 'Unlock with the passphrase', (r) =>
    lock.unlock(z.object({ passphrase: Pass }).parse(r.body).passphrase),
  );
  route('POST', '/lock/lock', 'Lock now', () => lock.lock());
  route(
    'POST',
    '/lock/setup',
    'Set or change the passphrase (optionally choose encrypted collections)',
    (r) =>
      lock.setup(
        z
          .object({
            passphrase: Pass,
            current: Pass.optional(),
            collections: z.array(z.string().max(40)).max(20).optional(),
            autoLockMinutes: z.number().int().min(0).max(1440).optional(),
            lockOnHide: z.boolean().optional(),
          })
          .parse(r.body),
      ),
  );
  route('POST', '/lock/collections', 'Choose which collections are encrypted at rest', (r) => {
    const b = z
      .object({ collections: z.array(z.string().max(40)).max(20), passphrase: Pass.optional() })
      .parse(r.body);
    return lock.setCollections(b.collections, b.passphrase);
  });
  route('PATCH', '/lock/settings', 'Auto-lock settings', (r) =>
    lock.updateSettings(
      z
        .object({
          autoLockMinutes: z.number().int().min(0).max(1440).optional(),
          lockOnHide: z.boolean().optional(),
        })
        .parse(r.body),
    ),
  );
  route('POST', '/lock/disable', 'Remove the lock and decrypt everything', (r) =>
    lock.disable(z.object({ passphrase: Pass }).parse(r.body).passphrase),
  );

  // ---- settings, demo data, about ----
  route('GET', '/settings', 'UI and app settings', async () =>
    store.readJson<Record<string, unknown>>(settingsPath, { fallback: () => ({}) }),
  );
  route('PUT', '/settings', 'Replace settings', async (r) => {
    const b = z.record(z.unknown()).parse(r.body);
    if (JSON.stringify(b).length > 100_000)
      throw new ApiError(413, 'TOO_LARGE', 'settings too large');
    await store.writeJson(settingsPath, b);
    return b;
  });
  route('GET', '/about', 'App info', () => ({
    app: APP_NAME,
    demoLoaded: hasDemo(ctx),
    counts: {
      semesters: semesters.list().length,
      classes: classes.list().length,
      assignments: assignments.list().length,
      notes: notes.list().length,
    },
  }));
  route('POST', '/demo/load', 'Load invented demo data', () => loadDemo(ctx));
  route('DELETE', '/demo', 'Remove demo data', async () => {
    await clearDemo(ctx);
  });

  // ---- attachments ----
  const atts = new AttachmentService(store, ctx.attachments);
  const imports = new ImportService(ctx, atts);
  const download = (
    reply: import('fastify').FastifyReply,
    type: string,
    name: string,
    body: string | Buffer,
  ) =>
    reply
      .header('content-type', type)
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('x-content-type-options', 'nosniff')
      .send(body);
  route('GET', '/attachments', 'List attachments', (r) =>
    applyList(ctx.attachments.list(), r.query as Record<string, unknown>),
  );
  route('GET', '/attachments/:id', 'Attachment metadata', (r) => {
    const { id } = Id.parse(r.params);
    const a = ctx.attachments.get(id);
    if (!a) throw notFound('attachment', id);
    return a;
  });
  route('POST', '/attachments', 'Upload an attachment (base64)', async (r) => {
    const b = z
      .object({ filename: z.string().min(1).max(255), dataBase64: z.string().min(1) })
      .parse(r.body);
    return (await atts.add(b.filename, Buffer.from(b.dataBase64, 'base64'))).record;
  });
  route('DELETE', '/attachments/:id', 'Delete an attachment', async (r) => {
    const { id } = Id.parse(r.params);
    const a = ctx.attachments.get(id);
    if (!a) throw notFound('attachment', id);
    await atts.remove(a);
  });
  app.get(`${api}/attachments/:id/file`, async (req, reply) => {
    const { id } = Id.parse(req.params);
    const a = ctx.attachments.get(id);
    if (!a) throw notFound('attachment', id);
    const data = await atts.read(a);
    const safe = isInlineSafe(a.mime);
    return reply
      .header('content-type', safe ? a.mime : 'application/octet-stream')
      .header(
        'content-disposition',
        `${safe ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
      )
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(data);
  });

  // ---- import / export ----
  app.addContentTypeParser(
    ['application/octet-stream', 'application/zip'],
    { parseAs: 'buffer', bodyLimit: 600 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
  const Kinds = z.enum(['notion', 'csv', 'ics', 'markdown', 'json']);
  const PreviewBody = z.object({
    kind: Kinds,
    collection: z.enum(CSV_COLLECTIONS as [CsvCollection, ...CsvCollection[]]).optional(),
    text: z.string().optional(),
    dataBase64: z.string().optional(),
    icsAs: z.enum(['tasks', 'assignments']).optional(),
    className: z.string().max(200).optional(),
    dropTooltips: z.boolean().optional(),
    pluginId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,38}$/)
      .optional(),
  });
  routes.push({
    method: 'POST',
    path: `${api}/import/preview`,
    summary: 'Parse an export and report what would be imported (no writes)',
    body: PreviewBody,
  });
  app.post(`${api}/import/preview`, { bodyLimit: 600 * 1024 * 1024 }, async (req) => {
    if (Buffer.isBuffer(req.body)) {
      const q = z
        .object({
          kind: Kinds,
          collection: PreviewBody.shape.collection,
          icsAs: PreviewBody.shape.icsAs,
          className: PreviewBody.shape.className,
          pluginId: PreviewBody.shape.pluginId,
        })
        .parse(req.query);
      return imports.preview({ ...q, data: req.body });
    }
    const b = PreviewBody.parse(req.body);
    return imports.preview({
      ...b,
      data: b.dataBase64 ? Buffer.from(b.dataBase64, 'base64') : undefined,
    });
  });
  const Commit = z.object({
    previewId: z.string().min(1).max(64),
    strategy: z.enum(STRATEGIES).default('update_empty'),
  });
  route(
    'POST',
    '/import/commit',
    'Apply a previewed import',
    (r) => {
      const b = Commit.parse(r.body);
      return imports.commit(b.previewId, b.strategy);
    },
    Commit,
  );
  route('POST', '/import/undo/:id', 'Undo an import', (r) => imports.undo(Id.parse(r.params).id));
  route('GET', '/import/history', 'Past imports', () => imports.history());
  const Coll = z.object({
    collection: z.enum(CSV_COLLECTIONS as [CsvCollection, ...CsvCollection[]]),
  });
  app.get(`${api}/import/templates/:collection`, async (req, reply) => {
    const { collection } = Coll.parse(req.params);
    return download(
      reply,
      'text/csv; charset=utf-8',
      `${collection}-template.csv`,
      csvTemplate(collection),
    );
  });
  app.get(`${api}/export/csv/:collection`, async (req, reply) => {
    const { collection } = Coll.parse(req.params);
    return download(
      reply,
      'text/csv; charset=utf-8',
      `${collection}.csv`,
      exportCsv(ctx, collection),
    );
  });
  app.get(`${api}/export/gradebook`, async (_req, reply) =>
    download(reply, 'text/csv; charset=utf-8', 'gradebook.csv', exportGradebook(ctx)),
  );
  route('GET', '/plugins', 'Built-in and user mapping plugins', async () => ({
    ...(await listPlugins(store)),
    folder: path.join(opts.dataDir, 'plugins'),
  }));
  const Sync = z.object({
    dir: z.string().min(1).max(1024),
    acknowledgePlaintext: z.boolean().optional(),
  });
  route(
    'POST',
    '/sync/export',
    'One-way export to a folder other apps can read',
    async (r) => {
      const b = Sync.parse(r.body);
      if (lock.status().encryptedCollections.length && !b.acknowledgePlaintext)
        throw new ApiError(
          409,
          'NEEDS_ACK',
          'Some of your data is encrypted at rest. Exported files are NOT encrypted. Confirm to export anyway.',
        );
      return syncToFolder(ctx, opts.dataDir, b.dir);
    },
    Sync,
  );
  app.get(`${api}/export/ics`, async (req, reply) => {
    const { kind } = z
      .object({ kind: z.enum(['deadlines', 'timetable', 'all']).default('all') })
      .parse(req.query);
    return download(
      reply,
      'text/calendar; charset=utf-8',
      `classpad-${kind}.ics`,
      exportIcs(ctx, kind),
    );
  });
  app.get(`${api}/export/json`, async (_req, reply) =>
    download(
      reply,
      'application/json',
      'classpad-backup.json',
      JSON.stringify(exportJson(ctx), null, 2),
    ),
  );
  app.get(`${api}/export/markdown`, async (_req, reply) =>
    download(reply, 'application/zip', 'classpad-notes.zip', await exportMarkdownVault(ctx)),
  );
  app.get(`${api}/export/report`, async (req, reply) => {
    const { hide } = z.object({ hide: z.enum(['0', '1']).default('0') }).parse(req.query);
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('x-content-type-options', 'nosniff')
      .send(gradeReportHtml(ctx, { hideGrades: hide === '1' }));
  });

  if (opts.dev) {
    app.get(`${api}/openapi.json`, async () => ({
      openapi: '3.0.3',
      info: { title: `${APP_NAME} API`, version: '0.0.0' },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
      paths: routes.reduce<Record<string, Record<string, unknown>>>((acc, r) => {
        const p = r.path.replace(/:(\w+)/g, '{$1}');
        (acc[p] ??= {})[r.method.toLowerCase()] = {
          summary: r.summary,
          ...(r.body
            ? {
                requestBody: {
                  content: {
                    'application/json': { schema: zodToJsonSchema(r.body, { target: 'openApi3' }) },
                  },
                },
              }
            : {}),
          responses: { '200': { description: 'OK' } },
        };
        return acc;
      }, {}),
    }));
  }

  app.addHook('onClose', async () => {
    await ctx.close();
  });
  await app.ready();
  return { fastify: app, ctx, token };
}

export async function startServer(opts: AppOptions & { port?: number; host?: string }) {
  const app = await createApp(opts);
  const host = opts.host ?? '127.0.0.1';
  await app.fastify.listen({ port: opts.port ?? 0, host });
  const addr = app.fastify.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { ...app, host, port, url: `http://${host}:${port}`, close: () => app.fastify.close() };
}
