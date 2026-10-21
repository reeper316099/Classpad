import { z } from 'zod';
import {
  DeliverySchema,
  GradingModeSchema,
  HonorsLevelSchema,
  PrioritySchema,
  ReadingStatusSchema,
  StatusSchema,
  TaskPrioritySchema,
  WeekdaySchema,
} from './enums.js';

/** ISO date (YYYY-MM-DD) or datetime. */
const IsoSchema = z.string().min(8);
const base = {
  id: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  importRef: z.string().optional(),
};

export const SemesterSchema = z.object({
  ...base,
  name: z.string().min(1),
  start: IsoSchema.optional(),
  end: IsoSchema.optional(),
  isCurrent: z.boolean().default(false),
  goals: z.array(z.string()).default([]),
  gpaScaleId: z.string().optional(),
  archived: z.boolean().default(false),
});

export const MeetingSchema = z.object({
  day: WeekdaySchema,
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  location: z.string().optional(),
});

export const ClassSchema = z.object({
  ...base,
  semesterId: z.string(),
  name: z.string().min(1),
  code: z.string().optional(),
  type: z.string().optional(),
  delivery: DeliverySchema.optional(),
  credits: z.number().nonnegative().optional(),
  instructor: z.string().optional(),
  contactIds: z.array(z.string()).default([]),
  location: z.string().optional(),
  meetings: z.array(MeetingSchema).default([]),
  rawTimes: z.string().optional(),
  dates: z.object({ start: IsoSchema, end: IsoSchema }).optional(),
  color: z.string().default('#6366f1'),
  syllabusAttachmentId: z.string().optional(),
  quickNotes: z.string().optional(),
  gradingSchemeId: z.string().default('default'),
  honorsLevel: HonorsLevelSchema.default('regular'),
  passFail: z.boolean().default(false),
  includeInGpa: z.boolean().default(true),
  targetGrade: z.number().min(0).optional(),
  archived: z.boolean().default(false),
});

export const ScoreSchema = z.union([
  z.object({ earned: z.number(), possible: z.number().positive().optional() }),
  z.object({ percent: z.number() }),
]);

export const AssignmentSchema = z.object({
  ...base,
  classId: z.string(),
  title: z.string().min(1),
  type: z.array(z.string()).default([]),
  categoryId: z.string().optional(),
  status: StatusSchema.default('not_started'),
  priority: PrioritySchema.default('mid'),
  due: z.string().optional(),
  weight: z.number().min(0).max(100).optional(),
  pointsPossible: z.number().positive().optional(),
  score: ScoreSchema.optional(),
  extraCredit: z.boolean().optional(),
  excused: z.boolean().optional(),
  dropped: z.boolean().optional(),
  latePenalty: z.number().min(0).optional(),
  link: z.string().optional(),
  attachmentIds: z.array(z.string()).default([]),
  quickNotes: z.string().optional(),
  noteIds: z.array(z.string()).default([]),
  taskIds: z.array(z.string()).default([]),
});

export const TaskSchema = z.object({
  ...base,
  title: z.string().min(1),
  assignmentId: z.string().optional(),
  classId: z.string().optional(),
  date: z.string().optional(),
  priority: TaskPrioritySchema.default('medium'),
  done: z.boolean().default(false),
  targetHours: z.number().nonnegative().optional(),
  actualHours: z.number().nonnegative().optional(),
  recurrence: z.string().optional(),
});

export const NoteSchema = z.object({
  ...base,
  title: z.string().min(1),
  classId: z.string().optional(),
  date: z.string().optional(),
  markdown: z.string().default(''),
  tags: z.array(z.string()).default([]),
  assignmentIds: z.array(z.string()).default([]),
  readingIds: z.array(z.string()).default([]),
  attachmentIds: z.array(z.string()).default([]),
  template: z.string().optional(),
});

export const ReadingSchema = z.object({
  ...base,
  title: z.string().min(1),
  classId: z.string().optional(),
  status: ReadingStatusSchema.default('to_read'),
  format: z.string().optional(),
  totalPages: z.number().int().nonnegative().optional(),
  pagesRead: z.number().int().nonnegative().optional(),
  dateRead: z.string().optional(),
  quickNotes: z.string().optional(),
  noteIds: z.array(z.string()).default([]),
});

export const StudySessionSchema = z.object({
  ...base,
  start: z.string(),
  end: z.string(),
  minutes: z.number().nonnegative(),
  classId: z.string().optional(),
  taskId: z.string().optional(),
  assignmentId: z.string().optional(),
  kind: z.enum(['pomodoro', 'manual']).default('manual'),
});

export const LetterCutoffSchema = z.object({
  letter: z.string(),
  min: z.number(),
  gpa: z.number(),
});

export const GradingSchemeSchema = z.object({
  id: z.string(),
  name: z.string(),
  mode: GradingModeSchema,
  categories: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        weight: z.number().min(0),
        dropLowest: z.number().int().min(0).optional(),
        countMode: z.enum(['pooled', 'mean']).optional(),
      }),
    )
    .optional(),
  scale: z.object({
    cutoffs: z.array(LetterCutoffSchema).min(1),
    roundingMode: z.enum(['half_up', 'truncate']).default('half_up'),
    decimals: z.number().int().min(0).max(4).default(2),
  }),
  normalizeOverGradedOnly: z.boolean().default(true),
  extraCreditAllowed: z.boolean().default(true),
  maxScore: z.number().optional(),
});

export const GpaScaleSchema = z.object({
  id: z.string(),
  name: z.string(),
  points: z.array(z.object({ letter: z.string(), gpa: z.number() })),
  weightedBonus: z.record(z.string(), z.number()),
  notes: z.string().optional(),
});

export type Semester = z.infer<typeof SemesterSchema>;
export type ClassEntity = z.infer<typeof ClassSchema>;
export type Assignment = z.infer<typeof AssignmentSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Note = z.infer<typeof NoteSchema>;
export type Reading = z.infer<typeof ReadingSchema>;
export type StudySession = z.infer<typeof StudySessionSchema>;
export type GradingScheme = z.infer<typeof GradingSchemeSchema>;
export type GpaScale = z.infer<typeof GpaScaleSchema>;
