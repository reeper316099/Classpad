import { z } from 'zod';

const base = {
  id: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  importRef: z.string().optional(),
};

export const MOODS = [
  'happy',
  'energetic',
  'sad',
  'focused',
  'tired',
  'anxious',
  'neutral',
  'angry',
  'frustrated',
  'excited',
] as const;

export const JournalEntrySchema = z.object({
  ...base,
  date: z.string().min(8),
  title: z.string().default(''),
  mood: z.array(z.string()).default([]),
  markdown: z.string().default(''),
});

export const ContactSchema = z.object({
  ...base,
  name: z.string().min(1),
  role: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  classIds: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export const ActivitySchema = z.object({
  ...base,
  name: z.string().min(1),
  role: z.string().optional(),
  organization: z.string().optional(),
  status: z.enum(['active', 'past', 'planned']).default('active'),
  hoursPerWeek: z.number().min(0).max(168).optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  notes: z.string().optional(),
});

export const JOB_STATUSES = [
  'wishlist',
  'applied',
  'interview',
  'offer',
  'accepted',
  'rejected',
] as const;
export const JobSchema = z.object({
  ...base,
  position: z.string().min(1),
  company: z.string().default(''),
  type: z.string().optional(),
  status: z.enum(JOB_STATUSES).default('wishlist'),
  priority: z.enum(['important', 'mid', 'low']).optional(),
  compensation: z.string().optional(),
  deadline: z.string().optional(),
  url: z.string().optional(),
  notes: z.string().optional(),
});

export const APPLICATION_STATUSES = [
  'researching',
  'in_progress',
  'submitted',
  'accepted',
  'waitlisted',
  'rejected',
  'enrolled',
] as const;
export const AdmissionSchema = z.object({
  ...base,
  school: z.string().min(1),
  program: z.string().optional(),
  status: z.enum(APPLICATION_STATUSES).default('researching'),
  deadline: z.string().optional(),
  decisionDate: z.string().optional(),
  fee: z.number().min(0).optional(),
  url: z.string().optional(),
  checklist: z
    .array(z.object({ text: z.string().min(1), done: z.boolean().default(false) }))
    .default([]),
  notes: z.string().optional(),
});

export const BudgetItemSchema = z.object({
  ...base,
  purchase: z.string().min(1),
  type: z.enum(['expense', 'income']).default('expense'),
  /** Always a positive amount; `type` says which direction it goes. */
  cost: z.number().min(0),
  category: z.string().optional(),
  date: z.string().min(8),
  vendor: z.string().optional(),
  sentiment: z.string().optional(),
  notes: z.string().optional(),
});

/** Spaced-repetition state (SM-2 style). `dueAt` is an ISO timestamp. */
export const SrsSchema = z.object({
  ease: z.number().min(1.3).max(3.5).default(2.5),
  intervalDays: z.number().min(0).default(0),
  dueAt: z.string(),
  reps: z.number().int().min(0).default(0),
  lapses: z.number().int().min(0).default(0),
});

export const CardSchema = z.object({
  ...base,
  noteId: z.string().optional(),
  classId: z.string().optional(),
  front: z.string().min(1),
  back: z.string().default(''),
  /** For cloze cards: which `{{cN::…}}` this card hides. */
  cloze: z.number().int().min(1).optional(),
  /** Hash of the source text, so editing a note updates (not duplicates) its cards. */
  sourceKey: z.string().optional(),
  srs: SrsSchema,
});

export type JournalEntry = z.infer<typeof JournalEntrySchema>;
export type Contact = z.infer<typeof ContactSchema>;
export type Activity = z.infer<typeof ActivitySchema>;
export type Job = z.infer<typeof JobSchema>;
export type Admission = z.infer<typeof AdmissionSchema>;
export type BudgetItem = z.infer<typeof BudgetItemSchema>;
export type Card = z.infer<typeof CardSchema>;
export type Srs = z.infer<typeof SrsSchema>;
