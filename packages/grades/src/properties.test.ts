import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { computeGrade, defaultScheme, neededScore, type GradeItem, type Scheme } from './index.js';

const pctScore = (p: number) => ({ kind: 'percent' as const, percent: p });
const item = fc.record({
  weight: fc.integer({ min: 1, max: 60 }),
  score: fc.integer({ min: 0, max: 100 }),
});
const items = fc.array(item, { minLength: 1, maxLength: 8 });
const toItems = (xs: { weight: number; score: number }[]): GradeItem[] =>
  xs.map((x, i) => ({ id: `i${i}`, weight: x.weight, score: pctScore(x.score) }));

const catScheme: Scheme = {
  ...defaultScheme('category_weights'),
  categories: [
    { id: 'q', name: 'Q', weight: 30, dropLowest: 1, countMode: 'mean' },
    { id: 'e', name: 'E', weight: 70, countMode: 'pooled' },
  ],
};

describe('properties', () => {
  it('monotonic in each score', () => {
    fc.assert(
      fc.property(items, fc.nat(7), fc.integer({ min: 0, max: 100 }), (xs, idx, bump) => {
        const i = idx % xs.length;
        const lo = toItems(xs);
        const hi = lo.map((it, k) =>
          k === i ? { ...it, score: pctScore(Math.max(xs[i]!.score, bump)) } : it,
        );
        const a = computeGrade(defaultScheme(), lo).percentRaw!;
        const b = computeGrade(defaultScheme(), hi).percentRaw!;
        expect(b.gte(a)).toBe(true);
      }),
    );
  });
  it('invariant under scaling all weights by k', () => {
    fc.assert(
      fc.property(items, fc.integer({ min: 1, max: 9 }), (xs, k) => {
        const a = computeGrade(defaultScheme(), toItems(xs)).percentRaw!;
        const b = computeGrade(
          defaultScheme(),
          toItems(xs.map((x) => ({ ...x, weight: x.weight * k }))),
        ).percentRaw!;
        expect(a.eq(b)).toBe(true);
      }),
    );
  });
  it('excused items never change results', () => {
    fc.assert(
      fc.property(items, items, (xs, ys) => {
        const base = toItems(xs);
        const extra = toItems(ys).map((it, k) => ({ ...it, id: `x${k}`, excused: true }));
        const a = computeGrade(defaultScheme(), base).percentRaw!;
        const b = computeGrade(defaultScheme(), [...base, ...extra]).percentRaw!;
        expect(a.eq(b)).toBe(true);
      }),
    );
  });
  it('drop-lowest is order independent', () => {
    const cat = fc.array(
      fc.record({
        c: fc.constantFrom('q', 'e'),
        p: fc.integer({ min: 0, max: 100 }),
        poss: fc.integer({ min: 1, max: 50 }),
      }),
      { minLength: 2, maxLength: 10 },
    );
    fc.assert(
      fc.property(cat, fc.integer(), (xs, seed) => {
        const its: GradeItem[] = xs.map((x, i) => ({
          id: `i${i}`,
          categoryId: x.c,
          pointsPossible: x.poss,
          score: { kind: 'points', earned: (x.p * x.poss) / 100 },
        }));
        const shuffled = [...its].sort(
          (a, b) => ((a.id.charCodeAt(1) * seed) % 7) - ((b.id.charCodeAt(1) * seed) % 7),
        );
        const a = computeGrade(catScheme, its).percentRaw;
        const b = computeGrade(catScheme, shuffled).percentRaw;
        expect(a === null ? b === null : a.eq(b!)).toBe(true);
      }),
    );
  });
  it('solver round-trip reaches the target', () => {
    fc.assert(
      fc.property(
        items,
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 1, max: 100 }),
        (xs, w, target) => {
          const its: GradeItem[] = [...toItems(xs), { id: 'final', weight: w }];
          const n = neededScore(defaultScheme(), its, { target });
          fc.pre(n.feasibility === 'achievable');
          const r = computeGrade(
            defaultScheme(),
            its.map((i) => (i.id === 'final' ? { ...i, score: pctScore(0) } : i)),
          );
          expect(r.status).toBe('graded');
          const filled = its.map((i) =>
            i.id === 'final'
              ? { ...i, score: { kind: 'percent' as const, percent: n.required! } }
              : i,
          );
          const got = computeGrade(defaultScheme(), filled).percentRaw!;
          expect(got.minus(target).abs().lt(new Decimal('1e-20'))).toBe(true);
        },
      ),
    );
  });
  it('solver round-trip with drop-lowest categories', () => {
    const base: GradeItem[] = [
      { id: 'q1', categoryId: 'q', score: pctScore(70) },
      { id: 'q2', categoryId: 'q', score: pctScore(90) },
      { id: 'q3', categoryId: 'q' },
      { id: 'e1', categoryId: 'e', pointsPossible: 100, score: { kind: 'points', earned: 80 } },
    ];
    fc.assert(
      fc.property(fc.integer({ min: 76, max: 90 }), (target) => {
        const n = neededScore(catScheme, base, { target });
        fc.pre(n.feasibility === 'achievable');
        const filled = base.map((i) =>
          i.id === 'q3' ? { ...i, score: { kind: 'percent' as const, percent: n.required! } } : i,
        );
        const got = computeGrade(catScheme, filled).percentRaw!;
        expect(got.minus(target).abs().lt(new Decimal('1e-20'))).toBe(true);
      }),
    );
  });
  it('never yields NaN or Infinity, even on junk', () => {
    const junk = fc.array(
      fc.record({
        weight: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
        score: fc.option(
          fc.oneof(
            fc.record({
              kind: fc.constant('percent' as const),
              percent: fc.integer({ min: -50, max: 300 }),
            }),
            fc.record({
              kind: fc.constant('points' as const),
              earned: fc.integer({ min: 0, max: 50 }),
              possible: fc.integer({ min: 0, max: 50 }),
            }),
          ),
          { nil: undefined },
        ),
        excused: fc.boolean(),
      }),
      { maxLength: 8 },
    );
    fc.assert(
      fc.property(junk, (xs) => {
        const its: GradeItem[] = xs.map((x, i) => ({ id: `i${i}`, ...x }));
        for (const sc of [defaultScheme(), defaultScheme('points'), catScheme]) {
          const r = computeGrade(sc, its);
          for (const v of [r.percentRaw, r.percentRounded]) if (v) expect(v.isFinite()).toBe(true);
          if (r.status === 'none') expect(r.summary).toBe('No graded work yet');
        }
      }),
    );
  });
});
