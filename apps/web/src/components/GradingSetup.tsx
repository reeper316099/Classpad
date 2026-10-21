import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { get, patch, put } from '../lib/api.js';
import { useDialogs } from '../lib/dialogs.js';
import { refreshAll, useAssignments, useClasses } from '../lib/hooks.js';
import { useUi } from '../lib/store.js';
import type { GradingScheme } from '../lib/types.js';
import { Dialog } from './ui.js';

type Method = 'assignment_weights' | 'category_weights' | 'points';
interface Row {
  id: string;
  name: string;
  weight: string;
  dropLowest: string;
  countMode: 'pooled' | 'mean';
}

const newId = (name: string) =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'cat'
  }-${Math.random().toString(36).slice(2, 6)}`;

const LAYOUTS: { label: string; rows: [string, number][] }[] = [
  {
    label: 'Homework · Quizzes · Exams',
    rows: [
      ['Homework', 30],
      ['Quizzes', 20],
      ['Exams', 50],
    ],
  },
  {
    label: 'Homework · Midterm · Final',
    rows: [
      ['Homework', 30],
      ['Midterm', 30],
      ['Final', 40],
    ],
  },
  {
    label: 'Participation · Projects · Exams',
    rows: [
      ['Participation', 10],
      ['Projects', 30],
      ['Exams', 60],
    ],
  },
];

const singular = (s: string) => s.toLowerCase().replace(/s$/, '');

/**
 * Per-class grading: pick how the grade is worked out, define the class's own categories and weights, and say which
 * category each assignment counts in. The categories are stored as a scheme just for this class.
 */
export function GradingSetup() {
  const { grading, close } = useDialogs();
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const { data: classes = [] } = useClasses();
  const { data: allAsg = [] } = useAssignments();
  const { data: schemes = [] } = useQuery({
    queryKey: ['schemes'],
    queryFn: () => get<GradingScheme[]>('/grading-schemes'),
  });
  const cls = classes.find((c) => c.id === grading.classId);
  const mine = useMemo(
    () =>
      allAsg
        .filter((a) => a.classId === grading.classId)
        .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999')),
    [allAsg, grading.classId],
  );
  const [method, setMethod] = useState<Method>('assignment_weights');
  const [rows, setRows] = useState<Row[]>([]);
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!grading.open || !cls) return;
    const cur = schemes.find((s) => s.id === cls.gradingSchemeId);
    const own = schemes.find((s) => s.id === `class-${cls.id}`);
    const src = cur?.mode === 'category_weights' ? cur : own;
    setMethod((cur?.mode ?? 'assignment_weights') as Method);
    setRows(
      (src?.categories ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        weight: String(c.weight),
        dropLowest: c.dropLowest ? String(c.dropLowest) : '',
        countMode: c.countMode ?? 'pooled',
      })),
    );
    setAssign(Object.fromEntries(mine.map((a) => [a.id, a.categoryId ?? ''])));
    setErr('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grading.open, cls?.id]);

  if (!cls) return null;
  const total = rows.reduce((a, r) => a + (Number(r.weight) || 0), 0);
  const setRow = (id: string, p: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const validCat = (id: string) => rows.some((r) => r.id === id);
  const uncategorized = mine.filter((a) => !validCat(assign[a.id] ?? '')).length;

  const matchByType = () => {
    const next = { ...assign };
    let n = 0;
    for (const a of mine) {
      if (validCat(next[a.id] ?? '')) continue;
      const types = a.type.flatMap((t) => t.toLowerCase().split(/[_\s-]+/)).map(singular);
      const hit = rows.find((r) => {
        const name = singular(r.name);
        return (
          types.includes(name) ||
          types.some((t) => t && name.includes(t)) ||
          (name && singular(a.title).includes(name))
        );
      });
      if (hit) {
        next[a.id] = hit.id;
        n++;
      }
    }
    setAssign(next);
    toast(
      n
        ? `Matched ${n} assignment${n === 1 ? '' : 's'} by type or title`
        : 'No assignments matched a category name',
    );
  };

  const save = async () => {
    setErr('');
    if (method === 'category_weights') {
      if (!rows.length) return setErr('Add at least one category.');
      const names = rows.map((r) => r.name.trim().toLowerCase());
      if (names.some((n) => !n)) return setErr('Every category needs a name.');
      if (new Set(names).size !== names.length) return setErr('Category names must be different.');
      if (rows.some((r) => !(Number(r.weight) >= 0) || r.weight.trim() === ''))
        return setErr('Every category needs a weight (0 or more).');
      if (total <= 0) return setErr('The weights add up to 0.');
    }
    setBusy(true);
    try {
      let schemeId = method === 'points' ? 'points' : 'default';
      if (method === 'category_weights') {
        const base = schemes.find((s) => s.id === 'default') ?? schemes[0]!;
        schemeId = `class-${cls.id}`;
        const scheme: GradingScheme = {
          ...base,
          id: schemeId,
          name: `${cls.name} categories`,
          mode: 'category_weights',
          categories: rows.map((r) => ({
            id: r.id,
            name: r.name.trim(),
            weight: Number(r.weight),
            ...(Number(r.dropLowest) > 0 ? { dropLowest: Math.floor(Number(r.dropLowest)) } : {}),
            countMode: r.countMode,
          })),
        };
        await put(`/grading-schemes/${schemeId}`, scheme);
        for (const a of mine) {
          const want = validCat(assign[a.id] ?? '') ? assign[a.id]! : '';
          if (want !== (a.categoryId ?? ''))
            await patch(`/assignments/${a.id}`, { categoryId: want || null });
        }
      }
      await patch(`/classes/${cls.id}`, { gradingSchemeId: schemeId });
      await refreshAll(qc);
      toast('Grading saved');
      close();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const METHODS: [Method, string, string][] = [
    [
      'category_weights',
      'Categories',
      'Homework 30%, Exams 50%… Each category has a weight and the assignments inside it are averaged.',
    ],
    ['assignment_weights', 'Each assignment', 'Give every assignment its own weight.'],
    ['points', 'Total points', 'Add up every point earned and divide by every point possible.'],
  ];

  return (
    <Dialog
      open={grading.open}
      onClose={close}
      title={`Grading: ${cls.name}`}
      width={720}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            Save grading
          </button>
        </>
      }
    >
      <div className="dlg-body">
        {err && (
          <div className="badge danger" role="alert">
            {err}
          </div>
        )}
        <div className="stack tight" role="radiogroup" aria-label="How is this class graded?">
          <span className="label">How is this class graded?</span>
          {METHODS.map(([k, label, hint]) => (
            <label key={k} className="row" style={{ alignItems: 'flex-start' }}>
              <input
                type="radio"
                name="grading-method"
                checked={method === k}
                onChange={() => setMethod(k)}
                style={{ marginTop: 4 }}
              />
              <span>
                <b>{label}</b>
                <span className="muted small" style={{ display: 'block' }}>
                  {hint}
                </span>
              </span>
            </label>
          ))}
        </div>

        {method === 'category_weights' && (
          <>
            <div className="stack tight">
              <div className="row">
                <span className="label">Categories and weights</span>
                <span className="grow" />
                <span
                  className={`badge ${Math.abs(total - 100) < 0.005 ? 'success' : 'warning'}`}
                  role="status"
                >
                  Total {Math.round(total * 100) / 100}%
                  {Math.abs(total - 100) < 0.005 ? ' ✓' : ' (usually 100)'}
                </span>
              </div>
              {rows.length === 0 && (
                <div className="stack tight">
                  <p className="muted small">Start from a common layout, or add your own:</p>
                  <div className="row tight" style={{ flexWrap: 'wrap' }}>
                    {LAYOUTS.map((l) => (
                      <button
                        key={l.label}
                        className="btn sm"
                        onClick={() =>
                          setRows(
                            l.rows.map(([name, weight]) => ({
                              id: newId(name),
                              name,
                              weight: String(weight),
                              dropLowest: '',
                              countMode: 'pooled',
                            })),
                          )
                        }
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {rows.length > 0 && (
                <div
                  className="table-wrap"
                  tabIndex={0}
                  role="region"
                  aria-label="Table, scrollable"
                >
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Category</th>
                        <th className="num">Weight %</th>
                        <th className="num">Drop lowest</th>
                        <th>Combine by</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <input
                              className="input"
                              aria-label="Category name"
                              value={r.name}
                              onChange={(e) => setRow(r.id, { name: e.target.value })}
                            />
                          </td>
                          <td className="num">
                            <input
                              className="input num"
                              style={{ width: 80 }}
                              inputMode="decimal"
                              aria-label={`Weight for ${r.name || 'category'}`}
                              value={r.weight}
                              onChange={(e) => setRow(r.id, { weight: e.target.value })}
                            />
                          </td>
                          <td className="num">
                            <input
                              className="input num"
                              style={{ width: 64 }}
                              inputMode="numeric"
                              aria-label={`Drop lowest for ${r.name || 'category'}`}
                              placeholder="0"
                              value={r.dropLowest}
                              onChange={(e) => setRow(r.id, { dropLowest: e.target.value })}
                            />
                          </td>
                          <td>
                            <select
                              className="select sm"
                              aria-label={`How to combine ${r.name || 'category'}`}
                              value={r.countMode}
                              onChange={(e) =>
                                setRow(r.id, { countMode: e.target.value as 'pooled' | 'mean' })
                              }
                            >
                              <option value="pooled">Total points</option>
                              <option value="mean">Average of percents</option>
                            </select>
                          </td>
                          <td className="actions">
                            <button
                              className="btn ghost sm"
                              aria-label={`Remove ${r.name || 'category'}`}
                              onClick={() => {
                                setRows((rs) => rs.filter((x) => x.id !== r.id));
                                setAssign((a) =>
                                  Object.fromEntries(
                                    Object.entries(a).map(([k, v]) => [k, v === r.id ? '' : v]),
                                  ),
                                );
                              }}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="row">
                <button
                  className="btn sm"
                  onClick={() =>
                    setRows((rs) => [
                      ...rs,
                      {
                        id: newId('category'),
                        name: '',
                        weight: '',
                        dropLowest: '',
                        countMode: 'pooled',
                      },
                    ])
                  }
                >
                  + Add category
                </button>
                <span className="muted small">
                  “Total points” adds up points earned over points possible. “Average of percents”
                  gives every assignment the same say.
                </span>
              </div>
            </div>

            {rows.length > 0 && mine.length > 0 && (
              <div className="stack tight">
                <div className="row">
                  <span className="label">Which category does each assignment count in?</span>
                  <span className="grow" />
                  {uncategorized > 0 && (
                    <>
                      <span className="badge warning">{uncategorized} not in a category yet</span>
                      <button className="btn sm" onClick={matchByType}>
                        Match by type or title
                      </button>
                    </>
                  )}
                </div>
                <div
                  className="table-wrap"
                  tabIndex={0}
                  role="region"
                  aria-label="Table, scrollable"
                  style={{ maxHeight: 260, overflow: 'auto' }}
                >
                  <table className="t">
                    <tbody>
                      {mine.map((a) => (
                        <tr key={a.id}>
                          <td>{a.title}</td>
                          <td className="muted small">{a.type.join(', ')}</td>
                          <td>
                            <select
                              className="select sm"
                              aria-label={`Category for ${a.title}`}
                              value={validCat(assign[a.id] ?? '') ? assign[a.id] : ''}
                              onChange={(e) => setAssign((m) => ({ ...m, [a.id]: e.target.value }))}
                            >
                              <option value="">— none (not counted) —</option>
                              {rows
                                .filter((r) => r.name.trim())
                                .map((r) => (
                                  <option key={r.id} value={r.id}>
                                    {r.name}
                                  </option>
                                ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="muted small">
                  New assignments get their category in the assignment form.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
