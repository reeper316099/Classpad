import { useMemo, useState } from 'react';
import { useDialogs } from '../lib/dialogs.js';
import { urgency } from '../lib/format.js';
import {
  useAssignments,
  useClasses,
  useDeleteWithUndo,
  useSaveMutation,
  useTasks,
} from '../lib/hooks.js';
import { parseQuickDate } from '../lib/quickDate.js';
import { useUi } from '../lib/store.js';
import { taskOutcome } from '../lib/tasks.js';
import type { Task } from '../lib/types.js';
import { Icon } from './Icon.js';
import { ClassChip, Empty, Skeleton } from './ui.js';

const PRI: Record<string, string> = { high: 'danger', medium: 'warning', low: '' };

function Hours({ task, field }: { task: Task; field: 'targetHours' | 'actualHours' }) {
  const save = useSaveMutation<Task>('tasks');
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (task[field] != null ? String(task[field]) : '');
  const commit = () => {
    if (text === null) return;
    const n = text.trim() === '' ? null : Number(text);
    setText(null);
    if (n !== null && (!Number.isFinite(n) || n < 0)) {
      useUi.getState().toast('Hours must be a positive number.');
      return;
    }
    if ((n ?? undefined) === task[field]) return;
    save.mutate({ id: task.id, data: { [field]: n } });
  };
  return (
    <input
      className="input sm num"
      style={{ width: 72 }}
      aria-label={`${field === 'targetHours' ? 'Target' : 'Actual'} hours for ${task.title}`}
      inputMode="decimal"
      placeholder="—"
      value={shown}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setText(null);
      }}
    />
  );
}

export function TasksView() {
  const { data: tasks, isLoading } = useTasks();
  const { data: classes = [] } = useClasses();
  const { data: assignments = [] } = useAssignments();
  const save = useSaveMutation<Task>('tasks');
  const remove = useDeleteWithUndo<Task>('tasks', (t) => `“${t.title}”`);
  const dialogs = useDialogs();
  const [show, setShow] = useState<'open' | 'done' | 'all'>('open');
  const [classId, setClassId] = useState('');
  const [quick, setQuick] = useState('');
  const [quickClass, setQuickClass] = useState('');
  const byClass = new Map(classes.map((c) => [c.id, c]));
  const asgTitle = new Map(assignments.map((a) => [a.id, a.title]));

  const list = useMemo(
    () =>
      (tasks ?? [])
        .filter(
          (t) =>
            (show === 'all' || (show === 'done') === t.done) && (!classId || t.classId === classId),
        )
        .sort(
          (a, b) =>
            Number(a.done) - Number(b.done) ||
            (a.date ?? '9999').localeCompare(b.date ?? '9999') ||
            a.title.localeCompare(b.title),
        ),
    [tasks, show, classId],
  );
  const open = (tasks ?? []).filter((t) => !t.done);
  const targetOpen = open.reduce((n, t) => n + (t.targetHours ?? 0), 0);
  const logged = (tasks ?? []).reduce((n, t) => n + (t.actualHours ?? 0), 0);
  const planned = (tasks ?? []).filter((t) => t.targetHours != null && t.actualHours != null);
  const accuracy = planned.length
    ? planned.reduce((n, t) => n + t.actualHours!, 0) /
      planned.reduce((n, t) => n + t.targetHours!, 0)
    : null;

  const add = async () => {
    if (!quick.trim()) return;
    const p = parseQuickDate(quick);
    await save.mutateAsync({
      data: {
        title: p.title,
        date: p.due ?? null,
        classId: quickClass || classId || null,
        priority: 'medium',
      },
    });
    setQuick('');
    useUi.getState().toast(`Added “${p.title}”${p.due ? ` · ${p.due.replace('T', ' ')}` : ''}`);
  };
  const preview = quick.trim() ? parseQuickDate(quick) : null;

  return (
    <div className="stack">
      <div
        className="grid two"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}
      >
        <div className="card">
          <div className="muted small">Open tasks</div>
          <div className="grade-big">{open.length}</div>
        </div>
        <div className="card">
          <div className="muted small">Planned (open)</div>
          <div className="grade-big">
            {targetOpen}
            <span className="small muted">h</span>
          </div>
        </div>
        <div className="card">
          <div className="muted small">Logged</div>
          <div className="grade-big">
            {logged}
            <span className="small muted">h</span>
          </div>
        </div>
        <div className="card">
          <div className="muted small">Estimates were</div>
          <div className="grade-big" title="Actual hours ÷ target hours on tasks that have both">
            {accuracy == null ? '—' : `${Math.round(accuracy * 100)}%`}
          </div>
        </div>
      </div>
      <div className="card stack tight">
        <div className="row">
          <input
            className="input grow"
            style={{ minWidth: 220 }}
            placeholder='Quick add: "Read chapter 3 fri", "Outline essay tomorrow 4pm"'
            aria-label="Quick add task"
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add();
            }}
          />
          <select
            className="select"
            style={{ width: 'auto' }}
            aria-label="Class for quick add"
            value={quickClass}
            onChange={(e) => setQuickClass(e.target.value)}
          >
            <option value="">No class</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button className="btn" disabled={!quick.trim()} onClick={() => void add()}>
            Add
          </button>
          <button className="btn primary" onClick={() => dialogs.openTask()}>
            <Icon name="plus" size={16} /> Detailed…
          </button>
        </div>
        {preview && (
          <div className="small muted">
            Will add “{preview.title}”
            {preview.due ? ` for ${preview.due.replace('T', ' at ')}` : ' with no date'}
          </div>
        )}
      </div>
      <div className="row">
        <div className="segmented" role="group" aria-label="Show">
          {(['open', 'done', 'all'] as const).map((k) => (
            <button key={k} aria-pressed={show === k} onClick={() => setShow(k)}>
              {k[0]!.toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
        <select
          className="select"
          style={{ width: 'auto' }}
          aria-label="Filter by class"
          value={classId}
          onChange={(e) => setClassId(e.target.value)}
        >
          <option value="">All classes</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {isLoading ? (
        <Skeleton h={160} />
      ) : list.length === 0 ? (
        <Empty
          icon="check"
          title={show === 'open' ? 'Nothing to do' : 'No tasks here'}
          action={
            <button className="btn primary" onClick={() => dialogs.openTask()}>
              Add a task
            </button>
          }
        >
          Press <kbd>T</kbd> anywhere to add one. Set a target and log the actual hours to learn how
          long things really take you.
        </Empty>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Table, scrollable">
          <table className="t">
            <thead>
              <tr>
                <th style={{ width: 36 }} />
                <th>Task</th>
                <th>Class</th>
                <th>Date</th>
                <th>Priority</th>
                <th className="num">Target h</th>
                <th className="num">Actual h</th>
                <th>Outcome</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((t) => {
                const c = byClass.get(t.classId ?? '');
                const u = t.date ? urgency(t.date, t.done) : null;
                const o = taskOutcome(t.targetHours, t.actualHours);
                return (
                  <tr key={t.id} style={{ opacity: t.done ? 0.65 : 1 }}>
                    <td>
                      <input
                        type="checkbox"
                        checked={t.done}
                        aria-label={`Mark “${t.title}” ${t.done ? 'not done' : 'done'}`}
                        onChange={() => save.mutate({ id: t.id, data: { done: !t.done } })}
                      />
                    </td>
                    <td>
                      <button
                        className="btn ghost sm"
                        style={{
                          padding: 0,
                          color: 'var(--text)',
                          fontWeight: 600,
                          textDecoration: t.done ? 'line-through' : undefined,
                        }}
                        onClick={() => dialogs.openTask({ id: t.id })}
                      >
                        {t.title}
                      </button>
                      {t.assignmentId && asgTitle.get(t.assignmentId) && (
                        <div className="muted small">for {asgTitle.get(t.assignmentId)}</div>
                      )}
                    </td>
                    <td>
                      {c ? (
                        <ClassChip name={c.name} color={c.color} code={c.code} />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {u ? (
                        <span
                          className={
                            u.level === 'overdue'
                              ? 'urg-overdue'
                              : u.level === 'today'
                                ? 'urg-today'
                                : u.level === 'soon'
                                  ? 'urg-soon'
                                  : 'muted'
                          }
                        >
                          {u.label}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${PRI[t.priority]}`}>{t.priority}</span>
                    </td>
                    <td className="num">
                      <Hours task={t} field="targetHours" />
                    </td>
                    <td className="num">
                      <Hours task={t} field="actualHours" />
                    </td>
                    <td>
                      <span
                        className={`badge ${o.kind === 'over' ? 'warning' : o.kind === 'on' ? 'success' : o.kind === 'under' ? 'info' : ''}`}
                      >
                        {o.label}
                      </span>
                    </td>
                    <td className="actions">
                      <button
                        className="btn ghost icon sm"
                        aria-label={`Edit ${t.title}`}
                        onClick={() => dialogs.openTask({ id: t.id })}
                      >
                        <Icon name="edit" size={15} />
                      </button>
                      <button
                        className="btn ghost icon sm"
                        aria-label={`Delete ${t.title}`}
                        onClick={() => remove(t)}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
