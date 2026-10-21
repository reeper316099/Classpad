import { useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon.js';
import { LoadView } from '../components/LoadView.js';
import { AgendaView, MonthView, WeekView } from '../components/PlannerViews.js';
import { TasksView } from '../components/TasksView.js';
import { PageHead } from '../components/ui.js';
import { useDialogs } from '../lib/dialogs.js';

const TABS = [
  ['week', 'Week'],
  ['month', 'Month'],
  ['agenda', 'Agenda'],
  ['tasks', 'Tasks'],
  ['load', 'Workload'],
] as const;
type Tab = (typeof TABS)[number][0];

export function PlannerPage() {
  const [sp, setSp] = useSearchParams();
  const dialogs = useDialogs();
  const tab = (TABS.find(([k]) => k === sp.get('tab'))?.[0] ?? 'week') as Tab;
  return (
    <>
      <PageHead
        title="Planner"
        sub="Your timetable, deadlines and tasks in one place"
        actions={
          <>
            <button className="btn" onClick={() => dialogs.openAssignment()}>
              New assignment
            </button>
            <button className="btn primary" onClick={() => dialogs.openTask()}>
              <Icon name="plus" size={16} /> New task
            </button>
          </>
        }
      />
      <nav className="tabs" role="tablist" aria-label="Planner views">
        {TABS.map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setSp(k === 'week' ? {} : { tab: k })}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === 'week' && <WeekView />}
      {tab === 'month' && <MonthView />}
      {tab === 'agenda' && <AgendaView />}
      {tab === 'tasks' && <TasksView />}
      {tab === 'load' && <LoadView />}
    </>
  );
}
