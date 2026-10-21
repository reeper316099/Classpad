import ICAL from 'ical.js';
import { emptyPreview, type ImportPreview } from './types.js';
import { nameRef } from './csvImport.js';
import { normTitle } from './parse.js';

const pad = (n: number) => String(n).padStart(2, '0');

function toIso(t: ICAL.Time): string {
  if (t.isDate) return `${t.year}-${pad(t.month)}-${pad(t.day)}`;
  if (t.zone && t.zone.tzid === 'UTC') {
    const d = t.toJSDate(); // convert to local wall time
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${t.year}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}`;
}

export interface IcsOptions {
  as?: 'tasks' | 'assignments';
  className?: string;
}

/** Calendar events become tasks (default) or assignments of a named class. Recurring events import once. */
export function previewIcs(text: string, opts: IcsOptions = {}): ImportPreview {
  const out = emptyPreview('ics');
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(text));
  } catch (e) {
    out.warnings.push({
      code: 'ICS_PARSE',
      message: `Could not read calendar: ${(e as Error).message}`,
    });
    return out;
  }
  const seen = new Set<string>();
  let recurring = 0;
  for (const ev of root.getAllSubcomponents('vevent')) {
    const e = new ICAL.Event(ev);
    const title = (e.summary || '').trim();
    if (!title) {
      out.warnings.push({ code: 'EMPTY_EVENT', message: 'Event without a title skipped' });
      continue;
    }
    const uid = e.uid || title;
    const start = e.startDate ? toIso(e.startDate) : undefined;
    const end = e.endDate ? toIso(e.endDate) : undefined;
    let due = start;
    if (start && end && end !== start && start.includes('T')) due = `${start}/${end}`;
    if (ev.hasProperty('rrule')) recurring++;
    let ref = `ics:${opts.as ?? 'tasks'}:${normTitle(uid)}`;
    for (let n = 2; seen.has(ref); n++) ref = `${ref.replace(/#\d+$/, '')}#${n}`;
    seen.add(ref);
    const description = (e.description || '').trim();
    if (opts.as === 'assignments') {
      out.assignments.push({
        ref,
        title,
        classRef: opts.className ? nameRef('class', opts.className) : undefined,
        type: [],
        status: 'not_started',
        due,
        quickNotes: description || undefined,
        filePaths: [],
      });
    } else {
      out.tasks.push({ ref, title, date: due, priority: 'medium', done: false });
    }
  }
  if (recurring)
    out.warnings.push({
      code: 'RECURRING',
      message: `${recurring} recurring event(s) were imported once (first occurrence only)`,
    });
  return out;
}

// ------------------------------- export -------------------------------
const esc = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** RFC 5545 line folding at 75 octets, never splitting a UTF-8 character. */
export function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      out.push(cur);
      cur = ' ';
      bytes = 1;
      limit = 75;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

const compact = (iso: string) => iso.replace(/[-:]/g, '');
const nextDay = (d: string) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
};

export interface IcsDeadline {
  id: string;
  title: string;
  due: string;
  className?: string;
  notes?: string;
}
export interface IcsMeeting {
  classId: string;
  className: string;
  day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
  start: string;
  end: string;
  location?: string;
  from: string;
  until: string;
}
const BYDAY = {
  mon: 'MO',
  tue: 'TU',
  wed: 'WE',
  thu: 'TH',
  fri: 'FR',
  sat: 'SA',
  sun: 'SU',
} as const;
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function buildIcs(input: {
  deadlines?: IcsDeadline[];
  meetings?: IcsMeeting[];
  now?: Date;
  name?: string;
}): string {
  const stamp = (input.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const L: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Classpad//Export//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${esc(input.name ?? 'Classpad')}`,
  ];
  for (const d of input.deadlines ?? []) {
    const [a, b] = d.due.split('/');
    L.push('BEGIN:VEVENT', `UID:${d.id}@classpad`, `DTSTAMP:${stamp}`, `SUMMARY:${esc(d.title)}`);
    if (a!.includes('T')) {
      L.push(`DTSTART:${compact(a!)}00`);
      L.push(`DTEND:${compact(b ?? a!)}00`);
    } else {
      L.push(
        `DTSTART;VALUE=DATE:${compact(a!)}`,
        `DTEND;VALUE=DATE:${compact(b ? nextDay(b) : nextDay(a!))}`,
      );
    }
    const desc = [d.className ? `Class: ${d.className}` : '', d.notes ?? '']
      .filter(Boolean)
      .join('\n');
    if (desc) L.push(`DESCRIPTION:${esc(desc)}`);
    if (d.className) L.push(`CATEGORIES:${esc(d.className)}`);
    L.push('END:VEVENT');
  }
  for (const m of input.meetings ?? []) {
    // first occurrence on/after `from` that falls on the meeting weekday
    const first = new Date(`${m.from}T00:00:00Z`);
    for (let i = 0; i < 7 && DOW[first.getUTCDay()] !== m.day; i++)
      first.setUTCDate(first.getUTCDate() + 1);
    const day = first.toISOString().slice(0, 10);
    L.push(
      'BEGIN:VEVENT',
      `UID:${m.classId}-${m.day}-${m.start.replace(':', '')}@classpad`,
      `DTSTAMP:${stamp}`,
      `SUMMARY:${esc(m.className)}`,
      `DTSTART:${compact(day)}T${m.start.replace(':', '')}00`,
      `DTEND:${compact(day)}T${m.end.replace(':', '')}00`,
      `RRULE:FREQ=WEEKLY;BYDAY=${BYDAY[m.day]};UNTIL=${compact(m.until)}T235959`,
    );
    if (m.location) L.push(`LOCATION:${esc(m.location)}`);
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
