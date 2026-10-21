// Entity types come from the shared package (types only: nothing from it is bundled).
export type {
  Assignment,
  Attachment,
  ClassEntity,
  Note,
  Reading,
  Semester,
  StudySession,
  Task,
  GradingScheme,
  GpaScale,
} from '@classpad/shared';

/** Decimal values arrive as strings (exact, no float drift). */
export type Dec = string;

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
export interface SensitivityRow {
  id: string;
  title: string;
  ifZero: Dec | null;
  ifFull: Dec | null;
  swing: Dec;
}
export interface Projection {
  assumedPercent: Dec;
  projected: Dec | null;
  pendingIds: string[];
  note: string;
}
export interface ClassGrade {
  classId: string;
  name: string;
  grade: GradeResult;
  sensitivity: SensitivityRow[];
  projection: Projection | null;
}
export interface WhatIfResult {
  actual: GradeResult;
  hypothetical: GradeResult;
  delta: Dec | null;
}
export interface NeededResult {
  target: Dec;
  required: Dec | null;
  requiredRoundedUp: Dec | null;
  feasibility: 'achievable' | 'secured' | 'impossible';
  best: Dec | null;
  worst: Dec | null;
  expected: Dec | null;
  remainingIds: string[];
  perItem?: Record<string, Dec | null>;
  steps: Step[];
  warnings: string[];
}
export interface TranscriptRow {
  id: string;
  name: string;
  semesterId?: string;
  letter: string;
  credits: Dec;
  points: Dec;
  qualityPoints: Dec;
}
export interface GpaResult {
  gpa: Dec | null;
  rounded: Dec | null;
  credits: Dec;
  qualityPoints: Dec;
  rows: TranscriptRow[];
  steps: Step[];
  warnings: string[];
}
export interface GpaReport {
  scaleId: string;
  semesters: { semesterId: string; unweighted: GpaResult; weighted: GpaResult }[];
  cumulative: { unweighted: GpaResult; weighted: GpaResult };
  progress: { semesterId: string; name: string; unweighted: Dec | null; weighted: Dec | null }[];
}
export interface SemesterGrades {
  semesterId: string;
  name: string;
  averageGrade: Dec | null;
  averageNote: string;
  gpa: GpaResult;
  classes: { classId: string; name: string; credits: number | null; grade: GradeResult }[];
}
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
export interface SearchHit {
  id: string;
  kind: 'note' | 'assignment' | 'task' | 'reading';
  title: string;
  classId?: string;
  score: number;
  snippet?: string;
}

export type ScoreInput =
  | { kind: 'percent'; percent: number }
  | { kind: 'points'; earned: number; possible?: number }
  | { kind: 'letter'; letter: string };

export interface ImportSummary {
  previewId: string;
  source: string;
  counts: Record<string, number>;
  items: Record<string, string[]>;
  skipped: { kind: string; count: number; reason: string }[];
  mapping: { file: string; kind: string; chosen: boolean; rows: number; note?: string }[];
  warnings: { code: string; message: string; where?: string }[];
  validation: {
    className: string;
    exported: string;
    recomputed: string | null;
    status: string;
    diff?: string;
  }[];
}
