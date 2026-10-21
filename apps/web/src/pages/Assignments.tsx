import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AssignmentsBoard, AssignmentsTable } from '../components/AssignmentsView.js';
import { Icon } from '../components/Icon.js';
import { Empty, PageHead, Skeleton } from '../components/ui.js';
import { useDialogs } from '../lib/dialogs.js';
import { useAssignments, useClasses, useSaveMutation, useSelectedSemester } from '../lib/hooks.js';
import { parseQuickDate } from '../lib/quickDate.js';
import { useUi } from '../lib/store.js';
import type { Assignment } from '../lib/types.js';

export function AssignmentsPage() {
  const { data: assignments, isLoading } = useAssignments();
  const { data: classes = [] } = useClasses();
  const { semester } = useSelectedSemester();
  const dialogs = useDialogs();
  const save = useSaveMutation<Assignment>('assignments');
  const [sp, setSp] = useSearchParams();
  const view = sp.get('view') === 'board' ? 'board' : 'table';
  const [classId, setClassId] = useState('');
  const [status, setStatus] = useState('');
  const [text, setText] = useState('');
  const [quick, setQuick] = useState('');
  const [quickClass, setQuickClass] = useState('');
  const semClasses = classes.filter((c) => c.semesterId === semester?.id);
  const semIds = new Set(semClasses.map((c) => c.id));

  const items = useMemo(() => {
    const list = (assignments ?? []).filter(
      (a) =>
        semIds.has(a.classId) &&
        (!classId || a.classId === classId) &&
        (!status || a.status === status) &&
        (!text || a.title.toLowerCase().includes(text.toLowerCase())),
    );
    return list.sort(
      (a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.title.localeCompare(b.title),
    );
  }, [assignments, classId, status, text, semester?.id, classes.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    const target = quickClass || classId || semClasses[0]?.id;
    if (!quick.trim()) return;
    if (!target) {
      useUi.getState().toast('Create a class first.');
      return;
    }
    const p = parseQuickDate(quick);
    await save.mutateAsync({ data: { title: p.title, classId: target, due: p.due ?? null } });
    setQuick('');
    useUi.getState().toast(`Added “${p.title}”${p.due ? ` · due ${p.due.replace('T', ' ')}` : ''}`);
  };
  const preview = quick.trim() ? parseQuickDate(quick) : null;

  return (
    <>
      <PageHead
        title="Assignments"
        sub={semester ? `${items.length} in ${semester.name}` : undefined}
        actions={
          <>
            <div className="segmented" role="group" aria-label="View">
              <button aria-pressed={view === 'table'} onClick={() => setSp({})}>
                <Icon name="list" size={14} /> Table
              </button>
              <button aria-pressed={view === 'board'} onClick={() => setSp({ view: 'board' })}>
                <Icon name="board" size={14} /> Board
              </button>
            </div>
            <button className="btn primary" onClick={() => dialogs.openAssignment()}>
              <Icon name="plus" size={16} /> New assignment
            </button>
          </>
        }
      />
      <div className="card stack tight">
        <div className="row">
          <input
            className="input grow"
            style={{ minWidth: 220 }}
            placeholder='Quick add: "Essay 2 fri 11:59pm", "Quiz in 3 days"'
            aria-label="Quick add"
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
            <option value="">
              {classId ? 'Filtered class' : (semClasses[0]?.name ?? 'No class')}
            </option>
            {semClasses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => void add()} disabled={!quick.trim()}>
            Add
          </button>
        </div>
        {preview && (
          <div className="small muted">
            Will add “{preview.title}”
            {preview.due ? ` due ${preview.due.replace('T', ' at ')}` : ' with no due date'}
          </div>
        )}
      </div>
      <div className="row">
        <select
          className="select"
          style={{ width: 'auto' }}
          aria-label="Filter by class"
          value={classId}
          onChange={(e) => setClassId(e.target.value)}
        >
          <option value="">All classes</option>
          {semClasses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: 'auto' }}
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">Any status</option>
          <option value="not_started">Not started</option>
          <option value="in_progress">In progress</option>
          <option value="complete">Complete</option>
        </select>
        <input
          className="input"
          style={{ width: 220 }}
          placeholder="Filter by title"
          aria-label="Filter by title"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {(classId || status || text) && (
          <button
            className="btn ghost"
            onClick={() => {
              setClassId('');
              setStatus('');
              setText('');
            }}
          >
            Clear
          </button>
        )}
      </div>
      {isLoading ? (
        <Skeleton h={200} />
      ) : items.length === 0 ? (
        <Empty
          icon="assignments"
          title="No assignments here"
          action={
            <button className="btn primary" onClick={() => dialogs.openAssignment()}>
              Add an assignment
            </button>
          }
        >
          Add one above, press <kbd>A</kbd> anywhere, or import from a spreadsheet.
        </Empty>
      ) : view === 'board' ? (
        <AssignmentsBoard items={items} classes={classes} />
      ) : (
        <AssignmentsTable items={items} classes={classes} />
      )}
    </>
  );
}
