import type { IconName } from '../components/Icon.js';

export type FieldType =
  | 'text'
  | 'number'
  | 'money'
  | 'date'
  | 'select'
  | 'textarea'
  | 'class'
  | 'classes'
  | 'checklist'
  | 'tags';
export interface Field {
  key: string;
  label: string;
  type: FieldType;
  options?: [string, string][];
  required?: boolean;
  /** Show as a table column. */
  list?: boolean;
  /** Select cell can be changed straight from the table. */
  inline?: boolean;
  hint?: string;
  default?: unknown;
}
export interface ModuleDef {
  id: string;
  label: string;
  /** API collection path. */
  path: string;
  icon: IconName;
  description: string;
  titleKey: string;
  sort: { key: string; dir: 'asc' | 'desc' };
  fields: Field[];
  empty: string;
  /** Module that has its own page instead of the generic table. */
  custom?: boolean;
  defaultOn?: boolean;
  /** Which data collection this module's files belong to, for "encrypt at rest". */
  encryptKey?: string;
}

const READING_STATUS: [string, string][] = [
  ['to_read', 'To read'],
  ['reading', 'Reading'],
  ['complete', 'Complete'],
];
const JOB_STATUS: [string, string][] = [
  ['wishlist', 'Wishlist'],
  ['applied', 'Applied'],
  ['interview', 'Interview'],
  ['offer', 'Offer'],
  ['accepted', 'Accepted'],
  ['rejected', 'Rejected'],
];
const APP_STATUS: [string, string][] = [
  ['researching', 'Researching'],
  ['in_progress', 'In progress'],
  ['submitted', 'Submitted'],
  ['accepted', 'Accepted'],
  ['waitlisted', 'Waitlisted'],
  ['rejected', 'Rejected'],
  ['enrolled', 'Enrolled'],
];
const PRIORITY: [string, string][] = [
  ['', '—'],
  ['important', 'Important'],
  ['mid', 'Mid'],
  ['low', 'Low'],
];

export const MODULES: ModuleDef[] = [
  {
    id: 'reading',
    label: 'Reading',
    path: '/readings',
    icon: 'book',
    titleKey: 'title',
    defaultOn: true,
    sort: { key: 'status', dir: 'asc' },
    description: 'Books and articles for your classes, with page progress.',
    empty: 'Add what you are reading to track pages and progress.',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'classId', label: 'Class', type: 'class', list: true },
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        options: READING_STATUS,
        list: true,
        inline: true,
        default: 'to_read',
      },
      { key: 'pagesRead', label: 'Pages read', type: 'number', list: true },
      { key: 'totalPages', label: 'Total pages', type: 'number', list: true },
      {
        key: 'format',
        label: 'Format',
        type: 'select',
        options: [
          ['', '—'],
          ['bought', 'Bought'],
          ['borrowed', 'Borrowed'],
          ['library', 'Library'],
          ['digital', 'Digital'],
        ],
      },
      { key: 'dateRead', label: 'Date finished', type: 'date' },
      { key: 'quickNotes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    id: 'journal',
    label: 'Journal',
    path: '/journal',
    icon: 'edit',
    titleKey: 'title',
    custom: true,
    encryptKey: 'journal',
    sort: { key: 'date', dir: 'desc' },
    description:
      'A private journal with moods. Blurred by default on screen shares and can be encrypted.',
    empty: 'Write your first entry.',
    fields: [],
  },
  {
    id: 'contacts',
    label: 'Contacts',
    path: '/contacts',
    icon: 'info',
    titleKey: 'name',
    encryptKey: 'contacts',
    sort: { key: 'name', dir: 'asc' },
    description: 'Instructors, advisors and classmates.',
    empty: 'Add instructors and advisors so their details are one click away.',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, list: true },
      { key: 'role', label: 'Role', type: 'text', list: true, hint: 'e.g. Instructor, Advisor' },
      { key: 'email', label: 'Email', type: 'text', list: true },
      { key: 'phone', label: 'Phone', type: 'text', list: true },
      { key: 'classIds', label: 'Classes', type: 'classes', list: true },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    id: 'activities',
    label: 'Activities',
    path: '/activities',
    icon: 'sparkle',
    titleKey: 'name',
    encryptKey: 'activities',
    sort: { key: 'name', dir: 'asc' },
    description: 'Clubs, volunteering, teams and other commitments.',
    empty: 'Track clubs, teams and volunteering, with weekly hours.',
    fields: [
      { key: 'name', label: 'Activity', type: 'text', required: true, list: true },
      { key: 'role', label: 'Role', type: 'text', list: true },
      { key: 'organization', label: 'Organization', type: 'text', list: true },
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        options: [
          ['active', 'Active'],
          ['planned', 'Planned'],
          ['past', 'Past'],
        ],
        list: true,
        inline: true,
        default: 'active',
      },
      { key: 'hoursPerWeek', label: 'Hours / week', type: 'number', list: true },
      { key: 'start', label: 'Start', type: 'date' },
      { key: 'end', label: 'End', type: 'date' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    id: 'jobs',
    label: 'Internships & jobs',
    path: '/jobs',
    icon: 'planner',
    titleKey: 'position',
    encryptKey: 'jobs',
    sort: { key: 'status', dir: 'asc' },
    description: 'Internships and jobs you are considering or have applied to.',
    empty: 'Add roles you are interested in and track each application.',
    fields: [
      { key: 'position', label: 'Position', type: 'text', required: true, list: true },
      { key: 'company', label: 'Company', type: 'text', list: true },
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        options: JOB_STATUS,
        list: true,
        inline: true,
        default: 'wishlist',
      },
      { key: 'priority', label: 'Priority', type: 'select', options: PRIORITY },
      { key: 'type', label: 'Type', type: 'text', hint: 'internship, part-time…' },
      { key: 'deadline', label: 'Deadline', type: 'date', list: true },
      { key: 'compensation', label: 'Compensation', type: 'text' },
      { key: 'url', label: 'Link', type: 'text' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    id: 'admissions',
    label: 'Admissions',
    path: '/admissions',
    icon: 'classes',
    titleKey: 'school',
    encryptKey: 'admissions',
    sort: { key: 'deadline', dir: 'asc' },
    description: 'Schools and programs you are applying to, with a checklist for each.',
    empty: 'Add schools and a checklist of what each one needs.',
    fields: [
      { key: 'school', label: 'School', type: 'text', required: true, list: true },
      { key: 'program', label: 'Program', type: 'text', list: true },
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        options: APP_STATUS,
        list: true,
        inline: true,
        default: 'researching',
      },
      { key: 'deadline', label: 'Deadline', type: 'date', list: true },
      { key: 'decisionDate', label: 'Decision date', type: 'date' },
      { key: 'fee', label: 'Application fee', type: 'money' },
      { key: 'url', label: 'Link', type: 'text' },
      { key: 'checklist', label: 'Checklist', type: 'checklist', list: true },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    id: 'budget',
    label: 'Budget',
    path: '/budget',
    icon: 'gpa',
    titleKey: 'purchase',
    encryptKey: 'budget',
    sort: { key: 'date', dir: 'desc' },
    description: 'Simple income and spending tracking.',
    empty: 'Log purchases and income to see where your money goes.',
    fields: [
      { key: 'purchase', label: 'What', type: 'text', required: true, list: true },
      {
        key: 'type',
        label: 'Type',
        type: 'select',
        options: [
          ['expense', 'Expense'],
          ['income', 'Income'],
        ],
        list: true,
        default: 'expense',
      },
      { key: 'cost', label: 'Amount', type: 'money', required: true, list: true },
      { key: 'category', label: 'Category', type: 'text', list: true },
      { key: 'date', label: 'Date', type: 'date', required: true, list: true },
      { key: 'vendor', label: 'Vendor', type: 'text' },
      { key: 'sentiment', label: 'Worth it?', type: 'text', hint: 'e.g. Worth it, Meh' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    id: 'flashcards',
    label: 'Flashcards',
    path: '/flashcards',
    icon: 'study',
    titleKey: 'front',
    custom: true,
    encryptKey: 'flashcards',
    sort: { key: 'front', dir: 'asc' },
    description: 'Spaced-repetition review of cards made from your notes.',
    empty: 'Cards appear here when notes contain {{c1::cloze}} text.',
    fields: [],
  },
];

export const moduleById = (id: string) => MODULES.find((m) => m.id === id);
export const isOn = (modules: Record<string, boolean>, id: string) =>
  modules[id] ?? !!moduleById(id)?.defaultOn;

/** Blank form values for a module (defaults applied). */
export function blankForm(
  fields: Field[],
): Record<string, string | boolean | { text: string; done: boolean }[]> {
  const out: Record<string, string | boolean | { text: string; done: boolean }[]> = {};
  for (const f of fields)
    out[f.key] = f.type === 'checklist' ? [] : f.default !== undefined ? String(f.default) : '';
  return out;
}

export function toForm(
  fields: Field[],
  item: Record<string, unknown>,
): ReturnType<typeof blankForm> {
  const out = blankForm(fields);
  for (const f of fields) {
    const v = item[f.key];
    if (v == null) continue;
    out[f.key] =
      f.type === 'checklist'
        ? (v as { text: string; done: boolean }[])
        : f.type === 'classes' || f.type === 'tags'
          ? (v as string[]).join(', ')
          : String(v);
  }
  return out;
}

/** Form values → API body. Blank optional fields become null (which clears them); numbers are validated. */
export function toPayload(
  fields: Field[],
  form: ReturnType<typeof blankForm>,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const body: Record<string, unknown> = {};
  for (const f of fields) {
    const v = form[f.key];
    if (f.type === 'checklist') {
      body[f.key] = (v as { text: string; done: boolean }[])
        .filter((c) => c.text.trim())
        .map((c) => ({ text: c.text.trim(), done: !!c.done }));
      continue;
    }
    const t = String(v ?? '').trim();
    if (f.required && !t) return { ok: false, error: `${f.label} is required.` };
    if (f.type === 'classes' || f.type === 'tags')
      body[f.key] = t
        ? t
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : [];
    else if (f.type === 'number' || f.type === 'money') {
      if (!t) body[f.key] = null;
      else {
        const n = Number(t.replace(/[$,]/g, ''));
        if (!Number.isFinite(n) || n < 0)
          return { ok: false, error: `${f.label} must be a positive number.` };
        body[f.key] = n;
      }
    } else body[f.key] = t || null;
  }
  return { ok: true, body };
}

export interface Stat {
  label: string;
  value: string;
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`;
/** Small headline numbers shown above each module's table. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function summarize(id: string, items: Record<string, any>[], now = new Date()): Stat[] {
  const count = (key: string, v: string) => items.filter((i) => i[key] === v).length;
  if (id === 'reading') {
    const pages = sum(items.map((i) => Number(i.pagesRead ?? 0)));
    return [
      { label: 'Reading now', value: String(count('status', 'reading')) },
      { label: 'Finished', value: String(count('status', 'complete')) },
      { label: 'Pages read', value: String(pages) },
    ];
  }
  if (id === 'jobs')
    return [
      { label: 'Applied', value: String(count('status', 'applied')) },
      { label: 'Interviews', value: String(count('status', 'interview')) },
      {
        label: 'Offers',
        value: String(items.filter((i) => ['offer', 'accepted'].includes(i.status)).length),
      },
    ];
  if (id === 'admissions') {
    const today = now.toISOString().slice(0, 10);
    const next = items
      .filter(
        (i) =>
          i.deadline &&
          i.deadline >= today &&
          !['submitted', 'accepted', 'rejected', 'enrolled', 'waitlisted'].includes(i.status),
      )
      .sort((a, b) => a.deadline.localeCompare(b.deadline))[0];
    const open = sum(
      items.map((i) => (i.checklist ?? []).filter((c: { done: boolean }) => !c.done).length),
    );
    return [
      { label: 'Submitted', value: String(count('status', 'submitted')) },
      { label: 'Checklist items left', value: String(open) },
      { label: 'Next deadline', value: next ? `${next.school} · ${next.deadline}` : '—' },
    ];
  }
  if (id === 'activities')
    return [
      { label: 'Active', value: String(count('status', 'active')) },
      {
        label: 'Hours / week',
        value: String(
          sum(items.filter((i) => i.status === 'active').map((i) => Number(i.hoursPerWeek ?? 0))),
        ),
      },
    ];
  if (id === 'contacts') return [{ label: 'People', value: String(items.length) }];
  if (id === 'budget') {
    const month = now.toISOString().slice(0, 7);
    const m = items.filter((i) => String(i.date).startsWith(month));
    const spent = sum(m.filter((i) => i.type !== 'income').map((i) => i.cost));
    const earned = sum(m.filter((i) => i.type === 'income').map((i) => i.cost));
    return [
      { label: 'Spent this month', value: money(spent) },
      { label: 'Income this month', value: money(earned) },
      { label: 'Net', value: money(earned - spent) },
    ];
  }
  return [];
}
export const formatMoney = money;
