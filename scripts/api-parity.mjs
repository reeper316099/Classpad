#!/usr/bin/env node
// Runs the same scripted session against the TypeScript API (packages/server) and the Go API
// (cmd/classpad-server), each on its own empty data folder, and compares every response: status,
// content type and body. Ids, timestamps and request ids differ between runs, so they are replaced by
// placeholders (ids by order of first appearance) before comparing. All data is invented.
//
//   npx tsc -b packages/server && go build -o /tmp/classpad-server ./cmd/classpad-server
//   node scripts/api-parity.mjs --go /tmp/classpad-server [--keep]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { createInterface } from 'node:readline';

process.env.TZ = 'America/New_York'; // both servers read local dates; pin the zone
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const GO = arg('go');
if (!GO) throw new Error('--go <path to classpad-server> is required');
const keep = process.argv.includes('--keep');
const { startServer } = await import('../packages/server/dist/index.js');

const TOKEN = 'parity-token';
const root = mkdtempSync(path.join(tmpdir(), 'classpad-api-parity-'));

async function startTs() {
  const dataDir = path.join(root, 'ts');
  const s = await startServer({ dataDir, token: TOKEN, watch: false, port: 0 });
  return { url: s.url, dataDir, close: () => s.close() };
}

async function startGo() {
  const dataDir = path.join(root, 'go');
  const child = spawn(GO, ['--data-dir', dataDir, '--watch=false', '--exit-with-stdin'], {
    env: { ...process.env, CLASSPAD_TOKEN: TOKEN },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const line = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (c) => reject(new Error(`classpad-server exited (${c})`)));
    createInterface({ input: child.stdout }).once('line', resolve);
  });
  const ready = JSON.parse(line);
  return {
    url: ready.url,
    dataDir,
    close: () =>
      new Promise((resolve) => {
        child.removeAllListeners('exit');
        child.once('exit', resolve);
        child.stdin.end();
      }),
  };
}

// ---------------------------------------------------------------- the session
// `api` sends a request and records the response; the script reads ids from its own server's answers.
async function session(api, scratch) {
  const H = { authorization: `Bearer ${TOKEN}` };
  const json = (method, url, body, extra = {}) =>
    api(method, url, {
      headers: { ...H, 'content-type': 'application/json', ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const get = (url, headers = H) => api('GET', url, { headers });
  const del = (url) => api('DELETE', url, { headers: H });

  // auth, host and routing
  await get('/api/v1/health', {});
  await get('/api/v1/health', { authorization: 'Bearer wrong' });
  await get('/api/v1/health', { ...H, host: 'evil.example:80' });
  await get('/api/v1/nope');
  await api('PUT', '/api/v1/health', { headers: H });
  await get('/api/v1/about');

  // empty data
  for (const c of ['semesters', 'classes', 'assignments', 'tasks', 'readings', 'notes', 'journal'])
    await get(`/api/v1/${c}`);
  await get('/api/v1/gpa');
  await get('/api/v1/deadlines');
  await get('/api/v1/study/decks');

  // body handling and validation
  await api('POST', '/api/v1/semesters', {
    headers: { ...H, 'content-type': 'application/json' },
    body: '{"name":',
  });
  await api('POST', '/api/v1/semesters', {
    headers: { ...H, 'content-type': 'application/json' },
    body: '',
  });
  await api('POST', '/api/v1/semesters', { headers: H });
  await api('POST', '/api/v1/semesters', {
    headers: { ...H, 'content-type': 'text/plain' },
    body: 'hello',
  });
  await json('POST', '/api/v1/semesters', { name: '' });
  await json('POST', '/api/v1/semesters', [1, 2]);
  await json('POST', '/api/v1/semesters', { name: 'X', start: 'not a date' });
  await json('POST', '/api/v1/classes', { name: 'Orphan', semesterId: 'missing' });
  await get('/api/v1/semesters/' + 'x'.repeat(65));
  await get('/api/v1/semesters/missing');
  await del('/api/v1/semesters/missing');

  // demo data and everything that reads it
  const demo = await json('POST', '/api/v1/demo/load', {});
  await json('POST', '/api/v1/demo/load', {});
  const semId = demo.body.semesterId;
  const classes = (await get('/api/v1/classes?limit=1000')).body.items;
  for (const q of [
    'limit=2',
    'limit=3&offset=2',
    'sort=name',
    'sort=name&order=desc',
    'sort=credits',
    'sort=credits&order=desc',
    'sort=location&order=desc',
    'delivery=in_person',
    'limit=0',
    'limit=abc',
    'order=sideways',
  ])
    await get(`/api/v1/classes?${q}`);
  await get('/api/v1/assignments?sort=due&order=desc&limit=50');
  await get('/api/v1/assignments?type=exam&sort=title');
  await get('/api/v1/assignments?type=exam&type=quiz');
  await get('/api/v1/study-sessions?sort=minutes&order=desc&limit=5');
  for (const c of classes) {
    await get(`/api/v1/grades/class/${c.id}`);
    await get(`/api/v1/classes/${c.id}`);
  }
  await get(`/api/v1/grades/semester/${semId}`);
  await get('/api/v1/grades/class/missing');
  await get('/api/v1/gpa');
  await get('/api/v1/gpa?scaleId=flat_4');
  await get(`/api/v1/gpa?semesterId=${semId}`);
  await json('POST', '/api/v1/gpa/plan', { targetGpa: 3.5, plannedCredits: 15 });
  await json('POST', '/api/v1/gpa/plan', { targetGpa: 3.9, plannedCredits: 3, weighted: true });
  await json('POST', '/api/v1/gpa/plan', { targetGpa: -1, plannedCredits: 0 });
  const c1 = classes.find((c) => c.code === 'LOR 101');
  const c2 = classes.find((c) => c.code === 'IPS 210');
  const c1asg = (await get(`/api/v1/assignments?classId=${c1.id}&limit=100`)).body.items;
  const pending = c1asg.filter((a) => !a.score).map((a) => a.id);
  await json('POST', '/api/v1/grades/what-if', {
    classId: c1.id,
    overrides: { [pending[0]]: { kind: 'percent', percent: 95 }, [c1asg[0].id]: null },
  });
  await json('POST', '/api/v1/grades/what-if', {
    classId: c1.id,
    overrides: { x: { kind: 'letter', letter: 'B+' }, y: { kind: 'points', earned: 3 } },
  });
  await json('POST', '/api/v1/grades/what-if', {
    classId: c1.id,
    overrides: { x: { kind: 'nope' } },
  });
  await json('POST', '/api/v1/grades/needed', { classId: c1.id, target: 90 });
  await json('POST', '/api/v1/grades/needed', { classId: c1.id, target: { letter: 'A-' } });
  await json('POST', '/api/v1/grades/needed', {
    classId: c2.id,
    target: 85,
    remainingIds: pending,
    perItem: true,
    maxPerItem: 100,
  });
  await get('/api/v1/grading-schemes');
  await get('/api/v1/gpa-scales');
  await get('/api/v1/agenda?from=2026-01-01&to=2026-12-31');
  await get('/api/v1/agenda?from=bad&to=2026-12-31');
  await get('/api/v1/timetable?week=2026-11-25');
  await get('/api/v1/timetable?week=2026-11-25&weekStart=sun');
  await get('/api/v1/deadlines');
  await get('/api/v1/stats/overview');
  await get('/api/v1/stats/overview?weekStart=sun');
  for (const q of [
    'lorem',
    'exam',
    'class:"IPS 210"',
    'type:quiz',
    'tag:lecture',
    'due:week',
    'zzz',
  ])
    await get(`/api/v1/search?q=${encodeURIComponent(q)}`);
  await get('/api/v1/search');
  await get('/api/v1/about');

  // notes, links, flashcards
  const notes = (await get('/api/v1/notes')).body.items;
  await get('/api/v1/notes/resolve?title=ipsum%20sampling%20notes');
  await get(`/api/v1/notes/resolve?title=Nothing&classId=${c1.id}`);
  for (const n of notes) await get(`/api/v1/notes/${n.id}/backlinks`);
  const cloze = await json('POST', '/api/v1/notes', {
    title: 'Cloze practice',
    classId: c1.id,
    markdown:
      'The {{c1::mitochondria}} is the {{c2::powerhouse::energy}} of the cell.\n\nWater boils at {{c1::100}} °C.\n',
    tags: ['bio'],
  });
  await json('POST', `/api/v1/flashcards/sync-note/${cloze.body.id}`, {});
  await json('PATCH', `/api/v1/notes/${cloze.body.id}`, {
    markdown: 'The {{c1::mitochondria}} is the powerhouse.\n',
    tags: null,
  });
  await json('POST', `/api/v1/flashcards/sync-note/${cloze.body.id}`, {});
  const queue = await get('/api/v1/study/queue');
  await get(`/api/v1/study/queue?limit=1&newLimit=0&classId=${c1.id}`);
  await get('/api/v1/study/decks');
  if (queue.body.cards?.[0])
    await json('POST', '/api/v1/study/answer', { cardId: queue.body.cards[0].id, rating: 'good' });
  await json('POST', '/api/v1/study/answer', { cardId: 'missing', rating: 'good' });
  await json('POST', '/api/v1/study/answer', { cardId: 'x', rating: 'meh' });
  await get('/api/v1/flashcards');

  // templates
  await get('/api/v1/templates/notes');
  const tpl = await json('POST', '/api/v1/templates/notes', {
    name: 'Lab Report',
    markdown: '# Lab\n',
  });
  await json('PUT', `/api/v1/templates/notes/${tpl.body.id}`, {
    name: 'Lab Report 2',
    markdown: 'x',
  });
  await get('/api/v1/templates/notes');
  await del(`/api/v1/templates/notes/${tpl.body.id}`);
  await del('/api/v1/templates/notes/BAD_ID');

  // study timer
  await get('/api/v1/study-sessions/active');
  await json('POST', '/api/v1/study-sessions/start', { classId: c1.id });
  await json('POST', '/api/v1/study-sessions/start', {});
  await get('/api/v1/study-sessions/active');
  await json('POST', '/api/v1/study-sessions/stop', {});
  await api('POST', '/api/v1/study-sessions/stop', { headers: H });

  // edits and cascades
  const t = await json('POST', '/api/v1/tasks', {
    title: 'Plan',
    classId: c1.id,
    priority: 'high',
    id: 'ignored',
  });
  await json('PATCH', `/api/v1/tasks/${t.body.id}`, { done: true, targetHours: null });
  await json('PATCH', `/api/v1/tasks/${t.body.id}`, { priority: 'urgent' });
  await json('PATCH', `/api/v1/classes/${c2.id}`, { name: 'Ipsum Methods II', code: null });
  await get(`/api/v1/assignments?classId=${c2.id}&limit=3`);
  await del(`/api/v1/assignments/${pending[0]}`);
  await del(`/api/v1/classes/${c1.id}`);
  await get('/api/v1/tasks?sort=title');
  await get('/api/v1/notes?sort=title');
  await get('/api/v1/readings');
  await get('/api/v1/activity');

  // optional modules
  await json('POST', '/api/v1/journal', { date: '2026-11-20', title: 'Day', markdown: 'ok' });
  await json('POST', '/api/v1/contacts', { name: 'Pat Placeholder', email: 'pat@example.com' });
  await json('POST', '/api/v1/jobs', { position: 'Tutor', company: 'Example Co' });
  await json('POST', '/api/v1/budget', { purchase: 'Notebook', cost: 4.5, date: '2026-11-01' });
  await json('POST', '/api/v1/admissions', { school: 'Example University' });
  await json('POST', '/api/v1/activities', { name: 'Chess club' });
  for (const c of ['journal', 'contacts', 'jobs', 'budget', 'admissions', 'activities'])
    await get(`/api/v1/${c}`);

  // settings
  await get('/api/v1/settings');
  await json('PUT', '/api/v1/settings', { theme: 'dark', modules: { jobs: true }, z: 1, a: [1] });
  await get('/api/v1/settings');
  await json('PUT', '/api/v1/settings', 'nope');

  // attachments
  const att = await json('POST', '/api/v1/attachments', {
    filename: 'notes <1>.txt',
    dataBase64: Buffer.from('hello attachment').toString('base64'),
  });
  await json('POST', '/api/v1/attachments', {
    filename: 'again.txt',
    dataBase64: Buffer.from('hello attachment').toString('base64'),
  });
  await json('POST', '/api/v1/attachments', { filename: 'pic.png', dataBase64: 'iVBORw0KGgo=' });
  await get('/api/v1/attachments');
  await get(`/api/v1/attachments/${att.body.id}`);
  await get(`/api/v1/attachments/${att.body.id}/file`);
  await del(`/api/v1/attachments/${att.body.id}`);
  await get(`/api/v1/attachments/${att.body.id}/file`);

  // exports
  for (const c of ['semesters', 'classes', 'assignments', 'tasks', 'readings']) {
    await get(`/api/v1/export/csv/${c}`);
    await get(`/api/v1/import/templates/${c}`);
  }
  await get('/api/v1/export/csv/nope');
  await get('/api/v1/export/gradebook');
  for (const k of ['deadlines', 'timetable', 'all']) await get(`/api/v1/export/ics?kind=${k}`);
  const backup = await get('/api/v1/export/json');
  await get('/api/v1/export/report');
  await get('/api/v1/export/report?hide=1');
  await get('/api/v1/plugins');

  // imports
  const csv = await json('POST', '/api/v1/import/preview', {
    kind: 'csv',
    collection: 'assignments',
    text: 'title,class,due,weight,score\nEssay,Amet Writing Seminar,2026-12-01,10,90%\nLab X,Nope,2026-12-02,,\n',
  });
  await json('POST', '/api/v1/import/preview', { kind: 'csv', text: 'a,b\n1,2\n' });
  await json('POST', '/api/v1/import/preview', { kind: 'notion', text: 'x' });
  await json('POST', '/api/v1/import/preview', { kind: 'json', text: '{"format":"other"}' });
  await json('POST', '/api/v1/import/preview', { kind: 'csv', pluginId: 'no-such', text: 'a' });
  const ics = await json('POST', '/api/v1/import/preview', {
    kind: 'ics',
    icsAs: 'tasks',
    text: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Review\r\nDTSTART;VALUE=DATE:20261201\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
  });
  const committed = await json('POST', '/api/v1/import/commit', { previewId: csv.body.previewId });
  await json('POST', '/api/v1/import/commit', { previewId: csv.body.previewId });
  await json('POST', '/api/v1/import/commit', {
    previewId: ics.body.previewId,
    strategy: 'keep_both',
  });
  const again = await json('POST', '/api/v1/import/preview', {
    kind: 'csv',
    collection: 'assignments',
    text: 'title,class,due,weight,score\nEssay,Amet Writing Seminar,2026-12-01,12,95%\n',
  });
  await json('POST', '/api/v1/import/commit', {
    previewId: again.body.previewId,
    strategy: 'overwrite',
  });
  const restore = await json('POST', '/api/v1/import/preview', {
    kind: 'json',
    text: backup.text,
  });
  await json('POST', '/api/v1/import/commit', {
    previewId: restore.body.previewId,
    strategy: 'skip',
  });
  await get('/api/v1/import/history');
  await json('POST', `/api/v1/import/undo/${committed.body.importId}`, {});
  await json('POST', `/api/v1/import/undo/${committed.body.importId}`, {});
  await json('POST', '/api/v1/import/undo/not-an-id', {});
  await json('POST', '/api/v1/import/undo/01ARZ3NDEKTSV4RRFFQ69G5FAV', {});
  await get('/api/v1/assignments?sort=title&limit=100');

  // folder sync (each server writes into its own scratch folder)
  await json('POST', '/api/v1/sync/export', { dir: 'relative/path' });
  await json('POST', '/api/v1/sync/export', { dir: path.join(scratch, 'missing') });
  mkdirSync(path.join(scratch, 'out'), { recursive: true });
  await json('POST', '/api/v1/sync/export', { dir: path.join(scratch, 'out') });
  await json('POST', '/api/v1/sync/export', { dir: path.join(scratch, 'out') });

  // lock and encryption
  await get('/api/v1/lock/status');
  await json('POST', '/api/v1/lock/lock', {});
  await json('POST', '/api/v1/lock/setup', { passphrase: 'abc' });
  await json('POST', '/api/v1/lock/setup', {
    passphrase: 'correct horse',
    collections: ['notes', 'journal', 'nope', 'notes'],
    autoLockMinutes: 5,
  });
  await json('POST', '/api/v1/sync/export', { dir: path.join(scratch, 'out') });
  await json('POST', '/api/v1/lock/lock', {});
  await get('/api/v1/notes');
  await get('/api/v1/lock/status');
  await json('POST', '/api/v1/lock/unlock', { passphrase: 'wrong' });
  await json('POST', '/api/v1/lock/unlock', { passphrase: 'correct horse' });
  await get('/api/v1/notes?sort=title');
  await json('PATCH', '/api/v1/lock/settings', { lockOnHide: true });
  await json('POST', '/api/v1/lock/collections', { collections: ['contacts'] });
  await json('POST', '/api/v1/lock/setup', {
    passphrase: 'new phrase',
    current: 'correct horse',
  });
  await json('POST', '/api/v1/lock/disable', { passphrase: 'correct horse' });
  await json('POST', '/api/v1/lock/disable', { passphrase: 'new phrase' });
  await get('/api/v1/lock/status');

  // removing the demo
  await del('/api/v1/demo');
  await get('/api/v1/about');
  await get('/api/v1/grading-schemes');
  await del(`/api/v1/semesters/${semId}`);
}

// ---------------------------------------------------------------- recording and comparing
function recorder(base, port) {
  const log = [];
  const api = async (method, url, { headers = {}, body } = {}) => {
    const h = { ...headers };
    if (!('host' in h)) h.host = `127.0.0.1:${port}`;
    // node:http, not fetch: fetch replaces the Host header, and the host guard is under test
    const res = await new Promise((resolve, reject) => {
      const req = request(base + url, { method, headers: h }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () =>
          resolve({ status: r.statusCode, headers: r.headers, buf: Buffer.concat(chunks) }),
        );
        r.on('error', reject);
      });
      req.on('error', reject);
      req.end(body);
    });
    const type = res.headers['content-type'] ?? '';
    const buf = res.buf;
    let parsed;
    const text = buf.toString('utf8');
    if (type.includes('json') && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    const entry = {
      req: `${method} ${url}`,
      status: res.status,
      type: type.replace(/\s+/g, ''),
      disposition: res.headers['content-disposition'] ?? undefined,
      body:
        parsed ??
        (type.includes('zip')
          ? zipSummary(buf)
          : type.startsWith('text/') || !type
            ? text
            : `<${buf.length} bytes>`),
    };
    log.push(entry);
    return { status: res.status, body: parsed ?? {}, text };
  };
  return { api, log };
}

function zipSummary(buf) {
  // file names and sizes are enough: timestamps inside zips differ by design
  const out = [];
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) return '<not a zip>';
  let p = buf.readUInt32LE(i + 16);
  const n = buf.readUInt16LE(i + 10);
  for (let k = 0; k < n; k++) {
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    out.push(`${buf.toString('utf8', p + 46, p + 46 + nameLen)} (${size})`);
    p += 46 + nameLen + extra + comment;
  }
  return out.sort();
}

const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const ISO_TS = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\b/g;
const STAMP = /\b\d{8}T\d{6}Z\b/g;

function normalizer() {
  const ids = new Map();
  const fix = (s) =>
    s
      .replace(ULID, (m) => {
        if (!ids.has(m)) ids.set(m, `<id${ids.size + 1}>`);
        return ids.get(m);
      })
      .replace(ISO_TS, '<ts>')
      .replace(STAMP, '<stamp>')
      .replace(/classpad-api-parity-[^/\\"]+[/\\](ts|go)\b/g, '<dir>')
      .replace(/"(requestId|retryAfterMs)":("[^"]*"|\d+)/g, '"$1":"<x>"');
  return (entry) => JSON.parse(fix(JSON.stringify(entry)));
}

const ts = await startTs();
const go = await startGo();
const tsRec = recorder(ts.url, new URL(ts.url).port);
const goRec = recorder(go.url, new URL(go.url).port);
mkdirSync(path.join(root, 'ts-scratch'), { recursive: true });
mkdirSync(path.join(root, 'go-scratch'), { recursive: true });
let failed = false;
try {
  await session(tsRec.api, path.join(root, 'ts-scratch'));
  await session(goRec.api, path.join(root, 'go-scratch'));
} catch (e) {
  console.error('session failed:', e);
  failed = true;
} finally {
  await ts.close();
  await go.close();
}

const nt = normalizer();
const ng = normalizer();
let diffs = 0;
const n = Math.max(tsRec.log.length, goRec.log.length);
const report = [];
for (let i = 0; i < n; i++) {
  const a = tsRec.log[i] && nt(tsRec.log[i]);
  const b = goRec.log[i] && ng(goRec.log[i]);
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) {
    diffs++;
    report.push({ i, ts: a, go: b });
  }
}
writeFileSync(path.join(root, 'diff.json'), JSON.stringify(report, null, 2));
writeFileSync(path.join(root, 'ts.json'), JSON.stringify(tsRec.log.map(nt), null, 2));
writeFileSync(path.join(root, 'go.json'), JSON.stringify(goRec.log.map(ng), null, 2));
console.log(
  `${n} requests, ${n - diffs} identical, ${diffs} different${diffs ? ` (details: ${path.join(root, 'diff.json')})` : ''}`,
);
for (const d of report.slice(0, 15)) {
  console.log(`  #${d.i} ${d.ts?.req ?? d.go?.req}`);
  // where the two answers start to differ, so a CI log is enough to see the problem
  const a = JSON.stringify(d.ts) ?? '';
  const b = JSON.stringify(d.go) ?? '';
  let k = 0;
  while (k < a.length && a[k] === b[k]) k++;
  console.log(`    ts: …${a.slice(Math.max(0, k - 120), k + 200)}`);
  console.log(`    go: …${b.slice(Math.max(0, k - 120), k + 200)}`);
}
if (!keep && !diffs && !failed) rmSync(root, { recursive: true, force: true });
process.exit(diffs || failed ? 1 : 0);
