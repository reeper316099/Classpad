import type { Meeting } from './parse.js';

export interface Warning {
  code: string;
  message: string;
  where?: string;
}

export interface DraftSemester {
  ref: string;
  name: string;
  start?: string;
  end?: string;
  isCurrent: boolean;
  goals: string[];
}
export interface DraftClass {
  ref: string;
  semesterRef?: string;
  name: string;
  code?: string;
  type?: string;
  delivery?: 'in_person' | 'online' | 'hybrid';
  credits?: number;
  instructor?: string;
  location?: string;
  meetings: Meeting[];
  rawTimes?: string;
  dates?: { start: string; end: string };
  quickNotes?: string;
  color: string;
  syllabusPath?: string;
}
export interface DraftAssignment {
  ref: string;
  classRef?: string;
  title: string;
  type: string[];
  status: 'not_started' | 'in_progress' | 'complete';
  priority?: 'important' | 'mid' | 'low';
  priorityLabel?: string;
  due?: string;
  weight?: number;
  score?: { percent: number };
  link?: string;
  quickNotes?: string;
  filePaths: string[];
}
export interface DraftTask {
  ref: string;
  title: string;
  assignmentRef?: string;
  classRef?: string;
  date?: string;
  priority: 'low' | 'medium' | 'high';
  done: boolean;
  targetHours?: number;
  actualHours?: number;
}
export interface DraftReading {
  ref: string;
  title: string;
  classRef?: string;
  status: 'to_read' | 'reading' | 'complete';
  format?: string;
  totalPages?: number;
  pagesRead?: number;
  dateRead?: string;
  quickNotes?: string;
}
export interface DraftNote {
  ref: string;
  title: string;
  classRef?: string;
  date?: string;
  markdown: string;
  tags: string[];
  assignmentRefs: string[];
  readingRefs: string[];
}
export interface DraftTemplate {
  kind: 'notes' | 'assignments' | 'classes';
  name: string;
  markdown: string;
}
export interface AttachmentRef {
  archivePath: string;
  filename: string;
}

export interface MappingEntry {
  file: string;
  kind: string;
  chosen: boolean;
  rows: number;
  used: string[];
  computed: string[];
  ignored: string[];
  note?: string;
}
export interface ValidationRow {
  className: string;
  exported: string;
  recomputed: string | null;
  status: 'ok' | 'mismatch' | 'both-empty' | 'exported-only' | 'recomputed-only';
  diff?: string;
}
export interface SkippedGroup {
  kind: string;
  count: number;
  reason: string;
}

export interface ImportPreview {
  source: 'notion' | 'csv' | 'ics' | 'markdown' | 'json';
  semesters: DraftSemester[];
  classes: DraftClass[];
  assignments: DraftAssignment[];
  tasks: DraftTask[];
  readings: DraftReading[];
  notes: DraftNote[];
  templates: DraftTemplate[];
  attachments: AttachmentRef[];
  skipped: SkippedGroup[];
  mapping: MappingEntry[];
  warnings: Warning[];
  validation: ValidationRow[];
}

export const emptyPreview = (source: ImportPreview['source']): ImportPreview => ({
  source,
  semesters: [],
  classes: [],
  assignments: [],
  tasks: [],
  readings: [],
  notes: [],
  templates: [],
  attachments: [],
  skipped: [],
  mapping: [],
  warnings: [],
  validation: [],
});

export const PREVIEW_KINDS = [
  'semesters',
  'classes',
  'assignments',
  'tasks',
  'readings',
  'notes',
] as const;
