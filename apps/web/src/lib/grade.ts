import type { GradingScheme, ScoreInput } from './types.js';

/** Letter for a percent using a scheme's cutoffs (display helper; the server is the source of truth). */
export function letterFor(
  percent: number,
  scheme: Pick<GradingScheme, 'scale'> | undefined,
): string {
  const cuts = [...(scheme?.scale.cutoffs ?? [])].sort((a, b) => b.min - a.min);
  return (cuts.find((c) => percent >= c.min) ?? cuts[cuts.length - 1])?.letter ?? '—';
}

/** Hypothetical-score text ("90", "45/50") -> API ScoreInput; null when blank (= ungraded); undefined when invalid. */
export function parseOverride(text: string): ScoreInput | null | undefined {
  const t = text.trim();
  if (!t) return null;
  let m = /^(-?\d+(?:\.\d+)?)\s*%?$/.exec(t);
  if (m) return { kind: 'percent', percent: Number(m[1]) };
  m = /^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(t);
  if (m && Number(m[2]) > 0)
    return { kind: 'points', earned: Number(m[1]), possible: Number(m[2]) };
  return undefined;
}
