import type { Dec, Num } from './decimal.js';

export type ScoreInput =
  | { kind: 'percent'; percent: Num }
  | { kind: 'points'; earned: Num; possible?: Num }
  | { kind: 'letter'; letter: string };

export interface GradeItem {
  id: string;
  title?: string;
  categoryId?: string;
  /** Percent weight (assignment_weights mode). */
  weight?: Num;
  pointsPossible?: Num;
  score?: ScoreInput | null;
  extraCredit?: boolean;
  excused?: boolean;
  /** Manually dropped. */
  dropped?: boolean;
  /** Percentage points deducted from this item's score. */
  latePenalty?: Num;
  lateDays?: number;
}

export interface Category {
  id: string;
  name: string;
  weight: Num;
  dropLowest?: number;
  countMode?: 'pooled' | 'mean';
}

export interface LetterCutoff {
  letter: string;
  min: Num;
  gpa?: Num;
}

export interface LetterScale {
  cutoffs: LetterCutoff[];
}

export interface RoundingConfig {
  mode: 'half_up' | 'truncate';
  decimals: number;
  /** Look up the letter from the raw or the rounded percent. */
  letterOn: 'raw' | 'rounded';
}

export type Curve = { kind: 'flat'; add: Num } | { kind: 'scale_to_max'; max: Num };

export interface Scheme {
  mode: 'assignment_weights' | 'category_weights' | 'points';
  categories?: Category[];
  scale: LetterScale;
  rounding: RoundingConfig;
  /** Default true: only graded work counts in the denominator. */
  normalizeOverGradedOnly: boolean;
  extraCreditAllowed: boolean;
  /** Points mode: cap on extra credit, as percent of total possible points. */
  extraCreditCapPercent?: Num;
  latePolicy?: { perDayPercent: Num; maxPercent?: Num };
  curve?: Curve;
  /** Clamp the final percent (e.g. 100). Omit for no clamp. */
  maxScore?: Num;
  /** Pass/fail: letter becomes P/NP and the class is excluded from GPA. */
  passFail?: { threshold: Num };
}

export interface Term {
  label: string;
  score?: string;
  weight?: string;
  product?: string;
  note?: string;
}

export interface Step {
  kind: string;
  label: string;
  formula?: string;
  terms?: Term[];
  value?: string;
  note?: string;
}

export interface GradeResult {
  status: 'graded' | 'none';
  summary?: string;
  percentRaw: Dec | null;
  percentRounded: Dec | null;
  letter: string | null;
  gpaPoints: Dec | null;
  passed?: boolean;
  nextLetter: string | null;
  pointsToNextLetter: Dec | null;
  steps: Step[];
  warnings: string[];
}

/** Internal normalized item. */
export interface Prepared {
  id: string;
  title: string;
  categoryId?: string;
  weight: Dec | null;
  /** Score percent after late penalty (null = ungraded). */
  percent: Dec | null;
  rawPercent: Dec | null;
  earned: Dec | null;
  possible: Dec;
  penalty: Dec;
  extraCredit: boolean;
  /** Excluded entirely (excused or manually dropped). */
  inactive: boolean;
}

export interface Core {
  percent: Dec | null;
  steps: Step[];
  warnings: string[];
}
