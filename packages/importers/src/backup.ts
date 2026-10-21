export interface BackupV1 {
  format: 'classpad-backup';
  schemaVersion: 1;
  exportedAt: string;
  semesters: unknown[];
  classes: unknown[];
  assignments: unknown[];
  tasks: unknown[];
  readings: unknown[];
  notes: unknown[];
  journal?: unknown[];
  contacts?: unknown[];
  activities?: unknown[];
  jobs?: unknown[];
  admissions?: unknown[];
  budget?: unknown[];
  flashcards?: unknown[];
  attachments: unknown[];
  gradingSchemes: unknown[];
  gpaScales: unknown[];
}

export function parseBackup(text: string): BackupV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON');
  }
  const b = raw as Partial<BackupV1>;
  if (b?.format !== 'classpad-backup') throw new Error('Not a Classpad backup file');
  if (b.schemaVersion !== 1)
    throw new Error(`Unsupported backup version ${String(b.schemaVersion)}`);
  const arr = (k: keyof BackupV1) => (Array.isArray(b[k]) ? (b[k] as unknown[]) : []);
  return {
    format: 'classpad-backup',
    schemaVersion: 1,
    exportedAt: String(b.exportedAt ?? ''),
    semesters: arr('semesters'),
    classes: arr('classes'),
    assignments: arr('assignments'),
    tasks: arr('tasks'),
    readings: arr('readings'),
    notes: arr('notes'),
    journal: arr('journal'),
    contacts: arr('contacts'),
    activities: arr('activities'),
    jobs: arr('jobs'),
    admissions: arr('admissions'),
    budget: arr('budget'),
    flashcards: arr('flashcards'),
    attachments: arr('attachments'),
    gradingSchemes: arr('gradingSchemes'),
    gpaScales: arr('gpaScales'),
  };
}
