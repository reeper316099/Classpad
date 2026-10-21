import { describe, expect, it } from 'vitest';
import {
  GPA_SCALES,
  computeGpa,
  computeGrade,
  defaultScheme,
  gpaReport,
  neededScore,
  planGpa,
  project,
  sensitivity,
  whatIf,
  type GradeItem,
  type Scheme,
} from './index.js';

const pctScore = (p: number) => ({ kind: 'percent' as const, percent: p });
const A: GradeItem[] = [
  { id: 'a', weight: 20, score: pctScore(90) },
  { id: 'b', weight: 30, score: pctScore(80) },
  { id: 'c', weight: 50 },
];

describe('worked example A (assignment weights)', () => {
  it('current grade is exactly 84.0', () => {
    const r = computeGrade(defaultScheme(), A);
    expect(r.percentRaw!.toString()).toBe('84');
    expect(r.letter).toBe('B');
    expect(r.steps.length).toBeGreaterThan(2);
  });
  it('needs exactly 96 on the final to reach 90', () => {
    const n = neededScore(defaultScheme(), A, { target: 90 });
    expect(n.required!.toString()).toBe('96');
    expect(n.feasibility).toBe('achievable');
  });
  it('flags >100 as impossible and reports best case', () => {
    const n = neededScore(defaultScheme(), A, { target: 95 });
    expect(n.feasibility).toBe('impossible');
    expect(n.required!.toString()).toBe('106');
    expect(n.best!.toString()).toBe('92');
  });
  it('letter target A needs 100 - exact cutoff 93', () => {
    const n = neededScore(defaultScheme(), A, { target: { letter: 'A' } });
    expect(n.required!.toString()).toBe('102'); // (93 - 42)/0.5
    expect(n.feasibility).toBe('impossible');
  });
  it('what-if and projection', () => {
    const w = whatIf(defaultScheme(), A, { c: pctScore(100) });
    expect(w.hypothetical.percentRaw!.toString()).toBe('92');
    expect(w.delta!.toString()).toBe('8');
    expect(project(defaultScheme(), A)!.projected!.toString()).toBe('84');
  });
  it('sensitivity ranks pending items', () => {
    const s = sensitivity(defaultScheme(), A);
    expect(s).toHaveLength(1);
    expect(s[0]!.swing.toString()).toBe('50');
  });
  it('not normalizing counts ungraded work as zero', () => {
    const s: Scheme = { ...defaultScheme(), normalizeOverGradedOnly: false };
    expect(computeGrade(s, A).percentRaw!.toString()).toBe('42');
  });
});

describe('worked example B (category weights, drop lowest)', () => {
  const scheme: Scheme = {
    ...defaultScheme('category_weights'),
    categories: [
      { id: 'q', name: 'Quizzes', weight: 30, dropLowest: 1, countMode: 'mean' },
      { id: 'e', name: 'Exams', weight: 70, countMode: 'mean' },
    ],
  };
  const items: GradeItem[] = [
    { id: 'q1', categoryId: 'q', score: pctScore(70) },
    { id: 'q2', categoryId: 'q', score: pctScore(90) },
    { id: 'q3', categoryId: 'q', score: pctScore(100) },
    { id: 'e1', categoryId: 'e', score: pctScore(80) },
  ];
  it('is exactly 84.5', () => {
    const r = computeGrade(scheme, items);
    expect(r.percentRaw!.toString()).toBe('84.5');
    expect(JSON.stringify(r.steps)).toContain('dropped lowest 1');
  });
  it('pooled mode uses points', () => {
    const s: Scheme = {
      ...scheme,
      categories: scheme.categories!.map((c) => ({ ...c, countMode: 'pooled' as const })),
    };
    const it2 = items.map((i) => ({
      ...i,
      pointsPossible: 100,
      score: { kind: 'points' as const, earned: (i.score as { percent: number }).percent },
    }));
    expect(computeGrade(s, it2).percentRaw!.toString()).toBe('84.5');
  });
});

describe('worked example C (GPA)', () => {
  const scale = GPA_SCALES.standard_plus_minus!;
  const courses = [
    { id: '1', credits: 4, letter: 'A', honorsLevel: 'ap' },
    { id: '2', credits: 3, letter: 'B+' },
    { id: '3', credits: 3, letter: 'A-' },
  ];
  it('unweighted is 3.70', () => {
    const g = computeGpa(courses, scale, { weighted: false });
    expect(g.gpa!.toString()).toBe('3.7');
  });
  it('weighted is 4.10', () => {
    expect(computeGpa(courses, scale, { weighted: true }).gpa!.toString()).toBe('4.1');
  });
  it('report: per-semester and cumulative', () => {
    const r = gpaReport(
      courses.map((c, i) => ({ ...c, semesterId: i < 2 ? 's1' : 's2' })),
      scale,
    );
    expect(r.semesters).toHaveLength(2);
    expect(r.cumulative.unweighted.gpa!.toString()).toBe('3.7');
  });
  it('planner', () => {
    const p = planGpa({
      currentQualityPoints: 37,
      currentCredits: 10,
      plannedCredits: 10,
      targetGpa: 3.8,
      maxGpa: 4,
    });
    expect(p.requiredGpa!.toString()).toBe('3.9');
    expect(p.feasibility).toBe('achievable');
  });
});

describe('golden cases', () => {
  const s = defaultScheme();
  it('all-ungraded shows "No graded work yet"', () => {
    const r = computeGrade(s, [{ id: 'x', weight: 100 }]);
    expect(r.status).toBe('none');
    expect(r.summary).toBe('No graded work yet');
    expect(computeGrade(s, []).status).toBe('none');
  });
  it('single item', () => {
    expect(
      computeGrade(s, [{ id: 'x', weight: 10, score: pctScore(77) }]).percentRaw!.toString(),
    ).toBe('77');
  });
  it('weights not summing to 100 warn but compute', () => {
    const r = computeGrade(s, [
      { id: 'x', weight: 10, score: pctScore(50) },
      { id: 'y', weight: 10, score: pctScore(100) },
    ]);
    expect(r.percentRaw!.toString()).toBe('75');
    expect(r.warnings.join()).toContain('not 100');
  });
  it('excused items are excluded entirely', () => {
    const r = computeGrade(s, [
      { id: 'x', weight: 10, score: pctScore(50) },
      { id: 'y', weight: 90, score: pctScore(0), excused: true },
    ]);
    expect(r.percentRaw!.toString()).toBe('50');
  });
  it('extra credit adds to numerator only', () => {
    const r = computeGrade(s, [
      { id: 'x', weight: 100, score: pctScore(90) },
      { id: 'ec', weight: 5, extraCredit: true, score: pctScore(100) },
    ]);
    expect(r.percentRaw!.toString()).toBe('95');
  });
  it('points scheme with capped extra credit and late penalty', () => {
    const ps: Scheme = { ...defaultScheme('points'), extraCreditCapPercent: 2 };
    const r = computeGrade(ps, [
      { id: 'a', pointsPossible: 50, score: { kind: 'points', earned: 40 } },
      { id: 'b', pointsPossible: 50, score: { kind: 'points', earned: 40 } },
      { id: 'ec', extraCredit: true, pointsPossible: 10, score: { kind: 'points', earned: 10 } },
    ]);
    expect(r.percentRaw!.toString()).toBe('82'); // (80 + 2) / 100
    const late = computeGrade(defaultScheme('points'), [
      { id: 'a', pointsPossible: 100, score: { kind: 'points', earned: 90 }, latePenalty: 10 },
    ]);
    expect(late.percentRaw!.toString()).toBe('80');
  });
  it('curve: flat add and scale to max', () => {
    const base: GradeItem[] = [{ id: 'x', weight: 100, score: pctScore(80) }];
    expect(
      computeGrade({ ...s, curve: { kind: 'flat', add: 5 } }, base).percentRaw!.toString(),
    ).toBe('85');
    expect(
      computeGrade({ ...s, curve: { kind: 'scale_to_max', max: 80 } }, base).percentRaw!.toString(),
    ).toBe('100');
  });
  it('rounding boundaries', () => {
    const at = (p: string, cfg: Partial<Scheme['rounding']> = {}) =>
      computeGrade({ ...s, rounding: { ...s.rounding, ...cfg } }, [
        { id: 'x', weight: 100, score: pctScore(Number(p)) },
      ]);
    expect(at('89.5', { decimals: 0, letterOn: 'rounded' }).letter).toBe('A-');
    expect(at('89.5', { decimals: 0, letterOn: 'raw' }).letter).toBe('B+');
    const r = computeGrade(
      { ...s, rounding: { mode: 'half_up', decimals: 2, letterOn: 'rounded' } },
      [{ id: 'x', weight: 100, score: { kind: 'percent', percent: '92.995' } }],
    );
    expect(r.percentRounded!.toString()).toBe('93');
    expect(r.letter).toBe('A');
    const t = computeGrade(
      { ...s, rounding: { mode: 'truncate', decimals: 2, letterOn: 'rounded' } },
      [{ id: 'x', weight: 100, score: { kind: 'percent', percent: '92.995' } }],
    );
    expect(t.percentRounded!.toString()).toBe('92.99');
    expect(t.letter).toBe('A-');
  });
  it('rounded letter target accounts for half-up rounding', () => {
    const sc = {
      ...s,
      rounding: { mode: 'half_up' as const, decimals: 0, letterOn: 'rounded' as const },
    };
    const n = neededScore(sc, A, { target: { letter: 'A-' } });
    expect(n.target.toString()).toBe('89.5');
  });
  it('pass/fail yields P/NP and no GPA points', () => {
    const r = computeGrade({ ...s, passFail: { threshold: 60 } }, [
      { id: 'x', weight: 100, score: pctScore(65) },
    ]);
    expect(r.letter).toBe('P');
    expect(r.gpaPoints).toBeNull();
  });
  it('drop-lowest tie-break is deterministic', () => {
    const sc: Scheme = {
      ...defaultScheme('category_weights'),
      categories: [{ id: 'q', name: 'Q', weight: 100, dropLowest: 1, countMode: 'pooled' }],
    };
    const it = [
      {
        id: 'a',
        categoryId: 'q',
        pointsPossible: 10,
        score: { kind: 'points' as const, earned: 5 },
      },
      {
        id: 'b',
        categoryId: 'q',
        pointsPossible: 100,
        score: { kind: 'points' as const, earned: 50 },
      },
      {
        id: 'c',
        categoryId: 'q',
        pointsPossible: 100,
        score: { kind: 'points' as const, earned: 90 },
      },
    ];
    const r1 = computeGrade(sc, it).percentRaw!;
    const r2 = computeGrade(sc, [...it].reverse()).percentRaw!;
    expect(r1.eq(r2)).toBe(true);
  });
  it('retakes: repeat rule keeps latest or best', () => {
    const scale = GPA_SCALES.standard_plus_minus!;
    const cs = [
      { id: 'a', credits: 3, letter: 'D', courseKey: 'MATH', termIndex: 1 },
      { id: 'b', credits: 3, letter: 'B', courseKey: 'MATH', termIndex: 2 },
    ];
    expect(
      computeGpa(cs, scale, { weighted: false, repeatRule: 'replace_latest' }).gpa!.toString(),
    ).toBe('3');
    expect(computeGpa(cs, scale, { weighted: false }).gpa!.toString()).toBe('2');
    expect(
      computeGpa(cs, scale, { weighted: false, repeatRule: 'keep_best' }).gpa!.toString(),
    ).toBe('3');
  });
  it('credit-less and pass/fail courses are excluded from GPA with a warning', () => {
    const g = computeGpa(
      [
        { id: 'a', letter: 'A' },
        { id: 'b', credits: 3, letter: 'A', passFail: true },
      ],
      GPA_SCALES.flat_4!,
      { weighted: false },
    );
    expect(g.gpa).toBeNull();
    expect(g.warnings.join()).toContain('no credits');
  });
});
