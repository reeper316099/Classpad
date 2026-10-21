import { type Dec, type Num, ZERO, dec, fmt } from './decimal.js';
import { computeGrade } from './grade.js';
import { prepare } from './prepare.js';
import { percentScore } from './whatif.js';
import type { GradeItem, Scheme, Step } from './types.js';

export type Feasibility = 'achievable' | 'secured' | 'impossible';

export interface NeededResult {
  target: Dec;
  /** Exact required score on each remaining item (null when impossible and unbounded). */
  required: Dec | null;
  requiredRoundedUp: Dec | null;
  feasibility: Feasibility;
  best: Dec | null;
  worst: Dec | null;
  expected: Dec | null;
  remainingIds: string[];
  perItem?: Record<string, Dec | null>;
  steps: Step[];
  warnings: string[];
}

export interface NeededOptions {
  /** Target percent or letter. */
  target: Num | { letter: string };
  /** Items to solve over; default: all active, ungraded, non-extra-credit items. */
  remainingIds?: string[];
  /** Highest score allowed on one item (default scheme.maxScore ?? 100). */
  maxPerItem?: Num;
  /** Also compute the score needed on each item alone (others at `assume` percent). */
  perItem?: boolean;
  assume?: Num;
}

const gOf = (scheme: Scheme, items: GradeItem[]): Dec | null =>
  computeGrade(scheme, items).percentRaw;

/**
 * Final grade is continuous, non-decreasing and piecewise-linear in a score x applied to the
 * remaining items, with breakpoints only where x equals an existing score (drop-lowest order
 * changes). We evaluate exactly at the breakpoints and interpolate on the containing segment,
 * which is exact — no iterative guessing.
 */
function solve(
  build: (x: Dec) => Dec | null,
  breakpoints: Dec[],
  max: Dec,
  target: Dec,
): { x: Dec | null; feasibility: Feasibility; best: Dec | null; worst: Dec | null } {
  const xs = [ZERO, max, ...breakpoints.filter((b) => b.gt(0) && b.lt(max))]
    .sort((a, b) => a.comparedTo(b))
    .filter((v, i, a) => i === 0 || !v.eq(a[i - 1]!));
  const gs = xs.map((x) => build(x));
  if (gs.some((g) => g === null))
    return { x: null, feasibility: 'impossible', best: null, worst: null };
  const g = gs as Dec[];
  const worst = g[0]!;
  const best = g[g.length - 1]!;
  if (worst.gte(target)) return { x: ZERO, feasibility: 'secured', best, worst };
  for (let k = 1; k < xs.length; k++) {
    if (g[k]!.gte(target)) {
      const x0 = xs[k - 1]!,
        x1 = xs[k]!,
        g0 = g[k - 1]!,
        g1 = g[k]!;
      const x = x0.plus(target.minus(g0).times(x1.minus(x0)).div(g1.minus(g0)));
      return { x, feasibility: 'achievable', best, worst };
    }
  }
  // Out of reach: extrapolate the last segment to show how far off it is.
  const n = xs.length;
  const slope = n >= 2 ? g[n - 1]!.minus(g[n - 2]!).div(xs[n - 1]!.minus(xs[n - 2]!)) : ZERO;
  const x = slope.gt(0) ? xs[n - 1]!.plus(target.minus(best).div(slope)) : null;
  return { x, feasibility: 'impossible', best, worst };
}

export function neededScore(scheme: Scheme, items: GradeItem[], opts: NeededOptions): NeededResult {
  const warnings: string[] = [];
  const steps: Step[] = [];
  const prep = prepare(items, scheme, []);
  const remaining = new Set(
    opts.remainingIds ??
      prep.filter((p) => !p.inactive && !p.percent && !p.extraCredit).map((p) => p.id),
  );
  const max = dec(opts.maxPerItem ?? scheme.maxScore ?? 100);

  let target: Dec;
  if (typeof opts.target === 'object' && opts.target !== null && 'letter' in opts.target) {
    const letter = opts.target.letter;
    const c = scheme.scale.cutoffs.find((x) => x.letter.toLowerCase() === letter.toLowerCase());
    if (!c) throw new Error(`Unknown letter "${letter}"`);
    target = dec(c.min);
    if (scheme.rounding.letterOn === 'rounded' && scheme.rounding.mode === 'half_up') {
      // A raw percent within half a unit below the cutoff rounds up to it.
      target = target.minus(dec(5).div(dec(10).pow(scheme.rounding.decimals + 1)));
    }
    steps.push({ kind: 'target', label: `Target ${letter}`, value: fmt(target, 10) });
  } else {
    target = dec(opts.target as Num);
    steps.push({ kind: 'target', label: 'Target percent', value: fmt(target) });
  }

  const ids = [...remaining];
  const base = items.map((i) => ({ ...i }));
  const withScores = (x: Dec): GradeItem[] =>
    base.map((i) =>
      remaining.has(i.id) ? { ...i, score: percentScore(x), excused: false, dropped: false } : i,
    );
  const bps = prep.filter((p) => p.percent && !remaining.has(p.id)).map((p) => p.percent!);

  const cur = gOf(scheme, items);
  const out = ids.length
    ? solve((x) => gOf(scheme, withScores(x)), bps, max, target)
    : { x: null, feasibility: 'impossible' as Feasibility, best: cur, worst: cur };
  if (!ids.length) warnings.push('No remaining items to solve over.');
  const expected = cur && ids.length ? gOf(scheme, withScores(cur)) : null;

  steps.push({ kind: 'solve', label: `Worst case (all remaining at 0)`, value: fmt(out.worst) });
  steps.push({
    kind: 'solve',
    label: `Best case (all remaining at ${fmt(max)})`,
    value: fmt(out.best),
  });
  if (expected)
    steps.push({
      kind: 'solve',
      label: `Expected (all remaining at current ${fmt(cur)})`,
      value: fmt(expected),
    });
  steps.push({
    kind: 'result',
    label:
      out.feasibility === 'secured'
        ? 'Target already secured: any score on the remaining work reaches it'
        : out.feasibility === 'impossible'
          ? `Target not reachable even with ${fmt(max)} on everything remaining`
          : 'Score needed on each remaining item',
    value: out.x ? fmt(out.x) : '—',
  });

  let perItem: Record<string, Dec | null> | undefined;
  if (opts.perItem && ids.length) {
    perItem = {};
    const assume = opts.assume != null ? dec(opts.assume) : (cur ?? ZERO);
    for (const id of ids) {
      const r = solve(
        (x) =>
          gOf(
            scheme,
            base.map((i) =>
              remaining.has(i.id)
                ? {
                    ...i,
                    score: percentScore(i.id === id ? x : assume),
                    excused: false,
                    dropped: false,
                  }
                : i,
            ),
          ),
        bps,
        max,
        target,
      );
      perItem[id] = r.feasibility === 'impossible' ? null : r.x;
    }
  }
  const requiredRoundedUp = out.x ? out.x.toDecimalPlaces(2, 0 /* ROUND_UP */) : null;
  return {
    target,
    required: out.x,
    requiredRoundedUp,
    feasibility: out.feasibility,
    best: out.best,
    worst: out.worst,
    expected,
    remainingIds: ids,
    perItem,
    steps,
    warnings,
  };
}

export interface SensitivityRow {
  id: string;
  title: string;
  ifZero: Dec | null;
  ifFull: Dec | null;
  /** ifFull − ifZero: how far this item alone can move the grade. */
  swing: Dec;
}

/** Rank pending items by how much they can move the final grade. */
export function sensitivity(
  scheme: Scheme,
  items: GradeItem[],
  includeGraded = false,
): SensitivityRow[] {
  const prep = prepare(items, scheme, []);
  const max = dec(scheme.maxScore ?? 100);
  const rows: SensitivityRow[] = [];
  for (const p of prep) {
    if (p.inactive || p.extraCredit) continue;
    if (p.percent && !includeGraded) continue;
    const at = (x: Dec) =>
      gOf(
        scheme,
        items.map((i) => (i.id === p.id ? { ...i, score: percentScore(x) } : i)),
      );
    const lo = at(ZERO),
      hi = at(max);
    if (!lo || !hi) continue;
    rows.push({ id: p.id, title: p.title, ifZero: lo, ifFull: hi, swing: hi.minus(lo) });
  }
  return rows.sort((a, b) => b.swing.comparedTo(a.swing) || a.id.localeCompare(b.id));
}

export interface Projection {
  assumedPercent: Dec;
  projected: Dec | null;
  pendingIds: string[];
  note: string;
}

/** Where does the class land if every pending item scores the current average? */
export function project(scheme: Scheme, items: GradeItem[]): Projection | null {
  const cur = gOf(scheme, items);
  if (!cur) return null;
  const prep = prepare(items, scheme, []);
  const pending = prep.filter((p) => !p.inactive && !p.percent && !p.extraCredit).map((p) => p.id);
  const set = new Set(pending);
  const projected = gOf(
    scheme,
    items.map((i) => (set.has(i.id) ? { ...i, score: percentScore(cur) } : i)),
  );
  return {
    assumedPercent: cur,
    projected,
    pendingIds: pending,
    note: `Assumes ${pending.length} pending item(s) score the current average of ${fmt(cur)}%.`,
  };
}
