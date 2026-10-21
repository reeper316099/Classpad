import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CHART_COLORS } from '../lib/color.js';
import { dayLabel } from '../lib/dates.js';
import type { Stats } from '../lib/planner.js';
import type { ClassEntity } from '../lib/types.js';

const tip = {
  background: 'var(--surface-solid)',
  border: '1px solid var(--border-strong)',
  borderRadius: 10,
};

export function StudyCharts({ stats, classes }: { stats: Stats; classes: ClassEntity[] }) {
  const byId = new Map(classes.map((c) => [c.id, c]));
  const perClass = stats.study.perClass
    .filter((p) => p.minutes > 0 || p.targetMinutes > 0)
    .map((p) => ({
      name: byId.get(p.classId)?.code ?? byId.get(p.classId)?.name ?? '—',
      Studied: +(p.minutes / 60).toFixed(1),
      Goal: +(p.targetMinutes / 60).toFixed(1),
    }));
  const daily = stats.study.daily.map((d) => ({
    name: dayLabel(d.date, { month: 'short', day: 'numeric' }),
    Minutes: d.minutes,
  }));
  return (
    <div className="grid two">
      <section className="card stack tight">
        <h3>This week by class (hours)</h3>
        {perClass.length === 0 ? (
          <p className="muted">No study time yet this week.</p>
        ) : (
          <div
            className="chart-box"
            role="img"
            aria-label="Hours studied per class this week compared with weekly goals"
          >
            <ResponsiveContainer>
              <BarChart data={perClass} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={12} />
                <YAxis stroke="var(--text-muted)" fontSize={12} />
                <Tooltip contentStyle={tip} />
                <Legend />
                <Bar dataKey="Studied" fill={CHART_COLORS[0]} radius={[6, 6, 0, 0]} />
                <Bar dataKey="Goal" fill={CHART_COLORS[1]} radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>
      <section className="card stack tight">
        <h3>Last 14 days (minutes)</h3>
        <div
          className="chart-box"
          role="img"
          aria-label="Minutes studied per day over the last two weeks"
        >
          <ResponsiveContainer>
            <BarChart data={daily} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={11} interval={1} />
              <YAxis stroke="var(--text-muted)" fontSize={12} />
              <Tooltip contentStyle={tip} />
              <Bar dataKey="Minutes" fill={CHART_COLORS[2]} radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
