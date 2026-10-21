import { describe, expect, it } from 'vitest';
import { dueNotifications, leadLabel } from './notify.js';

const at = (d: string, h: number, m = 0) => new Date(2031, 9, Number(d), h, m).getTime();
const items = [
  { key: 'a1', title: 'Essay', due: '2031-10-16T09:00' },
  { key: 'a2', title: 'Quiz', due: '2031-10-16' },
];

describe('deadline reminders', () => {
  it('fires inside the window once, never twice', () => {
    const fired = new Set<string>();
    expect(dueNotifications(items, at('15', 8), [60], fired)).toEqual([]); // 25h before
    const first = dueNotifications(items, at('16', 8, 30), [60], fired);
    expect(first.map((d) => d.title)).toEqual(['Essay']);
    first.forEach((d) => fired.add(d.id));
    expect(dueNotifications(items, at('16', 8, 45), [60], fired)).toEqual([]);
  });
  it('never fires for things already due', () =>
    expect(dueNotifications([items[0]!], at('16', 9, 1), [60, 1440], new Set())).toEqual([]));
  it('date-only items are due at 23:59', () => {
    expect(dueNotifications(items, at('16', 23, 0), [60], new Set()).map((d) => d.title)).toEqual([
      'Quiz',
    ]);
  });
  it('with several leads only the tightest window applies (no burst after waking late)', () => {
    const r = dueNotifications([items[0]!], at('16', 8, 30), [1440, 60], new Set());
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe('a1:60');
    expect(dueNotifications([items[0]!], at('15', 12), [1440, 60], new Set())[0]!.id).toBe(
      'a1:1440',
    );
  });
  it('no leads, no reminders; zero or negative leads are ignored', () => {
    expect(dueNotifications(items, at('16', 8, 30), [], new Set())).toEqual([]);
    expect(dueNotifications(items, at('16', 8, 30), [0, -5], new Set())).toEqual([]);
  });
  it('labels leads', () => {
    expect([
      leadLabel(15),
      leadLabel(60),
      leadLabel(120),
      leadLabel(1440),
      leadLabel(2880),
    ]).toEqual(['15 minutes', '1 hour', '2 hours', '1 day', '2 days']);
  });
});
