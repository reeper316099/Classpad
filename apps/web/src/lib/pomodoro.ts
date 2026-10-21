export interface PomodoroConfig {
  focusMin: number;
  shortMin: number;
  longMin: number;
  longEvery: number;
}
export const DEFAULT_POMODORO: PomodoroConfig = {
  focusMin: 25,
  shortMin: 5,
  longMin: 15,
  longEvery: 4,
};
export type Phase = 'focus' | 'short' | 'long';

export interface TimerState {
  phase: Phase;
  /** Focus periods completed so far in this run. */
  completed: number;
  /** Epoch ms when the current phase ends (running), or null when paused. */
  endsAt: number | null;
  /** Milliseconds left while paused. */
  pausedMs: number | null;
}

export const phaseMs = (p: Phase, c: PomodoroConfig) =>
  (p === 'focus' ? c.focusMin : p === 'short' ? c.shortMin : c.longMin) * 60_000;
export const startFocus = (now: number, c: PomodoroConfig, completed = 0): TimerState => ({
  phase: 'focus',
  completed,
  endsAt: now + phaseMs('focus', c),
  pausedMs: null,
});
export const remainingMs = (s: TimerState, now: number) =>
  s.endsAt === null ? (s.pausedMs ?? 0) : Math.max(0, s.endsAt - now);
export const isFinished = (s: TimerState, now: number) => s.endsAt !== null && now >= s.endsAt;

export const pause = (s: TimerState, now: number): TimerState =>
  s.endsAt === null ? s : { ...s, endsAt: null, pausedMs: Math.max(0, s.endsAt - now) };
export const resume = (s: TimerState, now: number): TimerState =>
  s.endsAt !== null ? s : { ...s, endsAt: now + (s.pausedMs ?? 0), pausedMs: null };

/** What comes after the current phase ends (or is skipped). Breaks always lead back to focus. */
export function next(s: TimerState, now: number, c: PomodoroConfig): TimerState {
  if (s.phase !== 'focus')
    return {
      phase: 'focus',
      completed: s.completed,
      endsAt: now + phaseMs('focus', c),
      pausedMs: null,
    };
  const completed = s.completed + 1;
  const phase: Phase = completed % c.longEvery === 0 ? 'long' : 'short';
  return { phase, completed, endsAt: now + phaseMs(phase, c), pausedMs: null };
}

export const fmtClock = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
