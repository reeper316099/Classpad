import { describe, expect, it } from 'vitest';
import {
  computeGrade,
  defaultScheme,
  neededScore,
  sensitivity,
  project,
  type Scheme,
} from './index.js';

const s = defaultScheme();
describe('input forms and edge cases', () => {
  it('letter scores map to the lowest percent of the letter', () => {
    const r = computeGrade(s, [{ id: 'x', weight: 100, score: { kind: 'letter', letter: 'b+' } }]);
    expect(r.percentRaw!.toString()).toBe('87');
  });
  it('unknown letter is ignored with a warning', () => {
    const r = computeGrade(s, [{ id: 'x', weight: 100, score: { kind: 'letter', letter: 'Z' } }]);
    expect(r.status).toBe('none');
    expect(r.warnings.join()).toContain('unknown letter');
  });
  it('per-day late policy with max', () => {
    const sc: Scheme = { ...s, latePolicy: { perDayPercent: 5, maxPercent: 20 } };
    const r = computeGrade(sc, [
      { id: 'x', weight: 100, score: { kind: 'percent', percent: 100 }, lateDays: 10 },
    ]);
    expect(r.percentRaw!.toString()).toBe('80');
    const r2 = computeGrade(sc, [
      { id: 'x', weight: 100, score: { kind: 'percent', percent: 100 }, lateDays: 2 },
    ]);
    expect(r2.percentRaw!.toString()).toBe('90');
  });
  it('points without possible assume 100; non-positive possible ignored', () => {
    const a = computeGrade(s, [{ id: 'x', weight: 100, score: { kind: 'points', earned: 40 } }]);
    expect(a.percentRaw!.toString()).toBe('40');
    expect(a.warnings.join()).toContain('assumed 100');
    const b = computeGrade(s, [
      { id: 'x', weight: 100, score: { kind: 'points', earned: 4, possible: 0 } },
    ]);
    expect(b.status).toBe('none');
  });
  it('disallowed extra credit is ignored', () => {
    const sc = { ...s, extraCreditAllowed: false };
    const r = computeGrade(sc, [
      { id: 'x', weight: 100, score: { kind: 'percent', percent: 90 } },
      { id: 'e', weight: 5, extraCredit: true, score: { kind: 'percent', percent: 100 } },
    ]);
    expect(r.percentRaw!.toString()).toBe('90');
  });
  it('graded item without weight warns', () => {
    const r = computeGrade(s, [
      { id: 'x', score: { kind: 'percent', percent: 90 } },
      { id: 'y', weight: 10, score: { kind: 'percent', percent: 70 } },
    ]);
    expect(r.percentRaw!.toString()).toBe('70');
    expect(r.warnings.join()).toContain('no weight');
  });
  it('maxScore caps the result', () => {
    const r = computeGrade({ ...s, maxScore: 100 }, [
      { id: 'x', weight: 100, score: { kind: 'percent', percent: 110 } },
    ]);
    expect(r.percentRaw!.toString()).toBe('100');
  });
  it('perItem needed scores and secured targets', () => {
    const items = [
      { id: 'a', weight: 50, score: { kind: 'percent' as const, percent: 90 } },
      { id: 'b', weight: 25 },
      { id: 'c', weight: 25 },
    ];
    const n = neededScore(s, items, { target: 85, perItem: true, assume: 80 });
    expect(n.perItem!.b!.toString()).toBe('80');
    expect(neededScore(s, items, { target: 10 }).feasibility).toBe('secured');
    expect(neededScore(s, items, { target: 50, remainingIds: [] }).warnings.length).toBe(1);
  });
  it('unknown target letter throws; sensitivity/project on empty', () => {
    expect(() => neededScore(s, [], { target: { letter: 'Q' } })).toThrow();
    expect(sensitivity(s, [])).toEqual([]);
    expect(project(s, [])).toBeNull();
  });
});
