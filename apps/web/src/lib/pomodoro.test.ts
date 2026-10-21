import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POMODORO as C,
  fmtClock,
  isFinished,
  next,
  pause,
  remainingMs,
  resume,
  startFocus,
} from './pomodoro.js';

describe('pomodoro state machine', () => {
  it('counts down from timestamps, so background throttling cannot drift it', () => {
    const s = startFocus(1_000, C);
    expect(remainingMs(s, 1_000)).toBe(25 * 60_000);
    expect(remainingMs(s, 1_000 + 10 * 60_000)).toBe(15 * 60_000);
    expect(isFinished(s, 1_000 + 25 * 60_000)).toBe(true);
    expect(isFinished(s, 1_000 + 25 * 60_000 - 1)).toBe(false);
    expect(remainingMs(s, 1_000 + 99 * 60_000)).toBe(0);
  });
  it('pause freezes the remaining time and resume continues from it', () => {
    let s = startFocus(0, C);
    s = pause(s, 5 * 60_000);
    expect(s.endsAt).toBeNull();
    expect(remainingMs(s, 999 * 60_000)).toBe(20 * 60_000);
    s = resume(s, 100 * 60_000);
    expect(remainingMs(s, 110 * 60_000)).toBe(10 * 60_000);
    expect(pause(pause(s, 1), 2)).toEqual(pause(s, 1)); // pausing twice is harmless
    expect(resume(s, 5)).toBe(s);
  });
  it('cycles focus → short break, with a long break every N focus periods', () => {
    let s = startFocus(0, C);
    const phases: string[] = [];
    for (let i = 0; i < 9; i++) {
      s = next(s, i, C);
      phases.push(`${s.phase}${s.completed}`);
    }
    expect(phases).toEqual([
      'short1',
      'focus1',
      'short2',
      'focus2',
      'short3',
      'focus3',
      'long4',
      'focus4',
      'short5',
    ]);
  });
  it('honors custom durations', () => {
    const c = { focusMin: 50, shortMin: 10, longMin: 30, longEvery: 2 };
    let s = startFocus(0, c);
    expect(remainingMs(s, 0)).toBe(50 * 60_000);
    s = next(s, 0, c);
    s = next(s, 0, c);
    s = next(s, 0, c);
    expect(s.phase).toBe('long');
    expect(remainingMs(s, 0)).toBe(30 * 60_000);
  });
  it('formats the clock', () => {
    expect(fmtClock(25 * 60_000)).toBe('25:00');
    expect(fmtClock(61_001)).toBe('01:02');
    expect(fmtClock(0)).toBe('00:00');
  });
});
