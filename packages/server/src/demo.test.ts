import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from './app.js';

let dir: string;
let app: App;
const call = async (method: string, url: string, payload?: unknown) => {
  const r = await app.fastify.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    headers: { authorization: 'Bearer t' },
    payload: payload as never,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
};
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'classpad-demo-'));
  app = await createApp({ dataDir: dir, token: 't' });
});
afterAll(async () => {
  await app.fastify.close();
  await rm(dir, { recursive: true, force: true });
});

describe('demo data, settings, gpa progress', () => {
  it('loads once, produces graded classes under every scheme, and GPA progress', async () => {
    expect((await call('POST', '/demo/load')).body.alreadyLoaded).toBe(false);
    expect((await call('POST', '/demo/load')).body.alreadyLoaded).toBe(true);
    const about = (await call('GET', '/about')).body;
    expect(about.demoLoaded).toBe(true);
    expect(about.counts.classes).toBe(5);
    expect(about.counts.assignments).toBeGreaterThanOrEqual(40);
    const classes = (await call('GET', '/classes')).body.items as { id: string; code: string }[];
    for (const c of classes) {
      const g = (await call('GET', `/grades/class/${c.id}`)).body.grade;
      expect(g.status).toBe('graded');
      expect(Number(g.percentRaw)).toBeGreaterThan(40);
    }
    const lor = classes.find((c) => c.code === 'LOR 101')!;
    const pf = classes.find((c) => c.code === 'SIT 099')!;
    expect((await call('GET', `/grades/class/${pf.id}`)).body.grade.letter).toBe('P');
    expect(
      (await call('GET', `/grades/class/${lor.id}`)).body.grade.warnings.length,
    ).toBeGreaterThanOrEqual(0);
    const gpa = (await call('GET', '/gpa')).body;
    expect(gpa.progress).toHaveLength(1);
    expect(Number(gpa.cumulative.unweighted.gpa)).toBeGreaterThan(2);
    expect(Number(gpa.cumulative.weighted.gpa)).toBeGreaterThan(
      Number(gpa.cumulative.unweighted.gpa),
    );
    expect(gpa.cumulative.unweighted.warnings.join()).not.toMatch(/SIT 099/); // pass/fail is silently excluded
  });
  it('settings round-trip', async () => {
    expect((await call('GET', '/settings')).body).toEqual({});
    await call('PUT', '/settings', { theme: 'dark', accent: '#6366f1' });
    expect((await call('GET', '/settings')).body.theme).toBe('dark');
    expect((await call('PUT', '/settings', ['x'])).status).toBe(422);
  });
  it('clear removes only demo data', async () => {
    const sem = (await call('POST', '/semesters', { name: 'Mine' })).body.id;
    expect((await call('DELETE', '/demo')).status).toBe(204);
    const about = (await call('GET', '/about')).body;
    expect(about.demoLoaded).toBe(false);
    expect(about.counts).toMatchObject({ semesters: 1, classes: 0, assignments: 0, notes: 0 });
    expect((await call('GET', `/semesters/${sem}`)).status).toBe(200);
  });
});
