import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  dowKey,
  fmtDuration,
  minutesOf,
  monthGrid,
  toIso,
  weekStartOf,
  weekdayHeaders,
} from './dates.js';

describe('dates', () => {
  it('adds days across month and year boundaries and DST', () => {
    expect(addDays('2031-01-31', 1)).toBe('2031-02-01');
    expect(addDays('2031-12-31', 1)).toBe('2032-01-01');
    expect(addDays('2032-03-01', -1)).toBe('2032-02-29');
    expect(addDays('2031-03-09', 1)).toBe('2031-03-10'); // DST changes never skip a calendar day
    expect(addDays('2031-11-02', 1)).toBe('2031-11-03');
  });
  it('adds months from the first of the month', () => {
    expect(addMonths('2031-01-31', 1)).toBe('2031-02-01');
    expect(addMonths('2031-12-15', 1)).toBe('2032-01-01');
    expect(addMonths('2031-01-15', -1)).toBe('2030-12-01');
  });
  it('week starts for Monday and Sunday calendars', () => {
    expect(weekStartOf('2031-10-15', 'mon')).toBe('2031-10-13');
    expect(weekStartOf('2031-10-15', 'sun')).toBe('2031-10-12');
    expect(weekStartOf('2031-10-12', 'mon')).toBe('2031-10-06');
    expect(weekdayHeaders('sun')[0]).toBe('sun');
    expect(dowKey('2031-10-15')).toBe('wed');
  });
  it('month grid is always 6 aligned weeks with in-month flags', () => {
    const g = monthGrid('2031-10-15', 'mon');
    expect(g).toHaveLength(42);
    expect(g[0]!.date).toBe('2031-09-29');
    expect(g.filter((c) => c.inMonth)).toHaveLength(31);
    expect(g.filter((c) => c.inMonth)[0]!.date).toBe('2031-10-01');
    expect(monthGrid('2031-02-10', 'sun')[0]!.date).toBe('2031-01-26');
    expect(toIso(new Date(2031, 0, 5))).toBe('2031-01-05');
  });
  it('formats durations and parses times', () => {
    expect(fmtDuration(45)).toBe('45m');
    expect(fmtDuration(60)).toBe('1h');
    expect(fmtDuration(135)).toBe('2h 15m');
    expect(minutesOf('09:30')).toBe(570);
  });
});
