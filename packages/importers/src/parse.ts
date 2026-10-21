/** Small, pure parsers for the messy cell formats found in database exports. */

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const DAY_ALIASES: Record<string, Weekday> = {
  mon: 'mon',
  monday: 'mon',
  m: 'mon',
  tue: 'tue',
  tues: 'tue',
  tuesday: 'tue',
  wed: 'wed',
  weds: 'wed',
  wednesday: 'wed',
  thu: 'thu',
  thur: 'thu',
  thurs: 'thu',
  thursday: 'thu',
  fri: 'fri',
  friday: 'fri',
  sat: 'sat',
  saturday: 'sat',
  sun: 'sun',
  sunday: 'sun',
};

export const parseDay = (s: string): Weekday | null =>
  DAY_ALIASES[s.trim().toLowerCase().replace(/[.:]/g, '')] ?? null;

export function parseDays(cell: string): Weekday[] {
  const days = cell
    .split(/[,;/&]|\band\b/i)
    .map(parseDay)
    .filter((d): d is Weekday => !!d);
  return [...new Set(days)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
}

/** "20%", "20", " 0.5 % " -> number in percent units. null when blank/unparseable. */
export function parsePercent(cell: string | undefined): number | null {
  const s = (cell ?? '').trim().replace(/,/g, '');
  if (!s) return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*%?$/.exec(s);
  return m ? Number(m[1]) : null;
}

export function parseNumber(cell: string | undefined): number | null {
  const s = (cell ?? '').trim().replace(/,/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseBool(cell: string | undefined): boolean {
  return /^(yes|true|checked|x|1)$/i.test((cell ?? '').trim());
}

// ---------------- dates ----------------
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const pad = (n: number) => String(n).padStart(2, '0');

export interface ParsedDate {
  /** ISO date (YYYY-MM-DD) or local datetime (YYYY-MM-DDTHH:mm). */
  start: string;
  end?: string;
  hasTime: boolean;
  timezoneLabel?: string;
}

function parseOne(raw: string): { iso: string; hasTime: boolean; tz?: string } | null {
  let s = raw.trim();
  if (!s) return null;
  let tz: string | undefined;
  const tzm = /\s*\(([^)]*)\)\s*$/.exec(s);
  if (tzm) {
    tz = tzm[1];
    s = s.slice(0, tzm.index).trim();
  }
  let y: number, mo: number, d: number;
  let rest = '';
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](.*))?$/.exec(s))) {
    y = +m[1]!;
    mo = +m[2]!;
    d = +m[3]!;
    rest = m[4] ?? '';
  } else if ((m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s*(.*)$/.exec(s))) {
    y = +m[1]!;
    mo = +m[2]!;
    d = +m[3]!;
    rest = m[4] ?? '';
  } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(.*)$/.exec(s))) {
    mo = +m[1]!;
    d = +m[2]!;
    y = +m[3]!;
    rest = m[4] ?? '';
  } else if ((m = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s*(.*)$/.exec(s))) {
    const idx = MONTHS.findIndex(
      (n) =>
        n.startsWith(m![1]!.toLowerCase().slice(0, 3)) &&
        n.startsWith(m![1]!.toLowerCase().slice(0, Math.max(3, m![1]!.length))),
    );
    if (idx < 0) return null;
    mo = idx + 1;
    d = +m[2]!;
    y = +m[3]!;
    rest = m[4] ?? '';
  } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = `${y}-${pad(mo)}-${pad(d)}`;
  rest = rest.trim();
  if (!rest) return { iso: date, hasTime: false, tz };
  const t = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?m?\.?$/i.exec(rest);
  if (!t) return { iso: date, hasTime: false, tz };
  let h = +t[1]!;
  const mer = t[3]?.toLowerCase();
  if (mer === 'p' && h < 12) h += 12;
  if (mer === 'a' && h === 12) h = 0;
  return { iso: `${date}T${pad(h)}:${t[2]}`, hasTime: true, tz };
}

/** Handles "August 28, 2026", "... 3:00 PM (EST)", ISO, US numeric, and "A → B" ranges. */
export function parseNotionDate(cell: string | undefined): ParsedDate | null {
  const s = (cell ?? '').trim();
  if (!s) return null;
  const parts = s.split(/\s*(?:→|->|—|–)\s*/);
  const a = parseOne(parts[0]!);
  if (!a) return null;
  const b = parts[1] ? parseOne(parts[1]) : null;
  return {
    start: a.iso,
    end: b?.iso,
    hasTime: a.hasTime || !!b?.hasTime,
    timezoneLabel: a.tz ?? b?.tz,
  };
}

/** Assignment/semester `due` convention: single value, or "start/end" interval. */
export const formatInterval = (d: ParsedDate): string => (d.end ? `${d.start}/${d.end}` : d.start);

// ---------------- times ----------------
export interface Meeting {
  day: Weekday;
  start: string;
  end: string;
}
const TIME =
  /(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?/i;

export function parseTimeRange(s: string): { start: string; end: string } | null {
  const m = TIME.exec(s);
  if (!m) return null;
  const sh = +m[1]!,
    sm = +(m[2] ?? 0),
    eh = +m[4]!,
    em = +(m[5] ?? 0);
  const sMer = m[3]?.toLowerCase(),
    eMer = m[6]?.toLowerCase();
  const to24 = (h: number, mer?: string) =>
    mer === 'p' ? (h % 12) + 12 : mer === 'a' ? h % 12 : h;
  if (sh > 24 || eh > 24 || sm > 59 || em > 59) return null;
  let endH = to24(eh, eMer);
  let startH = to24(sh, sMer ?? eMer);
  if (!sMer && !eMer && sh <= 12 && eh <= 12 && startH >= endH) {
    /* ambiguous 12h without marker */ endH = eh < 8 ? eh + 12 : eh;
  }
  // "11-1p": inferred start (pm) lands after the end, so it must be am
  if (!sMer && startH * 60 + sm >= endH * 60 + em && sh <= 12) startH = sh % 12;
  return { start: `${pad(startH)}:${pad(sm)}`, end: `${pad(endH)}:${pad(em)}` };
}

export interface TimesResult {
  meetings: Meeting[];
  warnings: string[];
}

/**
 * `times` may be one compact range ("11:50a-1:10p", applied to every day in `days`) or one line per
 * day, optionally prefixed with a weekday ("Mon 10:00 AM - 11:15 AM"). Raw text is kept by callers.
 */
export function parseTimes(times: string, days: Weekday[]): TimesResult {
  const warnings: string[] = [];
  const lines = times
    .split(/\r?\n|;/)
    .map((l) => l.trim())
    .filter(Boolean);
  const meetings: Meeting[] = [];
  const unprefixed: { start: string; end: string }[] = [];
  for (const line of lines) {
    const dayMatch = /^([A-Za-z]+)\.?\s*[:,-]?\s*(.*)$/.exec(line);
    const lead = dayMatch ? parseDay(dayMatch[1]!) : null;
    const body = lead ? dayMatch![2]! : line;
    const range = parseTimeRange(body);
    if (!range) {
      warnings.push(`Could not read time "${line}"`);
      continue;
    }
    if (lead) meetings.push({ day: lead, ...range });
    else unprefixed.push(range);
  }
  if (unprefixed.length === 1) {
    if (!days.length) warnings.push('Time given without any days');
    for (const d of days) meetings.push({ day: d, ...unprefixed[0]! });
  } else if (unprefixed.length > 1) {
    if (unprefixed.length === days.length) {
      warnings.push('Several time lines paired to days by weekday order');
      days.forEach((d, i) => meetings.push({ day: d, ...unprefixed[i]! }));
    } else warnings.push(`${unprefixed.length} time lines but ${days.length} days; could not pair`);
  }
  meetings.sort(
    (a, b) => WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day) || a.start.localeCompare(b.start),
  );
  return { meetings, warnings };
}

// ---------------- options ----------------
const INVISIBLE = /[​-‏‪- ⁠-⁩  ﻿­]/g;

export function cleanLabel(s: string): string {
  return s.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
}

export type PriorityValue = 'important' | 'mid' | 'low';
/** Strips emoji, invisible direction marks and odd spaces; keeps the cleaned display label. */
export function normalizePriority(
  cell: string | undefined,
): { value: PriorityValue; label: string } | null {
  const label = cleanLabel(cell ?? '');
  if (!label) return null;
  const word = label
    .replace(/[\p{Extended_Pictographic}️⃣]/gu, '')
    .replace(/[^\p{L}]/gu, '')
    .toLowerCase();
  if (/^(important|high|urgent|critical)/.test(word)) return { value: 'important', label };
  if (/^(mid|medium|normal|moderate)/.test(word)) return { value: 'mid', label };
  if (/^(low|minor|someday)/.test(word)) return { value: 'low', label };
  return null;
}

export type TaskPriority = 'low' | 'medium' | 'high';
export function normalizeTaskPriority(cell: string | undefined): TaskPriority | null {
  const p = normalizePriority(cell);
  if (!p) return null;
  return p.value === 'important' ? 'high' : p.value === 'mid' ? 'medium' : 'low';
}

/** "In-Class" -> in_class, "Group Project" -> group_project */
export const slugOption = (s: string): string =>
  cleanLabel(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

export function splitMulti(cell: string | undefined): string[] {
  return (cell ?? '').split(',').map(cleanLabel).filter(Boolean);
}

// ---------------- relations ----------------
export interface RelationRef {
  title: string;
  path?: string;
  id?: string;
  url?: string;
}

/** `Title (url%20encoded/path.md), Other (path.md)`; falls back to plain comma lists. */
export function parseRelation(cell: string | undefined): RelationRef[] {
  const s = (cell ?? '').trim();
  if (!s) return [];
  const out: RelationRef[] = [];
  const re = /\(([^()]*?\.md|https?:\/\/[^()\s]*)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const title = s
      .slice(last, m.index)
      .replace(/^[\s,]+/, '')
      .trim();
    let path = m[1]!;
    if (/^https?:/i.test(path)) {
      out.push({ title, url: path, id: /([0-9a-f]{32})(?=[?#]|$)/.exec(path)?.[1] });
      last = m.index + m[0].length;
      continue;
    }
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep raw */
    }
    out.push({ title, path, id: /([0-9a-f]{32})(?:\.md)?$/.exec(path)?.[1] });
    last = m.index + m[0].length;
  }
  if (!out.length)
    return s
      .split(',')
      .map((t) => ({ title: t.trim() }))
      .filter((r) => r.title);
  return out;
}

export const normTitle = (s: string): string =>
  cleanLabel(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Split "Name 0123…(32 hex)<suffix>" file names. */
export function splitName(file: string): { base: string; id?: string; suffix: string } {
  const m = /^(.*?)\s*([0-9a-f]{32})(.*)$/.exec(file);
  return m ? { base: m[1]!, id: m[2], suffix: m[3]! } : { base: file, suffix: '' };
}
