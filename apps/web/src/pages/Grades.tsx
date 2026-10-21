import { useNavigate, useParams } from 'react-router-dom';
import { GradesWorkspace } from '../components/GradesWorkspace.js';
import { Empty, PageHead } from '../components/ui.js';
import { useDialogs } from '../lib/dialogs.js';
import { useClasses, useSelectedSemester } from '../lib/hooks.js';

export function GradesPage() {
  const { classId } = useParams();
  const nav = useNavigate();
  const dialogs = useDialogs();
  const { semester } = useSelectedSemester();
  const { data: classes = [] } = useClasses();
  const list = classes.filter((c) => c.semesterId === semester?.id);
  const current = classes.find((c) => c.id === classId) ?? list[0];
  if (!current)
    return (
      <Empty
        icon="grades"
        title="No classes to grade yet"
        action={
          <button className="btn primary" onClick={() => dialogs.openClass()}>
            Add a class
          </button>
        }
      >
        The grade tools work per class. Add a class and a few weighted assignments to get started.
      </Empty>
    );
  return (
    <>
      <PageHead
        title="Grades"
        sub="Current grade, what-if, what you need, and every step of the math"
        actions={
          <select
            className="select"
            style={{ width: 'auto' }}
            aria-label="Class"
            value={current.id}
            onChange={(e) => nav(`/grades/${e.target.value}`)}
          >
            {list.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        }
      />
      <GradesWorkspace classId={current.id} />
    </>
  );
}
