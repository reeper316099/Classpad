import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post } from '../lib/api.js';
import { useDialogs } from '../lib/dialogs.js';
import { todayIso } from '../lib/format.js';
import { refreshAll, useClasses, useNotes, useSelectedSemester } from '../lib/hooks.js';
import { applyTemplate, fuzzy } from '../lib/notes.js';
import type { Note } from '../lib/types.js';
import { Dialog, Field } from './ui.js';

export interface NoteTemplate {
  id: string;
  name: string;
  markdown: string;
}
export const useTemplates = () =>
  useQuery({
    queryKey: ['note-templates'],
    queryFn: () => get<NoteTemplate[]>('/templates/notes'),
  });

export function NewNoteDialog() {
  const { note: st, close } = useDialogs();
  const { data: classes = [] } = useClasses();
  const { semester } = useSelectedSemester();
  const { data: templates = [] } = useTemplates();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [classId, setClassId] = useState('');
  const [tpl, setTpl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!st.open) return;
    setTitle('');
    setErr('');
    setTpl('');
    setClassId(st.classId ?? '');
  }, [st.open, st.classId]);
  const semClasses = classes.filter((c) => c.semesterId === semester?.id);

  const create = async () => {
    if (!title.trim()) return setErr('Give the note a title.');
    setBusy(true);
    try {
      const t = templates.find((x) => x.id === tpl);
      const className = classes.find((c) => c.id === classId)?.name;
      const markdown = t
        ? applyTemplate(t.markdown, { title: title.trim(), date: todayIso(), className })
        : '';
      const n = await post<Note>('/notes', {
        title: title.trim(),
        classId: classId || null,
        date: todayIso(),
        markdown,
        tags: [],
        ...(t ? { template: t.id } : {}),
      });
      await refreshAll(qc);
      close();
      nav(`/notes/${n.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={st.open}
      onClose={close}
      title="New note"
      width={520}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={create} disabled={busy}>
            Create note
          </button>
        </>
      }
    >
      <form
        className="dlg-body"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        {err && (
          <div className="badge danger" role="alert">
            {err}
          </div>
        )}
        <Field label="Title" htmlFor="n-title">
          <input
            id="n-title"
            className="input"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Lecture 4: Entropy"
          />
        </Field>
        <div className="form-grid">
          <Field label="Class">
            <select className="select" value={classId} onChange={(e) => setClassId(e.target.value)}>
              <option value="">Unfiled</option>
              {semClasses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              {classes
                .filter((c) => c.semesterId !== semester?.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} (other semester)
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Start from">
            <select className="select" value={tpl} onChange={(e) => setTpl(e.target.value)}>
              <option value="">Blank note</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </form>
    </Dialog>
  );
}

/** Ctrl/⌘+P: jump to any note by (fuzzy) title. */
export function QuickOpen() {
  const { quickOpen: open, setQuickOpen } = useDialogs();
  const { data: notes = [] } = useNotes();
  const { data: classes = [] } = useClasses();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setQ('');
      setSel(0);
      setTimeout(() => input.current?.focus(), 0);
    }
    if (!open && d.open) d.close();
  }, [open]);
  const cname = useMemo(() => new Map(classes.map((c) => [c.id, c.code ?? c.name])), [classes]);
  const results = useMemo(
    () =>
      notes
        .map((n) => ({ n, s: fuzzy(q, n.title) }))
        .filter((x): x is { n: Note; s: number } => x.s !== null)
        .sort((a, b) => b.s - a.s || b.n.updatedAt.localeCompare(a.n.updatedAt))
        .slice(0, 30)
        .map((x) => x.n),
    [notes, q],
  );
  useEffect(() => setSel(0), [q]);
  const go = (n?: Note) => {
    if (!n) return;
    setQuickOpen(false);
    nav(`/notes/${n.id}`);
  };
  return (
    <dialog
      ref={ref}
      className="dlg palette"
      aria-label="Open note"
      onClose={() => setQuickOpen(false)}
      onCancel={() => setQuickOpen(false)}
      onClick={(e) => {
        if (e.target === ref.current) setQuickOpen(false);
      }}
    >
      <input
        ref={input}
        className="palette-input"
        placeholder="Open note…"
        value={q}
        role="combobox"
        aria-expanded="true"
        aria-controls="qo-list"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(s + 1, results.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(s - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            go(results[sel]);
          }
        }}
      />
      <div className="palette-list" id="qo-list" role="listbox">
        {results.length === 0 && (
          <div className="empty">{notes.length ? 'No matching notes' : 'No notes yet'}</div>
        )}
        {results.map((n, i) => (
          <button
            key={n.id}
            role="option"
            aria-selected={i === sel}
            className="palette-item"
            onMouseMove={() => setSel(i)}
            onClick={() => go(n)}
          >
            <span>{n.title}</span>
            <span className="hint">{n.classId ? cname.get(n.classId) : 'Unfiled'}</span>
          </button>
        ))}
      </div>
    </dialog>
  );
}
