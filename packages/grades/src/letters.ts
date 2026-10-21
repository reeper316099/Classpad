import { type Dec, dec } from './decimal.js';
import type { LetterCutoff, LetterScale } from './types.js';

/** Default scale (editable). The lowest entry catches everything below. */
export const DEFAULT_LETTER_SCALE: LetterScale = {
  cutoffs: [
    { letter: 'A', min: 93, gpa: 4.0 },
    { letter: 'A-', min: 90, gpa: 3.7 },
    { letter: 'B+', min: 87, gpa: 3.3 },
    { letter: 'B', min: 83, gpa: 3.0 },
    { letter: 'B-', min: 80, gpa: 2.7 },
    { letter: 'C+', min: 77, gpa: 2.3 },
    { letter: 'C', min: 73, gpa: 2.0 },
    { letter: 'C-', min: 70, gpa: 1.7 },
    { letter: 'D+', min: 67, gpa: 1.3 },
    { letter: 'D', min: 63, gpa: 1.0 },
    { letter: 'D-', min: 60, gpa: 0.7 },
    { letter: 'F', min: 0, gpa: 0 },
  ],
};

export function sortedCutoffs(scale: LetterScale): LetterCutoff[] {
  return [...scale.cutoffs].sort((a, b) => dec(b.min).comparedTo(dec(a.min)));
}

export function letterFor(
  percent: Dec,
  scale: LetterScale,
): { cutoff: LetterCutoff; next: LetterCutoff | null } {
  const sorted = sortedCutoffs(scale);
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!;
    if (percent.gte(dec(c.min))) return { cutoff: c, next: i > 0 ? sorted[i - 1]! : null };
  }
  const last = sorted[sorted.length - 1]!;
  return { cutoff: last, next: sorted.length > 1 ? sorted[sorted.length - 2]! : null };
}

/** Percent a letter maps to when entered as a score: the lowest percent of that letter. */
export function letterToPercent(letter: string, scale: LetterScale): Dec | null {
  const c = scale.cutoffs.find((x) => x.letter.toLowerCase() === letter.trim().toLowerCase());
  return c ? dec(c.min) : null;
}
