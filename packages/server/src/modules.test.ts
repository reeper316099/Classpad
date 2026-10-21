import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  dir = await mkdtemp(path.join(tmpdir(), 'classpad-mod-'));
  app = await createApp({ dataDir: dir, token: 't' });
});
afterAll(async () => {
  await app.fastify.close();
  await rm(dir, { recursive: true, force: true });
});

describe('optional module collections', () => {
  it('journal entries are stored per month and validated', async () => {
    const a = await call('POST', '/journal', {
      date: '2031-03-05',
      title: 'Day one',
      mood: ['happy', 'focused'],
      markdown: 'private words',
    });
    expect(a.status).toBe(200);
    await call('POST', '/journal', { date: '2031-04-01', markdown: 'april' });
    expect(
      JSON.parse(await readFile(path.join(dir, 'data/journal/2031-03.json'), 'utf8')).items,
    ).toHaveLength(1);
    await readFile(path.join(dir, 'data/journal/2031-04.json'), 'utf8');
    expect((await call('POST', '/journal', { date: 'x' })).status).toBe(422);
    // journal text is not part of search (private by default)
    expect((await call('GET', '/search?q=private')).body.hits).toHaveLength(0);
    // moving an entry to another month moves its file entry
    await call('PATCH', `/journal/${a.body.id}`, { date: '2031-04-02' });
    await expect(readFile(path.join(dir, 'data/journal/2031-03.json'))).rejects.toThrow();
  });
  it('contacts, activities, jobs, admissions and budget round-trip with defaults', async () => {
    const sem = (await call('POST', '/semesters', { name: 'S' })).body.id;
    const cls = (await call('POST', '/classes', { semesterId: sem, name: 'C' })).body.id;
    expect(
      (
        await call('POST', '/contacts', {
          name: 'Pat Placeholder',
          role: 'Instructor',
          classIds: [cls],
        })
      ).body.classIds,
    ).toEqual([cls]);
    expect(
      (await call('POST', '/activities', { name: 'Chess club', hoursPerWeek: 3 })).body.status,
    ).toBe('active');
    expect(
      (await call('POST', '/jobs', { position: 'Intern', company: 'Example Co' })).body.status,
    ).toBe('wishlist');
    const adm = (
      await call('POST', '/admissions', {
        school: 'Example U',
        checklist: [{ text: 'Essay' }, { text: 'Transcript', done: true }],
      })
    ).body;
    expect(adm.status).toBe('researching');
    expect(adm.checklist.map((c: { done: boolean }) => c.done)).toEqual([false, true]);
    expect(
      (await call('POST', '/budget', { purchase: 'Notebook', cost: 4.5, date: '2031-03-02' })).body
        .type,
    ).toBe('expense');
    expect(
      (await call('POST', '/budget', { purchase: 'Bad', cost: -1, date: '2031-03-02' })).status,
    ).toBe(422);
    expect((await call('POST', '/jobs', { position: 'X', status: 'maybe' })).status).toBe(422);
    expect((await call('GET', '/jobs')).body.total).toBe(1);
    await readFile(path.join(dir, 'data/modules/budget/budget.json'), 'utf8');
  });
});

describe('flashcards from notes and spaced repetition', () => {
  let noteId = '';
  const cardsOf = async () =>
    (await call('GET', '/flashcards?limit=1000')).body.items as {
      id: string;
      front: string;
      cloze?: number;
      srs: { reps: number };
    }[];
  it('syncs cloze deletions into cards, keeps progress on unchanged text and drops stale cards', async () => {
    noteId = (
      await call('POST', '/notes', {
        title: 'Bio',
        markdown: 'The {{c1::cell}} is the unit of {{c2::life}}.\n\nDNA is in the {{c1::nucleus}}.',
      })
    ).body.id;
    expect((await call('POST', `/flashcards/sync-note/${noteId}`)).body).toEqual({
      created: 3,
      removed: 0,
      kept: 0,
    });
    const first = await cardsOf();
    expect(first).toHaveLength(3);
    expect(first.every((c) => c.srs.reps === 0)).toBe(true);
    const keep = first.find((c) => c.front.includes('[…] is the unit'))!;
    await call('POST', '/study/answer', { cardId: keep.id, rating: 'good' });
    // idempotent, and editing one paragraph only replaces that paragraph's cards
    expect((await call('POST', `/flashcards/sync-note/${noteId}`)).body.created).toBe(0);
    await call('PATCH', `/notes/${noteId}`, {
      markdown:
        'The {{c1::cell}} is the unit of {{c2::life}}.\n\nDNA is in the {{c1::chromosome}}.',
    });
    expect((await call('POST', `/flashcards/sync-note/${noteId}`)).body).toEqual({
      created: 1,
      removed: 1,
      kept: 2,
    });
    const after = await cardsOf();
    expect(after.find((c) => c.id === keep.id)?.srs.reps).toBe(1); // progress kept
    expect(after.some((c) => c.front.includes('nucleus'))).toBe(false);
  });
  it('queue: due reviews first, then new cards up to the limit; counts are right', async () => {
    const q = (await call('GET', '/study/queue?newLimit=1')).body;
    expect(q.counts).toEqual({ due: 0, new: 2, total: 3 }); // the answered card is scheduled for tomorrow
    expect(q.cards).toHaveLength(1);
    expect(q.cards[0].srs.reps).toBe(0);
    const all = (await call('GET', '/study/queue')).body;
    expect(all.cards).toHaveLength(2);
    expect((await call('GET', `/study/queue?noteId=nope`)).body.counts.total).toBe(0);
  });
  it('answering schedules via SM-2; again brings a card back in minutes; bad input is rejected', async () => {
    const c = (await cardsOf()).find((x) => x.srs.reps === 0)!;
    const again = (await call('POST', '/study/answer', { cardId: c.id, rating: 'again' })).body;
    expect(again.srs.lapses).toBe(1);
    expect(Date.parse(again.srs.dueAt) - Date.now()).toBeLessThan(11 * 60_000);
    expect((await call('POST', '/study/answer', { cardId: c.id, rating: 'meh' })).status).toBe(422);
    expect(
      (await call('POST', '/study/answer', { cardId: 'missing', rating: 'good' })).status,
    ).toBe(404);
    const decks = (await call('GET', '/study/decks')).body;
    expect(decks).toHaveLength(1);
    expect(decks[0].total).toBe(3);
  });
  it('manual cards work, and deleting a note deletes its generated cards only', async () => {
    const manual = (
      await call('POST', '/flashcards', { front: 'Capital of France?', back: 'Paris' })
    ).body;
    expect(manual.srs.reps).toBe(0);
    expect((await call('DELETE', `/notes/${noteId}`)).status).toBe(204);
    const left = await cardsOf();
    expect(left.map((c) => c.id)).toEqual([manual.id]);
  });
});
