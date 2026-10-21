import { type Dec, HUNDRED, ZERO, dec, fmt } from './decimal.js';
import { letterToPercent } from './letters.js';
import type { GradeItem, Prepared, Scheme } from './types.js';

export function prepare(items: GradeItem[], scheme: Scheme, warnings: string[]): Prepared[] {
  return items.map((it) => {
    const title = it.title ?? it.id;
    const inactive = !!it.excused || !!it.dropped;
    let percent: Dec | null = null;
    let earned: Dec | null = null;
    let possible: Dec = it.pointsPossible != null ? dec(it.pointsPossible) : HUNDRED;
    const s = it.score;
    if (s && !inactive) {
      if (s.kind === 'percent') {
        percent = dec(s.percent);
      } else if (s.kind === 'points') {
        const p = s.possible ?? it.pointsPossible;
        if (p == null)
          warnings.push(`"${title}": points score has no possible points; assumed 100.`);
        possible = p != null ? dec(p) : HUNDRED;
        if (possible.lte(0)) {
          warnings.push(`"${title}": possible points must be positive; item ignored.`);
        } else {
          earned = dec(s.earned);
          percent = earned.div(possible).times(100);
        }
      } else {
        const lp = letterToPercent(s.letter, scheme.scale);
        if (lp) percent = lp;
        else warnings.push(`"${title}": unknown letter "${s.letter}"; item ignored.`);
      }
    }
    const rawPercent = percent;
    let penalty: Dec = ZERO;
    if (percent) {
      if (it.latePenalty != null) penalty = dec(it.latePenalty);
      else if (it.lateDays && scheme.latePolicy) {
        penalty = dec(scheme.latePolicy.perDayPercent).times(it.lateDays);
        if (scheme.latePolicy.maxPercent != null)
          penalty = penalty.lt(dec(scheme.latePolicy.maxPercent))
            ? penalty
            : dec(scheme.latePolicy.maxPercent);
      }
      if (penalty.gt(0)) {
        const adj = percent.minus(penalty);
        percent = adj.lt(0) ? ZERO : adj;
        earned = null;
      }
    }
    if (percent && earned == null) earned = percent.times(possible).div(100);
    let extraCredit = !!it.extraCredit;
    if (extraCredit && !scheme.extraCreditAllowed) {
      warnings.push(`"${title}": extra credit is not allowed in this scheme; item ignored.`);
      extraCredit = true;
      percent = null;
      earned = null;
    }
    return {
      id: it.id,
      title,
      categoryId: it.categoryId,
      weight: it.weight != null ? dec(it.weight) : null,
      percent,
      rawPercent,
      earned,
      possible,
      penalty,
      extraCredit,
      inactive,
    };
  });
}

export const penaltyNote = (p: Prepared): string | undefined =>
  p.penalty.gt(0) ? `late penalty −${fmt(p.penalty)} (from ${fmt(p.rawPercent)})` : undefined;
