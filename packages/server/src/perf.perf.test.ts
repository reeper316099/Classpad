import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from './app.js';

// Budgets from the spec, measured against a realistic worst case: 10k notes and 5k assignments on disk.
// Budgets are for a normal laptop; shared CI runners are slower, so they get headroom.
const SLACK = process.env.CI ? 4 : 1;
const NOTES = 10_000;
const ASSIGNMENTS = 5_000;
let dir: string;
let app: App | undefined;
let classId = '';
let startupMs = 0;
const call = async (url: string) => {
  const r = await app!.fastify.inject({
    method: 'GET',
    url: `/api/v1${url}`,
    headers: { authorization: 'Bearer t' },
  });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'classpad-perf-'));
  const seed = await createApp({ dataDir: dir, token: 't' });
  const post = async (url: string, payload: unknown) =>
    JSON.parse(
      (
        await seed.fastify.inject({
          method: 'POST',
          url: `/api/v1${url}`,
          headers: { authorization: 'Bearer t' },
          payload: payload as never,
        })
      ).body,
    );
  const sem = await post('/semesters', { name: 'Perf Term' });
  const cls = await post('/classes', { name: 'Perf Class', code: 'PRF 100', semesterId: sem.id });
  classId = cls.id;
  await seed.fastify.close();

  const now = new Date().toISOString();
  const aDir = path.join(dir, 'data/assignments', sem.slug, cls.slug);
  await mkdir(path.dirname(aDir), { recursive: true });
  await writeFile(
    `${aDir}.json`,
    JSON.stringify({
      schemaVersion: 1,
      items: Array.from({ length: ASSIGNMENTS }, (_, i) => ({
        id: `A${String(i).padStart(10, '0')}`,
        createdAt: now,
        updatedAt: now,
        classId,
        title: `Assignment ${i}`,
        weight: 1 + (i % 5),
        score: { percent: i % 101 },
        type: [],
        status: 'complete',
        priority: 'mid',
        attachmentIds: [],
        noteIds: [],
        taskIds: [],
      })),
    }),
  );
  const nDir = path.join(dir, 'data/notes/perf-class');
  await mkdir(nDir, { recursive: true });
  await Promise.all(
    Array.from({ length: NOTES }, (_, i) =>
      writeFile(
        path.join(nDir, `note-${i}.md`),
        `---\nid: N${String(i).padStart(10, '0')}\ntitle: Note ${i}\nclassId: ${classId}\ntags: []\n---\nlorem ipsum dolor ${i} sit amet entropy${i % 97}\n`,
      ),
    ),
  );
  const t0 = performance.now();
  app = await createApp({ dataDir: dir, token: 't' });
  startupMs = performance.now() - t0;
}, 120_000);
afterAll(async () => {
  await app?.fastify.close();
  await rm(dir, { recursive: true, force: true });
});

describe('performance budgets (10k notes, 5k assignments)', () => {
  it('loads everything in under 3 seconds', () => {
    expect(startupMs).toBeLessThan(3000 * SLACK);
  });
  it('searches 10k notes quickly', async () => {
    await call('/search?q=entropy42'); // warm
    const t = performance.now();
    const r = await call('/search?q=entropy42');
    const ms = performance.now() - t;
    expect(r.body.hits.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(100 * SLACK); // 50 ms budget for the index itself, plus HTTP overhead
  });
  it('recomputes a class grade over 5k assignments quickly', async () => {
    const t = performance.now();
    const r = await call(`/grades/class/${classId}`);
    const ms = performance.now() - t;
    expect(r.status).toBe(200);
    expect(ms).toBeLessThan(250 * SLACK);
  });
});
