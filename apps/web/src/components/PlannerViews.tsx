import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDialogs } from '../lib/dialogs.js';
import {
  WEEKDAY_SHORT,
  addDays,
  dayLabel,
  dowKey,
  fromIso,
  minutesOf,
  monthGrid,
  monthLabel,
  toIso,
  weekDays,
  weekStartOf,
  weekdayHeaders,
} from '../lib/dates.js';
import { fmtTime } from '../lib/format.js';
import { useClasses, useSaveMutation } from '../lib/hooks.js';
import { useAgenda, useDeadlines, useTimetable, type AgendaItem } from '../lib/planner.js';
import { useUi } from '../lib/store.js';
import type { Assignment, ClassEntity, Task } from '../lib/types.js';
import { Icon } from './Icon.js';
import { ClassChip, Skeleton, classStyle } from './ui.js';

const HOUR = 52; // px per hour in the week grid
export const useToday = () => {
  const [t, setT] = useState(toIso(new Date()));
  useEffect(() => {
    const id = setInterval(() => setT(toIso(new Date())), 60_000);
    return () => clearInterval(id);
  }, []);
  return t;
};

export function useOpenItem() {
  const dialogs = useDialogs();
  const nav = useNavigate();
  return (i: AgendaItem) => {
    if (i.kind === 'deadline') dialogs.openAssignment({ id: i.id });
    else if (i.kind === 'task') dialogs.openTask({ id: i.id });
    else if (i.classId) nav(`/classes/${i.classId}`);
  };
}
const kindIcon = {
  deadline: 'assignments',
  task: 'check',
  class: 'classes',
  study: 'study',
} as const;
const classMap = (classes: ClassEntity[]) => new Map(classes.map((c) => [c.id, c]));

function Nav({
  label,
  onPrev,
  onNext,
  onToday,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  return (
    <div className="row">
      <button className="btn icon" onClick={onPrev} aria-label="Previous">
        <Icon name="chevron" style={{ transform: 'rotate(180deg)' }} />
      </button>
      <button className="btn icon" onClick={onNext} aria-label="Next">
        <Icon name="chevron" />
      </button>
      <button className="btn" onClick={onToday}>
        Today
      </button>
      <h2 style={{ marginLeft: 8 }} aria-live="polite">
        {label}
      </h2>
    </div>
  );
}

// ------------------------------------------------------------------ week
export function WeekView() {
  const today = useToday();
  const weekStartPref = useUi((s) => s.weekStart);
  const [anchor, setAnchor] = useState(today);
  const { data: tt, isLoading } = useTimetable(anchor);
  const { data: classes = [] } = useClasses();
  const open = useOpenItem();
  const byId = classMap(classes);
  const days =
    tt?.days ??
    weekDays(weekStartOf(anchor, weekStartPref)).map((date) => ({
      date,
      items: [] as AgendaItem[],
    }));

  const timed = days.flatMap((d) => d.items.filter((i) => !i.allDay));
  const lo = Math.max(
    0,
    Math.min(8, ...timed.map((i) => Math.floor(minutesOf(i.start.slice(11)) / 60))),
  );
  const hi = Math.min(
    24,
    Math.max(18, ...timed.map((i) => Math.ceil(minutesOf((i.end ?? i.start).slice(11)) / 60))),
  );
  const hours = Array.from({ length: hi - lo }, (_, i) => lo + i);
  const now = new Date();
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60 - lo) * HOUR;

  return (
    <div className="stack">
      <Nav
        label={`${dayLabel(days[0]!.date, { month: 'short', day: 'numeric' })} – ${dayLabel(days[6]!.date, { month: 'short', day: 'numeric', year: 'numeric' })}`}
        onPrev={() => setAnchor(addDays(anchor, -7))}
        onNext={() => setAnchor(addDays(anchor, 7))}
        onToday={() => setAnchor(today)}
      />
      {isLoading ? (
        <Skeleton h={300} />
      ) : (
        <div className="week card" role="group" aria-label="Week timetable">
          <div className="week-head">
            <div />
            {days.map((d) => (
              <div key={d.date} className={`week-dayhead ${d.date === today ? 'today' : ''}`}>
                <span className="muted small">{WEEKDAY_SHORT[dowKey(d.date)]}</span>
                <b>{fromIso(d.date).getDate()}</b>
              </div>
            ))}
          </div>
          <div className="week-allday">
            <div className="muted small">All day</div>
            {days.map((d) => (
              <div key={d.date} className="week-allcell">
                {d.items
                  .filter((i) => i.allDay)
                  .map((i) => (
                    <Chip
                      key={i.id}
                      item={i}
                      cls={byId.get(i.classId ?? '')}
                      onClick={() => open(i)}
                    />
                  ))}
              </div>
            ))}
          </div>
          <div className="week-body" style={{ height: hours.length * HOUR }}>
            <div className="week-hours">
              {hours.map((h) => (
                <div key={h} style={{ height: HOUR }} className="muted small">
                  {fmtTime(`${h}:00`).replace(':00', '')}
                </div>
              ))}
            </div>
            {days.map((d) => (
              <div
                key={d.date}
                className={`week-col ${d.date === today ? 'today' : ''}`}
                style={{ backgroundSize: `100% ${HOUR}px` }}
              >
                {d.date === today && nowTop >= 0 && nowTop <= hours.length * HOUR && (
                  <div className="now-line" style={{ top: nowTop }} aria-hidden />
                )}
                {d.items
                  .filter((i) => !i.allDay)
                  .map((i) => {
                    const s = minutesOf(i.start.slice(11)),
                      e = i.end ? minutesOf(i.end.slice(11)) : s + 30;
                    const c = byId.get(i.classId ?? '');
                    return (
                      <button
                        key={i.id}
                        className={`week-block ${i.kind} ${i.done ? 'done' : ''}`}
                        style={{
                          ...classStyle(c?.color),
                          top: (s / 60 - lo) * HOUR,
                          height: Math.max(24, ((e - s) / 60) * HOUR - 2),
                        }}
                        onClick={() => open(i)}
                        title={`${i.title} · ${fmtTime(i.start.slice(11))}${i.end ? '–' + fmtTime(i.end.slice(11)) : ''}${i.location ? ' · ' + i.location : ''}`}
                      >
                        <b>{i.title}</b>
                        <span>
                          {fmtTime(i.start.slice(11))}
                          {i.end && i.kind === 'class' ? `–${fmtTime(i.end.slice(11))}` : ''}
                          {i.location ? ` · ${i.location}` : ''}
                        </span>
                      </button>
                    );
                  })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({
  item,
  cls,
  onClick,
}: {
  item: AgendaItem;
  cls?: ClassEntity;
  onClick: () => void;
}) {
  return (
    <button
      className={`cal-chip ${item.kind} ${item.done ? 'done' : ''}`}
      style={classStyle(cls?.color)}
      onClick={onClick}
      title={`${item.title}${cls ? ' · ' + cls.name : ''}`}
    >
      <Icon name={kindIcon[item.kind]} size={11} /> <span>{item.title}</span>
    </button>
  );
}

// ------------------------------------------------------------------ month
export function MonthView() {
  const today = useToday();
  const start = useUi((s) => s.weekStart);
  const [anchor, setAnchor] = useState(`${today.slice(0, 7)}-01`);
  const [sel, setSel] = useState(today);
  const grid = useMemo(() => monthGrid(anchor, start), [anchor, start]);
  const { data: items = [] } = useAgenda(grid[0]!.date, grid[41]!.date);
  const { data: classes = [] } = useClasses();
  const open = useOpenItem();
  const byId = classMap(classes);
  const by = new Map<string, AgendaItem[]>();
  for (const i of items.filter((x) => x.kind !== 'class' && x.kind !== 'study'))
    by.set(i.start.slice(0, 10), [...(by.get(i.start.slice(0, 10)) ?? []), i]);
  const dayItems = items.filter((i) => i.start.slice(0, 10) === sel);
  const move = (n: number) => {
    const a = addMonthsLocal(anchor, n);
    setAnchor(a);
    setSel(a);
  };

  return (
    <div className="stack">
      <Nav
        label={monthLabel(anchor)}
        onPrev={() => move(-1)}
        onNext={() => move(1)}
        onToday={() => {
          setAnchor(`${today.slice(0, 7)}-01`);
          setSel(today);
        }}
      />
      <div className="month card" role="grid" aria-label={monthLabel(anchor)}>
        {weekdayHeaders(start).map((d) => (
          <div key={d} role="columnheader" className="month-head muted small">
            {WEEKDAY_SHORT[d]}
          </div>
        ))}
        {grid.map(({ date, inMonth }) => {
          const list = by.get(date) ?? [];
          return (
            <div
              key={date}
              role="gridcell"
              tabIndex={0}
              aria-selected={sel === date}
              className={`month-cell ${inMonth ? '' : 'out'} ${date === today ? 'today' : ''} ${sel === date ? 'sel' : ''}`}
              onClick={() => setSel(date)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSel(date);
                }
              }}
            >
              <span className="month-num">{fromIso(date).getDate()}</span>
              {list.slice(0, 3).map((i) => (
                <Chip key={i.id} item={i} cls={byId.get(i.classId ?? '')} onClick={() => open(i)} />
              ))}
              {list.length > 3 && <span className="muted small">+{list.length - 3} more</span>}
            </div>
          );
        })}
      </div>
      <div className="card stack tight">
        <h3>{dayLabel(sel)}</h3>
        {dayItems.length === 0 ? (
          <p className="muted">Nothing scheduled.</p>
        ) : (
          dayItems.map((i) => <AgendaRow key={i.id} item={i} cls={byId.get(i.classId ?? '')} />)
        )}
      </div>
    </div>
  );
}
const addMonthsLocal = (s: string, n: number) => {
  const d = fromIso(s);
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  return toIso(d);
};

// ------------------------------------------------------------------ agenda
export function AgendaRow({ item, cls }: { item: AgendaItem; cls?: ClassEntity }) {
  const open = useOpenItem();
  const saveTask = useSaveMutation<Task>('tasks');
  const saveAsg = useSaveMutation<Assignment>('assignments');
  const toggle = () =>
    item.kind === 'task'
      ? saveTask.mutate({ id: item.id, data: { done: !item.done } })
      : item.kind === 'deadline'
        ? saveAsg.mutate({ id: item.id, data: { status: item.done ? 'in_progress' : 'complete' } })
        : undefined;
  return (
    <div className={`row agenda-row ${item.done ? 'done' : ''}`} style={classStyle(cls?.color)}>
      {item.kind === 'task' || item.kind === 'deadline' ? (
        <input
          type="checkbox"
          checked={!!item.done}
          onChange={toggle}
          aria-label={`Mark “${item.title}” ${item.done ? 'not done' : 'done'}`}
        />
      ) : (
        <Icon name={kindIcon[item.kind]} size={16} />
      )}
      <span className="agenda-time muted small">
        {item.allDay
          ? 'All day'
          : fmtTime(item.start.slice(11)) +
            (item.end && item.kind === 'class' ? `–${fmtTime(item.end.slice(11))}` : '')}
      </span>
      <button
        className="btn ghost sm grow"
        style={{ justifyContent: 'flex-start', color: 'var(--text)' }}
        onClick={() => open(item)}
      >
        {item.title}
      </button>
      {item.kind === 'deadline' && item.weight != null && (
        <span className="badge">{item.weight}%</span>
      )}
      {item.kind !== 'class' && <span className="badge">{item.kind}</span>}
      {cls && <ClassChip name={cls.name} color={cls.color} code={cls.code} />}
    </div>
  );
}

export function AgendaView() {
  const today = useToday();
  const [span, setSpan] = useState(14);
  const { data: items = [], isLoading } = useAgenda(today, addDays(today, span - 1));
  const { data: dl = [] } = useDeadlines();
  const { data: classes = [] } = useClasses();
  const byId = classMap(classes);
  const overdue = dl.filter((d) => d.urgency === 'overdue');
  const days = [...new Set(items.map((i) => i.start.slice(0, 10)))];
  return (
    <div className="stack">
      <div className="row">
        <h2>Agenda</h2>
        <span className="grow" />
        <div className="segmented" role="group" aria-label="Range">
          {[7, 14, 30].map((n) => (
            <button key={n} aria-pressed={span === n} onClick={() => setSpan(n)}>
              {n} days
            </button>
          ))}
        </div>
      </div>
      {overdue.length > 0 && (
        <div
          className="card stack tight"
          style={{ borderColor: 'color-mix(in oklab, var(--danger) 50%, var(--border))' }}
        >
          <h3 className="urg-overdue">Overdue · {overdue.length}</h3>
          {overdue.map((d) => (
            <AgendaRow
              key={d.id}
              cls={byId.get(d.classId)}
              item={{
                kind: 'deadline',
                id: d.id,
                title: d.title,
                classId: d.classId,
                start: d.due,
                allDay: !d.due.includes('T'),
                weight: d.weight,
              }}
            />
          ))}
        </div>
      )}
      {isLoading ? (
        <Skeleton h={200} />
      ) : days.length === 0 ? (
        <div className="card muted">Nothing in the next {span} days.</div>
      ) : (
        days.map((d) => (
          <section key={d} className="card stack tight">
            <h3>
              {d === today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : dayLabel(d)}{' '}
              <span className="muted small">
                {d === today ? dayLabel(d, { month: 'short', day: 'numeric' }) : ''}
              </span>
            </h3>
            {items
              .filter((i) => i.start.slice(0, 10) === d)
              .map((i) => (
                <AgendaRow key={i.id} item={i} cls={byId.get(i.classId ?? '')} />
              ))}
          </section>
        ))
      )}
    </div>
  );
}
