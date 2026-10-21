import { computeGrade } from '@classpad/grades';
import type { Assignment, ClassEntity } from '@classpad/shared';
import type { Context } from './context.js';
import { ApiError } from './errors.js';
import { toEngineScheme, toGradeItem } from './grading.js';

const pad = (n: number) => String(n).padStart(2, '0');
export const localDate = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const parseDate = (s: string) => {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};
export const addDays = (s: string, n: number) => {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return localDate(d);
};
const dayDiff = (a: string, b: string) =>
  Math.round((parseDate(a).getTime() - parseDate(b).getTime()) / 86_400_000);
const isDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parseDate(s).getTime());

export interface AgendaItem {
  kind: 'deadline' | 'task' | 'class' | 'study';
  id: string;
  title: string;
  classId?: string;
  /** YYYY-MM-DD or YYYY-MM-DDTHH:mm (local wall time) */
  start: string;
  end?: string;
  allDay: boolean;
  done?: boolean;
  location?: string;
  weight?: number;
  priority?: string;
  minutes?: number;
}

export function weekStartOf(date: string, startDay: 'mon' | 'sun' = 'mon'): string {
  const dow = parseDate(date).getDay();
  const back = startDay === 'mon' ? (dow + 6) % 7 : dow;
  return addDays(date, -back);
}

export function agenda(ctx: Context, from: string, to: string): AgendaItem[] {
  if (!isDate(from) || !isDate(to))
    throw new ApiError(422, 'VALIDATION', 'from and to must be YYYY-MM-DD');
  if (to < from) throw new ApiError(422, 'VALIDATION', 'to is before from');
  if (dayDiff(to, from) > 400)
    throw new ApiError(422, 'VALIDATION', 'range is limited to 400 days');
  const out: AgendaItem[] = [];
  const inRange = (d: string) => d >= from && d <= to;

  for (const a of ctx.assignments.list()) {
    if (!a.due || a.excused) continue;
    const [s, e] = a.due.split('/');
    if (!inRange(s!.slice(0, 10))) continue;
    out.push({
      kind: 'deadline',
      id: a.id,
      title: a.title,
      classId: a.classId,
      start: s!,
      end: e,
      allDay: !s!.includes('T'),
      done: a.status === 'complete',
      weight: a.weight,
      priority: a.priority,
    });
  }
  for (const t of ctx.tasks.list()) {
    if (!t.date) continue;
    const [s, e] = t.date.split('/');
    if (!inRange(s!.slice(0, 10))) continue;
    out.push({
      kind: 'task',
      id: t.id,
      title: t.title,
      classId: t.classId,
      start: s!,
      end: e,
      allDay: !s!.includes('T'),
      done: t.done,
      priority: t.priority,
    });
  }
  // class meetings, bounded by the class's own dates or its semester
  for (const c of ctx.classes.list()) {
    if (c.archived || !c.meetings.length) continue;
    const sem = ctx.semesters.get(c.semesterId);
    const lo = c.dates?.start ?? sem?.start;
    const hi = c.dates?.end ?? sem?.end;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if ((lo && d < lo) || (hi && d > hi)) continue;
      const dow = DAYS[parseDate(d).getDay()]!;
      for (const m of c.meetings.filter((x) => x.day === dow))
        out.push({
          kind: 'class',
          id: `${c.id}:${d}:${m.start}`,
          title: c.name,
          classId: c.id,
          start: `${d}T${m.start}`,
          end: `${d}T${m.end}`,
          allDay: false,
          location: m.location ?? c.location,
        });
    }
  }
  for (const s of ctx.study.list()) {
    const d = localDate(new Date(s.start));
    if (!inRange(d)) continue;
    const st = new Date(s.start);
    out.push({
      kind: 'study',
      id: s.id,
      title: 'Study session',
      classId: s.classId,
      start: `${d}T${pad(st.getHours())}:${pad(st.getMinutes())}`,
      allDay: false,
      minutes: s.minutes,
    });
  }
  return out.sort(
    (a, b) =>
      a.start.slice(0, 10).localeCompare(b.start.slice(0, 10)) ||
      Number(b.allDay) - Number(a.allDay) ||
      a.start.localeCompare(b.start) ||
      a.title.localeCompare(b.title),
  );
}

export function timetable(ctx: Context, week: string, startDay: 'mon' | 'sun' = 'mon') {
  if (!isDate(week)) throw new ApiError(422, 'VALIDATION', 'week must be YYYY-MM-DD');
  const weekStart = weekStartOf(week, startDay);
  const weekEnd = addDays(weekStart, 6);
  const items = agenda(ctx, weekStart, weekEnd).filter((i) => i.kind !== 'study');
  return {
    weekStart,
    weekEnd,
    days: Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i);
      return { date, items: items.filter((x) => x.start.slice(0, 10) === date) };
    }),
  };
}

export type Urgency = 'overdue' | 'today' | 'soon' | 'later';
export function deadlines(ctx: Context, now = new Date()) {
  const today = localDate(now);
  const level = (days: number): Urgency =>
    days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 6 ? 'soon' : 'later';
  const rows = ctx.assignments
    .list()
    .filter((a) => a.due && a.status !== 'complete' && !a.excused && !a.dropped)
    .map((a: Assignment) => {
      const date = a.due!.split('/')[0]!.slice(0, 10);
      const days = dayDiff(date, today);
      return {
        id: a.id,
        title: a.title,
        classId: a.classId,
        due: a.due!,
        weight: a.weight,
        priority: a.priority,
        days,
        urgency: level(days),
      };
    });
  return rows.sort((a, b) => a.due.localeCompare(b.due));
}

/** Heavier exams and high-weight items count more; planned task hours add on top. */
const itemLoad = (a: Pick<Assignment, 'weight' | 'type' | 'priority'>) =>
  1 +
  (a.weight ?? 0) / 20 +
  (a.type.some((t) => ['exam', 'project', 'presentation'].includes(t)) ? 1.5 : 0) +
  (a.priority === 'important' ? 0.5 : 0);
export const loadLevel = (score: number): 'light' | 'normal' | 'heavy' =>
  score < 3 ? 'light' : score < 6 ? 'normal' : 'heavy';

export function stats(ctx: Context, now = new Date(), startDay: 'mon' | 'sun' = 'mon') {
  const today = localDate(now);
  const weekStart = weekStartOf(today, startDay);
  const weekEnd = addDays(weekStart, 6);
  const classes = ctx.classes.list().filter((c) => !c.archived);

  // study time this week vs targets, and the last 14 days
  const sessions = ctx.study.list().map((s) => ({ ...s, date: localDate(new Date(s.start)) }));
  const perClass = classes.map((c: ClassEntity) => ({
    classId: c.id,
    minutes: sessions
      .filter((s) => s.classId === c.id && s.date >= weekStart && s.date <= weekEnd)
      .reduce((n, s) => n + s.minutes, 0),
    targetMinutes: Math.round((c.studyTargetHours ?? 0) * 60),
  }));
  const unassigned = sessions
    .filter((s) => !s.classId && s.date >= weekStart && s.date <= weekEnd)
    .reduce((n, s) => n + s.minutes, 0);
  const daily = Array.from({ length: 14 }, (_, i) => {
    const date = addDays(today, i - 13);
    return {
      date,
      minutes: sessions.filter((s) => s.date === date).reduce((n, s) => n + s.minutes, 0),
    };
  });
  // consecutive study days, counting back from today (or yesterday if you haven't studied yet today)
  const had = (d: string) => sessions.some((s) => s.date === d && s.minutes > 0);
  let streak = 0;
  for (let d = had(today) ? today : addDays(today, -1); had(d); d = addDays(d, -1)) streak++;

  // workload forecast for the next 8 weeks
  const asgs = ctx.assignments
    .list()
    .filter((a) => a.due && a.status !== 'complete' && !a.excused && !a.dropped);
  const workload = Array.from({ length: 8 }, (_, w) => {
    const ws = addDays(weekStart, w * 7),
      we = addDays(ws, 6);
    const ds = asgs.filter((a) => {
      const d = a.due!.split('/')[0]!.slice(0, 10);
      return d >= ws && d <= we;
    });
    const tasks = ctx.tasks
      .list()
      .filter((t) => !t.done && t.date && t.date.slice(0, 10) >= ws && t.date.slice(0, 10) <= we);
    const taskHours = tasks.reduce((n, t) => n + (t.targetHours ?? 0), 0);
    const score = ds.reduce((n, a) => n + itemLoad(a), 0) + taskHours * 0.5;
    return {
      weekStart: ws,
      deadlines: ds.length,
      taskHours,
      score: Math.round(score * 10) / 10,
      load: loadLevel(score),
    };
  });

  // grade trend per class: running grade after each graded item, oldest to newest
  const trends: Record<string, number[]> = {};
  for (const c of classes) {
    const scheme = toEngineScheme(ctx.config.scheme(c.gradingSchemeId), c);
    const items = ctx.assignments
      .list()
      .filter((a) => a.classId === c.id)
      .map((a) => ({ a, due: a.due?.slice(0, 10) ?? a.updatedAt.slice(0, 10) }));
    const graded = items
      .filter(({ a }) => a.score && !a.excused && !a.dropped)
      .sort((x, y) => x.due.localeCompare(y.due) || x.a.title.localeCompare(y.a.title));
    const pts: number[] = [];
    for (let i = 1; i <= graded.length; i++) {
      const r = computeGrade(
        scheme,
        graded.slice(0, i).map(({ a }) => toGradeItem(a)),
      );
      if (r.percentRaw) pts.push(Number(r.percentRaw.toDecimalPlaces(2).toString()));
    }
    trends[c.id] = pts.slice(-12);
  }
  return {
    today,
    weekStart,
    weekEnd,
    study: {
      perClass,
      unassignedMinutes: unassigned,
      totalWeekMinutes: perClass.reduce((n, p) => n + p.minutes, 0) + unassigned,
      daily,
      streakDays: streak,
    },
    workload,
    trends,
  };
}
