export interface Notifiable {
  key: string;
  title: string;
  classId?: string;
  /** local wall time: YYYY-MM-DD or YYYY-MM-DDTHH:mm */ due: string;
}
export interface Due {
  id: string;
  title: string;
  body: string;
}

const parse = (due: string): number => {
  const [d, t] = due.split('T');
  const [y, m, day] = d!.split('-').map(Number);
  const [hh, mm] = (t ?? '23:59').split(':').map(Number);
  return new Date(y!, m! - 1, day!, hh!, mm!).getTime();
};

export const leadLabel = (mins: number) =>
  mins >= 1440 && mins % 1440 === 0
    ? `${mins / 1440} day${mins === 1440 ? '' : 's'}`
    : mins >= 60 && mins % 60 === 0
      ? `${mins / 60} hour${mins === 60 ? '' : 's'}`
      : `${mins} minutes`;

/**
 * Which reminders should fire now. A reminder fires once, when we are inside the window
 * [due − lead, due) and haven't fired it. With several leads, only the tightest window that
 * applies is used, so waking up late never produces a burst of stale reminders. Date-only
 * items are due at 23:59.
 */
export function dueNotifications(
  items: Notifiable[],
  now: number,
  leads: number[],
  fired: Set<string>,
): Due[] {
  const sorted = [...leads].filter((l) => l > 0).sort((a, b) => a - b);
  const out: Due[] = [];
  for (const it of items) {
    const due = parse(it.due);
    const mins = (due - now) / 60_000;
    if (mins <= 0) continue;
    const lead = sorted.find((l) => mins <= l);
    if (lead === undefined) continue;
    const id = `${it.key}:${lead}`;
    if (fired.has(id)) continue;
    out.push({
      id,
      title: it.title,
      body: `Due in ${leadLabel(Math.max(1, Math.round(mins)) >= lead ? lead : Math.round(mins))}`,
    });
  }
  return out;
}
