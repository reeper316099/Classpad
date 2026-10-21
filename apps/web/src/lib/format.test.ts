import { describe, expect, it } from 'vitest';
import { fmtDue, parseScoreInput, pct, scoreText, urgency } from './format.js';

const now = new Date(2031, 0, 15, 10, 0);
describe('format helpers', () => {
  it('pct trims zeros and handles blanks', () => {
    expect(pct('84.000')).toBe('84%');
    expect(pct('84.5')).toBe('84.5%');
    expect(pct(null)).toBe('—');
    expect(pct('abc')).toBe('—');
  });
  it('urgency levels', () => {
    expect(urgency('2031-01-10', false, now)).toMatchObject({ level: 'overdue', days: -5 });
    expect(urgency('2031-01-15T23:00', false, now).level).toBe('today');
    expect(urgency('2031-01-16', false, now).label).toBe('Tomorrow');
    expect(urgency('2031-01-19', false, now).level).toBe('soon');
    expect(urgency('2031-03-01', false, now).level).toBe('later');
    expect(urgency('2031-01-10', true, now).level).toBe('later'); // done items are never overdue
    expect(urgency(undefined, false, now).level).toBe('none');
  });
  it('score parsing round-trips', () => {
    expect(parseScoreInput('90')).toEqual({ ok: true, score: { percent: 90 } });
    expect(parseScoreInput(' 87.5% ')).toEqual({ ok: true, score: { percent: 87.5 } });
    expect(parseScoreInput('45/50')).toEqual({ ok: true, score: { earned: 45, possible: 50 } });
    expect(parseScoreInput('')).toEqual({ ok: true, score: null });
    expect(parseScoreInput('abc').ok).toBe(false);
    expect(parseScoreInput('4/0').ok).toBe(false);
    expect(scoreText({ earned: 45, possible: 50 })).toBe('45/50');
    expect(scoreText({ percent: 90 })).toBe('90');
    expect(scoreText(undefined)).toBe('');
  });
  it('fmtDue shows ranges and times', () => {
    expect(fmtDue('2031-01-15T09:00')).toMatch(/Jan 15, 9:00 AM/);
    expect(fmtDue('2031-01-15/2031-01-16')).toMatch(/→/);
    expect(fmtDue(undefined)).toBe('—');
  });
});
