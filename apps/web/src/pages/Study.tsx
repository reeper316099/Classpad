import { useQueryClient } from '@tanstack/react-query';
import { Suspense, lazy, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { ClassChip, PageHead, Skeleton } from '../components/ui.js';
import { del, post } from '../lib/api.js';
import { addDays, fmtDuration, toIso } from '../lib/dates.js';
import { fmtTime } from '../lib/format.js';
import { refreshAll, useAssignments, useClasses, useTasks } from '../lib/hooks.js';
import { useActiveTimer, useStats, useStudySessions } from '../lib/planner.js';
import { fmtClock } from '../lib/pomodoro.js';
import { usePomodoro } from '../lib/usePomodoro.js';
import { useUi } from '../lib/store.js';

const StudyCharts = lazy(() =>
  import('../components/StudyCharts.js').then((m) => ({ default: m.StudyCharts })),
);

export function StudyPage() {
  const p = usePomodoro();
  const qc = useQueryClient();
  const { data: classes = [] } = useClasses();
  const { data: tasks = [] } = useTasks();
  const { data: assignments = [] } = useAssignments();
  const { data: stats } = useStats();
  const { data: sessions = [] } = useStudySessions(addDays(toIso(new Date()), -13));
  const { data: serverActive } = useActiveTimer();
  const [min, setMin] = useState('30');
  const [mClass, setMClass] = useState('');
  const byId = new Map(classes.map((c) => [c.id, c]));
  const openTasks = tasks.filter(
    (t) => !t.done && (!p.link.classId || t.classId === p.link.classId),
  );
  const openAsg = assignments.filter(
    (a) => a.status !== 'complete' && (!p.link.classId || a.classId === p.link.classId),
  );
  const phaseLabel = !p.timer
    ? 'Ready'
    : p.timer.phase === 'focus'
      ? 'Focus'
      : p.timer.phase === 'short'
        ? 'Short break'
        : 'Long break';
  const frac = p.timer ? 1 - p.remaining / p.total : 0;
  const R = 92,
    C = 2 * Math.PI * R;
  const today = toIso(new Date());
  const todayMin = sessions
    .filter((s) => toIso(new Date(s.start)) === today)
    .reduce((n, s) => n + s.minutes, 0);
  const orphan = serverActive && !p.timer;

  const logManual = async () => {
    const m = Math.round(Number(min));
    if (!Number.isFinite(m) || m < 1 || m > 1440) {
      useUi.getState().toast('Enter a number of minutes between 1 and 1440.');
      return;
    }
    const end = new Date();
    await post('/study-sessions', {
      start: new Date(end.getTime() - m * 60_000).toISOString(),
      end: end.toISOString(),
      minutes: m,
      classId: mClass || p.link.classId || null,
      kind: 'manual',
    });
    await refreshAll(qc);
    useUi.getState().toast(`Logged ${fmtDuration(m)}`);
  };

  return (
    <>
      <PageHead
        title="Study"
        sub={`${fmtDuration(todayMin)} today${stats ? ` · ${fmtDuration(stats.study.totalWeekMinutes)} this week · ${stats.study.streakDays}-day streak` : ''}`}
      />
      {orphan && (
        <div className="card row" role="alert">
          <Icon name="info" />{' '}
          <span>
            A study timer started {new Date(serverActive!.start).toLocaleTimeString()} is still
            running.
          </span>
          <span className="grow" />
          <button
            className="btn"
            onClick={async () => {
              await post('/study-sessions/stop');
              await refreshAll(qc);
            }}
          >
            Stop and log it
          </button>
        </div>
      )}
      <div className="grid two">
        <section
          className="card stack"
          aria-label="Pomodoro timer"
          style={{ alignItems: 'center' }}
        >
          <div
            className="pomo"
            role="timer"
            aria-live="off"
            aria-label={`${phaseLabel}, ${fmtClock(p.remaining)} remaining`}
          >
            <svg viewBox="0 0 200 200" width="220" height="220" aria-hidden>
              <circle
                cx="100"
                cy="100"
                r={R}
                fill="none"
                stroke="var(--border-strong)"
                strokeWidth="10"
              />
              <circle
                cx="100"
                cy="100"
                r={R}
                fill="none"
                stroke={
                  p.timer?.phase === 'focus' || !p.timer ? 'var(--primary)' : 'var(--success)'
                }
                strokeWidth="10"
                strokeLinecap="round"
                strokeDasharray={C}
                strokeDashoffset={C * (1 - frac)}
                transform="rotate(-90 100 100)"
                style={{ transition: 'stroke-dashoffset .3s linear' }}
              />
            </svg>
            <div className="pomo-center">
              <div className="muted small">{phaseLabel}</div>
              <div className="pomo-clock">{fmtClock(p.remaining)}</div>
              <div
                className="row tight"
                aria-label={`${p.timer?.completed ?? 0} focus sessions done`}
              >
                {Array.from({ length: p.cfg.longEvery }, (_, i) => (
                  <span
                    key={i}
                    className="dot"
                    style={{
                      opacity:
                        i < (p.timer?.completed ?? 0) % p.cfg.longEvery ||
                        (p.timer &&
                          p.timer.completed > 0 &&
                          p.timer.completed % p.cfg.longEvery === 0)
                          ? 1
                          : 0.25,
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
          <div className="row">
            {!p.timer ? (
              <button className="btn primary" onClick={() => void p.start()}>
                <Icon name="study" size={16} /> Start focus
              </button>
            ) : p.running ? (
              <button className="btn" onClick={() => void p.pause()}>
                Pause
              </button>
            ) : (
              <button className="btn primary" onClick={() => void p.resume()}>
                {p.timer.phase === 'focus' ? 'Start focus' : 'Resume'}
              </button>
            )}
            {p.timer && (
              <button className="btn" onClick={() => void p.skip()}>
                Skip
              </button>
            )}
            {p.timer && (
              <button className="btn danger" onClick={() => void p.stop()}>
                Stop
              </button>
            )}
          </div>
          <div className="form-grid" style={{ width: '100%' }}>
            <label className="field">
              <span className="label">Class</span>
              <select
                className="select"
                value={p.link.classId ?? ''}
                onChange={(e) => p.setLink({ classId: e.target.value || undefined })}
                disabled={p.running}
              >
                <option value="">No class</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="label">Task</span>
              <select
                className="select"
                value={p.link.taskId ?? ''}
                onChange={(e) => p.setLink({ ...p.link, taskId: e.target.value || undefined })}
                disabled={p.running}
              >
                <option value="">—</option>
                {openTasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="label">Assignment</span>
              <select
                className="select"
                value={p.link.assignmentId ?? ''}
                onChange={(e) =>
                  p.setLink({ ...p.link, assignmentId: e.target.value || undefined })
                }
                disabled={p.running}
              >
                <option value="">—</option>
                {openAsg.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted small">
            Only focus time is logged. Pausing or skipping logs what you did so far. Lengths are in
            Settings.
          </p>
        </section>

        <section className="card stack">
          <h2>Log time manually</h2>
          <div className="row">
            <input
              className="input num"
              style={{ width: 90 }}
              inputMode="numeric"
              aria-label="Minutes"
              value={min}
              onChange={(e) => setMin(e.target.value)}
            />
            <span>minutes</span>
            <select
              className="select grow"
              aria-label="Class"
              value={mClass}
              onChange={(e) => setMClass(e.target.value)}
            >
              <option value="">{p.link.classId ? 'Selected class' : 'No class'}</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className="btn primary" onClick={() => void logManual()}>
              Log
            </button>
          </div>
          <h3>Recent sessions</h3>
          {sessions.length === 0 ? (
            <p className="muted">Nothing logged in the last two weeks.</p>
          ) : (
            <div className="table-wrap" style={{ maxHeight: 280, overflow: 'auto' }}>
              <table className="t">
                <tbody>
                  {sessions.slice(0, 30).map((s) => {
                    const c = byId.get(s.classId ?? '');
                    const d = new Date(s.start);
                    return (
                      <tr key={s.id}>
                        <td>
                          {d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{' '}
                          <span className="muted">
                            {fmtTime(`${d.getHours()}:${d.getMinutes()}`)}
                          </span>
                        </td>
                        <td>
                          {c ? (
                            <ClassChip name={c.name} color={c.color} code={c.code} />
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="num">{fmtDuration(s.minutes)}</td>
                        <td>
                          <span className="badge">{s.kind}</span>
                        </td>
                        <td className="actions">
                          <button
                            className="btn ghost icon sm"
                            aria-label="Delete session"
                            onClick={async () => {
                              await del(`/study-sessions/${s.id}`);
                              await refreshAll(qc);
                            }}
                          >
                            <Icon name="trash" size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      {stats && (
        <Suspense fallback={<Skeleton h={260} />}>
          <StudyCharts stats={stats} classes={classes} />
        </Suspense>
      )}
    </>
  );
}
