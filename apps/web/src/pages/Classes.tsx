import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AssignmentsTable } from '../components/AssignmentsView.js';
import { ClassFilesTab, ClassNotesTab, ClassReadingsTab } from '../components/ClassTabs.js';
import { GradesWorkspace } from '../components/GradesWorkspace.js';
import { Icon } from '../components/Icon.js';
import { Empty, GradePill, PageHead, Sens, classStyle } from '../components/ui.js';
import { get } from '../lib/api.js';
import { useDialogs } from '../lib/dialogs.js';
import { DAY_LABEL, fmtTime, pct, typeLabel } from '../lib/format.js';
import { useAssignments, useClasses, useSelectedSemester } from '../lib/hooks.js';
import type { SemesterGrades } from '../lib/types.js';
import { DueBadge } from '../components/AssignmentsView.js';

const meetingsText = (c: { meetings: { day: string; start: string; end: string }[] }) => {
  const groups = new Map<string, string[]>();
  for (const m of c.meetings)
    groups.set(`${fmtTime(m.start)}–${fmtTime(m.end)}`, [
      ...(groups.get(`${fmtTime(m.start)}–${fmtTime(m.end)}`) ?? []),
      DAY_LABEL[m.day]!,
    ]);
  return [...groups].map(([t, d]) => `${d.join('/')} ${t}`).join(' · ');
};

export function ClassesPage() {
  const { semester, semesters } = useSelectedSemester();
  const { data: classes = [] } = useClasses();
  const { data: assignments = [] } = useAssignments();
  const dialogs = useDialogs();
  const list = classes.filter((c) => c.semesterId === semester?.id && !c.archived);
  const { data: sg } = useQuery({
    queryKey: ['sem-grades', semester?.id, assignments.length],
    enabled: !!semester,
    queryFn: () => get<SemesterGrades>(`/grades/semester/${semester!.id}`),
  });
  const credits = list.reduce((n, c) => n + (c.credits ?? 0), 0);
  return (
    <>
      <PageHead
        title="Classes"
        sub={
          semester ? `${semester.name} · ${list.length} classes · ${credits} credits` : undefined
        }
        actions={
          <>
            <button className="btn" onClick={() => dialogs.openSemester()}>
              New semester
            </button>
            <button
              className="btn primary"
              onClick={() => dialogs.openClass()}
              disabled={semesters.length === 0}
            >
              <Icon name="plus" size={16} /> New class
            </button>
          </>
        }
      />
      {semesters.length === 0 ? (
        <Empty
          icon="classes"
          title="Create a semester first"
          action={
            <button className="btn primary" onClick={() => dialogs.openSemester()}>
              New semester
            </button>
          }
        >
          Classes live inside a semester.
        </Empty>
      ) : list.length === 0 ? (
        <Empty
          icon="classes"
          title="No classes in this semester"
          action={
            <button className="btn primary" onClick={() => dialogs.openClass()}>
              Add a class
            </button>
          }
        />
      ) : (
        <div className="grid cards">
          {list.map((c) => {
            const g = sg?.classes.find((x) => x.classId === c.id)?.grade;
            const next = assignments
              .filter((a) => a.classId === c.id && a.status !== 'complete' && a.due)
              .sort((a, b) => a.due!.localeCompare(b.due!))[0];
            return (
              <Link
                to={`/classes/${c.id}`}
                key={c.id}
                className="card hover stripe stack tight"
                style={{ ...classStyle(c.color), color: 'inherit', textDecoration: 'none' }}
              >
                <div className="row">
                  <div className="grow">
                    <h2>{c.name}</h2>
                    <div className="muted small">
                      {[
                        c.code,
                        c.credits != null ? `${c.credits} credits` : 'no credits set',
                        c.type ? typeLabel(c.type) : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                  <GradePill grade={g} />
                </div>
                <div className="muted small">{meetingsText(c) || 'No meeting times'}</div>
                <div className="small">
                  {next ? (
                    <>
                      Next: <b>{next.title}</b> <DueBadge a={next} />
                    </>
                  ) : (
                    <span className="muted">Nothing due</span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}

const TABS = [
  ['overview', 'Overview'],
  ['assignments', 'Assignments'],
  ['grades', 'Grades'],
  ['schedule', 'Schedule'],
  ['notes', 'Notes'],
  ['readings', 'Readings'],
  ['files', 'Files'],
] as const;

export function ClassPage() {
  const { id = '', tab = 'overview' } = useParams();
  const nav = useNavigate();
  const { data: classes = [], isLoading } = useClasses();
  const { data: assignments = [] } = useAssignments();
  const dialogs = useDialogs();
  const c = classes.find((x) => x.id === id);
  const { data: cg } = useQuery({
    queryKey: ['grade', id, assignments.filter((a) => a.classId === id).length],
    enabled: !!c,
    queryFn: () => get<{ grade: import('../lib/types.js').GradeResult }>(`/grades/class/${id}`),
  });
  if (isLoading) return null;
  if (!c)
    return (
      <Empty
        title="Class not found"
        action={
          <button className="btn" onClick={() => nav('/classes')}>
            Back to classes
          </button>
        }
      />
    );
  const mine = assignments
    .filter((a) => a.classId === id)
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
  const open = mine.filter((a) => a.status !== 'complete');
  const done = mine.length - open.length;
  return (
    <>
      <PageHead
        title={
          <span className="row" style={{ gap: 12 }}>
            <span className="dot" style={{ ...classStyle(c.color), width: 14, height: 14 }} />
            {c.name}
          </span>
        }
        sub={[c.code, c.instructor, c.location].filter(Boolean).join(' · ')}
        actions={
          <>
            <button className="btn" onClick={() => dialogs.openClass(c.id)}>
              <Icon name="edit" size={16} /> Edit
            </button>
            <button
              className="btn primary"
              onClick={() => dialogs.openAssignment({ classId: c.id })}
            >
              <Icon name="plus" size={16} /> Assignment
            </button>
          </>
        }
      />
      <nav className="tabs" role="tablist" aria-label="Class sections">
        {TABS.map(([k, label]) => (
          <Link
            key={k}
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? 'active' : ''}
            to={`/classes/${id}/${k}`}
          >
            {label}
          </Link>
        ))}
      </nav>
      {tab === 'overview' && (
        <div className="grid two">
          <div className="card stack">
            <div className="row" style={{ gap: 20 }}>
              <GradePill grade={cg?.grade} />
              <div>
                <div className="grade-big">
                  <Sens>{cg?.grade.status === 'graded' ? pct(cg.grade.percentRounded) : '—'}</Sens>
                </div>
              </div>
            </div>
            <div className="meter">
              <i style={{ width: `${mine.length ? (done / mine.length) * 100 : 0}%` }} />
            </div>
            <div className="muted small">
              {done} of {mine.length} assignments complete
            </div>
            <Link className="btn" to={`/classes/${id}/grades`}>
              Open grade tools
            </Link>
          </div>
          <dl className="card kv">
            <dt>Credits</dt>
            <dd>{c.credits ?? <span className="muted">not set</span>}</dd>
            <dt>Type</dt>
            <dd>{c.type ? typeLabel(c.type) : '—'}</dd>
            <dt>Format</dt>
            <dd>{c.delivery ? typeLabel(c.delivery) : '—'}</dd>
            <dt>Meets</dt>
            <dd>{meetingsText(c) || '—'}</dd>
            <dt>GPA level</dt>
            <dd>
              {typeLabel(String(c.honorsLevel))}
              {c.passFail ? ' · pass/fail' : ''}
            </dd>
            {c.quickNotes && (
              <>
                <dt>Notes</dt>
                <dd>{c.quickNotes}</dd>
              </>
            )}
          </dl>
          <div className="card stack tight" style={{ gridColumn: '1 / -1' }}>
            <h3>Coming up</h3>
            {open.length === 0 ? (
              <p className="muted">Nothing open.</p>
            ) : (
              open.slice(0, 5).map((a) => (
                <div className="row" key={a.id}>
                  <button
                    className="btn ghost sm grow"
                    style={{ justifyContent: 'flex-start', color: 'var(--text)' }}
                    onClick={() => dialogs.openAssignment({ id: a.id })}
                  >
                    {a.title}
                  </button>
                  <DueBadge a={a} />
                </div>
              ))
            )}
          </div>
        </div>
      )}
      {tab === 'assignments' &&
        (mine.length ? (
          <AssignmentsTable items={mine} classes={[c]} showClass={false} />
        ) : (
          <Empty
            icon="assignments"
            title="No assignments yet"
            action={
              <button
                className="btn primary"
                onClick={() => dialogs.openAssignment({ classId: c.id })}
              >
                Add one
              </button>
            }
          />
        ))}
      {tab === 'grades' && <GradesWorkspace classId={id} />}
      {tab === 'schedule' && (
        <div className="card stack tight">
          {c.meetings.length === 0 ? (
            <p className="muted">No meeting times yet. Edit the class to add them.</p>
          ) : (
            c.meetings.map((m, i) => (
              <div className="row" key={i}>
                <b style={{ width: 52 }}>{DAY_LABEL[m.day]}</b>
                <span>
                  {fmtTime(m.start)} – {fmtTime(m.end)}
                </span>
                <span className="muted">{m.location ?? c.location}</span>
              </div>
            ))
          )}
        </div>
      )}
      {tab === 'notes' && <ClassNotesTab c={c} />}
      {tab === 'readings' && <ClassReadingsTab c={c} />}
      {tab === 'files' && <ClassFilesTab c={c} />}
    </>
  );
}
