import { useEffect, useRef } from 'react';
import { announce } from '../lib/usePomodoro.js';
import { useTasks } from '../lib/hooks.js';
import { dueNotifications, type Notifiable } from '../lib/notify.js';
import { useDeadlines } from '../lib/planner.js';
import { useUi } from '../lib/store.js';

const KEY = 'classpad-notified';
const readFired = (): Record<string, number> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
};

/** Local reminders for deadlines and dated tasks. Nothing leaves the machine. */
export function Notifier() {
  const leads = useUi((s) => s.notifyLeads);
  const { data: deadlines = [] } = useDeadlines();
  const { data: tasks = [] } = useTasks();
  const latest = useRef<Notifiable[]>([]);
  latest.current = [
    ...deadlines
      .filter((d) => d.urgency !== 'overdue')
      .map((d) => ({ key: `a:${d.id}`, title: d.title, due: d.due.split('/')[0]! })),
    ...tasks
      .filter((t) => !t.done && t.date)
      .map((t) => ({ key: `t:${t.id}`, title: t.title, due: t.date!.split('/')[0]! })),
  ];

  useEffect(() => {
    if (!leads.length) return;
    const check = () => {
      const fired = readFired();
      const due = dueNotifications(latest.current, Date.now(), leads, new Set(Object.keys(fired)));
      if (!due.length) return;
      const now = Date.now();
      for (const d of due) {
        fired[d.id] = now;
        announce(d.title, d.body);
      }
      for (const [k, t] of Object.entries(fired)) if (now - t > 3 * 86_400_000) delete fired[k]; // forget old reminders
      try {
        localStorage.setItem(KEY, JSON.stringify(fired));
      } catch {
        /* optional */
      }
    };
    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, [leads]);
  return null;
}
