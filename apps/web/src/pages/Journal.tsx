import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Icon } from '../components/Icon.js';
import { Markdown } from '../components/Markdown.js';
import { Dialog, Empty, Field, PageHead, Skeleton } from '../components/ui.js';
import { del, get, patch, post } from '../lib/api.js';
import { todayIso } from '../lib/format.js';
import { refreshAll } from '../lib/hooks.js';
import { isOn } from '../lib/modules.js';
import { useUi } from '../lib/store.js';
import type { Page } from '../lib/types.js';
import { ModuleOff } from './Module.js';
import { MODULES } from '../lib/modules.js';

const MOODS = [
  'happy',
  'energetic',
  'sad',
  'focused',
  'tired',
  'anxious',
  'neutral',
  'angry',
  'frustrated',
  'excited',
];
interface Entry {
  id: string;
  date: string;
  title: string;
  mood: string[];
  markdown: string;
}

export function JournalPage() {
  const ui = useUi();
  const qc = useQueryClient();
  const def = MODULES.find((m) => m.id === 'journal')!;
  const { data: items, isLoading } = useQuery({
    queryKey: ['module', 'journal'],
    queryFn: async () => (await get<Page<Entry>>('/journal?limit=1000&sort=date&order=desc')).items,
  });
  const [editing, setEditing] = useState<{ id?: string } | null>(null);
  const groups = useMemo(() => {
    const m = new Map<string, Entry[]>();
    for (const e of items ?? [])
      m.set(e.date.slice(0, 7), [...(m.get(e.date.slice(0, 7)) ?? []), e]);
    return [...m];
  }, [items]);
  if (!isOn(ui.modules, 'journal')) return <ModuleOff def={def} />;
  const hidden = ui.hideJournal;

  return (
    <>
      <PageHead
        title="Journal"
        sub="Private by default: entries are blurred until you reveal them."
        actions={
          <>
            <button
              className="btn"
              aria-pressed={!hidden}
              onClick={() => ui.set({ hideJournal: !hidden })}
            >
              <Icon name={hidden ? 'eye' : 'eye-off'} size={16} />{' '}
              {hidden ? 'Reveal entries' : 'Hide entries'}
            </button>
            <button className="btn primary" onClick={() => setEditing({})}>
              <Icon name="plus" size={16} /> New entry
            </button>
          </>
        }
      />
      {isLoading ? (
        <Skeleton h={160} />
      ) : groups.length === 0 ? (
        <Empty
          icon="edit"
          title="No entries yet"
          action={
            <button className="btn primary" onClick={() => setEditing({})}>
              Write the first one
            </button>
          }
        >
          {def.empty}
        </Empty>
      ) : (
        groups.map(([month, list]) => (
          <section key={month} className="stack tight">
            <h2>
              {new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, {
                month: 'long',
                year: 'numeric',
              })}
            </h2>
            <div className="grid cards">
              {list.map((e) => (
                <button
                  key={e.id}
                  className="card hover option-card"
                  onClick={() => setEditing({ id: e.id })}
                  aria-label={`Open entry from ${e.date}`}
                >
                  <div className="row">
                    <b>
                      {new Date(`${e.date}T00:00:00`).toLocaleDateString(undefined, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </b>
                    {e.mood.map((m) => (
                      <span key={m} className="badge accent">
                        {m}
                      </span>
                    ))}
                  </div>
                  <div className="sens-j">
                    <div style={{ fontWeight: 600 }}>{e.title || 'Untitled'}</div>
                    <div className="muted small" style={{ whiteSpace: 'pre-wrap' }}>
                      {e.markdown.slice(0, 160)}
                      {e.markdown.length > 160 ? '…' : ''}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))
      )}
      <EntryDialog
        entry={editing?.id ? items?.find((i) => i.id === editing.id) : undefined}
        open={!!editing}
        onClose={() => setEditing(null)}
        onSaved={() => refreshAll(qc)}
      />
    </>
  );
}

function EntryDialog({
  entry,
  open,
  onClose,
  onSaved,
}: {
  entry?: Entry;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const [f, setF] = useState({ date: todayIso(), title: '', mood: [] as string[], markdown: '' });
  const [preview, setPreview] = useState(false);
  const [err, setErr] = useState('');
  const toast = useUi((s) => s.toast);
  useEffect(() => {
    if (open) {
      setF(
        entry
          ? { date: entry.date, title: entry.title, mood: entry.mood, markdown: entry.markdown }
          : { date: todayIso(), title: '', mood: [], markdown: '' },
      );
      setPreview(false);
      setErr('');
    }
  }, [open, entry?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    if (!f.date) return setErr('Pick a date.');
    try {
      if (entry) await patch(`/journal/${entry.id}`, f);
      else await post('/journal', f);
      await onSaved();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const remove = async () => {
    if (!entry || !confirm('Delete this journal entry?')) return;
    const { id: _i, ...rest } = entry;
    void _i;
    await del(`/journal/${entry.id}`);
    await onSaved();
    onClose();
    toast('Entry deleted', {
      actionLabel: 'Undo',
      onAction: async () => {
        await post('/journal', rest);
        await onSaved();
      },
    });
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={entry ? 'Journal entry' : 'New journal entry'}
      width={700}
      footer={
        <>
          {entry && (
            <button
              className="btn danger"
              style={{ marginRight: 'auto' }}
              onClick={() => void remove()}
            >
              Delete…
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
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
        <div className="form-grid">
          <Field label="Date">
            <input
              type="date"
              className="input"
              value={f.date}
              onChange={(e) => setF({ ...f, date: e.target.value })}
            />
          </Field>
          <Field label="Title">
            <input
              className="input"
              value={f.title}
              onChange={(e) => setF({ ...f, title: e.target.value })}
            />
          </Field>
        </div>
        <div className="stack tight">
          <span className="label">Mood</span>
          <div className="row tight" role="group" aria-label="Mood">
            {MOODS.map((m) => (
              <button
                type="button"
                key={m}
                className={`badge ${f.mood.includes(m) ? 'accent' : ''}`}
                style={{ border: 0, cursor: 'pointer' }}
                aria-pressed={f.mood.includes(m)}
                onClick={() =>
                  setF({
                    ...f,
                    mood: f.mood.includes(m) ? f.mood.filter((x) => x !== m) : [...f.mood, m],
                  })
                }
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <span className="label">Entry</span>
          <span className="grow" />
          <div className="segmented" role="group" aria-label="Editor mode">
            <button aria-pressed={!preview} onClick={() => setPreview(false)}>
              Write
            </button>
            <button aria-pressed={preview} onClick={() => setPreview(true)}>
              Preview
            </button>
          </div>
        </div>
        {preview ? (
          <div className="card" style={{ minHeight: 200 }}>
            <Markdown source={f.markdown || '*Nothing yet*'} />
          </div>
        ) : (
          <textarea
            className="textarea"
            style={{ minHeight: 240 }}
            aria-label="Entry text"
            value={f.markdown}
            onChange={(e) => setF({ ...f, markdown: e.target.value })}
            placeholder="Markdown works here, including $math$."
          />
        )}
      </div>
    </Dialog>
  );
}
export const JournalRedirect = () => <Navigate to="/journal" replace />;
