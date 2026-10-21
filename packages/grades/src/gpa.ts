import { type Dec, type Num, ZERO, dec, fmt } from './decimal.js';
import { roundTo } from './rounding.js';
import type { RoundingConfig, Step } from './types.js';

export interface GpaScale {
  points: { letter: string; gpa: Num }[];
  /** Added to passing grades (points > 0) in weighted GPA, keyed by honors level. */
  weightedBonus: Record<string, Num>;
}

export interface GpaCourse {
  id: string;
  name?: string;
  semesterId?: string;
  credits?: Num | null;
  letter?: string | null;
  honorsLevel?: string;
  passFail?: boolean;
  includeInGpa?: boolean;
  /** Courses sharing a key are attempts at the same course (repeat rule). */
  courseKey?: string;
  /** Chronological order of the attempt (higher = later). */
  termIndex?: number;
}

export type RepeatRule = 'none' | 'replace_latest' | 'keep_best';

export interface GpaOptions {
  weighted: boolean;
  repeatRule?: RepeatRule;
  rounding?: RoundingConfig;
}

export interface TranscriptRow {
  id: string;
  name: string;
  semesterId?: string;
  letter: string;
  credits: Dec;
  points: Dec;
  qualityPoints: Dec;
}

export interface GpaResult {
  gpa: Dec | null;
  rounded: Dec | null;
  credits: Dec;
  qualityPoints: Dec;
  rows: TranscriptRow[];
  steps: Step[];
  warnings: string[];
}

export const gradePoints = (letter: string, scale: GpaScale): Dec | null => {
  const e = scale.points.find((p) => p.letter.toLowerCase() === letter.trim().toLowerCase());
  return e ? dec(e.gpa) : null;
};

export function computeGpa(courses: GpaCourse[], scale: GpaScale, opts: GpaOptions): GpaResult {
  const warnings: string[] = [];
  const steps: Step[] = [];
  let list = courses;
  const rule = opts.repeatRule ?? 'none';
  if (rule !== 'none') {
    const groups = new Map<string, GpaCourse[]>();
    const rest: GpaCourse[] = [];
    for (const c of courses) {
      if (!c.courseKey) rest.push(c);
      else groups.set(c.courseKey, [...(groups.get(c.courseKey) ?? []), c]);
    }
    for (const [key, g] of groups) {
      if (g.length === 1) {
        rest.push(g[0]!);
        continue;
      }
      const pointsOf = (c: GpaCourse) => (c.letter ? (gradePoints(c.letter, scale) ?? ZERO) : ZERO);
      const sorted = [...g].sort((a, b) =>
        rule === 'replace_latest'
          ? (b.termIndex ?? 0) - (a.termIndex ?? 0) || a.id.localeCompare(b.id)
          : pointsOf(b).comparedTo(pointsOf(a)) || a.id.localeCompare(b.id),
      );
      rest.push(sorted[0]!);
      warnings.push(
        `Repeated course "${key}": ${g.length - 1} earlier attempt(s) excluded (${rule}).`,
      );
    }
    list = rest;
  }
  const rows: TranscriptRow[] = [];
  for (const c of list) {
    const name = c.name ?? c.id;
    if (c.includeInGpa === false || c.passFail) continue;
    if (c.credits == null || dec(c.credits).lte(0)) {
      warnings.push(`"${name}" has no credits; excluded from GPA.`);
      continue;
    }
    if (!c.letter) continue;
    const base = gradePoints(c.letter, scale);
    if (!base) {
      warnings.push(`"${name}": letter "${c.letter}" not in GPA scale; excluded.`);
      continue;
    }
    let pts = base;
    if (opts.weighted && base.gt(0)) {
      const bonus = scale.weightedBonus[c.honorsLevel ?? 'regular'];
      if (bonus != null) pts = pts.plus(dec(bonus));
    }
    const credits = dec(c.credits);
    rows.push({
      id: c.id,
      name,
      semesterId: c.semesterId,
      letter: c.letter,
      credits,
      points: pts,
      qualityPoints: pts.times(credits),
    });
  }
  if (!rows.length)
    return { gpa: null, rounded: null, credits: ZERO, qualityPoints: ZERO, rows, steps, warnings };
  const Q = rows.reduce<Dec>((a, r) => a.plus(r.qualityPoints), ZERO);
  const C = rows.reduce<Dec>((a, r) => a.plus(r.credits), ZERO);
  steps.push({
    kind: 'terms',
    label: `Quality points (grade points × credits${opts.weighted ? ', weighted' : ''})`,
    terms: rows.map((r) => ({
      label: `${r.name} (${r.letter})`,
      score: fmt(r.points),
      weight: fmt(r.credits),
      product: fmt(r.qualityPoints),
    })),
  });
  const gpa = Q.div(C);
  steps.push({ kind: 'result', label: 'GPA', formula: `${fmt(Q)} ÷ ${fmt(C)}`, value: fmt(gpa) });
  const rounded = opts.rounding
    ? roundTo(gpa, opts.rounding)
    : roundTo(gpa, { mode: 'half_up', decimals: 2 });
  return { gpa, rounded, credits: C, qualityPoints: Q, rows, steps, warnings };
}

export interface GpaReport {
  semesters: { semesterId: string; unweighted: GpaResult; weighted: GpaResult }[];
  cumulative: { unweighted: GpaResult; weighted: GpaResult };
}

/** Per-semester and cumulative GPA, weighted and unweighted. */
export function gpaReport(
  courses: GpaCourse[],
  scale: GpaScale,
  base: Omit<GpaOptions, 'weighted'> = {},
): GpaReport {
  const ids = [...new Set(courses.map((c) => c.semesterId ?? ''))];
  const both = (cs: GpaCourse[]) => ({
    unweighted: computeGpa(cs, scale, { ...base, weighted: false }),
    weighted: computeGpa(cs, scale, { ...base, weighted: true }),
  });
  return {
    semesters: ids.map((s) => ({
      semesterId: s,
      ...both(courses.filter((c) => (c.semesterId ?? '') === s)),
    })),
    cumulative: both(courses),
  };
}

export interface PlanResult {
  requiredGpa: Dec | null;
  feasibility: 'achievable' | 'secured' | 'impossible';
  steps: Step[];
}

/** What GPA do I need over the next `plannedCredits` to reach `targetGpa` cumulatively? */
export function planGpa(input: {
  currentQualityPoints: Num;
  currentCredits: Num;
  plannedCredits: Num;
  targetGpa: Num;
  maxGpa: Num;
}): PlanResult {
  const Q = dec(input.currentQualityPoints),
    C = dec(input.currentCredits);
  const n = dec(input.plannedCredits),
    T = dec(input.targetGpa),
    M = dec(input.maxGpa);
  if (n.lte(0))
    return {
      requiredGpa: null,
      feasibility: 'impossible',
      steps: [{ kind: 'note', label: 'No planned credits' }],
    };
  const req = T.times(C.plus(n)).minus(Q).div(n);
  const steps: Step[] = [
    {
      kind: 'result',
      label: 'Required average over planned credits',
      formula: `(${fmt(T)} × (${fmt(C)} + ${fmt(n)}) − ${fmt(Q)}) ÷ ${fmt(n)}`,
      value: fmt(req),
    },
  ];
  const feasibility = req.lte(0) ? 'secured' : req.gt(M) ? 'impossible' : 'achievable';
  return { requiredGpa: req, feasibility, steps };
}
