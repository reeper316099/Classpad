import { type Dec, type Num, dec } from './decimal.js';
import { computeGrade } from './grade.js';
import type { GradeItem, GradeResult, ScoreInput, Scheme } from './types.js';

export interface WhatIfResult {
  actual: GradeResult;
  hypothetical: GradeResult;
  /** hypothetical − actual (raw percent); null if either side has no grade. */
  delta: Dec | null;
}

/** Overlay hypothetical scores (null = ungraded). Never mutates input. */
export function whatIf(
  scheme: Scheme,
  items: GradeItem[],
  overrides: Record<string, ScoreInput | null>,
): WhatIfResult {
  const actual = computeGrade(scheme, items);
  const hypo = items.map((i) => (i.id in overrides ? { ...i, score: overrides[i.id] } : i));
  const hypothetical = computeGrade(scheme, hypo);
  const delta =
    actual.percentRaw && hypothetical.percentRaw
      ? hypothetical.percentRaw.minus(actual.percentRaw)
      : null;
  return { actual, hypothetical, delta };
}

export const percentScore = (p: Num): ScoreInput => ({ kind: 'percent', percent: dec(p) });
