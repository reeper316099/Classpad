import { useState } from 'react';
import { useDialogs } from '../lib/dialogs.js';
import { fmtDue, parseScoreInput, scoreText, typeLabel, urgency } from '../lib/format.js';
import { useDeleteWithUndo, useSaveMutation } from '../lib/hooks.js';
import { useUi } from '../lib/store.js';
import type { Assignment, ClassEntity } from '../lib/types.js';
import { Icon } from './Icon.js';
import { ClassChip, Sens, classStyle } from './ui.js';

const STATUS: Record<string, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  complete: 'Complete',
};
const PRI: Record<string, string> = { important: 'Important', mid: 'Mid', low: 'Low' };

function ScoreCell({ a }: { a: Assignment }) {
  const save = useSaveMutation<Assignment>('assignments');
  const [text, setText] = useState<string | null>(null);
  const [bad, setBad] = useState('');
  const shown = text ?? scoreText(a.score);
  const commit = () => {
    if (text === null) return;
    const r = parseScoreInput(text);
    if (!r.ok) {
      setBad(r.error);
      return;
    }
    setBad('');
    setText(null);
    if (scoreText(a.score) === (r.score ? scoreText(r.score) : '')) return;
    save.mutate({ id: a.id, data: { score: r.score, status: r.score ? 'complete' : a.status } });
  };
  return (
    <span className="sens">
      <input
        className="input sm num"
        style={{ width: 84, borderColor: bad ? 'var(--danger)' : undefined }}
        aria-label={`Score for ${a.title}`}
        aria-invalid={!!bad}
        title={bad || 'Type 90, 90% or 45/50'}
        placeholder="—"
        value={shown}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(null);
            setBad('');
          }
        }}
      />
    </span>
  );
}

export function DueBadge({ a }: { a: Assignment }) {
  const u = urgency(a.due, a.status === 'complete');
  if (!a.due) return <span className="muted">—</span>;
  const cls =
    u.level === 'overdue'
      ? 'urg-overdue'
      : u.level === 'today'
        ? 'urg-today'
        : u.level === 'soon'
          ? 'urg-soon'
          : 'muted';
  return (
    <span className={cls} title={fmtDue(a.due)}>
      {u.level === 'later' ? fmtDue(a.due) : `${u.label} · ${fmtDue(a.due)}`}
    </span>
  );
}

export function AssignmentsTable({
  items,
  classes,
  showClass = true,
}: {
  items: Assignment[];
  classes: ClassEntity[];
  showClass?: boolean;
}) {
  const dialogs = useDialogs();
  const save = useSaveMutation<Assignment>('assignments');
  const remove = useDeleteWithUndo<Assignment>('assignments', (a) => `“${a.title}”`);
  const byId = new Map(classes.map((c) => [c.id, c]));
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>Assignment</th>
            {showClass && <th>Class</th>}
            <th>Due</th>
            <th className="num">Weight</th>
            <th className="num">Score</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((a) => {
            const c = byId.get(a.classId);
            return (
              <tr key={a.id}>
                <td>
                  <button
                    className="btn ghost sm"
                    style={{ padding: 0, fontWeight: 600, color: 'var(--text)' }}
                    onClick={() => dialogs.openAssignment({ id: a.id })}
                  >
                    {a.title}
                  </button>
                  <div className="row tight">
                    {a.priority === 'important' && <span className="badge danger">Important</span>}
                    {a.type.map((t) => (
                      <span key={t} className="badge">
                        {typeLabel(t)}
                      </span>
                    ))}
                    {a.extraCredit && <span className="badge success">Extra credit</span>}
                    {a.excused && <span className="badge warning">Excused</span>}
                    {a.dropped && <span className="badge warning">Dropped</span>}
                  </div>
                </td>
                {showClass && (
                  <td>
                    {c ? (
                      <ClassChip name={c.name} color={c.color} code={c.code} />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                )}
                <td>
                  <DueBadge a={a} />
                </td>
                <td className="num">
                  {a.weight != null
                    ? `${a.weight}%`
                    : a.pointsPossible != null
                      ? `${a.pointsPossible} pts`
                      : '—'}
                </td>
                <td className="num">
                  <ScoreCell a={a} />
                </td>
                <td>
                  <select
                    className="select sm"
                    style={{ width: 130 }}
                    aria-label={`Status of ${a.title}`}
                    value={a.status}
                    onChange={(e) => save.mutate({ id: a.id, data: { status: e.target.value } })}
                  >
                    {Object.entries(STATUS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="actions">
                  <button
                    className="btn ghost icon sm"
                    aria-label={`Edit ${a.title}`}
                    onClick={() => dialogs.openAssignment({ id: a.id })}
                  >
                    <Icon name="edit" size={15} />
                  </button>
                  <button
                    className="btn ghost icon sm"
                    aria-label={`Delete ${a.title}`}
                    onClick={() => remove(a)}
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
  );
}

export function AssignmentsBoard({
  items,
  classes,
}: {
  items: Assignment[];
  classes: ClassEntity[];
}) {
  const dialogs = useDialogs();
  const save = useSaveMutation<Assignment>('assignments');
  const byId = new Map(classes.map((c) => [c.id, c]));
  const move = (a: Assignment, status: string) => {
    save.mutate({ id: a.id, data: { status } });
    useUi.getState().toast(`Moved to ${STATUS[status]}`);
  };
  return (
    <div className="board">
      {Object.entries(STATUS).map(([status, label]) => {
        const col = items.filter((a) => a.status === status);
        return (
          <section className="board-col" key={status} aria-label={label}>
            <h3>
              <span>{label}</span>
              <span className="badge">{col.length}</span>
            </h3>
            {col.map((a) => {
              const c = byId.get(a.classId);
              return (
                <article className="board-card" key={a.id} style={classStyle(c?.color)}>
                  <button
                    className="btn ghost"
                    style={{
                      padding: 0,
                      justifyContent: 'flex-start',
                      fontWeight: 600,
                      textAlign: 'left',
                    }}
                    onClick={() => dialogs.openAssignment({ id: a.id })}
                  >
                    {a.title}
                  </button>
                  <div className="row tight small">
                    {c && <ClassChip name={c.name} color={c.color} code={c.code} />}
                    <DueBadge a={a} />
                    {a.score && (
                      <Sens>
                        <span className="badge accent">{scoreText(a.score)}</span>
                      </Sens>
                    )}
                  </div>
                  <div className="row tight">
                    {status !== 'not_started' && (
                      <button
                        className="btn sm"
                        onClick={() =>
                          move(a, status === 'complete' ? 'in_progress' : 'not_started')
                        }
                      >
                        ← {status === 'complete' ? STATUS.in_progress : STATUS.not_started}
                      </button>
                    )}
                    {status !== 'complete' && (
                      <button
                        className="btn sm"
                        onClick={() =>
                          move(a, status === 'not_started' ? 'in_progress' : 'complete')
                        }
                      >
                        {status === 'not_started' ? STATUS.in_progress : STATUS.complete} →
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
            {col.length === 0 && (
              <div className="muted small" style={{ padding: 8 }}>
                Nothing here
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

export { PRI };
