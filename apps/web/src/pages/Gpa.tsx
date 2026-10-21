import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Breakdown, Empty, PageHead, Sens } from '../components/ui.js';
import { get, post } from '../lib/api.js';
import { CHART_COLORS } from '../lib/color.js';
import { fixed, num } from '../lib/format.js';
import { useSemesters } from '../lib/hooks.js';
import { useUi } from '../lib/store.js';
import type { GpaReport, GpaResult, GpaScale, Step } from '../lib/types.js';

interface Plan {
  current: { gpa: string | null; credits: string };
  plan: {
    requiredGpa: string | null;
    feasibility: 'achievable' | 'secured' | 'impossible';
    steps: Step[];
  };
}

export function GpaPage() {
  const [scaleId, setScaleId] = useState('');
  const [weighted, setWeighted] = useState(false);
  const { data: semesters = [] } = useSemesters();
  const { data: scales = [] } = useQuery({
    queryKey: ['gpa-scales'],
    queryFn: () => get<GpaScale[]>('/gpa-scales'),
  });
  const { data: r } = useQuery({
    queryKey: ['gpa', scaleId],
    queryFn: () => get<GpaReport>(`/gpa${scaleId ? `?scaleId=${scaleId}` : ''}`),
  });
  const [target, setTarget] = useState('3.7');
  const [credits, setCredits] = useState('15');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const hide = useUi((s) => s.hideGrades);
  if (!r) return <PageHead title="GPA" />;
  const pick = (x: { unweighted: GpaResult; weighted: GpaResult }) =>
    weighted ? x.weighted : x.unweighted;
  const cum = pick(r.cumulative);
  const chart = r.progress.map((p) => ({
    name: p.name,
    Unweighted: num(p.unweighted) ?? undefined,
    Weighted: num(p.weighted) ?? undefined,
  }));
  const names = new Map(semesters.map((s) => [s.id, s.name]));
  const runPlan = async () => {
    setBusy(true);
    try {
      setPlan(
        await post<Plan>('/gpa/plan', {
          targetGpa: Number(target),
          plannedCredits: Number(credits),
          weighted,
          scaleId: scaleId || undefined,
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  const hasData = cum.gpa != null;
  return (
    <>
      <PageHead
        title="GPA"
        sub="Credit-weighted average of class grade points"
        actions={
          <>
            <select
              className="select"
              style={{ width: 'auto' }}
              aria-label="GPA scale"
              value={scaleId || r.scaleId}
              onChange={(e) => setScaleId(e.target.value)}
            >
              {scales.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <div className="segmented" role="group" aria-label="Weighting">
              <button aria-pressed={!weighted} onClick={() => setWeighted(false)}>
                Unweighted
              </button>
              <button aria-pressed={weighted} onClick={() => setWeighted(true)}>
                Weighted
              </button>
            </div>
          </>
        }
      />
      {!hasData ? (
        <Empty icon="gpa" title="No GPA yet">
          A class counts once it has credits and at least one graded assignment. Pass/fail classes
          are left out.
        </Empty>
      ) : (
        <>
          <div className="grid two">
            <div className="card stack">
              <div className="muted small">
                Cumulative GPA ({weighted ? 'weighted' : 'unweighted'})
              </div>
              <div className="grade-big">
                <Sens>{fixed(cum.gpa)}</Sens>
              </div>
              <div className="muted small">{fixed(cum.credits, 1)} credits counted</div>
            </div>
            <div className="card">
              <div className="card-title">
                <h3>Trend by semester</h3>
              </div>
              <div
                className="chart-box"
                role="img"
                aria-label="Cumulative GPA by semester"
                style={hide ? { filter: 'blur(8px)' } : undefined}
              >
                <ResponsiveContainer>
                  <LineChart data={chart} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={12} />
                    <YAxis domain={[0, 'auto']} stroke="var(--text-muted)" fontSize={12} />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--surface-solid)',
                        border: '1px solid var(--border-strong)',
                        borderRadius: 10,
                      }}
                    />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="Unweighted"
                      stroke={CHART_COLORS[0]}
                      strokeWidth={2.5}
                      dot={{ r: 4 }}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="Weighted"
                      stroke={CHART_COLORS[1]}
                      strokeWidth={2.5}
                      strokeDasharray="6 3"
                      dot={{ r: 4 }}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
          <div className="card stack">
            <h2>Transcript</h2>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Semester</th>
                    <th>Class</th>
                    <th>Grade</th>
                    <th className="num">Credits</th>
                    <th className="num">Points</th>
                    <th className="num">Quality pts</th>
                  </tr>
                </thead>
                <tbody>
                  {cum.rows.map((row) => (
                    <tr key={row.id}>
                      <td>{names.get(row.semesterId ?? '') ?? '—'}</td>
                      <td>{row.name}</td>
                      <td>
                        <Sens>{row.letter}</Sens>
                      </td>
                      <td className="num">{fixed(row.credits, 1)}</td>
                      <td className="num">
                        <Sens>{fixed(row.points)}</Sens>
                      </td>
                      <td className="num">
                        <Sens>{fixed(row.qualityPoints)}</Sens>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {r.semesters.map((s) => (
              <div className="row small" key={s.semesterId}>
                <b style={{ width: 180 }}>{names.get(s.semesterId) ?? '—'}</b>
                <span className="muted">GPA</span>
                <b className="sens">{fixed(pick(s).gpa)}</b>
                <span className="muted">{fixed(pick(s).credits, 1)} credits</span>
              </div>
            ))}
            {cum.warnings.map((w, i) => (
              <div key={i} className="badge warning" style={{ alignSelf: 'flex-start' }}>
                {w}
              </div>
            ))}
            <Breakdown steps={cum.steps} title="How this GPA was calculated" />
          </div>
        </>
      )}
      <div className="card stack">
        <h2>Target GPA planner</h2>
        <p className="muted small">
          What average do you need over your next courses to reach a cumulative GPA?
        </p>
        <div className="row">
          <label className="row tight">
            Target{' '}
            <input
              className="input num"
              style={{ width: 80 }}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              aria-label="Target GPA"
            />
          </label>
          <label className="row tight">
            Next credits{' '}
            <input
              className="input num"
              style={{ width: 80 }}
              value={credits}
              onChange={(e) => setCredits(e.target.value)}
              aria-label="Planned credits"
            />
          </label>
          <button className="btn primary" onClick={runPlan} disabled={busy || !Number(credits)}>
            Calculate
          </button>
        </div>
        {plan && (
          <div className="stack tight">
            <div className="row" style={{ gap: 16 }}>
              <span
                className={`badge ${plan.plan.feasibility === 'impossible' ? 'danger' : plan.plan.feasibility === 'secured' ? 'success' : 'accent'}`}
              >
                {plan.plan.feasibility === 'impossible'
                  ? 'Not reachable'
                  : plan.plan.feasibility === 'secured'
                    ? 'Already secured'
                    : 'Reachable'}
              </span>
              {plan.plan.feasibility !== 'secured' && (
                <div className="grade-big">
                  <Sens>{fixed(plan.plan.requiredGpa)}</Sens>
                </div>
              )}
              <span className="muted">
                {plan.plan.feasibility === 'impossible'
                  ? 'would be needed, above the highest possible grade point.'
                  : 'average grade points needed over the next courses.'}
              </span>
            </div>
            <Breakdown steps={plan.plan.steps} />
          </div>
        )}
      </div>
    </>
  );
}
