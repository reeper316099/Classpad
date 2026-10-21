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
  SemesterSchema,
  TaskSchema,
} from '@classpad/shared';
import { z, ZodError, type ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CSV_COLLECTIONS, csvTemplate, type CsvCollection } from '@classpad/importers';
import { AttachmentService, isInlineSafe } from './attachments.js';
import {
  exportCsv,
  exportIcs,
  exportJson,
  exportMarkdownVault,
  gradeReportHtml,
} from './exportService.js';
import { clearDemo, hasDemo, loadDemo } from './demo.js';
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
}

export interface App {
  fastify: FastifyInstance;
  ctx: Context;
  token: string;
}

/** PATCH treats null as "clear this field". */
const nullsToUndefined = (b: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v === null ? undefined : v]));

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
  const ctx = await createContext(opts.dataDir, { watch: opts.watch });
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
  });
  const routes: { method: string; path: string; summary: string; body?: ZodType }[] = [];
  const api = '/api/v1';

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    const url = req.url.split('?')[0]!;
    let given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!given && url === `${api}/events`)
      given = String((req.query as Record<string, string>)?.access_token ?? '');
    if (!given || !timingSafeEqual(digest(given), digest(token)))
      throw new ApiError(401, 'UNAUTHORIZED', 'missing or invalid bearer token');
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
  app.setNotFoundHandler((req, reply) =>
    reply
      .status(404)
      .send({ error: { code: 'NOT_FOUND', message: 'route not found', requestId: req.id } }),
  );

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
  crud('/notes', notes, NoteSchema.omit({ id: true, createdAt: true, updatedAt: true }));

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
