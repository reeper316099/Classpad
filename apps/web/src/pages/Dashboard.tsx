import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon.js';
import {
  ClassChip,
  Empty,
  GradePill,
  PageHead,
  Sens,
  Skeleton,
  classStyle,
} from '../components/ui.js';
import { DueBadge } from '../components/AssignmentsView.js';
import { get, post } from '../lib/api.js';
import { useDialogs } from '../lib/dialogs.js';
import { DAY_LABEL, fixed, fmtTime, pct, urgency } from '../lib/format.js';
import {
  refreshAll,
  useAssignments,
  useClasses,
  useSelectedSemester,
  useTasks,
} from '../lib/hooks.js';
import type { SemesterGrades } from '../lib/types.js';

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
  const { data: assignments = [] } = useAssignments();
  const { data: tasks = [] } = useTasks();
  const dialogs = useDialogs();
  const { data: sg, isLoading } = useQuery({
    queryKey: ['sem-grades', semester?.id, assignments.length],
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
  const upcoming = assignments
    .filter((a) => ids.has(a.classId) && a.status !== 'complete' && a.due)
    .sort((a, b) => a.due!.localeCompare(b.due!))
    .slice(0, 7);
  const dow = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()]!;
  const today = semClasses
    .flatMap((c) => c.meetings.filter((m) => m.day === dow).map((m) => ({ c, m })))
    .sort((a, b) => a.m.start.localeCompare(b.m.start));
  const openTasks = tasks
    .filter((t) => !t.done)
    .sort((a, b) => (a.date ?? '9').localeCompare(b.date ?? '9'))
    .slice(0, 5);
  const overdue = upcoming.filter((a) => urgency(a.due).level === 'overdue').length;

  return (
    <>
      <PageHead
        title={semester?.name ?? 'Dashboard'}
        sub={semester?.start && semester.end ? `${semester.start} → ${semester.end}` : undefined}
        actions={
          <button className="btn primary" onClick={() => dialogs.openAssignment()}>
            <Icon name="plus" size={16} /> Add assignment
          </button>
        }
      />
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
                    <b className="sens">
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
              {upcoming.map((a) => (
                <div className="row" key={a.id}>
                  <ClassChip
                    name={byId.get(a.classId)?.name ?? ''}
                    color={byId.get(a.classId)?.color}
                    code={byId.get(a.classId)?.code}
                  />
                  <button
                    className="btn ghost sm grow"
                    style={{ justifyContent: 'flex-start', color: 'var(--text)' }}
                    onClick={() => dialogs.openAssignment({ id: a.id })}
                  >
                    {a.title}
                  </button>
                  <span className="small">
                    <DueBadge a={a} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="card">
          <div className="card-title">
            <h2>Today</h2>
            <span className="muted small">{DAY_LABEL[dow]}</span>
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
            <h2>Open tasks</h2>
          </div>
          {openTasks.length === 0 ? (
            <p className="muted">All caught up.</p>
          ) : (
            <div className="stack tight">
              {openTasks.map((t) => (
                <div className="row" key={t.id}>
                  <Icon name="check" size={14} />
                  <span className="grow">{t.title}</span>
                  {t.date && <span className="muted small">{t.date.slice(5, 10)}</span>}
                </div>
              ))}
            </div>
          )}
        </section>
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
