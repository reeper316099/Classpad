import { useQuery } from '@tanstack/react-query';
import { get } from './api.js';
import type { WeekStart } from './dates.js';
import { useUi } from './store.js';
import type { StudySession } from './types.js';

export interface AgendaItem {
  kind: 'deadline' | 'task' | 'class' | 'study';
  id: string;
  title: string;
  classId?: string;
  start: string;
  end?: string;
  allDay: boolean;
  done?: boolean;
  location?: string;
  weight?: number;
  priority?: string;
  minutes?: number;
}
export interface Timetable {
  weekStart: string;
  weekEnd: string;
  days: { date: string; items: AgendaItem[] }[];
}
export interface Stats {
  today: string;
  weekStart: string;
  weekEnd: string;
  study: {
    perClass: { classId: string; minutes: number; targetMinutes: number }[];
    unassignedMinutes: number;
    totalWeekMinutes: number;
    daily: { date: string; minutes: number }[];
    streakDays: number;
  };
  workload: {
    weekStart: string;
    deadlines: number;
    taskHours: number;
    score: number;
    load: 'light' | 'normal' | 'heavy';
  }[];
  trends: Record<string, number[]>;
}
export interface DeadlineRow {
  id: string;
  title: string;
  classId: string;
  due: string;
  weight?: number;
  priority: string;
  days: number;
  urgency: 'overdue' | 'today' | 'soon' | 'later';
}
export interface ActiveTimer {
  start: string;
  kind: 'pomodoro' | 'manual';
  classId?: string;
  taskId?: string;
  assignmentId?: string;
}

export const useAgenda = (from: string, to: string) =>
  useQuery({
    queryKey: ['agenda', from, to],
    queryFn: () => get<AgendaItem[]>(`/agenda?from=${from}&to=${to}`),
  });
export function useTimetable(week: string) {
  const weekStart = useUi((s) => s.weekStart);
  return useQuery({
    queryKey: ['timetable', week, weekStart],
    queryFn: () => get<Timetable>(`/timetable?week=${week}&weekStart=${weekStart}`),
  });
}
export function useStats() {
  const weekStart: WeekStart = useUi((s) => s.weekStart);
  return useQuery({
    queryKey: ['stats', weekStart],
    queryFn: () => get<Stats>(`/stats/overview?weekStart=${weekStart}`),
  });
}
export const useDeadlines = () =>
  useQuery({ queryKey: ['deadlines'], queryFn: () => get<DeadlineRow[]>('/deadlines') });
export const useStudySessions = (from?: string) =>
  useQuery({
    queryKey: ['study-sessions', from ?? ''],
    queryFn: async () =>
      (
        await get<{ items: StudySession[] }>(
          `/study-sessions?limit=1000${from ? `&from=${from}` : ''}&sort=start&order=desc`,
        )
      ).items,
  });
export const useActiveTimer = () =>
  useQuery({
    queryKey: ['study-active'],
    queryFn: () => get<ActiveTimer | null>('/study-sessions/active'),
  });
