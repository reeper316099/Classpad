import { useEffect, useState } from 'react';
import { useDialogs } from '../lib/dialogs.js';
import { useAssignments, useClasses, useSaveMutation, useTasks } from '../lib/hooks.js';
import type { Task } from '../lib/types.js';
import { Dialog, Field } from './ui.js';

export function TaskDialog() {
  const { task: st, close } = useDialogs();
  const { data: tasks = [] } = useTasks();
  const { data: classes = [] } = useClasses();
  const { data: assignments = [] } = useAssignments();
  const save = useSaveMutation<Task>('tasks');
  const existing = st.id ? tasks.find((t) => t.id === st.id) : undefined;
  const [f, setF] = useState<Record<string, string | boolean>>({});
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!st.open) return;
    const t = existing;
    const [date = '', time = ''] = (t?.date?.split('/')[0] ?? '').split('T');
    setErr('');
    setF({
      title: t?.title ?? '',
      classId: t?.classId ?? st.classId ?? '',
      assignmentId: t?.assignmentId ?? '',
      date,
      time: time.slice(0, 5),
      priority: t?.priority ?? 'medium',
      targetHours: t?.targetHours != null ? String(t.targetHours) : '',
      actualHours: t?.actualHours != null ? String(t.actualHours) : '',
      done: !!t?.done,
    });
  }, [st.open, st.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: string) => (e: { target: { value: string; checked?: boolean; type?: string } }) =>
    setF((p) => ({
      ...p,
      [k]: e.target.type === 'checkbox' ? !!e.target.checked : e.target.value,
    }));
  const forClass = assignments.filter((a) => !f.classId || a.classId === f.classId);
  const num = (v: unknown) => (String(v).trim() === '' ? null : Number(v));

  const submit = async () => {
    if (!String(f.title).trim()) return setErr('Give the task a title.');
    for (const k of ['targetHours', 'actualHours']) {
      const n = num(f[k]);
      if (n !== null && (!Number.isFinite(n) || n < 0))
        return setErr('Hours must be a positive number.');
    }
    const a = assignments.find((x) => x.id === f.assignmentId);
    try {
      await save.mutateAsync({
        id: st.id,
        data: {
          title: String(f.title).trim(),
          classId: f.classId || a?.classId || null,
          assignmentId: f.assignmentId || null,
          date: f.date ? `${f.date}${f.time ? 'T' + f.time : ''}` : null,
          priority: f.priority,
          done: !!f.done,
          targetHours: num(f.targetHours),
          actualHours: num(f.actualHours),
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
      title={st.id ? 'Edit task' : 'New task'}
      width={560}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={save.isPending}>
            {st.id ? 'Save' : 'Add task'}
          </button>
        </>
      }
    >
      <form
        className="dlg-body"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {err && (
          <div className="badge danger" role="alert">
            {err}
          </div>
        )}
        <Field label="Task" htmlFor="t-title">
          <input
            id="t-title"
            className="input"
            value={String(f.title ?? '')}
            onChange={set('title')}
            placeholder="e.g. Outline the essay"
          />
        </Field>
        <div className="form-grid">
          <Field label="Class">
            <select className="select" value={String(f.classId ?? '')} onChange={set('classId')}>
              <option value="">—</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="For assignment">
            <select
              className="select"
              value={String(f.assignmentId ?? '')}
              onChange={set('assignmentId')}
            >
              <option value="">—</option>
              {forClass.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date">
            <input
              type="date"
              className="input"
              value={String(f.date ?? '')}
              onChange={set('date')}
            />
          </Field>
          <Field label="Time (optional)">
            <input
              type="time"
              className="input"
              value={String(f.time ?? '')}
              onChange={set('time')}
            />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Priority">
            <select className="select" value={String(f.priority)} onChange={set('priority')}>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </Field>
          <Field label="Target hours" hint="How long you expect it to take">
            <input
              className="input num"
              inputMode="decimal"
              value={String(f.targetHours ?? '')}
              onChange={set('targetHours')}
            />
          </Field>
          <Field label="Actual hours" hint="How long it really took">
            <input
              className="input num"
              inputMode="decimal"
              value={String(f.actualHours ?? '')}
              onChange={set('actualHours')}
            />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={!!f.done} onChange={set('done')} /> Done
        </label>
      </form>
    </Dialog>
  );
}
