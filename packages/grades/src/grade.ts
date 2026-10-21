import { type Dec, dec, fmt } from './decimal.js';
import { letterFor } from './letters.js';
import { prepare } from './prepare.js';
import { roundTo } from './rounding.js';
import { assignmentWeights, categoryWeights, pointsScheme } from './schemes.js';
import type { Core, GradeItem, GradeResult, Scheme, Step } from './types.js';

function applyCurveAndClamp(core: Core, scheme: Scheme): { percent: Dec; steps: Step[] } {
  let p = core.percent!;
  const steps: Step[] = [];
  if (scheme.curve?.kind === 'flat') {
    const add = dec(scheme.curve.add);
    p = p.plus(add);
    steps.push({ kind: 'curve', label: `Curve: add ${fmt(add)} points`, value: fmt(p) });
  } else if (scheme.curve?.kind === 'scale_to_max') {
    const max = dec(scheme.curve.max);
    if (max.gt(0)) {
      p = p.times(100).div(max);
      steps.push({
        kind: 'curve',
        label: `Curve: scale so ${fmt(max)} becomes 100`,
        value: fmt(p),
      });
    }
  }
  if (scheme.maxScore != null && p.gt(dec(scheme.maxScore))) {
    p = dec(scheme.maxScore);
    steps.push({ kind: 'cap', label: `Capped at ${fmt(p)}`, value: fmt(p) });
  }
  return { percent: p, steps };
}

/** Compute the current grade for a class with a full step-by-step breakdown. */
export function computeGrade(scheme: Scheme, items: GradeItem[]): GradeResult {
  const warnings: string[] = [];
  const prepared = prepare(items, scheme, warnings);
  const core =
    scheme.mode === 'assignment_weights'
      ? assignmentWeights(prepared, scheme)
      : scheme.mode === 'category_weights'
        ? categoryWeights(prepared, scheme)
        : pointsScheme(prepared, scheme);
  warnings.push(...core.warnings);
  if (core.percent === null) {
    return {
      status: 'none',
      summary: 'No graded work yet',
      percentRaw: null,
      percentRounded: null,
      letter: null,
      gpaPoints: null,
      nextLetter: null,
      pointsToNextLetter: null,
      steps: [],
      warnings,
    };
  }
  const adj = applyCurveAndClamp(core, scheme);
  const steps = [...core.steps, ...adj.steps];
  const raw = adj.percent;
  const rounded = roundTo(raw, scheme.rounding);
  steps.push({
    kind: 'rounding',
    label: `Round to ${scheme.rounding.decimals} dp (${scheme.rounding.mode === 'half_up' ? 'half up' : 'truncate'})`,
    formula: `${fmt(raw, 10)} → ${fmt(rounded)}`,
    value: fmt(rounded),
  });
  const lookup = scheme.rounding.letterOn === 'rounded' ? rounded : raw;
  let letter: string;
  let gpa: Dec | null = null;
  let passed: boolean | undefined;
  let next: string | null = null;
  let toNext: Dec | null = null;
  if (scheme.passFail) {
    passed = lookup.gte(dec(scheme.passFail.threshold));
    letter = passed ? 'P' : 'NP';
    steps.push({
      kind: 'letter',
      label: `Pass/fail threshold ${fmt(dec(scheme.passFail.threshold))}`,
      value: letter,
    });
  } else {
    const { cutoff, next: n } = letterFor(lookup, scheme.scale);
    letter = cutoff.letter;
    gpa = cutoff.gpa != null ? dec(cutoff.gpa) : null;
    if (n) {
      next = n.letter;
      toNext = dec(n.min).minus(lookup);
    }
    steps.push({
      kind: 'letter',
      label: `Letter lookup on ${scheme.rounding.letterOn === 'rounded' ? 'rounded' : 'raw'} percent (≥ ${fmt(dec(cutoff.min))})`,
      value: letter,
      note: n ? `${fmt(toNext)} points to ${n.letter}` : undefined,
    });
  }
  return {
    status: 'graded',
    percentRaw: raw,
    percentRounded: rounded,
    letter,
    gpaPoints: gpa,
    passed,
    nextLetter: next,
    pointsToNextLetter: toNext,
    steps,
    warnings,
  };
}

export const pct = (r: GradeResult): Dec | null => r.percentRaw;
