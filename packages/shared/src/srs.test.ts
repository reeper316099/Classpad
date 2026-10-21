import { describe, expect, it } from 'vitest';
import { extractClozeCards, hashText, isDue, newSrs, schedule } from './srs.js';

const t0 = new Date('2031-01-01T10:00:00Z');
const days = (s: { dueAt: string }, from = t0) =>
  Math.round((Date.parse(s.dueAt) - from.getTime()) / 86_400_000);

describe('spaced repetition scheduling', () => {
  it('new cards are due immediately', () => expect(isDue(newSrs(t0), t0)).toBe(true));
  it('good: 1 day, then 3, then growing by ease', () => {
    let s = schedule(newSrs(t0), 'good', t0);
    expect([s.intervalDays, days(s)]).toEqual([1, 1]);
    s = schedule(s, 'good', t0);
    expect(s.intervalDays).toBe(3);
    s = schedule(s, 'good', t0);
    expect(s.intervalDays).toBe(8); // 3 × 2.5 = 7.5 → 8
    s = schedule(s, 'good', t0);
    expect(s.intervalDays).toBe(20);
    expect(s.reps).toBe(4);
  });
  it('again relearns in 10 minutes, lowers ease and counts a lapse', () => {
    const s = schedule({ ...newSrs(t0), intervalDays: 20, reps: 5, ease: 2.5 }, 'again', t0);
    expect(Date.parse(s.dueAt) - t0.getTime()).toBe(10 * 60_000);
    expect(s).toMatchObject({ ease: 2.3, intervalDays: 0, reps: 0, lapses: 1 });
    expect(isDue(s, t0)).toBe(false);
    expect(isDue(s, new Date(t0.getTime() + 11 * 60_000))).toBe(true);
  });
  it('hard grows slowly and lowers ease; easy grows fast and raises it', () => {
    const base = { ...newSrs(t0), intervalDays: 10, reps: 3, ease: 2.5 };
    expect(schedule(base, 'hard', t0)).toMatchObject({ intervalDays: 12, ease: 2.35 });
    expect(schedule(base, 'good', t0).intervalDays).toBe(25);
    expect(schedule(base, 'easy', t0)).toMatchObject({ intervalDays: 33, ease: 2.65 });
    expect(schedule(newSrs(t0), 'easy', t0).intervalDays).toBe(3);
  });
  it('ease never leaves 1.3–3.5 and ratings never shorten a graduated card below a day', () => {
    let s = newSrs(t0);
    for (let i = 0; i < 30; i++) s = schedule(s, 'again', t0);
    expect(s.ease).toBe(1.3);
    let h = { ...newSrs(t0), intervalDays: 1, reps: 2, ease: 1.3 };
    for (let i = 0; i < 10; i++) h = schedule(h, 'hard', t0);
    expect(h.intervalDays).toBeGreaterThanOrEqual(1);
    let e = newSrs(t0);
    for (let i = 0; i < 30; i++) e = schedule(e, 'easy', t0);
    expect(e.ease).toBe(3.5);
    expect(e.intervalDays).toBe(36_500);
    expect(Number.isNaN(Date.parse(e.dueAt))).toBe(false);
  });
});

describe('cloze extraction', () => {
  it('makes one card per cloze number, hiding only that one', () => {
    const cards = extractClozeCards(
      'The {{c1::mitochondria}} is the {{c2::powerhouse}} of the cell.',
    );
    expect(cards.map((c) => c.cloze)).toEqual([1, 2]);
    expect(cards[0]!.front).toBe('The […] is the powerhouse of the cell.');
    expect(cards[1]!.front).toBe('The mitochondria is the […] of the cell.');
    expect(cards[0]!.back).toBe('The mitochondria is the powerhouse of the cell.');
  });
  it('same number twice in a block is one card; hints replace the ellipsis', () => {
    const cards = extractClozeCards('{{c1::Paris::capital}} is in {{c1::France}}.');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.front).toBe('[capital] is in [capital].'.replace('[capital].', '[…].'));
  });
  it('works per paragraph and ignores code fences and plain text', () => {
    const md =
      'No clozes here.\n\nFirst {{c1::alpha}}.\n\n```\n{{c1::in code}}\n```\n\nSecond {{c1::beta}}.';
    const cards = extractClozeCards(md);
    expect(cards.map((c) => c.back)).toEqual(['First alpha.', 'Second beta.']);
    expect(new Set(cards.map((c) => c.sourceKey)).size).toBe(2);
  });
  it('source keys change when the text changes and stay stable otherwise', () => {
    const a = extractClozeCards('X {{c1::one}}')[0]!.sourceKey;
    expect(extractClozeCards('X {{c1::one}}')[0]!.sourceKey).toBe(a);
    expect(extractClozeCards('X {{c1::two}}')[0]!.sourceKey).not.toBe(a);
    expect(hashText('abc')).toBe(hashText('abc'));
  });
});
