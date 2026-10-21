import { type Dec, ZERO, dec, fmt } from './decimal.js';
import { penaltyNote } from './prepare.js';
import type { Core, Prepared, Scheme, Step, Term } from './types.js';

const NONE: Core = { percent: null, steps: [], warnings: [] };

/** Σ(score × weight) / Σ(weight) over graded items. */
export function assignmentWeights(items: Prepared[], scheme: Scheme): Core {
  const warnings: string[] = [];
  const steps: Step[] = [];
  const active = items.filter((i) => !i.inactive);
  const graded: Prepared[] = [];
  let numer: Dec = ZERO;
  let denom: Dec = ZERO;
  let allWeights: Dec = ZERO;
  const terms: Term[] = [];
  const ecTerms: Term[] = [];
  let ecNumer: Dec = ZERO;
  for (const i of active) {
    if (i.weight == null) {
      if (i.percent) warnings.push(`"${i.title}" is graded but has no weight; ignored.`);
      continue;
    }
    if (!i.extraCredit) allWeights = allWeights.plus(i.weight);
    if (!i.percent) continue;
    const product = i.percent.times(i.weight);
    if (i.extraCredit) {
      ecNumer = ecNumer.plus(product);
      ecTerms.push({
        label: i.title,
        score: fmt(i.percent),
        weight: fmt(i.weight),
        product: fmt(product),
        note: 'extra credit',
      });
      continue;
    }
    graded.push(i);
    numer = numer.plus(product);
    denom = denom.plus(i.weight);
    terms.push({
      label: i.title,
      score: fmt(i.percent),
      weight: fmt(i.weight),
      product: fmt(product),
      note: penaltyNote(i),
    });
  }
  if (!graded.length) return { ...NONE, warnings };
  if (!allWeights.eq(100)) warnings.push(`Weights sum to ${fmt(allWeights)}%, not 100%.`);
  steps.push({ kind: 'terms', label: 'Graded items (score × weight)', terms });
  steps.push({ kind: 'sum', label: 'Sum of score × weight', value: fmt(numer) });
  if (ecTerms.length) {
    steps.push({
      kind: 'terms',
      label: 'Extra credit (added to the numerator only)',
      terms: ecTerms,
    });
    numer = numer.plus(ecNumer);
  }
  let divisor = denom;
  if (!scheme.normalizeOverGradedOnly) {
    divisor = allWeights;
    steps.push({
      kind: 'normalize',
      label: 'Divide by all weights (ungraded work counts as 0)',
      value: fmt(divisor),
    });
  } else {
    steps.push({
      kind: 'normalize',
      label: 'Divide by the weight of graded work only',
      value: fmt(divisor),
    });
  }
  if (divisor.lte(0)) return { ...NONE, warnings };
  const percent = numer.div(divisor);
  steps.push({
    kind: 'result',
    label: 'Grade before rounding',
    formula: `${fmt(numer)} ÷ ${fmt(divisor)}`,
    value: fmt(percent),
  });
  return { percent, steps, warnings };
}

/** Per-category average, weighted by category weight, with drop-lowest-N. */
export function categoryWeights(items: Prepared[], scheme: Scheme): Core {
  const warnings: string[] = [];
  const steps: Step[] = [];
  const cats = scheme.categories ?? [];
  const active = items.filter((i) => !i.inactive);
  const known = new Set(cats.map((c) => c.id));
  for (const i of active)
    if (i.percent && (!i.categoryId || !known.has(i.categoryId)))
      warnings.push(`"${i.title}" has no valid category; ignored.`);
  const catTerms: Term[] = [];
  let numer: Dec = ZERO;
  let denomGraded: Dec = ZERO;
  let denomAll: Dec = ZERO;
  for (const c of cats) {
    const w = dec(c.weight);
    denomAll = denomAll.plus(w);
    const inCat = active.filter((i) => i.categoryId === c.id && i.percent);
    const regular = inCat.filter((i) => !i.extraCredit);
    const ec = inCat.filter((i) => i.extraCredit);
    if (!regular.length) {
      catTerms.push({ label: c.name, weight: fmt(w), note: 'no graded work' });
      continue;
    }
    const sorted = [...regular].sort(
      (a, b) => a.percent!.comparedTo(b.percent!) || a.id.localeCompare(b.id),
    );
    const nDrop = Math.min(c.dropLowest ?? 0, sorted.length - 1);
    const dropped = sorted.slice(0, nDrop);
    const kept = sorted.slice(nDrop);
    const mode = c.countMode ?? 'pooled';
    let avg: Dec;
    if (mode === 'mean') {
      const s = kept
        .reduce<Dec>((a, i) => a.plus(i.percent!), ZERO)
        .plus(ec.reduce<Dec>((a, i) => a.plus(i.percent!), ZERO));
      avg = s.div(kept.length);
    } else {
      const e = kept
        .reduce<Dec>((a, i) => a.plus(i.earned!), ZERO)
        .plus(ec.reduce<Dec>((a, i) => a.plus(i.earned!), ZERO));
      const p = kept.reduce<Dec>((a, i) => a.plus(i.possible), ZERO);
      avg = p.lte(0) ? ZERO : e.div(p).times(100);
    }
    const note = [
      mode === 'mean' ? 'mean of percents' : 'pooled points',
      dropped.length
        ? `dropped lowest ${dropped.length}: ${dropped.map((d) => `${d.title} (${fmt(d.percent)})`).join(', ')}`
        : '',
      ec.length ? `${ec.length} extra credit` : '',
    ]
      .filter(Boolean)
      .join('; ');
    catTerms.push({
      label: c.name,
      score: fmt(avg),
      weight: fmt(w),
      product: fmt(avg.times(w)),
      note,
    });
    numer = numer.plus(avg.times(w));
    denomGraded = denomGraded.plus(w);
  }
  if (denomGraded.lte(0)) return { ...NONE, warnings };
  if (!denomAll.eq(100)) warnings.push(`Category weights sum to ${fmt(denomAll)}%, not 100%.`);
  steps.push({ kind: 'terms', label: 'Category averages (average × weight)', terms: catTerms });
  const divisor = scheme.normalizeOverGradedOnly ? denomGraded : denomAll;
  steps.push({
    kind: 'normalize',
    label: scheme.normalizeOverGradedOnly
      ? 'Divide by the weight of categories with graded work'
      : 'Divide by all category weights (empty categories count as 0)',
    value: fmt(divisor),
  });
  const percent = numer.div(divisor);
  steps.push({
    kind: 'result',
    label: 'Grade before rounding',
    formula: `${fmt(numer)} ÷ ${fmt(divisor)}`,
    value: fmt(percent),
  });
  return { percent, steps, warnings };
}

/** Σ earned / Σ possible over graded work; extra credit adds to earned only. */
export function pointsScheme(items: Prepared[], scheme: Scheme): Core {
  const warnings: string[] = [];
  const steps: Step[] = [];
  const graded = items.filter((i) => !i.inactive && i.percent && !i.extraCredit);
  const ec = items.filter((i) => !i.inactive && i.percent && i.extraCredit);
  if (!graded.length) return { ...NONE, warnings };
  const E = graded.reduce<Dec>((a, i) => a.plus(i.earned!), ZERO);
  const P = graded.reduce<Dec>((a, i) => a.plus(i.possible), ZERO);
  steps.push({
    kind: 'terms',
    label: 'Graded items (earned / possible)',
    terms: graded.map((i) => ({
      label: i.title,
      score: `${fmt(i.earned)} / ${fmt(i.possible)}`,
      note: penaltyNote(i),
    })),
  });
  steps.push({ kind: 'sum', label: 'Totals', value: `${fmt(E)} / ${fmt(P)}` });
  let ecPts: Dec = ec.reduce<Dec>((a, i) => a.plus(i.earned!), ZERO);
  if (ec.length) {
    if (scheme.extraCreditCapPercent != null) {
      const cap = P.times(dec(scheme.extraCreditCapPercent)).div(100);
      if (ecPts.gt(cap)) {
        steps.push({
          kind: 'cap',
          label: `Extra credit capped at ${fmt(dec(scheme.extraCreditCapPercent))}% of possible points`,
          value: fmt(cap),
        });
        ecPts = cap;
      }
    }
    steps.push({
      kind: 'extra',
      label: 'Extra credit (adds to earned, not to possible)',
      value: fmt(ecPts),
    });
  }
  if (P.lte(0)) return { ...NONE, warnings };
  const percent = E.plus(ecPts).div(P).times(100);
  steps.push({
    kind: 'result',
    label: 'Grade before rounding',
    formula: `(${fmt(E)} + ${fmt(ecPts)}) ÷ ${fmt(P)} × 100`,
    value: fmt(percent),
  });
  return { percent, steps, warnings };
}
