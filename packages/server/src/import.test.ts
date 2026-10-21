import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type App } from './app.js';
import { openDir } from '@classpad/importers';

const FIX = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/synthetic/notion-export',
);
const TOKEN = 't';
const dirs: string[] = [];
const apps: App[] = [];

async function make(): Promise<{
  app: App;
  dir: string;
  call: (
    m: string,
    u: string,
    body?: unknown,
    raw?: Buffer,
  ) => Promise<{ status: number; body: any; text: string; headers: Record<string, unknown> }>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'classpad-imp-'));
  dirs.push(dir);
  const app = await createApp({ dataDir: dir, token: TOKEN });
  apps.push(app);
  const call = async (method: string, url: string, body?: unknown, raw?: Buffer) => {
    const res = await app.fastify.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(raw ? { 'content-type': 'application/zip' } : {}),
      },
      payload: (raw ?? body) as never,
    });
    let parsed: any;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      /* not json */
    }
    return {
      status: res.statusCode,
      body: parsed,
      text: res.body,
      headers: res.headers as Record<string, unknown>,
    };
  };
  return { app, dir, call };
}
afterAll(async () => {
  for (const a of apps) await a.fastify.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const fixtureZip = (): Buffer => {
  const z = new AdmZip();
  const a = openDir(FIX);
  for (const f of a.files) z.addFile(f, a.read(f));
  return z.toBuffer();
};
type Call = Awaited<ReturnType<typeof make>>['call'];
async function importNotion(call: Call, strategy = 'update_empty') {
  const p = await call('POST', '/import/preview?kind=notion', undefined, fixtureZip());
  expect(p.status).toBe(200);
  const c = await call('POST', '/import/commit', { previewId: p.body.previewId, strategy });
  expect(c.status).toBe(200);
  return { preview: p.body, commit: c.body };
}
const count = async (call: Call, c: string) =>
  (await call('GET', `/${c}?limit=1000`)).body.total as number;

describe('Notion import end to end (synthetic export)', () => {
  it('previews without writing, then commits with correct data', async () => {
    const { call, dir } = await make();
    const p = await call('POST', '/import/preview?kind=notion', undefined, fixtureZip());
    expect(p.body.counts).toMatchObject({
      semesters: 3,
      classes: 5,
      assignments: 12,
      notes: 4,
      templates: 4,
    });
    expect(p.body.validation.find((v: any) => v.className === 'DOLOR 150').status).toBe('mismatch');
    expect(await count(call, 'classes')).toBe(0); // preview wrote nothing
    const c = await call('POST', '/import/commit', { previewId: p.body.previewId });
    expect(c.body.created).toMatchObject({
      semesters: 3,
      classes: 6,
      assignments: 12,
      notes: 4,
      tasks: 3,
      readings: 2,
    });
    const lorem = (await call('GET', '/classes?name=LOREM%20101')).body.items[0];
    expect(lorem).toMatchObject({ credits: 3, type: 'core', delivery: 'in_person' });
    const g = await call('GET', `/grades/class/${lorem.id}`);
    expect(g.body.grade.percentRaw).toBe('84');
    expect(g.body.grade.letter).toBe('B');
    const nb = (await call('GET', '/notes?limit=100')).body.items.find((n: any) =>
      n.title.startsWith('Lecture 1'),
    );
    expect(nb.markdown).toContain('$E = mc^2$');
    expect(nb.markdown).toMatch(/attachment:\/\/[0-9a-f]{64}\.png/);
    expect(nb.assignmentIds).toHaveLength(1);
    const att = (await call('GET', '/attachments')).body.items;
    expect(att).toHaveLength(1);
    await readFile(path.join(dir, att[0].path));
    const tpl = await readdir(path.join(dir, 'config/templates/assignments'));
    expect(tpl.sort()).toEqual(['essay-template.md', 'group-project.md']);
    expect(
      await readFile(path.join(dir, 'config/templates/assignments/essay-template.md'), 'utf8'),
    ).not.toMatch(/tooltip/i);
    const cap = (await call('GET', '/assignments?limit=100')).body.items.find(
      (a: any) => a.title === 'Capstone Draft',
    );
    expect(cap.noteIds).toHaveLength(1);
  });

  it('re-import is idempotent (nothing duplicated)', async () => {
    const { call } = await make();
    await importNotion(call);
    const before = await Promise.all(
      ['semesters', 'classes', 'assignments', 'notes', 'tasks', 'readings', 'attachments'].map(
        (c) => count(call, c),
      ),
    );
    const again = await importNotion(call);
    expect(Object.values(again.commit.created).every((n) => n === 0)).toBe(true);
    const after = await Promise.all(
      ['semesters', 'classes', 'assignments', 'notes', 'tasks', 'readings', 'attachments'].map(
        (c) => count(call, c),
      ),
    );
    expect(after).toEqual(before);
  });

  it('strategies: update_empty keeps my edits, overwrite replaces, skip ignores, keep_both duplicates', async () => {
    const { call } = await make();
    await importNotion(call);
    const get = async () =>
      (await call('GET', '/assignments?limit=100')).body.items.find(
        (a: any) => a.title === 'Final Exam',
      );
    const fe = await get();
    await call('PATCH', `/assignments/${fe.id}`, {
      weight: 55,
      quickNotes: undefined,
      link: 'https://example.invalid/mine',
    });
    await importNotion(call, 'update_empty');
    expect((await get()).weight).toBe(55);
    expect((await get()).link).toBe('https://example.invalid/mine');
    await importNotion(call, 'skip');
    expect((await get()).weight).toBe(55);
    await importNotion(call, 'overwrite');
    expect((await get()).weight).toBe(50);
    const n = await count(call, 'assignments');
    const kb = await importNotion(call, 'keep_both');
    expect(kb.commit.created.assignments).toBe(12);
    expect(await count(call, 'assignments')).toBe(n + 12);
  });

  it('update_empty fills fields that I cleared', async () => {
    const { call } = await make();
    await importNotion(call);
    const fe = (await call('GET', '/assignments?limit=100')).body.items.find(
      (a: any) => a.title === 'Midterm Exam',
    );
    expect((await call('PATCH', `/assignments/${fe.id}`, { weight: 0 })).status).toBe(200);
    const cls = (await call('GET', '/classes?name=AMET%20310')).body.items[0];
    await call('PATCH', `/classes/${cls.id}`, { location: '' });
    await importNotion(call, 'update_empty');
    expect((await call('GET', `/classes/${cls.id}`)).body.location).toBe('Room 4');
  });

  it('undo removes created data and restores edited data; twice is rejected', async () => {
    const { call, dir } = await make();
    const first = await importNotion(call);
    const fe = (await call('GET', '/assignments?limit=100')).body.items.find(
      (a: any) => a.title === 'Final Exam',
    );
    await call('PATCH', `/assignments/${fe.id}`, { weight: 55 });
    const second = await importNotion(call, 'overwrite');
    expect((await call('GET', `/assignments/${fe.id}`)).body.weight).toBe(50);
    expect((await call('POST', `/import/undo/${second.commit.importId}`)).status).toBe(200);
    expect((await call('GET', `/assignments/${fe.id}`)).body.weight).toBe(55);
    expect((await call('POST', `/import/undo/${second.commit.importId}`)).status).toBe(409);
    expect((await call('POST', `/import/undo/${first.commit.importId}`)).status).toBe(200);
    for (const c of [
      'semesters',
      'classes',
      'assignments',
      'notes',
      'tasks',
      'readings',
      'attachments',
    ])
      expect(await count(call, c)).toBe(0);
    expect(await readdir(path.join(dir, 'config/templates/assignments')).catch(() => [])).toEqual(
      [],
    );
    expect((await call('GET', '/import/history')).body).toHaveLength(2);
    expect((await call('POST', '/import/undo/not-an-id')).status).toBe(400);
  });

  it('undo keeps a class that gained assignments after the import', async () => {
    const { call } = await make();
    const imp = await importNotion(call);
    const cls = (await call('GET', '/classes?name=SITAM%20099')).body.items[0];
    await call('POST', '/assignments', { classId: cls.id, title: 'Added by me' });
    const u = await call('POST', `/import/undo/${imp.commit.importId}`);
    expect(u.body.warnings.join()).toMatch(/Kept a class/);
    expect((await call('GET', `/classes/${cls.id}`)).status).toBe(200);
  });

  it('rejects non-zip uploads and unauthenticated calls', async () => {
    const { call, app } = await make();
    expect(
      (await call('POST', '/import/preview?kind=notion', undefined, Buffer.from('not a zip')))
        .status,
    ).toBe(422);
    expect((await call('POST', '/import/commit', { previewId: 'nope' })).status).toBe(404);
    const r = await app.fastify.inject({ method: 'GET', url: '/api/v1/export/json' });
    expect(r.statusCode).toBe(401);
  });
});

describe('other import paths', () => {
  it('CSV import attaches to existing classes by name; ICS and Markdown folder import', async () => {
    const { call } = await make();
    const sem = (await call('POST', '/semesters', { name: 'Term One' })).body.id;
    await call('POST', '/classes', { semesterId: sem, name: 'Lorem Studies', code: 'LS 100' });
    const csv =
      'title,class,due,weight,score\nEssay,Lorem Studies,2031-10-01,20,90\nOrphan,Unknown Class,2031-10-02,5,\n';
    const p = await call('POST', '/import/preview', {
      kind: 'csv',
      collection: 'assignments',
      text: csv,
    });
    const c = await call('POST', '/import/commit', { previewId: p.body.previewId });
    expect(c.body.created.assignments).toBe(2);
    expect(c.body.warnings.join()).toMatch(/Orphan.*Unassigned/);
    expect((await call('GET', '/classes?name=Unassigned')).body.total).toBe(1);
    const lc = (await call('GET', '/classes')).body.items[0];
    expect((await call('GET', `/grades/class/${lc.id}`)).body.grade.percentRaw).toBe('90');

    const ics =
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x1\r\nSUMMARY:Campus event\r\nDTSTART;VALUE=DATE:20311105\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const pi = await call('POST', '/import/preview', { kind: 'ics', text: ics });
    await call('POST', '/import/commit', { previewId: pi.body.previewId });
    expect((await call('GET', '/tasks')).body.items[0]).toMatchObject({
      title: 'Campus event',
      date: '2031-11-05',
    });

    const z = new AdmZip();
    z.addFile('Lorem Studies/Idea.md', Buffer.from('---\ntags: [x]\n---\nHello [[Other]]\n'));
    const pm = await call('POST', '/import/preview?kind=markdown', undefined, z.toBuffer());
    await call('POST', '/import/commit', { previewId: pm.body.previewId });
    const note = (await call('GET', '/notes')).body.items[0];
    expect(note).toMatchObject({ title: 'Idea', classId: lc.id });
    expect(note.tags).toContain('x');
  });

  it('JSON backup export restores into a fresh data directory', async () => {
    const a = await make();
    await importNotion(a.call);
    const backup = (await a.call('GET', '/export/json')).text;
    const b = await make();
    const p = await b.call('POST', '/import/preview', { kind: 'json', text: backup });
    expect(p.status).toBe(200);
    const c = await b.call('POST', '/import/commit', { previewId: p.body.previewId });
    expect(c.body.created).toMatchObject({ semesters: 3, classes: 6, assignments: 12, notes: 4 });
    const lorem = (await b.call('GET', '/classes?name=LOREM%20101')).body.items[0];
    expect((await b.call('GET', `/grades/class/${lorem.id}`)).body.grade.percentRaw).toBe('84');
    const again = await b.call('POST', '/import/preview', { kind: 'json', text: backup });
    expect(
      (
        await b.call('POST', '/import/commit', {
          previewId: again.body.previewId,
          strategy: 'skip',
        })
      ).body.created.classes,
    ).toBe(0);
    expect(
      (await b.call('POST', '/import/preview', { kind: 'json', text: '{"format":"nope"}' })).status,
    ).toBe(422);
  });
});

describe('exports', () => {
  it('CSV export round-trips through the CSV importer', async () => {
    const { call } = await make();
    await importNotion(call);
    for (const coll of ['assignments', 'classes', 'tasks', 'readings', 'semesters']) {
      const csv = (await call('GET', `/export/csv/${coll}`)).text;
      const p = await call('POST', '/import/preview', { kind: 'csv', collection: coll, text: csv });
      expect(p.body.counts[coll]).toBe(await count(call, coll));
    }
    const tpl = await call('GET', '/import/templates/assignments');
    expect(tpl.text).toContain('title,class,due');
  });
  it('ICS export has deadlines and weekly timetable events', async () => {
    const { call } = await make();
    await importNotion(call);
    const ics = (await call('GET', '/export/ics?kind=all')).text;
    expect(ics).toContain('SUMMARY:Midterm Exam');
    expect(ics).toContain('DTSTART:20311020T090000');
    expect(ics).toMatch(/RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20311212T235959/);
    expect((await call('GET', '/export/ics?kind=deadlines')).text).not.toContain('RRULE');
  });
  it('Markdown vault zip has frontmatter notes by class and bundled attachments', async () => {
    const { call, app } = await make();
    await importNotion(call);
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/v1/export/markdown',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.headers['content-type']).toBe('application/zip');
    const zip = new AdmZip(res.rawPayload);
    const names = zip.getEntries().map((e) => e.entryName);
    const lecture = names.find((n) => n.startsWith('lorem-101/') && n.includes('lecture-1'))!;
    expect(lecture).toBeTruthy();
    const text = zip.readAsText(lecture);
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('title: Lecture 1 - Lorem Basics');
    expect(text).toContain('class: LOREM 101');
    expect(text).toMatch(/!\[Figure 1\]\(\.\.\/attachments\/[0-9a-f]{64}\.png\)/);
    expect(text).toContain('[[Lecture 2 - Ipsum Deep Dive]]');
    expect(names.some((n) => /^attachments\/[0-9a-f]{64}\.png$/.test(n))).toBe(true);
    // and it can be imported back as a Markdown folder
    const back = await call('POST', '/import/preview?kind=markdown', undefined, res.rawPayload);
    expect(back.body.counts.notes).toBe(4);
  });
  it('printable report shows the breakdown and escapes names', async () => {
    const { call } = await make();
    await importNotion(call);
    const sem = (await call('GET', '/semesters')).body.items[0].id;
    await call('POST', '/classes', { semesterId: sem, name: '<script>alert(1)</script>' });
    const html = (await call('GET', '/export/report')).text;
    expect(html).toContain('How this was calculated');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain("default-src 'none'");
    expect((await call('GET', '/export/report?hide=1')).text).toContain('blur');
  });
});

describe('attachments', () => {
  it('stores content-addressed files, dedupes, and serves unsafe types as downloads', async () => {
    const { call, dir } = await make();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==',
      'base64',
    );
    const a = await call('POST', '/attachments', {
      filename: '../../evil name.png',
      dataBase64: png.toString('base64'),
    });
    expect(a.body.path).toMatch(/^attachments\/[0-9a-f]{64}\.png$/);
    expect(a.body.filename).not.toMatch(/[\\/]/);
    const b = await call('POST', '/attachments', {
      filename: 'other.png',
      dataBase64: png.toString('base64'),
    });
    expect(b.body.id).toBe(a.body.id);
    await readFile(path.join(dir, a.body.path));
    const f = await call('GET', `/attachments/${a.body.id}/file`);
    expect(f.headers['content-type']).toBe('image/png');
    expect(String(f.headers['content-disposition'])).toMatch(/^inline/);
    expect(f.headers['x-content-type-options']).toBe('nosniff');
    const svg = await call('POST', '/attachments', {
      filename: 'x.svg',
      dataBase64: Buffer.from('<svg onload="alert(1)"/>').toString('base64'),
    });
    const sf = await call('GET', `/attachments/${svg.body.id}/file`);
    expect(sf.headers['content-type']).toBe('application/octet-stream');
    expect(String(sf.headers['content-disposition'])).toMatch(/^attachment/);
    expect((await call('DELETE', `/attachments/${a.body.id}`)).status).toBe(204);
  });
});
