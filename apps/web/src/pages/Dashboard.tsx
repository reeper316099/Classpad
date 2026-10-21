import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon.js';
import { Sparkline } from '../components/Sparkline.js';
import {
  ClassChip,
  Empty,
  GradePill,
  PageHead,
  Sens,
  Skeleton,
  classStyle,
} from '../components/ui.js';
import { get, post } from '../lib/api.js';
import { fmtDuration } from '../lib/dates.js';
import { useDialogs } from '../lib/dialogs.js';
import { fixed, fmtTime, pct } from '../lib/format.js';
import {
  refreshAll,
  useClasses,
  useReadings,
  useSaveMutation,
  useSelectedSemester,
  useTasks,
} from '../lib/hooks.js';
import { useDeadlines, useStats } from '../lib/planner.js';
import { parseQuickDate } from '../lib/quickDate.js';
import { useUi } from '../lib/store.js';
import type { SemesterGrades, Task } from '../lib/types.js';

export function Welcome() {
  const dialogs = useDialogs();
  const nav = useNavigate();
  const qc = useQueryClient();
  return (
    <div className="hero">
      <div className="stack tight">
        <h1>Welcome to Classpad</h1>
        <p className="muted">
          A calm place for classes, grades and notes. Everything stays on this computer. No account,
          no tracking.
        </p>
      </div>
      <div className="grid cards">
        <button className="card hover option-card" onClick={() => nav('/import')}>
          <Icon name="import" size={26} />
          <h2>Import my Notion export</h2>
          <span className="muted">
            Bring over classes, assignments and notes, with a check that your grades match.
          </span>
        </button>
        <button className="card hover option-card" onClick={() => dialogs.openSemester()}>
          <Icon name="plus" size={26} />
          <h2>Start fresh</h2>
          <span className="muted">Create your first semester and add classes as you go.</span>
        </button>
        <button
          className="card hover option-card"
          onClick={async () => {
            await post('/demo/load');
            await refreshAll(qc);
          }}
        >
          <Icon name="sparkle" size={26} />
          <h2>Open demo data</h2>
          <span className="muted">
            Explore with an invented semester. You can remove it anytime in Settings.
          </span>
        </button>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { semester, loaded } = useSelectedSemester();
  const { data: classes = [] } = useClasses();
  const { data: tasks = [] } = useTasks();
  const { data: readings = [] } = useReadings();
  const { data: deadlines = [] } = useDeadlines();
  const { data: stats } = useStats();
  const dialogs = useDialogs();
  const saveTask = useSaveMutation<Task>('tasks');
  const [quick, setQuick] = useState('');
  const { data: sg, isLoading } = useQuery({
    queryKey: ['sem-grades', semester?.id, deadlines.length],
    enabled: !!semester,
    queryFn: () => get<SemesterGrades>(`/grades/semester/${semester!.id}`),
  });
  const { data: gpa } = useQuery({
    queryKey: ['gpa-mini'],
    queryFn: () =>
      get<{ cumulative: { unweighted: { gpa: string | null }; weighted: { gpa: string | null } } }>(
        '/gpa',
      ),
    enabled: loaded,
  });
  if (!loaded) return <Welcome />;
  const semClasses = classes.filter((c) => c.semesterId === semester?.id);
  const ids = new Set(semClasses.map((c) => c.id));
  const byId = new Map(classes.map((c) => [c.id, c]));
  const upcoming = deadlines.filter((d) => ids.has(d.classId)).slice(0, 7);
  const overdue = deadlines.filter((d) => ids.has(d.classId) && d.urgency === 'overdue').length;
  const dow = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()]!;
  const today = semClasses
    .flatMap((c) => c.meetings.filter((m) => m.day === dow).map((m) => ({ c, m })))
    .sort((a, b) => a.m.start.localeCompare(b.m.start));
  const openTasks = tasks
    .filter((t) => !t.done)
    .sort((a, b) => (a.date ?? '9').localeCompare(b.date ?? '9'))
    .slice(0, 6);
  const reading = readings.filter((r) => r.status === 'reading');
  const week = stats?.workload[0];
  const goals = stats
    ? semClasses
        .map((c) => ({ c, ...stats.study.perClass.find((p) => p.classId === c.id)! }))
        .filter((x) => x.targetMinutes > 0)
    : [];

  const add = async () => {
    if (!quick.trim()) return;
    const p = parseQuickDate(quick);
    await saveTask.mutateAsync({
      data: { title: p.title, date: p.due ?? null, priority: 'medium' },
    });
    setQuick('');
    useUi.getState().toast(`Task added${p.due ? ` · ${p.due.replace('T', ' ')}` : ''}`);
  };

  return (
    <>
      <PageHead
        title={semester?.name ?? 'Dashboard'}
        sub={semester?.start && semester.end ? `${semester.start} → ${semester.end}` : undefined}
        actions={
          <>
            <button className="btn" onClick={() => dialogs.openTask()}>
              Add task
            </button>
            <button className="btn primary" onClick={() => dialogs.openAssignment()}>
              <Icon name="plus" size={16} /> Add assignment
            </button>
          </>
        }
      />
      {week && (week.load === 'heavy' || overdue > 0) && (
        <Link
          to="/planner?tab=load"
          className={`card row load-banner ${week.load}`}
          style={{ color: 'inherit', textDecoration: 'none' }}
          role="status"
        >
          <Icon name="alert" />
          <b>{week.load === 'heavy' ? 'This week is heavy.' : 'You have overdue work.'}</b>
          <span className="muted">
            {week.deadlines} deadline{week.deadlines === 1 ? '' : 's'} this week
            {overdue ? ` · ${overdue} overdue` : ''}. See the workload view.
          </span>
        </Link>
      )}
      <div className="row card" style={{ padding: '10px 14px' }}>
        <input
          className="input grow"
          placeholder='Quick add a task: "Read chapter 3 fri", "Email advisor tomorrow 4pm"'
          aria-label="Quick add task"
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
        <button className="btn" disabled={!quick.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>
      <div className="grid two">
        <section className="card">
          <div className="card-title">
            <h2>Grades so far</h2>
            <Link to="/grades" className="small">
              Open calculator
            </Link>
          </div>
          {isLoading ? (
            <Skeleton h={120} />
          ) : (
            <div className="stack tight">
              {sg?.classes.map((r) => {
                const c = byId.get(r.classId);
                return (
                  <Link
                    to={`/grades/${r.classId}`}
                    key={r.classId}
                    className="row stripe"
                    style={{
                      ...classStyle(c?.color),
                      padding: '8px 12px',
                      color: 'inherit',
                      textDecoration: 'none',
                      borderRadius: 10,
                    }}
                  >
                    <GradePill grade={r.grade} size="sm" />
                    <div className="grow">
                      <div style={{ fontWeight: 600 }}>{r.name}</div>
                      <div className="muted small">
                        {c?.code}
                        {r.credits != null ? ` · ${r.credits} cr` : ''}
                      </div>
                    </div>
                    <Sparkline points={stats?.trends[r.classId] ?? []} />
                    <b className="sens" style={{ minWidth: 64, textAlign: 'right' }}>
                      {r.grade.status === 'graded' ? pct(r.grade.percentRounded) : '—'}
                    </b>
                  </Link>
                );
              })}
              {sg && sg.classes.length === 0 && (
                <Empty
                  title="No classes yet"
                  action={
                    <button className="btn primary" onClick={() => dialogs.openClass()}>
                      Add a class
                    </button>
                  }
                />
              )}
            </div>
          )}
        </section>
        <section className="card stack">
          <div className="card-title">
            <h2>GPA</h2>
            <Link to="/gpa" className="small">
              Details
            </Link>
          </div>
          <div className="row" style={{ gap: 32 }}>
            <div>
              <div className="muted small">Unweighted</div>
              <div className="grade-big">
                <Sens>{fixed(gpa?.cumulative.unweighted.gpa)}</Sens>
              </div>
            </div>
            <div>
              <div className="muted small">Weighted</div>
              <div className="grade-big">
                <Sens>{fixed(gpa?.cumulative.weighted.gpa)}</Sens>
              </div>
            </div>
          </div>
          <div className="muted small">
            Semester average: <Sens>{pct(sg?.averageGrade, 1)}</Sens>
          </div>
        </section>
        <section className="card">
          <div className="card-title">
            <h2>Upcoming deadlines</h2>
            {overdue > 0 && <span className="badge danger">{overdue} overdue</span>}
          </div>
          {upcoming.length === 0 ? (
            <p className="muted">Nothing due. Nice.</p>
          ) : (
            <div className="stack tight">
              {upcoming.map((d) => (
                <div className="row" key={d.id}>
                  <ClassChip
                    name={byId.get(d.classId)?.name ?? ''}
                    color={byId.get(d.classId)?.color}
                    code={byId.get(d.classId)?.code}
                  />
                  <button
                    className="btn ghost sm grow"
                    style={{ justifyContent: 'flex-start', color: 'var(--text)' }}
                    onClick={() => dialogs.openAssignment({ id: d.id })}
                  >
                    {d.title}
                  </button>
                  <span
                    className={`small ${d.urgency === 'overdue' ? 'urg-overdue' : d.urgency === 'today' ? 'urg-today' : d.urgency === 'soon' ? 'urg-soon' : 'muted'}`}
                  >
                    {d.urgency === 'overdue'
                      ? `${-d.days}d overdue`
                      : d.urgency === 'today'
                        ? 'Today'
                        : d.days === 1
                          ? 'Tomorrow'
                          : `In ${d.days}d`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="card">
          <div className="card-title">
            <h2>Today</h2>
            <Link to="/planner" className="small">
              Planner
            </Link>
          </div>
          {today.length === 0 ? (
            <p className="muted">No classes today.</p>
          ) : (
            <div className="stack tight">
              {today.map(({ c, m }, i) => (
                <div
                  className="row stripe"
                  key={i}
                  style={{ ...classStyle(c.color), padding: '6px 12px' }}
                >
                  <b>{fmtTime(m.start)}</b>
                  <span className="muted">–</span>
                  <span>{fmtTime(m.end)}</span>
                  <span className="grow">{c.name}</span>
                  <span className="muted small">{c.location}</span>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="card">
          <div className="card-title">
            <h2>Study this week</h2>
            <Link to="/study" className="small">
              Start timer
            </Link>
          </div>
          <div className="row" style={{ gap: 24, marginBottom: 8 }}>
            <div>
              <div className="grade-big" style={{ fontSize: '1.8rem' }}>
                {fmtDuration(stats?.study.totalWeekMinutes ?? 0)}
              </div>
              <div className="muted small">this week</div>
            </div>
            <div>
              <div className="grade-big" style={{ fontSize: '1.8rem' }}>
                {stats?.study.streakDays ?? 0}
              </div>
              <div className="muted small">day streak</div>
            </div>
          </div>
          {goals.length === 0 ? (
            <p className="muted small">
              Set a weekly study goal on a class to track progress here.
            </p>
          ) : (
            <div className="stack tight">
              {goals.map(({ c, minutes, targetMinutes }) => (
                <div key={c.id} style={classStyle(c.color)}>
                  <div className="row small">
                    <span className="dot" />
                    <span className="grow">{c.code ?? c.name}</span>
                    <span className="muted">
                      {fmtDuration(minutes)} / {fmtDuration(targetMinutes)}
                    </span>
                  </div>
                  <div
                    className="meter"
                    role="progressbar"
                    aria-valuenow={Math.min(100, Math.round((minutes / targetMinutes) * 100))}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${c.name} study goal`}
                  >
                    <i style={{ width: `${Math.min(100, (minutes / targetMinutes) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="card">
          <div className="card-title">
            <h2>Open tasks</h2>
            <Link to="/planner?tab=tasks" className="small">
              All tasks
            </Link>
          </div>
          {openTasks.length === 0 ? (
            <p className="muted">All caught up.</p>
          ) : (
            <div className="stack tight">
              {openTasks.map((t) => (
                <label className="row check" key={t.id}>
                  <input
                    type="checkbox"
                    checked={t.done}
                    onChange={() => saveTask.mutate({ id: t.id, data: { done: true } })}
                    aria-label={`Mark “${t.title}” done`}
                  />
                  <span className="grow">{t.title}</span>
                  {t.date && <span className="muted small">{t.date.slice(5, 10)}</span>}
                </label>
              ))}
            </div>
          )}
        </section>
        {reading.length > 0 && (
          <section className="card stack tight">
            <div className="card-title">
              <h2>Currently reading</h2>
            </div>
            {reading.map((r) => {
              const p = r.totalPages
                ? Math.min(100, Math.round(((r.pagesRead ?? 0) / r.totalPages) * 100))
                : 0;
              return (
                <div key={r.id}>
                  <div className="row small">
                    <span className="grow" style={{ fontWeight: 600 }}>
                      {r.title}
                    </span>
                    <span className="muted">
                      {r.pagesRead ?? 0}/{r.totalPages ?? '?'} pages
                    </span>
                  </div>
                  <div
                    className="meter"
                    role="progressbar"
                    aria-valuenow={p}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Progress in ${r.title}`}
                  >
                    <i style={{ width: `${p}%` }} />
                  </div>
                </div>
              );
            })}
          </section>
        )}
        {semester && semester.goals.length > 0 && (
          <section className="card">
            <div className="card-title">
              <h2>Semester goals</h2>
            </div>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {semester.goals.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
