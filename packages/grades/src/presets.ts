import type { GpaScale } from './gpa.js';
import { DEFAULT_LETTER_SCALE } from './letters.js';
import { DEFAULT_ROUNDING } from './rounding.js';
import type { Scheme } from './types.js';

const BONUS = { regular: 0, honors: 0.5, ap: 1, ib: 1, dual: 1 };
const pm = (a: number[]) =>
  ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F'].map((letter, i) => ({
    letter,
    gpa: a[i]!,
  }));

export const GPA_SCALES: Record<string, GpaScale & { name: string }> = {
  standard_plus_minus: {
    name: '4.0 with ±',
    weightedBonus: BONUS,
    points: pm([4, 3.7, 3.3, 3, 2.7, 2.3, 2, 1.7, 1.3, 1, 0.7, 0]),
  },
  flat_4: {
    name: '4.0 flat',
    weightedBonus: BONUS,
    points: pm([4, 4, 3, 3, 3, 2, 2, 2, 1, 1, 1, 0]),
  },
  plus_4_3: {
    name: '4.3 (A+ = 4.3)',
    weightedBonus: BONUS,
    points: [{ letter: 'A+', gpa: 4.3 }, ...pm([4, 3.7, 3.3, 3, 2.7, 2.3, 2, 1.7, 1.3, 1, 0.7, 0])],
  },
  five_point: {
    name: '5.0',
    weightedBonus: BONUS,
    points: pm([5, 4.7, 4.3, 4, 3.7, 3.3, 3, 2.7, 2.3, 2, 1.7, 0]),
  },
};

export const defaultScheme = (mode: Scheme['mode'] = 'assignment_weights'): Scheme => ({
  mode,
  scale: DEFAULT_LETTER_SCALE,
  rounding: DEFAULT_ROUNDING,
  normalizeOverGradedOnly: true,
  extraCreditAllowed: true,
});
