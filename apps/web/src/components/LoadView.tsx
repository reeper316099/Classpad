import { useAgenda, useStats } from '../lib/planner.js';
import {
  WEEKDAY_SHORT,
  addDays,
  dayLabel,
  dowKey,
  fromIso,
  weekStartOf,
  weekdayHeaders,
} from '../lib/dates.js';
import { useUi } from '../lib/store.js';
import { dayLoad, heatLevel } from '../lib/tasks.js';
import { useTasks } from '../lib/hooks.js';
import { Skeleton } from './ui.js';
import { useToday } from './PlannerViews.js';

const LABEL = { light: 'Light', normal: 'Steady', heavy: 'Heavy' } as const;
const BADGE = { light: 'success', normal: 'info', heavy: 'danger' } as const;

export function LoadView() {
  const today = useToday();
  const startPref = useUi((s) => s.weekStart);
  const { data: stats } = useStats();
  const start = weekStartOf(today, startPref);
  const { data: items = [] } = useAgenda(start, addDays(start, 27));
  const { data: tasks = [] } = useTasks();
  if (!stats) return <Skeleton h={240} />;
  const now = stats.workload[0]!;
  const max = Math.max(...stats.workload.map((w) => w.score), 6);
  const heavyIds = items
    .filter(
      (i) =>
        i.kind === 'deadline' &&
        !i.done &&
        i.start.slice(0, 10) >= stats.weekStart &&
        i.start.slice(0, 10) <= stats.weekEnd,
    )
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, 3);
  const hoursOn = (d: string) =>
    tasks
      .filter((t) => !t.done && t.date?.slice(0, 10) === d)
      .reduce((n, t) => n + (t.targetHours ?? 0), 0);

  return (
    <div className="stack">
      <div className={`card row load-banner ${now.load}`} role="status">
        <span className={`badge ${BADGE[now.load]}`}>{LABEL[now.load]} week</span>
        <b>
          {now.load === 'heavy'
            ? 'This week is heavy.'
            : now.load === 'normal'
              ? 'A steady week.'
              : 'A light week: a good time to get ahead.'}
        </b>
        <span className="muted">
          {now.deadlines} deadline{now.deadlines === 1 ? '' : 's'}
          {now.taskHours ? ` · ${now.taskHours}h of planned tasks` : ''}
        </span>
        {now.load === 'heavy' && heavyIds.length > 0 && (
          <span className="muted small">
            Biggest:{' '}
            {heavyIds.map((i) => `${i.title}${i.weight ? ` (${i.weight}%)` : ''}`).join(', ')}
          </span>
        )}
      </div>

      <section className="card stack">
        <h2>Next 8 weeks</h2>
        <div className="load-bars" role="list">
          {stats.workload.map((w, i) => (
            <div
              key={w.weekStart}
              role="listitem"
              className="load-bar"
              title={`${w.deadlines} deadlines, ${w.taskHours}h tasks`}
            >
              <div
                className="load-fill"
                style={{
                  height: `${Math.max(4, (w.score / max) * 100)}%`,
                  background: `var(--${w.load === 'heavy' ? 'danger' : w.load === 'normal' ? 'info' : 'success'})`,
                }}
              />
              <span className="small">
                {i === 0 ? 'This wk' : dayLabel(w.weekStart, { month: 'short', day: 'numeric' })}
              </span>
              <span className="muted small">{w.deadlines} due</span>
            </div>
          ))}
        </div>
        <p className="muted small">
          Each deadline counts 1, plus 1 per 20% of weight, plus extra for importance; planned task
          hours count half. Under 3 is light, 6 or more is heavy.
        </p>
      </section>

      <section className="card stack">
        <h2>Day by day</h2>
        <div className="heat" role="grid" aria-label="Workload heatmap, next four weeks">
          {weekdayHeaders(startPref).map((d) => (
            <div key={d} className="muted small heat-head" role="columnheader">
              {WEEKDAY_SHORT[d]}
            </div>
          ))}
          {Array.from({ length: 28 }, (_, i) => {
            const date = addDays(start, i);
            const day = items.filter((x) => x.start.slice(0, 10) === date);
            const score = dayLoad(day, hoursOn(date));
            const lvl = heatLevel(score);
            const n = day.filter((x) => x.kind === 'deadline' && !x.done).length;
            return (
              <div
                key={date}
                role="gridcell"
                className={`heat-cell l${lvl} ${date === today ? 'today' : ''}`}
                title={`${dayLabel(date)}: ${n} deadline${n === 1 ? '' : 's'}${hoursOn(date) ? `, ${hoursOn(date)}h tasks` : ''}`}
              >
                <span className="small">{fromIso(date).getDate()}</span>
                {n > 0 && <b className="small">{n}</b>}
                <span className="sr-only">
                  {dowKey(date)} {date}: load {lvl} of 3
                </span>
              </div>
            );
          })}
        </div>
        <div className="row small muted">
          <span>Lighter</span>
          {[0, 1, 2, 3].map((l) => (
            <span
              key={l}
              className={`heat-cell l${l}`}
              style={{ width: 22, height: 14, minHeight: 0 }}
            />
          ))}
          <span>Heavier</span>
        </div>
      </section>
    </div>
  );
}
