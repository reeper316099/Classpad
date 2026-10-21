import type { Dec } from './types.js';

export const num = (v: Dec | null | undefined): number | null =>
  v == null || v === '' ? null : Number(v);
export function pct(v: Dec | null | undefined, dp = 2): string {
  const n = num(v);
  return n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(dp).replace(/\.?0+$/, '')}%`;
}
export function fixed(v: Dec | null | undefined, dp = 2): string {
  const n = num(v);
  return n == null || !Number.isFinite(n) ? '—' : n.toFixed(dp);
}

const MS_DAY = 86_400_000;
export const todayIso = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const dayNumber = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Math.floor(Date.UTC(y!, m! - 1, d!) / MS_DAY);
};

export type Urgency = 'overdue' | 'today' | 'soon' | 'later' | 'none';
export function urgency(
  due: string | undefined,
  done = false,
  now = new Date(),
): { level: Urgency; days: number | null; label: string } {
  if (!due) return { level: 'none', days: null, label: 'No date' };
  const days = dayNumber(due.split('/')[0]!) - dayNumber(todayIso(now));
  if (done) return { level: 'later', days, label: fmtDue(due) };
  if (days < 0)
    return { level: 'overdue', days, label: days === -1 ? 'Yesterday' : `${-days}d overdue` };
  if (days === 0) return { level: 'today', days, label: 'Today' };
  if (days === 1) return { level: 'soon', days, label: 'Tomorrow' };
  if (days <= 6) return { level: 'soon', days, label: `In ${days}d` };
  return { level: 'later', days, label: fmtDue(due) };
}

export function fmtDue(due: string | undefined): string {
  if (!due) return '—';
  const [a, b] = due.split('/');
  const f = (s: string) => {
    const [d, t] = s.split('T');
    const [y, m, dd] = d!.split('-').map(Number);
    const date = new Date(y!, m! - 1, dd!).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
    return t ? `${date}, ${fmtTime(t)}` : date;
  };
  return b ? `${f(a!)} → ${f(b)}` : f(a!);
}
let hour12Default = true;
/** Set from the user's Settings so every time on screen follows 12h/24h. */
export const setHour12Default = (v: boolean) => {
  hour12Default = v;
};

export function fmtTime(hhmm: string, hour12 = hour12Default): string {
  const [h, m] = hhmm.split(':').map(Number);
  if (!hour12) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return `${((h! + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h! >= 12 ? 'PM' : 'AM'}`;
}
export const DAY_LABEL: Record<string, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

/**
 * Parse the score box: "90%", "45/50" -> API score object; "" -> clear. A bare number is points
 * earned when the assignment has points possible ("18" on a 20-point task is 18/20), else a percent.
 */
export function parseScoreInput(
  text: string,
  pointsPossible?: number | null,
):
  | { ok: true; score: { percent: number } | { earned: number; possible: number } | null }
  | { ok: false; error: string } {
  const t = text.trim();
  if (!t) return { ok: true, score: null };
  let m = /^(-?\d+(?:\.\d+)?)\s*(%?)$/.exec(t);
  if (m) {
    if (!m[2] && pointsPossible && pointsPossible > 0)
      return { ok: true, score: { earned: Number(m[1]), possible: pointsPossible } };
    return { ok: true, score: { percent: Number(m[1]) } };
  }
  m = /^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(t);
  if (m && Number(m[2]) > 0)
    return { ok: true, score: { earned: Number(m[1]), possible: Number(m[2]) } };
  return { ok: false, error: 'Use 18, 90%, or 45/50' };
}
export function scoreText(score: unknown): string {
  const s = score as { percent?: number; earned?: number; possible?: number } | undefined;
  if (!s) return '';
  if (s.percent != null) return `${s.percent}%`;
  return s.possible ? `${s.earned}/${s.possible}` : `${s.earned}`;
}

export const typeLabel = (t: string) => t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
