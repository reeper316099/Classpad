import { describe, expect, it } from 'vitest';
import { letterFor, parseOverride } from './grade.js';

const scheme = {
  scale: {
    cutoffs: [
      { letter: 'A', min: 93, gpa: 4 },
      { letter: 'B', min: 83, gpa: 3 },
      { letter: 'F', min: 0, gpa: 0 },
    ],
    roundingMode: 'half_up' as const,
    decimals: 2,
    letterOn: 'raw' as const,
  },
};
describe('grade helpers', () => {
  it('letterFor uses cutoffs in any order and falls to the lowest', () => {
    expect(letterFor(93, scheme)).toBe('A');
    expect(letterFor(92.99, scheme)).toBe('B');
    expect(letterFor(-5, scheme)).toBe('F');
    expect(letterFor(50, undefined)).toBe('—');
  });
  it('parseOverride: percent, points, blank (ungraded) and invalid', () => {
    expect(parseOverride('90')).toEqual({ kind: 'percent', percent: 90 });
    expect(parseOverride('45/50')).toEqual({ kind: 'points', earned: 45, possible: 50 });
    expect(parseOverride('  ')).toBeNull();
    expect(parseOverride('abc')).toBeUndefined();
    expect(parseOverride('1/0')).toBeUndefined();
  });
});
