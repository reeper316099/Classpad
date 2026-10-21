import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { Icon } from '../components/Icon.js';
import {
  ClassChip,
  Dialog,
  Empty,
  Field as FieldWrap,
  PageHead,
  Sens,
  Skeleton,
} from '../components/ui.js';
import { del, get, patch, post } from '../lib/api.js';
import { fmtDue } from '../lib/format.js';
import { refreshAll, useClasses } from '../lib/hooks.js';
import {
  MODULES,
  blankForm,
  formatMoney,
  isOn,
  moduleById,
  summarize,
  toForm,
  toPayload,
  type Field,
  type ModuleDef,
} from '../lib/modules.js';
import { useUi } from '../lib/store.js';
import type { ClassEntity, Page } from '../lib/types.js';

type Item = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function ModuleRoute() {
  const { id = '' } = useParams();
  const def = moduleById(id);
  const modules = useUi((s) => s.modules);
  if (!def || def.custom) return <Navigate to="/" replace />;
  if (!isOn(modules, def.id)) return <ModuleOff def={def} />;
  return <ModulePage def={def} />;
}

export function ModuleOff({ def }: { def: ModuleDef }) {
  const ui = useUi();
  return (
    <>
      <PageHead title={def.label} />
      <Empty
        icon={def.icon}
        title={`${def.label} is switched off`}
        action={
          <button
            className="btn primary"
            onClick={() => ui.set({ modules: { ...ui.modules, [def.id]: true } })}
          >
            Turn on {def.label}
          </button>
        }
      >
        {def.description} You can switch modules on or off any time in Settings.
      </Empty>
    </>
  );
}

function cell(f: Field, item: Item, classes: Map<string, ClassEntity>) {
  const v = item[f.key];
  if (v == null || v === '' || (Array.isArray(v) && v.length === 0))
    return <span className="muted">—</span>;
  if (f.type === 'class') {
    const c = classes.get(v);
    return c ? (
      <ClassChip name={c.name} color={c.color} code={c.code} />
    ) : (
      <span className="muted">—</span>
    );
  }
  if (f.type === 'classes')
    return (
      <span className="row tight">
        {(v as string[])
          .map((id) => classes.get(id))
          .filter(Boolean)
          .map((c) => (
            <ClassChip key={c!.id} name={c!.name} color={c!.color} code={c!.code} />
          ))}
      </span>
    );
  if (f.type === 'select')
    return <span className="badge">{f.options?.find(([k]) => k === v)?.[1] ?? v}</span>;
  if (f.type === 'date') return <span>{fmtDue(v)}</span>;
  if (f.type === 'money') return <Sens>{formatMoney(Number(v))}</Sens>;
  if (f.type === 'checklist') {
    const l = v as { done: boolean }[];
    return (
      <span className="badge">
        {l.filter((c) => c.done).length}/{l.length}
      </span>
    );
  }
  return <span>{String(v)}</span>;
}

export function ModulePage({ def }: { def: ModuleDef }) {
  const qc = useQueryClient();
  const { data: classes = [] } = useClasses();
  const byClass = useMemo(() => new Map(classes.map((c) => [c.id, c])), [classes]);
  const { data: items, isLoading } = useQuery({
    queryKey: ['module', def.id],
    queryFn: async () => (await get<Page<Item>>(`${def.path}?limit=1000`)).items,
  });
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<{ id?: string } | null>(null);
  const toast = useUi((s) => s.toast);
  const sorted = useMemo(() => {
    const dir = def.sort.dir === 'desc' ? -1 : 1;
    const text = q.trim().toLowerCase();
    return [...(items ?? [])]
      .filter(
        (i) =>
          !text ||
          def.fields.some(
            (f) =>
              typeof i[f.key] === 'string' && (i[f.key] as string).toLowerCase().includes(text),
          ),
      )
      .sort(
        (a, b) =>
          String(a[def.sort.key] ?? '￿').localeCompare(String(b[def.sort.key] ?? '￿'), undefined, {
            numeric: true,
          }) * dir || String(a[def.titleKey]).localeCompare(String(b[def.titleKey])),
      );
  }, [items, q, def]);
  const stats = summarize(def.id, items ?? []);
  const listFields = def.fields.filter((f) => f.list);

  const remove = async (item: Item) => {
    await del(`${def.path}/${item.id}`);
    await refreshAll(qc);
    const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = item;
    void _i;
    void _c;
    void _u;
    toast(`Deleted ${item[def.titleKey]}`, {
      actionLabel: 'Undo',
      onAction: async () => {
        await post(def.path, rest);
        await refreshAll(qc);
      },
    });
  };
  const inline = async (item: Item, key: string, value: string) => {
    await patch(`${def.path}/${item.id}`, { [key]: value || null });
    await refreshAll(qc);
  };

  return (
    <>
      <PageHead
        title={def.label}
        sub={def.description}
        actions={
          <button className="btn primary" onClick={() => setEditing({})}>
            <Icon name="plus" size={16} /> Add
          </button>
        }
      />
      {stats.length > 0 && (
        <div
          className="grid"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}
        >
          {stats.map((s) => (
            <div className="card" key={s.label}>
              <div className="muted small">{s.label}</div>
              <div className="grade-big" style={{ fontSize: '1.7rem' }}>
                <Sens>{s.value}</Sens>
              </div>
            </div>
          ))}
        </div>
      )}
      {(items?.length ?? 0) > 3 && (
        <input
          className="input"
          style={{ maxWidth: 320 }}
          placeholder="Filter…"
          aria-label={`Filter ${def.label}`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      )}
      {isLoading ? (
        <Skeleton h={160} />
      ) : sorted.length === 0 ? (
        <Empty
          icon={def.icon}
          title={q ? 'No matches' : `No ${def.label.toLowerCase()} yet`}
          action={
            !q && (
              <button className="btn primary" onClick={() => setEditing({})}>
                Add one
              </button>
            )
          }
        >
          {q ? 'Try a different filter.' : def.empty}
        </Empty>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Table, scrollable">
          <table className="t">
            <thead>
              <tr>
                {listFields.map((f) => (
                  <th
                    key={f.key}
                    className={f.type === 'number' || f.type === 'money' ? 'num' : ''}
                  >
                    {f.label}
                  </th>
                ))}
                {def.id === 'reading' && <th>Progress</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((it) => (
                <tr key={it.id}>
                  {listFields.map((f, i) => (
                    <td
                      key={f.key}
                      className={f.type === 'number' || f.type === 'money' ? 'num' : ''}
                    >
                      {i === 0 ? (
                        <button
                          className="btn ghost sm"
                          style={{ padding: 0, fontWeight: 600, color: 'var(--text)' }}
                          onClick={() => setEditing({ id: it.id })}
                        >
                          {it[f.key]}
                        </button>
                      ) : f.inline && f.options ? (
                        <select
                          className="select sm"
                          style={{ width: 'auto' }}
                          aria-label={`${f.label} of ${it[def.titleKey]}`}
                          value={it[f.key] ?? ''}
                          onChange={(e) => void inline(it, f.key, e.target.value)}
                        >
                          {f.options.map(([k, l]) => (
                            <option key={k} value={k}>
                              {l}
                            </option>
                          ))}
                        </select>
                      ) : (
                        cell(f, it, byClass)
                      )}
                    </td>
                  ))}
                  {def.id === 'reading' && (
                    <td style={{ minWidth: 120 }}>
                      <div
                        className="meter"
                        role="progressbar"
                        aria-label={`Progress in ${it.title}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={
                          it.totalPages
                            ? Math.min(100, Math.round(((it.pagesRead ?? 0) / it.totalPages) * 100))
                            : 0
                        }
                      >
                        <i
                          style={{
                            width: `${it.totalPages ? Math.min(100, ((it.pagesRead ?? 0) / it.totalPages) * 100) : 0}%`,
                          }}
                        />
                      </div>
                    </td>
                  )}
                  <td className="actions">
                    <button
                      className="btn ghost icon sm"
                      aria-label={`Edit ${it[def.titleKey]}`}
                      onClick={() => setEditing({ id: it.id })}
                    >
                      <Icon name="edit" size={15} />
                    </button>
                    <button
                      className="btn ghost icon sm"
                      aria-label={`Delete ${it[def.titleKey]}`}
                      onClick={() => void remove(it)}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ModuleDialog
        def={def}
        classes={classes}
        item={editing?.id ? items?.find((i) => i.id === editing.id) : undefined}
        open={!!editing}
        onClose={() => setEditing(null)}
      />
    </>
  );
}

export function ModuleDialog({
  def,
  classes,
  item,
  initial,
  open,
  onClose,
}: {
  def: ModuleDef;
  classes: ClassEntity[];
  item?: Item;
  /** Values to start a new item with (for example the class it is being added from). */
  initial?: Record<string, unknown>;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState(() => blankForm(def.fields));
  const [err, setErr] = useState('');
  useEffect(() => {
    if (open) {
      setForm(
        item ? toForm(def.fields, item) : { ...blankForm(def.fields), ...(initial as object) },
      );
      setErr('');
    }
  }, [open, item?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v as never }));
  const submit = async () => {
    const r = toPayload(def.fields, form);
    if (!r.ok) return setErr(r.error);
    try {
      if (item) await patch(`${def.path}/${item.id}`, r.body);
      else await post(def.path, r.body);
      await refreshAll(qc);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${item ? 'Edit' : 'New'} ${def.label.toLowerCase()}`}
      width={600}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void submit()}>
            {item ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      <div
        className="dlg-body"
        onKeyDown={(e) => {
          if (
            e.key === 'Enter' &&
            e.target instanceof HTMLInputElement &&
            e.target.type !== 'checkbox'
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
          {def.fields
            .filter((f) => f.type !== 'textarea' && f.type !== 'checklist')
            .map((f) => (
              <FieldWrap key={f.key} label={f.label + (f.required ? ' *' : '')} hint={f.hint}>
                {f.type === 'select' ? (
                  <select
                    className="select"
                    value={String(form[f.key] ?? '')}
                    onChange={(e) => set(f.key, e.target.value)}
                  >
                    {(f.options ?? []).map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                ) : f.type === 'class' ? (
                  <select
                    className="select"
                    value={String(form[f.key] ?? '')}
                    onChange={(e) => set(f.key, e.target.value)}
                  >
                    <option value="">—</option>
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                ) : f.type === 'classes' ? (
                  <ClassesPicker
                    classes={classes}
                    value={String(form[f.key] ?? '')}
                    onChange={(v) => set(f.key, v)}
                  />
                ) : (
                  <input
                    className={`input ${f.type === 'number' || f.type === 'money' ? 'num' : ''}`}
                    type={f.type === 'date' ? 'date' : 'text'}
                    inputMode={f.type === 'number' || f.type === 'money' ? 'decimal' : undefined}
                    value={String(form[f.key] ?? '')}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                )}
              </FieldWrap>
            ))}
        </div>
        {def.fields
          .filter((f) => f.type === 'checklist')
          .map((f) => (
            <div className="stack tight" key={f.key}>
              <span className="label">{f.label}</span>
              {(form[f.key] as { text: string; done: boolean }[]).map((c, i) => (
                <div className="row tight" key={i}>
                  <input
                    type="checkbox"
                    aria-label={`Done: ${c.text || 'item'}`}
                    checked={c.done}
                    onChange={(e) =>
                      set(
                        f.key,
                        (form[f.key] as { text: string; done: boolean }[]).map((x, j) =>
                          j === i ? { ...x, done: e.target.checked } : x,
                        ),
                      )
                    }
                  />
                  <input
                    className="input sm grow"
                    aria-label={`Checklist item ${i + 1}`}
                    value={c.text}
                    onChange={(e) =>
                      set(
                        f.key,
                        (form[f.key] as { text: string; done: boolean }[]).map((x, j) =>
                          j === i ? { ...x, text: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <button
                    className="btn ghost icon sm"
                    aria-label="Remove item"
                    onClick={() =>
                      set(
                        f.key,
                        (form[f.key] as unknown[]).filter((_, j) => j !== i),
                      )
                    }
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))}
              <button
                className="btn sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={() =>
                  set(f.key, [...(form[f.key] as unknown[]), { text: '', done: false }])
                }
              >
                + Add item
              </button>
            </div>
          ))}
        {def.fields
          .filter((f) => f.type === 'textarea')
          .map((f) => (
            <FieldWrap key={f.key} label={f.label}>
              <textarea
                className="textarea"
                value={String(form[f.key] ?? '')}
                onChange={(e) => set(f.key, e.target.value)}
              />
            </FieldWrap>
          ))}
      </div>
    </Dialog>
  );
}

function ClassesPicker({
  classes,
  value,
  onChange,
}: {
  classes: ClassEntity[];
  value: string;
  onChange: (v: string) => void;
}) {
  const ids = value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const toggle = (id: string) =>
    onChange((ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]).join(', '));
  return (
    <div className="row tight" role="group" aria-label="Classes">
      {classes.length === 0 ? (
        <span className="muted small">No classes yet</span>
      ) : (
        classes.map((c) => (
          <button
            type="button"
            key={c.id}
            className={`badge ${ids.includes(c.id) ? 'accent' : ''}`}
            style={{ border: 0, cursor: 'pointer' }}
            aria-pressed={ids.includes(c.id)}
            onClick={() => toggle(c.id)}
          >
            {c.code ?? c.name}
          </button>
        ))
      )}
    </div>
  );
}

export { MODULES };
