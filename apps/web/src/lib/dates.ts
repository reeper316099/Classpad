/** Local-date helpers (all dates are YYYY-MM-DD strings in the user's own time zone). */
const pad = (n: number) => String(n).padStart(2, '0');
export const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromIso = (s: string) => {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};
export const addDays = (s: string, n: number) => {
  const d = fromIso(s);
  d.setDate(d.getDate() + n);
  return toIso(d);
};
export const addMonths = (s: string, n: number) => {
  const d = fromIso(s);
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  return toIso(d);
};
export type WeekStart = 'mon' | 'sun';

export function weekStartOf(s: string, start: WeekStart = 'mon'): string {
  const dow = fromIso(s).getDay();
  return addDays(s, -(start === 'mon' ? (dow + 6) % 7 : dow));
}
export const weekDays = (weekStart: string): string[] =>
  Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

/** Six weeks of dates covering the month containing `s`, aligned to the chosen week start. */
export function monthGrid(
  s: string,
  start: WeekStart = 'mon',
): { date: string; inMonth: boolean }[] {
  const first = `${s.slice(0, 7)}-01`;
  const gridStart = weekStartOf(first, start);
  return Array.from({ length: 42 }, (_, i) => {
    const date = addDays(gridStart, i);
    return { date, inMonth: date.slice(0, 7) === s.slice(0, 7) };
  });
}

export const WEEKDAY_SHORT = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
} as const;
export const dowKey = (s: string) =>
  (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const)[fromIso(s).getDay()]!;
export const weekdayHeaders = (start: WeekStart): (keyof typeof WEEKDAY_SHORT)[] =>
  start === 'mon'
    ? ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
    : ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const monthLabel = (s: string) =>
  fromIso(s).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
export const dayLabel = (
  s: string,
  opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'short', day: 'numeric' },
) => fromIso(s).toLocaleDateString(undefined, opts);
export const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};
export const fmtDuration = (mins: number) =>
  mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
