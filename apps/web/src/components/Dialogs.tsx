import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { del } from '../lib/api.js';
import { CLASS_COLORS } from '../lib/color.js';
import { useDialogs } from '../lib/dialogs.js';
import { parseScoreInput, scoreText, typeLabel } from '../lib/format.js';
import {
  refreshAll,
  useAssignments,
  useClasses,
  useSaveMutation,
  useSelectedSemester,
  useSemesters,
} from '../lib/hooks.js';
import { useUi } from '../lib/store.js';
import type { Assignment, ClassEntity, GradingScheme, Semester } from '../lib/types.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get } from '../lib/api.js';
import { NewNoteDialog } from './NoteDialogs.js';
import { TaskDialog } from './TaskDialog.js';
import { Dialog, Field } from './ui.js';

const CLASS_TYPES = [
  'core',
  'gen_ed',
  'elective',
  'major',
  'minor',
  'prerequisite',
  'lab',
  'honors',
];
const TYPES = [
  'essay',
  'presentation',
  'group_project',
  'exam',
  'in_class',
  'quiz',
  'homework',
  'lab',
  'project',
];
const split = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function Dialogs() {
  return (
    <>
      <AssignmentDialog />
      <ClassDialog />
      <SemesterDialog />
      <NewNoteDialog />
      <TaskDialog />
    </>
  );
}

// ---------------------------------------------------------------- assignment
function AssignmentDialog() {
  const { assignment: st, close } = useDialogs();
  const { data: all = [] } = useAssignments();
  const { data: classes = [] } = useClasses();
  const { semester } = useSelectedSemester();
  const { data: schemes = [] } = useQuery({
    queryKey: ['schemes'],
    queryFn: () => get<GradingScheme[]>('/grading-schemes'),
  });
  const save = useSaveMutation<Assignment>('assignments');
  const existing = st.id ? all.find((a) => a.id === st.id) : undefined;
  const [f, setF] = useState<Record<string, string | boolean>>({});
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!st.open) return;
    const a = existing;
    const [dDate = '', dTime = ''] = (a?.due?.split('/')[0] ?? '').split('T');
    const sem = classes.filter((c) => c.semesterId === semester?.id);
    setErr('');
    setF({
      title: a?.title ?? '',
      classId: a?.classId ?? st.classId ?? sem[0]?.id ?? classes[0]?.id ?? '',
      types: (a?.type ?? []).join(', '),
      date: dDate,
      time: dTime.slice(0, 5),
      weight: a?.weight != null ? String(a.weight) : '',
      pointsPossible: a?.pointsPossible != null ? String(a.pointsPossible) : '',
      categoryId: a?.categoryId ?? '',
      priority: a?.priority ?? 'mid',
      status: a?.status ?? 'not_started',
      score: scoreText(a?.score),
      extraCredit: !!a?.extraCredit,
      excused: !!a?.excused,
      dropped: !!a?.dropped,
      latePenalty: a?.latePenalty != null ? String(a.latePenalty) : '',
      link: a?.link ?? '',
      quickNotes: a?.quickNotes ?? '',
    });
  }, [st.open, st.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: string) => (e: { target: { value: string; checked?: boolean; type?: string } }) =>
    setF((p) => ({
      ...p,
      [k]: e.target.type === 'checkbox' ? !!e.target.checked : e.target.value,
    }));
  const cls = classes.find((c) => c.id === f.classId);
  const scheme = schemes.find((s) => s.id === cls?.gradingSchemeId) ?? schemes[0];
  const num = (v: unknown) => (String(v).trim() === '' ? null : Number(v));

  const submit = async () => {
    if (!String(f.title).trim()) return setErr('Give it a title.');
    if (!f.classId) return setErr('Pick a class first (create one if you have none).');
    const sc = parseScoreInput(String(f.score));
    if (!sc.ok) return setErr(sc.error);
    for (const k of ['weight', 'pointsPossible', 'latePenalty'])
      if (num(f[k]) !== null && !Number.isFinite(num(f[k]))) return setErr(`${k} must be a number`);
    const due = f.date ? `${f.date}${f.time ? 'T' + f.time : ''}` : null;
    const data = {
      title: String(f.title).trim(),
      classId: f.classId,
      type: split(String(f.types)),
      due,
      weight: num(f.weight),
      pointsPossible: num(f.pointsPossible),
      categoryId: f.categoryId || null,
      priority: f.priority,
      status: f.status,
      score: sc.score,
      extraCredit: !!f.extraCredit,
      excused: !!f.excused,
      dropped: !!f.dropped,
      latePenalty: num(f.latePenalty),
      link: String(f.link).trim() || null,
      quickNotes: String(f.quickNotes).trim() || null,
    };
    try {
      await save.mutateAsync({ id: st.id, data });
      close();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Dialog
      open={st.open}
      onClose={close}
      title={st.id ? 'Edit assignment' : 'New assignment'}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={save.isPending}>
            {st.id ? 'Save' : 'Add assignment'}
          </button>
        </>
      }
    >
      <div
        className="dlg-body"
        onKeyDown={(e) => {
          if (
            e.key === 'Enter' &&
            !(e.target instanceof HTMLTextAreaElement) &&
            !(e.target instanceof HTMLButtonElement) &&
            !(e.target instanceof HTMLSelectElement)
          ) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        {err && (
          <div className="badge danger" role="alert">
            {err}
          </div>
        )}
        {classes.length === 0 && (
          <div className="badge warning row tight" role="status">
            Assignments belong to a class, and you have none yet.
            <button
              className="btn sm"
              onClick={() => {
                close();
                useDialogs.getState().openClass();
              }}
            >
              Create a class
            </button>
          </div>
        )}
        <div className="form-grid">
          <Field label="Title" htmlFor="a-title">
            <input
              id="a-title"
              className="input"
              autoFocus
              value={String(f.title ?? '')}
              onChange={set('title')}
            />
          </Field>
          <Field label="Class" htmlFor="a-class">
            <select
              id="a-class"
              className="select"
              value={String(f.classId ?? '')}
              onChange={set('classId')}
            >
              {classes.length === 0 && <option value="">No classes yet</option>}
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Due date" htmlFor="a-date">
            <input
              id="a-date"
              type="date"
              className="input"
              value={String(f.date ?? '')}
              onChange={set('date')}
            />
          </Field>
          <Field label="Due time (optional)" htmlFor="a-time">
            <input
              id="a-time"
              type="time"
              className="input"
              value={String(f.time ?? '')}
              onChange={set('time')}
            />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Type" hint={`e.g. ${TYPES.slice(0, 4).map(typeLabel).join(', ')}`}>
            <input
              className="input"
              list="types"
              value={String(f.types ?? '')}
              onChange={set('types')}
            />
          </Field>
          <Field label="Priority">
            <select className="select" value={String(f.priority)} onChange={set('priority')}>
              <option value="important">Important</option>
              <option value="mid">Mid</option>
              <option value="low">Low</option>
            </select>
          </Field>
          <Field label="Status">
            <select className="select" value={String(f.status)} onChange={set('status')}>
              <option value="not_started">Not started</option>
              <option value="in_progress">In progress</option>
              <option value="complete">Complete</option>
            </select>
          </Field>
        </div>
        <datalist id="types">
          {TYPES.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <div className="form-grid">
          {scheme?.mode === 'category_weights' ? (
            <Field label="Category" hint="Which part of the grade this counts toward">
              <select className="select" value={String(f.categoryId)} onChange={set('categoryId')}>
                <option value="">— none —</option>
                {(scheme.categories ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.weight}%)
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field
              label="Weight %"
              hint={
                scheme?.mode === 'points'
                  ? 'Not used by a points scheme'
                  : 'Share of the class grade'
              }
            >
              <input
                className="input num"
                inputMode="decimal"
                value={String(f.weight ?? '')}
                onChange={set('weight')}
              />
            </Field>
          )}
          <Field label="Points possible">
            <input
              className="input num"
              inputMode="decimal"
              value={String(f.pointsPossible ?? '')}
              onChange={set('pointsPossible')}
            />
          </Field>
          <Field label="Score" hint="90, 90%, or 45/50. Leave empty if ungraded.">
            <input className="input num" value={String(f.score ?? '')} onChange={set('score')} />
          </Field>
          <Field label="Late penalty (points off)">
            <input
              className="input num"
              inputMode="decimal"
              value={String(f.latePenalty ?? '')}
              onChange={set('latePenalty')}
            />
          </Field>
        </div>
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={!!f.extraCredit} onChange={set('extraCredit')} /> Extra
            credit
          </label>
          <label className="check">
            <input type="checkbox" checked={!!f.excused} onChange={set('excused')} /> Excused
            (ignored)
          </label>
          <label className="check">
            <input type="checkbox" checked={!!f.dropped} onChange={set('dropped')} /> Dropped
          </label>
        </div>
        <Field label="Link">
          <input
            className="input"
            type="url"
            placeholder="https://…"
            value={String(f.link ?? '')}
            onChange={set('link')}
          />
        </Field>
        <Field label="Quick notes">
          <textarea
            className="textarea"
            value={String(f.quickNotes ?? '')}
            onChange={set('quickNotes')}
          />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- class
function ClassDialog() {
  const { klass: st, close } = useDialogs();
  const { data: classes = [] } = useClasses();
  const { semesters, semester } = useSelectedSemester();
  const { data: schemes = [] } = useQuery({
    queryKey: ['schemes'],
    queryFn: () => get<GradingScheme[]>('/grading-schemes'),
  });
  const save = useSaveMutation<ClassEntity>('classes');
  const nav = useNavigate();
  const qc = useQueryClient();
  const existing = st.id ? classes.find((c) => c.id === st.id) : undefined;
  const [f, setF] = useState<Record<string, string | boolean>>({});
  const [days, setDays] = useState<Record<string, { on: boolean; start: string; end: string }>>({});
  const [err, setErr] = useState('');
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

  useEffect(() => {
    if (!st.open) return;
    const c = existing;
    setErr('');
    setF({
      name: c?.name ?? '',
      code: c?.code ?? '',
      semesterId: c?.semesterId ?? semester?.id ?? semesters[0]?.id ?? '',
      credits: c?.credits != null ? String(c.credits) : '',
      type: c?.type ? typeLabel(c.type) : '',
      delivery: c?.delivery ?? '',
      instructor: c?.instructor ?? '',
      location: c?.location ?? '',
      color: c?.color ?? CLASS_COLORS[classes.length % CLASS_COLORS.length]!,
      gradingSchemeId: c?.gradingSchemeId ?? 'default',
      honorsLevel: String(c?.honorsLevel ?? 'regular'),
      passFail: !!c?.passFail,
      includeInGpa: c?.includeInGpa ?? true,
      quickNotes: c?.quickNotes ?? '',
      studyTarget: c?.studyTargetHours != null ? String(c.studyTargetHours) : '',
    });
    setDays(
      Object.fromEntries(
        DAYS.map((d) => {
          const m = c?.meetings.find((x) => x.day === d);
          return [d, { on: !!m, start: m?.start ?? '09:00', end: m?.end ?? '10:15' }];
        }),
      ),
    );
  }, [st.open, st.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: string) => (e: { target: { value: string; checked?: boolean; type?: string } }) =>
    setF((p) => ({
      ...p,
      [k]: e.target.type === 'checkbox' ? !!e.target.checked : e.target.value,
    }));
  const submit = async () => {
    if (!String(f.name).trim()) return setErr('Give the class a name.');
    if (!f.semesterId) return setErr('Create a semester first.');
    const credits = String(f.credits).trim() === '' ? null : Number(f.credits);
    if (credits !== null && (!Number.isFinite(credits) || credits < 0))
      return setErr('Credits must be a number.');
    const meetings = DAYS.filter((d) => days[d]?.on).map((d) => ({
      day: d,
      start: days[d]!.start,
      end: days[d]!.end,
    }));
    if (meetings.some((m) => m.end <= m.start)) return setErr('A meeting ends before it starts.');
    try {
      const saved = await save.mutateAsync({
        id: st.id,
        data: {
          name: String(f.name).trim(),
          code: String(f.code).trim() || null,
          semesterId: f.semesterId,
          credits,
          studyTargetHours:
            String(f.studyTarget ?? '').trim() === '' ? null : Number(f.studyTarget),
          type:
            String(f.type ?? '')
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '_')
              .replace(/^_|_$/g, '') || null,
          delivery: f.delivery || null,
          instructor: String(f.instructor).trim() || null,
          location: String(f.location).trim() || null,
          color: f.color,
          gradingSchemeId: f.gradingSchemeId,
          honorsLevel: f.honorsLevel,
          passFail: !!f.passFail,
          includeInGpa: !!f.includeInGpa,
          quickNotes: String(f.quickNotes).trim() || null,
          meetings,
        },
      });
      close();
      if (!st.id) nav(`/classes/${saved.id}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const remove = async () => {
    if (
      !existing ||
      !confirm(`Delete "${existing.name}" and all of its assignments? A backup is taken first.`)
    )
      return;
    await del(`/classes/${existing.id}`);
    await refreshAll(qc);
    useUi.getState().toast(`Deleted ${existing.name}`);
    close();
    nav('/classes');
  };

  return (
    <Dialog
      open={st.open}
      onClose={close}
      title={st.id ? 'Edit class' : 'New class'}
      footer={
        <>
          {st.id && (
            <button className="btn danger" onClick={remove} style={{ marginRight: 'auto' }}>
              Delete…
            </button>
          )}
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            {st.id ? 'Save' : 'Create class'}
          </button>
        </>
      }
    >
      <div
        className="dlg-body"
        onKeyDown={(e) => {
          if (
            e.key === 'Enter' &&
            !(e.target instanceof HTMLTextAreaElement) &&
            !(e.target instanceof HTMLButtonElement) &&
            !(e.target instanceof HTMLSelectElement)
          ) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        {err && (
          <div className="badge danger" role="alert">
            {err}
          </div>
        )}
        <div className="form-grid">
          <Field label="Name" htmlFor="c-name">
            <input
              id="c-name"
              className="input"
              autoFocus
              value={String(f.name ?? '')}
              onChange={set('name')}
            />
          </Field>
          <Field label="Course code">
            <input className="input" value={String(f.code ?? '')} onChange={set('code')} />
          </Field>
          <Field label="Semester">
            <select
              className="select"
              value={String(f.semesterId ?? '')}
              onChange={set('semesterId')}
            >
              {semesters.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Credits">
            <input
              className="input num"
              inputMode="decimal"
              value={String(f.credits ?? '')}
              onChange={set('credits')}
            />
          </Field>
          <Field label="Study goal (hours/week)">
            <input
              className="input num"
              inputMode="decimal"
              value={String(f.studyTarget ?? '')}
              onChange={set('studyTarget')}
            />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Type">
            <input
              className="input"
              list="class-types"
              value={String(f.type ?? '')}
              onChange={set('type')}
              placeholder="Core, Elective, Major…"
            />
            <datalist id="class-types">
              {CLASS_TYPES.map((t) => (
                <option key={t} value={typeLabel(t)} />
              ))}
            </datalist>
          </Field>
          <Field label="Format">
            <select className="select" value={String(f.delivery ?? '')} onChange={set('delivery')}>
              <option value="">—</option>
              <option value="in_person">In person</option>
              <option value="online">Online</option>
              <option value="hybrid">Hybrid</option>
            </select>
          </Field>
          <Field label="Instructor">
            <input
              className="input"
              value={String(f.instructor ?? '')}
              onChange={set('instructor')}
            />
          </Field>
          <Field label="Location">
            <input className="input" value={String(f.location ?? '')} onChange={set('location')} />
          </Field>
        </div>
        <div className="stack tight">
          <span className="label">Meeting times</span>
          {DAYS.map((d) => (
            <div className="row tight" key={d}>
              <label className="check" style={{ width: 70 }}>
                <input
                  type="checkbox"
                  checked={!!days[d]?.on}
                  onChange={(e) =>
                    setDays((p) => ({ ...p, [d]: { ...p[d]!, on: e.target.checked } }))
                  }
                />{' '}
                {d.toUpperCase()}
              </label>
              <input
                type="time"
                className="input sm"
                style={{ width: 120 }}
                disabled={!days[d]?.on}
                value={days[d]?.start ?? ''}
                onChange={(e) =>
                  setDays((p) => ({ ...p, [d]: { ...p[d]!, start: e.target.value } }))
                }
                aria-label={`${d} start`}
              />
              <span className="muted">to</span>
              <input
                type="time"
                className="input sm"
                style={{ width: 120 }}
                disabled={!days[d]?.on}
                value={days[d]?.end ?? ''}
                onChange={(e) => setDays((p) => ({ ...p, [d]: { ...p[d]!, end: e.target.value } }))}
                aria-label={`${d} end`}
              />
            </div>
          ))}
        </div>
        <div className="form-grid">
          <Field label="Grading scheme" hint="How the grade is calculated">
            <select
              className="select"
              value={String(f.gradingSchemeId)}
              onChange={set('gradingSchemeId')}
            >
              {(schemes.length ? schemes : [{ id: 'default', name: 'Assignment weights' }]).map(
                (s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field label="GPA level" hint="Weighted GPA bonus">
            <select className="select" value={String(f.honorsLevel)} onChange={set('honorsLevel')}>
              <option value="regular">Regular</option>
              <option value="honors">Honors</option>
              <option value="ap">AP</option>
              <option value="ib">IB</option>
              <option value="dual">Dual enrollment</option>
            </select>
          </Field>
          <Field label="Color">
            <input
              type="color"
              className="input"
              style={{ padding: 2 }}
              value={String(f.color)}
              onChange={set('color')}
              aria-label="Class color"
            />
          </Field>
        </div>
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={!!f.passFail} onChange={set('passFail')} /> Pass/fail
            (left out of GPA)
          </label>
          <label className="check">
            <input type="checkbox" checked={!!f.includeInGpa} onChange={set('includeInGpa')} />{' '}
            Count in GPA
          </label>
        </div>
        <Field label="Quick notes">
          <textarea
            className="textarea"
            value={String(f.quickNotes ?? '')}
            onChange={set('quickNotes')}
          />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- semester
function SemesterDialog() {
  const { semester: st, close } = useDialogs();
  const { data: semesters = [] } = useSemesters();
  const save = useSaveMutation<Semester>('semesters');
  const existing = st.id ? semesters.find((s) => s.id === st.id) : undefined;
  const [f, setF] = useState({ name: '', start: '', end: '', isCurrent: true, goals: '' });
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!st.open) return;
    setErr('');
    setF({
      name: existing?.name ?? '',
      start: existing?.start ?? '',
      end: existing?.end ?? '',
      isCurrent: existing?.isCurrent ?? semesters.length === 0,
      goals: (existing?.goals ?? []).join('\n'),
    });
  }, [st.open, st.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async () => {
    if (!f.name.trim()) return setErr('Give the semester a name.');
    if (f.start && f.end && f.end < f.start)
      return setErr('The end date is before the start date.');
    try {
      await save.mutateAsync({
        id: st.id,
        data: {
          name: f.name.trim(),
          start: f.start || null,
          end: f.end || null,
          isCurrent: f.isCurrent,
          goals: f.goals
            .split('\n')
            .map((g) => g.trim())
            .filter(Boolean),
        },
      });
      close();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Dialog
      open={st.open}
      onClose={close}
      title={st.id ? 'Edit semester' : 'New semester'}
      width={520}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            {st.id ? 'Save' : 'Create semester'}
          </button>
        </>
      }
    >
      <div
        className="dlg-body"
        onKeyDown={(e) => {
          if (
            e.key === 'Enter' &&
            !(e.target instanceof HTMLTextAreaElement) &&
            !(e.target instanceof HTMLButtonElement) &&
            !(e.target instanceof HTMLSelectElement)
          ) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        {err && (
          <div className="badge danger" role="alert">
            {err}
          </div>
        )}
        <Field label="Name">
          <input
            className="input"
            autoFocus
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder="e.g. Autumn 2031"
          />
        </Field>
        <div className="form-grid">
          <Field label="Starts">
            <input
              type="date"
              className="input"
              value={f.start}
              onChange={(e) => setF({ ...f, start: e.target.value })}
            />
          </Field>
          <Field label="Ends">
            <input
              type="date"
              className="input"
              value={f.end}
              onChange={(e) => setF({ ...f, end: e.target.value })}
            />
          </Field>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={f.isCurrent}
            onChange={(e) => setF({ ...f, isCurrent: e.target.checked })}
          />{' '}
          Current semester
        </label>
        <Field label="Goals" hint="One per line">
          <textarea
            className="textarea"
            value={f.goals}
            onChange={(e) => setF({ ...f, goals: e.target.value })}
          />
        </Field>
      </div>
    </Dialog>
  );
}
