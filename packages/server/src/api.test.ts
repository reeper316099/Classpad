import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from './app.js';

let dir: string;
let app: App;
const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}` };

async function call(
  method: string,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = auth,
) {
  const res = await app.fastify.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    payload: payload as never,
    headers,
  });
  const body = res.body ? JSON.parse(res.body) : undefined;
  return { status: res.statusCode, body };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'classpad-api-'));
  app = await createApp({ dataDir: dir, token: TOKEN, watch: true, dev: true });
});
afterAll(async () => {
  await app.fastify.close();
  await rm(dir, { recursive: true, force: true });
});

describe('auth and errors', () => {
  it('rejects requests without a valid token', async () => {
    expect((await call('GET', '/semesters', undefined, {})).status).toBe(401);
    expect(
      (await call('GET', '/semesters', undefined, { authorization: 'Bearer nope' })).status,
    ).toBe(401);
    const r = await call('GET', '/semesters', undefined, {});
    expect(r.body.error.code).toBe('UNAUTHORIZED');
    expect(r.body.error.requestId).toBeTruthy();
  });
  it('unknown routes 404 only after auth, with the standard shape', async () => {
    expect((await call('GET', '/nope', undefined, {})).status).toBe(401);
    const r = await call('GET', '/nope');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });
  it('validates input with a uniform 422', async () => {
    const r = await call('POST', '/semesters', { name: '' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('VALIDATION');
  });
  it('serves OpenAPI in dev', async () => {
    const r = await call('GET', '/openapi.json');
    expect(r.body.paths['/api/v1/grades/needed'].post.requestBody).toBeTruthy();
  });
});

describe('CRUD and persistence layout', () => {
  let semId: string, classId: string, asgId: string;
  it('creates semester, class, assignment with on-disk files', async () => {
    const s = await call('POST', '/semesters', {
      name: 'Fall 2026',
      start: '2026-08-24',
      end: '2026-12-11',
      isCurrent: true,
    });
    expect(s.status).toBe(200);
    semId = s.body.id;
    expect(s.body.slug).toBe('fall-2026');
    const c = await call('POST', '/classes', {
      semesterId: semId,
      name: 'Intro Writing',
      code: 'ARTS 110',
      credits: 3,
    });
    classId = c.body.id;
    expect(c.body.slug).toBe('arts-110');
    const a = await call('POST', '/assignments', {
      classId,
      title: 'Essay 1',
      weight: 20,
      type: ['essay'],
      due: '2026-09-15',
    });
    asgId = a.body.id;
    const file = JSON.parse(
      await readFile(path.join(dir, 'data/assignments/fall-2026/arts-110.json'), 'utf8'),
    );
    expect(file.items[0].title).toBe('Essay 1');
    expect(file.schemaVersion).toBe(1);
    await readFile(path.join(dir, 'data/classes/fall-2026.json'), 'utf8');
  });
  it('rejects dangling references', async () => {
    const r = await call('POST', '/assignments', { classId: 'missing', title: 'x' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('BAD_REFERENCE');
  });
  it('lists with filter, sort and paging; patch ignores id/createdAt', async () => {
    await call('POST', '/assignments', { classId, title: 'Quiz', weight: 10, type: ['quiz'] });
    const l = await call('GET', `/assignments?classId=${classId}&sort=title&order=desc&limit=1`);
    expect(l.body.total).toBe(2);
    expect(l.body.items).toHaveLength(1);
    expect(l.body.items[0].title).toBe('Quiz');
    const created = (await call('GET', `/assignments/${asgId}`)).body.createdAt;
    const p = await call('PATCH', `/assignments/${asgId}`, {
      id: 'hack',
      createdAt: 'x',
      priority: 'important',
    });
    expect(p.body.id).toBe(asgId);
    expect(p.body.createdAt).toBe(created);
    expect(p.body.priority).toBe('important');
  });
  it('moving a class to another semester moves its assignments file too', async () => {
    const s2 = (await call('POST', '/semesters', { name: 'Spring 2027' })).body.id;
    await call('PATCH', `/classes/${classId}`, { semesterId: s2 });
    await readFile(path.join(dir, 'data/assignments/spring-2027/arts-110.json'), 'utf8');
    await expect(
      readFile(path.join(dir, 'data/assignments/fall-2026/arts-110.json')),
    ).rejects.toThrow();
    await call('PATCH', `/classes/${classId}`, { semesterId: semId });
  });
  it('deleting a class cascades and backs up first', async () => {
    const c2 = (await call('POST', '/classes', { semesterId: semId, name: 'Temp' })).body.id;
    await call('POST', '/assignments', { classId: c2, title: 'a' });
    await call('POST', '/assignments', { classId: c2, title: 'b' });
    expect((await call('DELETE', `/classes/${c2}`)).status).toBe(204);
    expect((await call('GET', `/assignments?classId=${c2}`)).body.total).toBe(0);
    expect((await call('GET', `/classes/${c2}`)).status).toBe(404);
  });
});

describe('grades via the API', () => {
  let classId: string;
  it('worked example A: current grade, what-if and needed score', async () => {
    const semId = (await call('POST', '/semesters', { name: 'Grades Sem' })).body.id;
    classId = (await call('POST', '/classes', { semesterId: semId, name: 'Calc', credits: 4 })).body
      .id;
    const mk = (title: string, weight: number, percent?: number) =>
      call('POST', '/assignments', {
        classId,
        title,
        weight,
        ...(percent === undefined ? {} : { score: { percent } }),
      });
    await mk('A1', 20, 90);
    await mk('A2', 30, 80);
    const fin = (await mk('Final', 50)).body.id;
    const g = await call('GET', `/grades/class/${classId}`);
    expect(g.body.grade.percentRaw).toBe('84');
    expect(g.body.grade.letter).toBe('B');
    expect(g.body.grade.steps.length).toBeGreaterThan(2);
    const w = await call('POST', '/grades/what-if', {
      classId,
      overrides: { [fin]: { kind: 'percent', percent: 100 } },
    });
    expect(w.body.hypothetical.percentRaw).toBe('92');
    expect((await call('GET', `/assignments/${fin}`)).body.score).toBeUndefined(); // never persisted
    const n = await call('POST', '/grades/needed', { classId, target: 90 });
    expect(n.body.required).toBe('96');
    expect(n.body.feasibility).toBe('achievable');
    const nl = await call('POST', '/grades/needed', { classId, target: { letter: 'A-' } });
    expect(nl.body.required).toBe('96');
  });
  it('a class with no graded work reports it, never NaN', async () => {
    const semId = (await call('POST', '/semesters', { name: 'Empty Sem' })).body.id;
    const c = (await call('POST', '/classes', { semesterId: semId, name: 'Empty' })).body.id;
    const g = await call('GET', `/grades/class/${c}`);
    expect(g.body.grade.status).toBe('none');
    expect(g.body.grade.summary).toBe('No graded work yet');
  });
  it('worked example C: GPA unweighted 3.7, weighted 4.1', async () => {
    const semId = (await call('POST', '/semesters', { name: 'GPA Sem', start: '2030-01-01' })).body
      .id;
    const mk = async (name: string, credits: number, pct: number, honorsLevel = 'regular') => {
      const c = (await call('POST', '/classes', { semesterId: semId, name, credits, honorsLevel }))
        .body.id;
      await call('POST', '/assignments', {
        classId: c,
        title: 't',
        weight: 100,
        score: { percent: pct },
      });
    };
    await mk('G1', 4, 95, 'ap');
    await mk('G2', 3, 88);
    await mk('G3', 3, 91);
    const r = await call('GET', `/gpa?semesterId=${semId}`);
    const sem = r.body.semesters.find((s: { semesterId: string }) => s.semesterId === semId);
    expect(sem.unweighted.gpa).toBe('3.7');
    expect(sem.weighted.gpa).toBe('4.1');
    const sm = await call('GET', `/grades/semester/${semId}`);
    expect(sm.body.classes).toHaveLength(3);
    expect(sm.body.gpa.gpa).toBe('3.7');
    const plan = await call('POST', '/gpa/plan', { targetGpa: 3.9, plannedCredits: 10 });
    expect(plan.status).toBe(200);
  });
  it('grading schemes round-trip and are validated', async () => {
    const cur = (await call('GET', '/grading-schemes')).body;
    expect(cur.map((s: { id: string }) => s.id)).toContain('default');
    expect((await call('PUT', '/grading-schemes', [{ id: 'x' }])).status).toBe(422);
    expect((await call('PUT', '/grading-schemes', cur)).status).toBe(200);
  });
});

describe('notes as Markdown files and search', () => {
  it('writes frontmatter .md under the class folder and finds it with operators', async () => {
    const semId = (await call('POST', '/semesters', { name: 'Notes Sem' })).body.id;
    const classId = (
      await call('POST', '/classes', { semesterId: semId, name: 'Physics', code: 'PHYS 101' })
    ).body.id;
    const n = await call('POST', '/notes', {
      title: 'Kinematics',
      classId,
      tags: ['exam1'],
      markdown: 'The equation $v = u + at$ relates velocity.\n',
    });
    expect(n.status).toBe(200);
    const text = await readFile(path.join(dir, 'data/notes/phys-101/kinematics.md'), 'utf8');
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('title: Kinematics');
    expect(text).toContain('v = u + at');
    const s = await call(
      'GET',
      `/search?q=${encodeURIComponent('velocity class:physics tag:exam1')}`,
    );
    expect(s.body.hits[0].id).toBe(n.body.id);
    expect(
      (await call('GET', `/search?q=${encodeURIComponent('velocity class:chemistry')}`)).body.hits,
    ).toHaveLength(0);
    expect(
      (await call('GET', `/search?q=${encodeURIComponent('type:note')}`)).body.hits.length,
    ).toBeGreaterThan(0);
    // moving to another class moves the file
    const c2 = (await call('POST', '/classes', { semesterId: semId, name: 'Chem', code: 'CHEM 1' }))
      .body.id;
    await call('PATCH', `/notes/${n.body.id}`, { classId: c2 });
    await readFile(path.join(dir, 'data/notes/chem-1/kinematics.md'), 'utf8');
    await expect(readFile(path.join(dir, 'data/notes/phys-101/kinematics.md'))).rejects.toThrow();
    await call('DELETE', `/notes/${n.body.id}`);
    expect((await call('GET', `/search?q=velocity`)).body.hits).toHaveLength(0);
  });
  it('JS frontmatter is never executed (treated as plain text)', async () => {
    await writeFile(path.join(dir, 'data/notes/evil.md'), '---js\n{ title: "x" }\n---\nbody');
    await expect(app.ctx.notes.reloadFile('data/notes/evil.md')).resolves.toBe(true);
    const n = app.ctx.notes.list().find((x) => x.title === 'evil');
    expect(n?.markdown).toContain('---js');
  });
});

describe('hand edits', () => {
  it('reload live; invalid edits never clobber memory', async () => {
    const semId = (await call('POST', '/semesters', { name: 'Edit Sem' })).body.id;
    const file = path.join(dir, 'data/semesters.json');
    const doc = JSON.parse(await readFile(file, 'utf8'));
    doc.items.find((s: { id: string }) => s.id === semId).name = 'Renamed By Hand';
    await writeFile(file, JSON.stringify(doc));
    await new Promise((r) => setTimeout(r, 700));
    expect((await call('GET', `/semesters/${semId}`)).body.name).toBe('Renamed By Hand');
    await writeFile(file, '{ "schemaVersion": 1, oops');
    await new Promise((r) => setTimeout(r, 700));
    expect((await call('GET', `/semesters/${semId}`)).body.name).toBe('Renamed By Hand');
    const act = (await call('GET', '/activity')).body as { kind: string; message?: string }[];
    expect(
      act.some((e) => e.kind === 'invalid-edit' && e.message?.includes('semesters.json')),
    ).toBe(true);
  });
});

describe('performance smoke', () => {
  it('search over 10k docs < 50 ms and grade recompute over 5k items < 20 ms', async () => {
    const { SearchIndex } = await import('./search.js');
    const { computeGrade, defaultScheme } = await import('@classpad/grades');
    const idx = new SearchIndex();
    idx.rebuild(
      Array.from({ length: 10_000 }, (_, i) => ({
        id: `n${i}`,
        kind: 'note' as const,
        title: `Note ${i} topic${i % 50}`,
        body: `lorem ipsum dolor ${i} sit amet entropy${i % 97}`,
        tags: [],
        types: [],
      })),
    );
    const t0 = performance.now();
    const hits = idx.search('entropy42', () => new Set());
    const searchMs = performance.now() - t0;
    expect(hits.length).toBeGreaterThan(0);
    expect(searchMs).toBeLessThan(50);
    const items = Array.from({ length: 5_000 }, (_, i) => ({
      id: `a${i}`,
      weight: 1 + (i % 5),
      score: { kind: 'percent' as const, percent: i % 101 },
    }));
    const t1 = performance.now();
    computeGrade(defaultScheme(), items);
    expect(performance.now() - t1).toBeLessThan(200); // generous in CI; target is 20 ms on dev hardware
  });
});

describe('per-class grading schemes', () => {
  it('saves one scheme without touching the others, and a class can use it', async () => {
    const before = (await call('GET', '/grading-schemes')).body as { id: string }[];
    const sem = (await call('POST', '/semesters', { name: 'Scheme Term' })).body as { id: string };
    const cls = (await call('POST', '/classes', { name: 'Cat Class', semesterId: sem.id }))
      .body as { id: string };
    const scale = (before[0] as never as { scale: unknown }).scale;
    const scheme = {
      id: `class-${cls.id}`,
      name: 'Cat Class categories',
      mode: 'category_weights',
      categories: [
        { id: 'hw', name: 'Homework', weight: 30, dropLowest: 1 },
        { id: 'ex', name: 'Exams', weight: 70 },
      ],
      scale,
      normalizeOverGradedOnly: true,
      extraCreditAllowed: true,
    };
    const put = await call('PUT', `/grading-schemes/${scheme.id}`, scheme);
    expect(put.status).toBe(200);
    const after = (await call('GET', '/grading-schemes')).body as { id: string }[];
    expect(after).toHaveLength(before.length + 1);
    expect(after.map((s) => s.id)).toEqual(expect.arrayContaining(before.map((s) => s.id)));
    await call('PATCH', `/classes/${cls.id}`, { gradingSchemeId: scheme.id });
    for (const [title, cat, score] of [
      ['HW1', 'hw', 100],
      ['HW2', 'hw', 80],
      ['Final', 'ex', 90],
    ] as const)
      await call('POST', '/assignments', {
        title,
        classId: cls.id,
        categoryId: cat,
        score: { percent: score },
      });
    const g = (await call('GET', `/grades/class/${cls.id}`)).body as {
      grade: { percentRaw: string };
    };
    // homework: drop the lowest (80) -> 100; exams 90: 100*30 + 90*70 = 93
    expect(Number(g.grade.percentRaw)).toBeCloseTo(93);
    // updating it replaces in place
    const again = await call('PUT', `/grading-schemes/${scheme.id}`, {
      ...scheme,
      name: 'Renamed',
    });
    expect(again.status).toBe(200);
    expect(
      ((await call('GET', '/grading-schemes')).body as { id: string; name: string }[]).filter(
        (s) => s.id === scheme.id,
      ),
    ).toHaveLength(1);
  });
  it('rejects a mismatched id', async () => {
    const [first] = (await call('GET', '/grading-schemes')).body as { id: string }[];
    const r = await call('PUT', '/grading-schemes/other', first);
    expect(r.status).toBe(422);
  });
});
