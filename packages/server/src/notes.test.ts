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
  dir = await mkdtemp(path.join(tmpdir(), 'classpad-notes-'));
  app = await createApp({ dataDir: dir, token: 't' });
});
afterAll(async () => {
  await app.fastify.close();
  await rm(dir, { recursive: true, force: true });
});

describe('wiki links, backlinks and search snippets', () => {
  it('resolves links (case/accent-insensitive, same class first) and lists backlinks', async () => {
    const sem = (await call('POST', '/semesters', { name: 'S' })).body.id;
    const a = (await call('POST', '/classes', { semesterId: sem, name: 'A' })).body.id;
    const b = (await call('POST', '/classes', { semesterId: sem, name: 'B' })).body.id;
    const inA = (
      await call('POST', '/notes', { title: 'Café Notes', classId: a, markdown: 'in A' })
    ).body;
    const inB = (
      await call('POST', '/notes', { title: 'Cafe notes', classId: b, markdown: 'in B' })
    ).body;
    const src = (
      await call('POST', '/notes', {
        title: 'Source',
        classId: b,
        markdown: 'Read [[cafe NOTES]] and `[[Code Only]]` today.',
      })
    ).body;
    expect((await call('GET', '/notes/resolve?title=cafe%20notes&classId=' + b)).body.id).toBe(
      inB.id,
    );
    expect((await call('GET', '/notes/resolve?title=cafe%20notes&classId=' + a)).body.id).toBe(
      inA.id,
    );
    expect((await call('GET', '/notes/resolve?title=missing')).body).toBeNull();
    const bl = (await call('GET', `/notes/${inB.id}/backlinks`)).body;
    expect(bl).toHaveLength(1);
    expect(bl[0].id).toBe(src.id);
    expect(bl[0].snippet).toContain('[[cafe NOTES]]');
    expect((await call('GET', `/notes/${inA.id}/backlinks`)).body).toHaveLength(0);
    expect((await call('GET', '/notes/nope/backlinks')).status).toBe(404);
  });
  it('search hits include a snippet around the match', async () => {
    await call('POST', '/notes', {
      title: 'Thermo',
      markdown: 'Entropy never decreases in an isolated system, which is the second law.',
    });
    const hits = (await call('GET', '/search?q=entropy')).body.hits;
    expect(hits[0].snippet).toMatch(/Entropy never decreases/);
  });
});

describe('templates', () => {
  it('seeds defaults once, and supports create/update/delete with id validation', async () => {
    const list = (await call('GET', '/templates/notes')).body;
    expect(list.map((t: { id: string }) => t.id)).toEqual(
      expect.arrayContaining(['lecture', 'cornell', 'lab-report', 'reading-notes', 'problem-set']),
    );
    expect(list.find((t: { id: string }) => t.id === 'lecture').markdown).toContain('{{title}}');
    const made = (
      await call('POST', '/templates/notes', { name: 'My Template', markdown: '# {{title}}' })
    ).body;
    expect(made.id).toBe('my-template');
    await call('PUT', '/templates/notes/my-template', { name: 'Renamed', markdown: 'x' });
    expect(
      (await call('GET', '/templates/notes')).body.find(
        (t: { id: string }) => t.id === 'my-template',
      ).name,
    ).toBe('Renamed');
    expect((await call('DELETE', '/templates/notes/my-template')).status).toBe(204);
    expect((await call('DELETE', '/templates/notes/..%2F..%2Fx')).status).toBe(400);
    expect((await call('PUT', '/templates/notes/Bad_Id', { name: 'x', markdown: '' })).status).toBe(
      400,
    );
    // a second app start must not overwrite edits
    await call('PUT', '/templates/notes/lecture', { name: 'Lecture notes', markdown: 'CUSTOM' });
    await app.ctx.close();
    app = await createApp({ dataDir: dir, token: 't' });
    expect(
      (await call('GET', '/templates/notes')).body.find((t: { id: string }) => t.id === 'lecture')
        .markdown,
    ).toBe('CUSTOM\n');
  });
});
