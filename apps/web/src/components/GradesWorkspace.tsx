import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { get, patch, post } from '../lib/api.js';
import { fixed, num, pct, scoreText } from '../lib/format.js';
import { letterFor, parseOverride } from '../lib/grade.js';
import { refreshAll, useAssignments, useClasses } from '../lib/hooks.js';
import { useDialogs } from '../lib/dialogs.js';
import { useUi } from '../lib/store.js';
import type {
  Assignment,
  ClassGrade,
  GradingScheme,
  NeededResult,
  WhatIfResult,
} from '../lib/types.js';
import { Breakdown, ClassChip, GradePill, Sens } from './ui.js';

type Tab = 'current' | 'whatif' | 'needed' | 'sensitivity' | 'projection';
const TABS: [Tab, string][] = [
  ['current', 'Current'],
  ['whatif', 'What-if'],
  ['needed', 'What do I need?'],
  ['sensitivity', 'Sensitivity'],
  ['projection', 'Projection'],
];

export function GradesWorkspace({ classId }: { classId: string }) {
  const { data: classes = [] } = useClasses();
  const { data: allAsg = [] } = useAssignments();
  const { data: schemes = [] } = useQuery({
    queryKey: ['schemes'],
    queryFn: () => get<GradingScheme[]>('/grading-schemes'),
  });
  const cls = classes.find((c) => c.id === classId);
  const items = useMemo(
    () =>
      allAsg
        .filter((a) => a.classId === classId)
        .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999')),
    [allAsg, classId],
  );
  const scheme =
    schemes.find((s) => s.id === cls?.gradingSchemeId) ?? schemes.find((s) => s.id === 'default');
  const { data: cg } = useQuery({
    queryKey: ['grade', classId, items.length],
    queryFn: () => get<ClassGrade>(`/grades/class/${classId}`),
    placeholderData: keepPreviousData,
  });
  const [tab, setTab] = useState<Tab>('current');
  const dialogs = useDialogs();
  useEffect(() => setTab('current'), [classId]);
  if (!cls) return null;
  const g = cg?.grade;

  return (
    <div className="stack">
      <div className="card row" style={{ gap: 24 }}>
        <div className="stack tight">
          <ClassChip name={cls.name} color={cls.color} code={cls.code} />
          <div className="row" style={{ gap: 16 }}>
            <div className="grade-big">
              <Sens>{g?.status === 'graded' ? pct(g.percentRounded) : '—'}</Sens>
            </div>
            <GradePill grade={g} />
          </div>
          <div className="muted small">
            {g?.status === 'none' ? (
              g.summary
            ) : g?.status === 'graded' && g.nextLetter ? (
              <Sens>
                <span>
                  {fixed(g.pointsToNextLetter)} points to {g.nextLetter}
                </span>
              </Sens>
            ) : g ? (
              'Top letter reached'
            ) : (
              'Calculating…'
            )}
            {' · '}
            {scheme?.name ?? 'Assignment weights'}{' '}
            <button className="btn ghost sm" onClick={() => dialogs.openGrading(classId)}>
              Set up grading
            </button>
            {cls.credits != null ? ` · ${cls.credits} credits` : ''}
          </div>
        </div>
        <span className="grow" />
        <div className="segmented" role="tablist" aria-label="Grade tools">
          {TABS.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {scheme?.mode === 'category_weights' && (scheme.categories ?? []).length === 0 && (
        <div className="badge warning row tight" style={{ alignSelf: 'flex-start' }}>
          This class uses category weights but has no categories yet.
          <button className="btn sm" onClick={() => dialogs.openGrading(classId)}>
            Add categories
          </button>
        </div>
      )}
      {scheme?.mode === 'category_weights' &&
        (scheme.categories ?? []).length > 0 &&
        items.some((a) => !(scheme.categories ?? []).some((c) => c.id === a.categoryId)) && (
          <div className="badge warning row tight" style={{ alignSelf: 'flex-start' }}>
            {
              items.filter((a) => !(scheme.categories ?? []).some((c) => c.id === a.categoryId))
                .length
            }{' '}
            assignment(s) are not in a category, so they do not count yet.
            <button className="btn sm" onClick={() => dialogs.openGrading(classId)}>
              Choose categories
            </button>
          </div>
        )}
      {g?.warnings
        .filter((w) => !/has no valid category/.test(w))
        .map((w, i) => (
          <div key={i} className="badge warning" style={{ alignSelf: 'flex-start' }}>
            {w}
          </div>
        ))}

      {tab === 'current' && (
        <div className="card stack">
          {g?.status === 'none' ? (
            <p className="muted">
              No graded work yet. Enter a score on any assignment, or try the What-if tab to see
              what a grade could look like.
            </p>
          ) : g ? (
            <Breakdown steps={g.steps} />
          ) : null}
        </div>
      )}
      {tab === 'whatif' && (
        <WhatIf
          classId={classId}
          items={items}
          g={g?.status === 'graded' ? g.percentRounded : null}
          scheme={scheme}
        />
      )}
      {tab === 'needed' && <Needed classId={classId} items={items} scheme={scheme} />}
      {tab === 'sensitivity' && (
        <div className="card stack">
          <p className="muted small">
            How far each pending item could move your grade on its own: the difference between
            scoring 100% and 0% on it.
          </p>
          {cg && cg.sensitivity.length > 0 ? (
            (() => {
              const max = Math.max(...cg.sensitivity.map((s) => Number(s.swing)), 1);
              return (
                <div
                  className="table-wrap"
                  tabIndex={0}
                  role="region"
                  aria-label="Table, scrollable"
                >
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th className="num">If 0%</th>
                        <th className="num">If 100%</th>
                        <th>Swing</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cg.sensitivity.map((s) => (
                        <tr key={s.id}>
                          <td>{s.title}</td>
                          <td className="num">
                            <Sens>{pct(s.ifZero)}</Sens>
                          </td>
                          <td className="num">
                            <Sens>{pct(s.ifFull)}</Sens>
                          </td>
                          <td style={{ minWidth: 180 }}>
                            <div className="row tight">
                              <div className="meter grow">
                                <i style={{ width: `${(Number(s.swing) / max) * 100}%` }} />
                              </div>
                              <b className="sens">±{fixed(s.swing, 1)}</b>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()
          ) : (
            <p className="muted">Nothing pending, so there is nothing left to move.</p>
          )}
        </div>
      )}
      {tab === 'projection' && (
        <div className="card stack">
          {cg?.projection ? (
            (() => {
              const p = num(cg.projection!.projected);
              return (
                <>
                  <p className="muted">{cg.projection!.note}</p>
                  <div className="row" style={{ gap: 20 }}>
                    <div className="grade-big">
                      <Sens>{pct(cg.projection!.projected)}</Sens>
                    </div>
                    {p != null && (
                      <GradePill
                        grade={
                          {
                            status: 'graded',
                            letter: letterFor(p, scheme),
                            percentRounded: String(p),
                          } as never
                        }
                      />
                    )}
                    <span className="muted">projected end-of-term grade</span>
                  </div>
                  {cg.projection!.pendingIds.length === 0 && (
                    <p className="muted">Everything is graded, so this is your final grade.</p>
                  )}
                </>
              );
            })()
          ) : (
            <p className="muted">Projection needs at least one graded item.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ what-if
function WhatIf({
  classId,
  items,
  g,
  scheme,
}: {
  classId: string;
  items: Assignment[];
  g: string | null;
  scheme?: GradingScheme;
}) {
  const qc = useQueryClient();
  const [ov, setOv] = useState<Record<string, string>>({});
  const [fill, setFill] = useState('90');
  useEffect(() => setOv({}), [classId]);
  const parsed = useMemo(() => {
    const body: Record<string, unknown> = {};
    const bad: string[] = [];
    for (const [id, t] of Object.entries(ov)) {
      const p = parseOverride(t);
      if (p === undefined) bad.push(id);
      else body[id] = p;
    }
    return { body, bad };
  }, [ov]);
  const key = JSON.stringify(parsed.body);
  const { data: r } = useQuery({
    queryKey: ['whatif', classId, key],
    enabled: Object.keys(parsed.body).length > 0,
    queryFn: () => post<WhatIfResult>('/grades/what-if', { classId, overrides: parsed.body }),
    placeholderData: keepPreviousData,
  });
  const active = Object.keys(parsed.body).length > 0 && r;
  const delta = active ? num(r!.delta) : null;
  const apply = async () => {
    if (
      !confirm(
        `Save these ${Object.keys(parsed.body).length} hypothetical score(s) as real scores?`,
      )
    )
      return;
    for (const [id, p] of Object.entries(parsed.body)) {
      const s = p as { kind: string; percent?: number; earned?: number; possible?: number } | null;
      await patch(`/assignments/${id}`, {
        score:
          s === null
            ? null
            : s.kind === 'percent'
              ? { percent: s.percent }
              : { earned: s.earned, possible: s.possible },
        status: s ? 'complete' : undefined,
      });
    }
    setOv({});
    await refreshAll(qc);
    useUi.getState().toast('Scores saved');
  };
  const pending = items.filter((a) => !a.score && !a.excused && !a.dropped);
  return (
    <div className="stack">
      <div className="card row" style={{ gap: 24 }}>
        <div>
          <div className="muted small">Actual</div>
          <div className="grade-big">
            <Sens>{pct(g)}</Sens>
          </div>
        </div>
        <div style={{ fontSize: '1.6rem' }} aria-hidden>
          →
        </div>
        <div>
          <div className="muted small">What-if</div>
          <div className="grade-big">
            <Sens>{active ? pct(r!.hypothetical.percentRounded) : '—'}</Sens>
          </div>
        </div>
        {active && delta != null && (
          <span className={`badge ${delta >= 0 ? 'success' : 'danger'}`}>
            <Sens>
              {delta >= 0 ? '+' : ''}
              {delta.toFixed(2)} pts
            </Sens>
          </span>
        )}
        {active && <GradePill grade={r!.hypothetical} />}
        <span className="grow" />
        <div className="row tight">
          <input
            className="input sm num"
            style={{ width: 72 }}
            aria-label="Fill value"
            value={fill}
            onChange={(e) => setFill(e.target.value)}
          />
          <button
            className="btn sm"
            disabled={!pending.length}
            onClick={() =>
              setOv((o) => ({ ...o, ...Object.fromEntries(pending.map((a) => [a.id, fill])) }))
            }
          >
            Fill {pending.length} pending
          </button>
          <button className="btn sm" disabled={!Object.keys(ov).length} onClick={() => setOv({})}>
            Reset
          </button>
          <button className="btn sm primary" disabled={!active} onClick={apply}>
            Apply…
          </button>
        </div>
      </div>
      <div className="card stack tight">
        <p className="muted small">
          Type a hypothetical score on any item (90, or 45/50). Nothing is saved unless you press
          Apply. Clear a graded item to see the grade without it.
        </p>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Table, scrollable">
          <table className="t">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Weight</th>
                <th className="num">Actual</th>
                <th className="num">What if</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.title}
                    {a.excused && (
                      <span className="badge warning" style={{ marginLeft: 6 }}>
                        Excused
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {a.weight != null
                      ? `${a.weight}%`
                      : a.pointsPossible != null
                        ? `${a.pointsPossible} pts`
                        : '—'}
                  </td>
                  <td className="num">
                    <Sens>{scoreText(a.score) || <span className="muted">—</span>}</Sens>
                  </td>
                  <td className="num">
                    <span className="sens">
                      <input
                        className="input sm num"
                        style={{
                          width: 96,
                          borderColor: parsed.bad.includes(a.id) ? 'var(--danger)' : undefined,
                        }}
                        aria-label={`What-if score for ${a.title}`}
                        placeholder="—"
                        value={ov[a.id] ?? ''}
                        onChange={(e) => setOv((o) => ({ ...o, [a.id]: e.target.value }))}
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {parsed.bad.length > 0 && (
          <div className="badge danger">Some entries aren’t scores. Use 90 or 45/50.</div>
        )}
      </div>
      {active && (
        <div className="card">
          <Breakdown steps={r!.hypothetical.steps} title="How the what-if was calculated" />
        </div>
      )}
      {scheme && null}
    </div>
  );
}

// ------------------------------------------------------------------ needed score
function Needed({
  classId,
  items,
  scheme,
}: {
  classId: string;
  items: Assignment[];
  scheme?: GradingScheme;
}) {
  const letters = useMemo(
    () => [...(scheme?.scale.cutoffs ?? [])].sort((a, b) => b.min - a.min).map((c) => c.letter),
    [scheme],
  );
  const [mode, setMode] = useState<'percent' | 'letter'>('letter');
  const [pctTarget, setPctTarget] = useState('90');
  const [letter, setLetter] = useState('');
  const [maxPer, setMaxPer] = useState('100');
  const pendingIds = useMemo(
    () =>
      items.filter((a) => !a.score && !a.excused && !a.dropped && !a.extraCredit).map((a) => a.id),
    [items],
  );
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  useEffect(() => setChosen(null), [classId]);
  const sel = chosen ?? new Set(pendingIds);
  const effLetter = letter || letters.find((l) => l.startsWith('A')) || letters[0] || '';
  const target = mode === 'percent' ? Number(pctTarget) : null;
  const valid =
    mode === 'letter' ? !!effLetter : Number.isFinite(target) && pctTarget.trim() !== '';
  const { data: r, isFetching } = useQuery({
    queryKey: [
      'needed',
      classId,
      mode,
      mode === 'percent' ? pctTarget : effLetter,
      [...sel].sort().join(','),
      maxPer,
      items.length,
    ],
    enabled: valid && sel.size > 0,
    queryFn: () =>
      post<NeededResult>('/grades/needed', {
        classId,
        target: mode === 'percent' ? Number(pctTarget) : { letter: effLetter },
        remainingIds: [...sel],
        perItem: true,
        maxPerItem: Number(maxPer) || 100,
      }),
    placeholderData: keepPreviousData,
  });
  const title = (id: string) => items.find((a) => a.id === id)?.title ?? id;

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <div className="segmented" role="group" aria-label="Target type">
            <button aria-pressed={mode === 'letter'} onClick={() => setMode('letter')}>
              Letter
            </button>
            <button aria-pressed={mode === 'percent'} onClick={() => setMode('percent')}>
              Percent
            </button>
          </div>
          {mode === 'letter' ? (
            <select
              className="select"
              style={{ width: 100 }}
              aria-label="Target letter"
              value={effLetter}
              onChange={(e) => setLetter(e.target.value)}
            >
              {letters.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          ) : (
            <input
              className="input num"
              style={{ width: 100 }}
              aria-label="Target percent"
              inputMode="decimal"
              value={pctTarget}
              onChange={(e) => setPctTarget(e.target.value)}
            />
          )}
          <span className="muted">as my final grade</span>
          <span className="grow" />
          <label className="row tight small muted">
            Max per item{' '}
            <input
              className="input sm num"
              style={{ width: 70 }}
              value={maxPer}
              onChange={(e) => setMaxPer(e.target.value)}
              title="Raise above 100 if extra credit is possible"
            />
          </label>
        </div>
        <div className="stack tight">
          <span className="label">Remaining work to solve over</span>
          <div className="row">
            {items
              .filter((a) => !a.extraCredit && !a.excused)
              .map((a) => (
                <label key={a.id} className="check badge" style={{ padding: '4px 10px' }}>
                  <input
                    type="checkbox"
                    checked={sel.has(a.id)}
                    onChange={(e) => {
                      const n = new Set(sel);
                      if (e.target.checked) n.add(a.id);
                      else n.delete(a.id);
                      setChosen(n);
                    }}
                  />
                  {a.title}
                  {a.score ? ' (graded)' : ''}
                </label>
              ))}
          </div>
          {pendingIds.length === 0 && (
            <p className="muted small">
              Nothing is pending. Tick items above to ask “what if I redid these?”
            </p>
          )}
        </div>
      </div>
      {sel.size === 0 ? (
        <div className="card muted">Select at least one item to solve over.</div>
      ) : (
        r && (
          <>
            <div className="card stack" aria-busy={isFetching}>
              <div className="row" style={{ gap: 20 }}>
                <span
                  className={`badge ${r.feasibility === 'impossible' ? 'danger' : r.feasibility === 'secured' ? 'success' : 'accent'}`}
                >
                  {r.feasibility === 'impossible'
                    ? 'Not reachable'
                    : r.feasibility === 'secured'
                      ? 'Already secured'
                      : 'Reachable'}
                </span>
                {r.feasibility !== 'secured' && r.required != null && (
                  <div className="grade-big">
                    <Sens>{pct(r.required)}</Sens>
                  </div>
                )}
                <span className="muted">
                  {r.feasibility === 'secured'
                    ? `Any score on the remaining work keeps you at ${fixed(r.target)}% or better.`
                    : r.feasibility === 'impossible'
                      ? `would be needed on each of the ${sel.size} item(s), more than the ${maxPer}% maximum.`
                      : `needed on each of the ${sel.size} item(s) to finish at ${fixed(r.target)}%.`}
                </span>
              </div>
              <div className="row" style={{ gap: 24 }}>
                <div>
                  <div className="muted small">Worst case (all 0%)</div>
                  <b className="sens">{pct(r.worst)}</b>
                </div>
                <div>
                  <div className="muted small">Expected (at your average)</div>
                  <b className="sens">{pct(r.expected)}</b>
                </div>
                <div>
                  <div className="muted small">Best case (all {maxPer}%)</div>
                  <b className="sens">{pct(r.best)}</b>
                </div>
              </div>
            </div>
            {r.perItem && Object.keys(r.perItem).length > 1 && (
              <div className="card stack tight">
                <h3>Item by item</h3>
                <p className="muted small">
                  If the other remaining items score your current average, this is what each one
                  needs on its own.
                </p>
                <div
                  className="table-wrap"
                  tabIndex={0}
                  role="region"
                  aria-label="Table, scrollable"
                >
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th className="num">Needed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(r.perItem).map(([id, v]) => (
                        <tr key={id}>
                          <td>{title(id)}</td>
                          <td className="num">
                            <Sens>
                              {v == null ? (
                                <span className="badge danger">Not reachable</span>
                              ) : (
                                pct(v)
                              )}
                            </Sens>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <div className="card">
              <Breakdown steps={r.steps} />
            </div>
          </>
        )
      )}
    </div>
  );
}
