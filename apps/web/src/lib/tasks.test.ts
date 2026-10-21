import { describe, expect, it } from 'vitest';
import { dayLoad, heatLevel, taskOutcome } from './tasks.js';

describe('task outcome', () => {
  it('compares actual to target with a small tolerance', () => {
    expect(taskOutcome(2, 2.5)).toMatchObject({ kind: 'over', label: 'Over by 0.5h' });
    expect(taskOutcome(2, 1)).toMatchObject({ kind: 'under', label: 'Under by 1h' });
    expect(taskOutcome(2, 2.1).kind).toBe('on');
    expect(taskOutcome(1, 1.2).kind).toBe('on'); // 15-minute floor on small tasks
    expect(taskOutcome(10, 10.9).kind).toBe('on'); // 10% of a long task
    expect(taskOutcome(undefined, 2).kind).toBe('none');
    expect(taskOutcome(2, undefined).kind).toBe('none');
  });
});
describe('heatmap load', () => {
  it('scales with weight and importance, ignores non-deadlines, adds task hours', () => {
    expect(dayLoad([])).toBe(0);
    expect(dayLoad([{ kind: 'class' }])).toBe(0);
    expect(dayLoad([{ kind: 'deadline' }])).toBe(1);
    expect(dayLoad([{ kind: 'deadline', weight: 40, priority: 'important' }])).toBe(3.5);
    expect(dayLoad([{ kind: 'deadline' }], 4)).toBe(3);
    expect([0, 0.5, 2, 3.9, 4, 9].map(heatLevel)).toEqual([0, 1, 2, 2, 3, 3]);
  });
});
