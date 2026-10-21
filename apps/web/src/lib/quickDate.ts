/**
 * Pulls a natural-ish date phrase off the end of quick-add text:
 *   "Essay 2 fri 11:59pm", "Read ch 3 tomorrow", "Lab report in 3 days", "Project mar 5 9am", "Quiz 5/3".
 * Returns the remaining title and an ISO date (YYYY-MM-DD) or local datetime (YYYY-MM-DDTHH:mm).
 */
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function parseTime(s: string): string | null {
  const t = s.trim().toLowerCase();
  if (t === 'noon') return '12:00';
  if (t === 'midnight') return '23:59';
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].startsWith('p') ? 12 : 0);
  } else if (!m[2] || h > 23) return null; // a bare number is not a time
  return `${pad(h)}:${pad(min)}`;
}

export interface QuickDate {
  title: string;
  due?: string;
}

export function parseQuickDate(input: string, now = new Date()): QuickDate {
  let text = input.trim();
  let time: string | null = null;
  const tm =
    /\s+(?:at\s+)?((?:\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)\b)|(?:\d{1,2}:\d{2})|noon|midnight)$/i.exec(
      text,
    );
  if (tm) {
    time = parseTime(tm[1]!);
    if (time) text = text.slice(0, tm.index).trim();
  }

  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const take = (re: RegExp, f: (m: RegExpExecArray) => Date | null): QuickDate | null => {
    const m = re.exec(text);
    if (!m) return null;
    const d = f(m);
    if (!d) return null;
    return { title: text.slice(0, m.index).trim(), due: iso(d) + (time ? `T${time}` : '') };
  };
  const plus = (n: number) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + n);

  const found =
    take(/\s*\b(today|tonight)$/i, () => start) ??
    take(/\s*\btomorrow$/i, () => plus(1)) ??
    take(/\s*\bin (\d{1,3}) (day|days|week|weeks)$/i, (m) =>
      plus(Number(m[1]) * (m[2]!.startsWith('w') ? 7 : 1)),
    ) ??
    take(/\s*\b(?:next |on |this )?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*$/i, (m) => {
      const idx = DAYS.indexOf(m[1]!.toLowerCase().slice(0, 3));
      const diff = (idx - start.getDay() + 7) % 7;
      return plus(diff === 0 ? 7 : diff);
    }) ??
    take(
      /\s*\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?$/i,
      (m) => {
        const mo = MONTHS.indexOf(m[1]!.toLowerCase().slice(0, 3)),
          d = Number(m[2]);
        if (d < 1 || d > 31) return null;
        let t = new Date(start.getFullYear(), mo, d);
        if (t < start) t = new Date(start.getFullYear() + 1, mo, d);
        return t;
      },
    ) ??
    take(/\s*\b(\d{1,2})\/(\d{1,2})$/, (m) => {
      const mo = Number(m[1]) - 1,
        d = Number(m[2]);
      if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
      let t = new Date(start.getFullYear(), mo, d);
      if (t < start) t = new Date(start.getFullYear() + 1, mo, d);
      return t;
    }) ??
    take(
      /\s*\b(\d{4})-(\d{2})-(\d{2})$/,
      (m) => new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
    );

  if (found && found.title) return found;
  if (time && !found) return { title: input.trim() }; // a lone time with no day is ignored
  return { title: input.trim() };
}
