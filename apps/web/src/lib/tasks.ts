export type Outcome = { kind: 'none' | 'under' | 'on' | 'over'; label: string; hours: number };

/** Target vs actual hours. Within 10% (or 15 minutes) of the target counts as on target. */
export function taskOutcome(target: number | undefined, actual: number | undefined): Outcome {
  if (target == null || actual == null) return { kind: 'none', label: '—', hours: 0 };
  const diff = Math.round((actual - target) * 100) / 100;
  const tol = Math.max(0.25, target * 0.1);
  if (Math.abs(diff) <= tol) return { kind: 'on', label: 'On target', hours: diff };
  return diff > 0
    ? { kind: 'over', label: `Over by ${diff}h`, hours: diff }
    : { kind: 'under', label: `Under by ${-diff}h`, hours: diff };
}

/** Load for one day on the heatmap: deadlines count more with weight and for exams/projects; planned task hours add on. */
export function dayLoad(
  items: { kind: string; weight?: number; priority?: string }[],
  taskHours = 0,
): number {
  const d = items.filter((i) => i.kind === 'deadline' && true);
  return (
    d.reduce((n, i) => n + 1 + (i.weight ?? 0) / 20 + (i.priority === 'important' ? 0.5 : 0), 0) +
    taskHours * 0.5
  );
}
export const heatLevel = (score: number): 0 | 1 | 2 | 3 =>
  score <= 0 ? 0 : score < 2 ? 1 : score < 4 ? 2 : 3;
