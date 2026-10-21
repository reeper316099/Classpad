import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Suspense,
  lazy,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon.js';
import { Markdown, slugHeading } from '../components/Markdown.js';
import { MarkdownEditor, type EditorHandle } from '../components/MarkdownEditor.js';
import { Empty, Skeleton, classStyle } from '../components/ui.js';
import { get, patch, post } from '../lib/api.js';
import { attachmentBlobUrl } from '../lib/attachments.js';
import { useDialogs } from '../lib/dialogs.js';
import { todayIso } from '../lib/format.js';
import {
  useAssignments,
  useClasses,
  useDeleteWithUndo,
  useNotes,
  useSelectedSemester,
} from '../lib/hooks.js';
import { outline, wordStats } from '../lib/notes.js';
import { useUi } from '../lib/store.js';
import type { ClassEntity, Note, SearchHit } from '../lib/types.js';

const PdfViewer = lazy(() =>
  import('../components/PdfViewer.js').then((m) => ({ default: m.PdfViewer })),
);
type Mode = 'edit' | 'split' | 'preview';
const readMode = (): Mode => {
  try {
    const v = localStorage.getItem('classpad-notes-view');
    return v === 'edit' || v === 'preview' ? v : 'split';
  } catch {
    return 'split';
  }
};

export function NotesPage() {
  const { id } = useParams();
  const dialogs = useDialogs();
  const { data: notes = [], isLoading } = useNotes();
  const note = notes.find((n) => n.id === id);
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle('focus-mode', focus);
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFocus(false);
    };
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('keydown', esc);
      document.documentElement.classList.remove('focus-mode');
    };
  }, [focus]);

  return (
    <div className={`notes-layout ${focus ? 'focus' : ''} ${note ? 'has-note' : ''}`}>
      {!focus && <NotesTree activeId={id} />}
      <section className="notes-main">
        {isLoading ? (
          <Skeleton h={300} />
        ) : note ? (
          <NoteEditor key={note.id} note={note} focus={focus} setFocus={setFocus} />
        ) : (
          <Empty
            icon="notes"
            title={notes.length ? 'Pick a note' : 'No notes yet'}
            action={
              <button className="btn primary" onClick={() => dialogs.openNote()}>
                <Icon name="plus" size={16} /> New note
              </button>
            }
          >
            {notes.length
              ? 'Choose one from the list, or press Ctrl/⌘ P to jump to a note by name.'
              : 'Notes are plain Markdown files on your computer, with math, code, images and [[links]] between notes.'}
          </Empty>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ tree
function NotesTree({ activeId }: { activeId?: string }) {
  const { data: notes = [] } = useNotes();
  const { data: classes = [] } = useClasses();
  const { semester } = useSelectedSemester();
  const dialogs = useDialogs();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const dq = useDebounced(q, 200);
  const { data: hits } = useQuery({
    queryKey: ['note-search', dq],
    enabled: dq.trim().length > 0,
    queryFn: async () =>
      (
        await get<{ hits: SearchHit[] }>(
          `/search?q=${encodeURIComponent(`type:note ${dq}`)}&limit=40`,
        )
      ).hits,
  });

  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes) for (const t of n.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [notes]);
  const visible = notes.filter((n) => !tag || n.tags.includes(tag));
  const classOf = new Map(classes.map((c) => [c.id, c]));
  const groups = useMemo(() => {
    const by = new Map<string, Note[]>();
    for (const n of visible) {
      const k = n.classId && classOf.has(n.classId) ? n.classId : '';
      by.set(k, [...(by.get(k) ?? []), n]);
    }
    const ordered = [...classes].sort(
      (a, b) =>
        Number(b.semesterId === semester?.id) - Number(a.semesterId === semester?.id) ||
        a.name.localeCompare(b.name),
    );
    return [
      ...ordered
        .filter((c) => by.has(c.id))
        .map((c) => ({ key: c.id, cls: c as ClassEntity | undefined, notes: by.get(c.id)! })),
      ...(by.has('') ? [{ key: '', cls: undefined, notes: by.get('')! }] : []),
    ].map((g) => ({
      ...g,
      notes: g.notes.sort(
        (a, b) =>
          (b.date ?? b.createdAt).localeCompare(a.date ?? a.createdAt) ||
          a.title.localeCompare(b.title),
      ),
    }));
  }, [visible, classes, semester?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (k: string) =>
    setClosed((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <aside className="notes-tree card" aria-label="Notes">
      <div className="row tight">
        <input
          className="input sm grow"
          placeholder="Search notes…"
          aria-label="Search notes"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          title="Try class:physics tag:exam1 due:week"
        />
        <button
          className="btn primary sm icon"
          aria-label="New note"
          onClick={() => dialogs.openNote()}
        >
          <Icon name="plus" size={16} />
        </button>
      </div>
      {tags.length > 0 && !q && (
        <div className="row tight" style={{ marginTop: 8 }}>
          {tags.slice(0, 10).map(([t, n]) => (
            <button
              key={t}
              className={`badge ${tag === t ? 'accent' : ''}`}
              style={{ border: 0, cursor: 'pointer' }}
              aria-pressed={tag === t}
              onClick={() => setTag(tag === t ? '' : t)}
            >
              #{t} {n}
            </button>
          ))}
        </div>
      )}
      <div className="tree-scroll">
        {q.trim() ? (
          <div className="stack tight" style={{ marginTop: 8 }}>
            {(hits ?? []).length === 0 && (
              <div className="muted small" style={{ padding: 8 }}>
                {hits ? 'No matches' : 'Searching…'}
              </div>
            )}
            {(hits ?? []).map((h) => (
              <button
                key={h.id}
                className={`tree-item ${h.id === activeId ? 'active' : ''}`}
                onClick={() => nav(`/notes/${h.id}`)}
              >
                <span>{h.title}</span>
                {h.snippet && <span className="muted small snippet">{h.snippet}</span>}
              </button>
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div className="muted small" style={{ padding: 12 }}>
            No notes{tag ? ` tagged #${tag}` : ' yet'}.
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.key || 'unfiled'} className="tree-group" style={classStyle(g.cls?.color)}>
              <div className="tree-head">
                <button
                  className="btn ghost sm grow"
                  style={{ justifyContent: 'flex-start' }}
                  aria-expanded={!closed.has(g.key)}
                  onClick={() => toggle(g.key)}
                >
                  <Icon
                    name="chevron"
                    size={14}
                    style={{
                      transform: closed.has(g.key) ? undefined : 'rotate(90deg)',
                      transition: 'transform .15s',
                    }}
                  />
                  <span className="dot" /> <b>{g.cls?.name ?? 'Unfiled'}</b>{' '}
                  <span className="muted">{g.notes.length}</span>
                </button>
                <button
                  className="btn ghost sm icon"
                  aria-label={`New note in ${g.cls?.name ?? 'Unfiled'}`}
                  onClick={() => dialogs.openNote(g.cls?.id)}
                >
                  <Icon name="plus" size={14} />
                </button>
              </div>
              {!closed.has(g.key) &&
                g.notes.map((n) => (
                  <button
                    key={n.id}
                    className={`tree-item ${n.id === activeId ? 'active' : ''}`}
                    onClick={() => nav(`/notes/${n.id}`)}
                    aria-current={n.id === activeId ? 'page' : undefined}
                  >
                    {n.title}
                  </button>
                ))}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

/** Width of an element, tracked with ResizeObserver. */
function useElementWidth<T extends HTMLElement>(): [number, React.RefObject<T>] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(1200);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [w, ref];
}

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

// ------------------------------------------------------------------ editor
interface Draft {
  title: string;
  markdown: string;
  tags: string[];
  classId: string;
  date: string;
  assignmentIds: string[];
}
const toDraft = (n: Note): Draft => ({
  title: n.title,
  markdown: n.markdown,
  tags: n.tags,
  classId: n.classId ?? '',
  date: n.date ?? '',
  assignmentIds: n.assignmentIds,
});

function NoteEditor({
  note,
  focus,
  setFocus,
}: {
  note: Note;
  focus: boolean;
  setFocus: (f: boolean) => void;
}) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const { data: notes = [] } = useNotes();
  const { data: classes = [] } = useClasses();
  const { data: assignments = [] } = useAssignments();
  const remove = useDeleteWithUndo<Note>('notes', (n) => `“${n.title}”`);
  const editor = useRef<EditorHandle>(null);
  const previewBox = useRef<HTMLDivElement>(null);
  const modules = useUi((s) => s.modules);
  const [draft, setDraft] = useState<Draft>(() => toDraft(note));
  const [status, setStatus] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved');
  const [conflict, setConflict] = useState(false);
  const [mode, setModeState] = useState<Mode>(readMode);
  const [pdf, setPdf] = useState<{ hash: string; name: string } | null>(null);
  const [workW, workRef] = useElementWidth<HTMLDivElement>();
  const [side, setSide] = useState(true);
  const [tagText, setTagText] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const base = useRef(note.updatedAt);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem('classpad-notes-view', m);
    } catch {
      /* optional */
    }
  };

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    if (!dirty.current) return;
    const d = draftRef.current;
    dirty.current = false;
    setStatus('saving');
    try {
      const saved = await patch<Note>(`/notes/${note.id}`, {
        title: d.title.trim() || 'Untitled',
        markdown: d.markdown,
        tags: d.tags,
        classId: d.classId || null,
        date: d.date || null,
        assignmentIds: d.assignmentIds,
      });
      base.current = saved.updatedAt;
      setStatus(dirty.current ? 'dirty' : 'saved');
      void qc.invalidateQueries({ queryKey: ['list', 'notes'] });
      void qc.invalidateQueries({ queryKey: ['backlinks'] });
      if (useUi.getState().modules.flashcards && d.markdown.includes('{{c'))
        void post(`/flashcards/sync-note/${note.id}`)
          .then(() => qc.invalidateQueries({ queryKey: ['decks'] }))
          .catch(() => null);
    } catch (e) {
      dirty.current = true;
      setStatus('error');
      useUi.getState().toast(`Could not save: ${(e as Error).message}`);
    }
  }, [note.id, qc]);
  const change = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }));
    dirty.current = true;
    setStatus('dirty');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 700);
  };

  useEffect(
    () => () => {
      void save();
    },
    [save],
  ); // flush when leaving the note
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') void save();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', () => void save());
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [save]);

  // changed on disk (hand edit, import, another window)
  useEffect(() => {
    if (note.updatedAt === base.current) return;
    if (dirty.current) setConflict(true);
    else {
      base.current = note.updatedAt;
      setDraft(toDraft(note));
    }
  }, [note]);

  const cls = classes.find((c) => c.id === draft.classId);
  const deferred = useDeferredValue(draft.markdown);
  const heads = useMemo(() => outline(draft.markdown), [draft.markdown]);
  const stats = useMemo(() => wordStats(draft.markdown), [draft.markdown]);
  const { data: backlinks = [] } = useQuery({
    queryKey: ['backlinks', note.id],
    queryFn: () =>
      get<{ id: string; title: string; snippet: string }[]>(`/notes/${note.id}/backlinks`),
  });
  const titles = useRef<string[]>([]);
  titles.current = notes.filter((n) => n.id !== note.id).map((n) => n.title);

  const openWiki = async (target: string, heading?: string) => {
    const r = await get<{ id: string } | null>(
      `/notes/resolve?title=${encodeURIComponent(target)}${draft.classId ? `&classId=${draft.classId}` : ''}`,
    );
    if (r) nav(`/notes/${r.id}${heading ? `?h=${slugHeading(heading)}` : ''}`);
    else
      useUi.getState().toast(`No note called “${target}” yet`, {
        actionLabel: 'Create it',
        onAction: async () => {
          const n = await post<Note>('/notes', {
            title: target,
            classId: draft.classId || null,
            date: todayIso(),
            markdown: `# ${target}\n\n`,
          });
          await qc.invalidateQueries({ queryKey: ['list', 'notes'] });
          nav(`/notes/${n.id}`);
        },
      });
  };
  const openAttachment = async (hash: string, ext: string, name: string) => {
    if (ext === 'pdf') {
      setPdf({ hash, name: name.endsWith('.pdf') ? name : `${name}.pdf` });
      return;
    }
    const url = await attachmentBlobUrl(hash);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
  };
  const scrollPreview = (slug: string) =>
    previewBox.current
      ?.querySelector(`#h-${CSS.escape(slug)}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  useEffect(() => {
    const h = sp.get('h');
    if (h) {
      const t = setTimeout(() => {
        scrollPreview(h);
        setSp({}, { replace: true });
      }, 250);
      return () => clearTimeout(t);
    }
  }, [sp]); // eslint-disable-line react-hooks/exhaustive-deps
  const gotoHeading = (h: { line: number; text: string }) => {
    if (effMode !== 'preview') editor.current?.goToLine(h.line);
    if (effMode !== 'edit') scrollPreview(slugHeading(h.text));
  };

  const addTag = () => {
    const t = tagText.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
    if (t && !draft.tags.includes(t)) change({ tags: [...draft.tags, t] });
    setTagText('');
  };
  const allTags = useMemo(() => [...new Set(notes.flatMap((n) => n.tags))], [notes]);
  const linked = draft.assignmentIds
    .map((id) => assignments.find((a) => a.id === id))
    .filter(Boolean);
  const linkable = assignments.filter(
    (a) => (!draft.classId || a.classId === draft.classId) && !draft.assignmentIds.includes(a.id),
  );
  // Only show what fits: split needs ~640px for the panes, the side panel ~260px more.
  const sideOk = side && !focus && workW >= 780;
  const paneW = workW - (sideOk ? 262 : 0);
  const effMode: Mode = mode === 'split' && (paneW < 640 || (pdf && paneW < 960)) ? 'edit' : mode;
  const showEditor = effMode !== 'preview';
  const showPreview = effMode !== 'edit';
  const cols = [showEditor, showPreview, !!pdf].filter(Boolean).length;

  const tb = (label: string, title: string, run: () => void) => (
    <button key={label} className="btn ghost sm tb" title={title} aria-label={title} onClick={run}>
      {label}
    </button>
  );
  return (
    <div className="note-editor" style={classStyle(cls?.color)}>
      <header className="note-head card">
        <div className="row">
          <button className="btn ghost sm back-btn" onClick={() => nav('/notes')}>
            ← Notes
          </button>
          <input
            className="note-title"
            aria-label="Note title"
            value={draft.title}
            onChange={(e) => change({ title: e.target.value })}
            placeholder="Untitled"
          />
          <span
            className={`badge ${status === 'error' ? 'danger' : status === 'saved' ? 'success' : ''}`}
            role="status"
          >
            {status === 'saved'
              ? 'Saved'
              : status === 'saving'
                ? 'Saving…'
                : status === 'error'
                  ? 'Not saved'
                  : 'Unsaved changes'}
          </span>
          <button
            className="btn ghost sm"
            onClick={() => setFocus(!focus)}
            aria-pressed={focus}
            title="Focus mode (Esc to exit)"
          >
            {focus ? 'Exit focus' : 'Focus'}
          </button>
          <button
            className="btn ghost sm danger icon"
            aria-label="Delete note"
            onClick={async () => {
              await remove(note);
              nav('/notes');
            }}
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
        {!focus && (
          <div className="row tight">
            <select
              className="select sm"
              style={{ width: 'auto' }}
              aria-label="Class"
              value={draft.classId}
              onChange={(e) => change({ classId: e.target.value })}
            >
              <option value="">Unfiled</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              type="date"
              className="input sm"
              style={{ width: 150 }}
              aria-label="Date"
              value={draft.date}
              onChange={(e) => change({ date: e.target.value })}
            />
            {draft.tags.map((t) => (
              <span key={t} className="badge accent">
                #{t}
                <button
                  className="btn ghost"
                  style={{ padding: 0, minHeight: 0, height: 'auto', marginLeft: 4 }}
                  aria-label={`Remove tag ${t}`}
                  onClick={() => change({ tags: draft.tags.filter((x) => x !== t) })}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              className="input sm"
              style={{ width: 130 }}
              list="all-tags"
              placeholder="Add tag…"
              aria-label="Add tag"
              value={tagText}
              onChange={(e) => setTagText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  addTag();
                }
              }}
              onBlur={addTag}
            />
            <datalist id="all-tags">
              {allTags.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
        )}
        {conflict && (
          <div className="badge warning row tight" role="alert">
            This note changed on disk while you were editing.{' '}
            <button
              className="btn sm"
              onClick={() => {
                base.current = note.updatedAt;
                dirty.current = false;
                setDraft(toDraft(note));
                setConflict(false);
                setStatus('saved');
              }}
            >
              Load disk version
            </button>
            <button
              className="btn sm"
              onClick={() => {
                base.current = note.updatedAt;
                setConflict(false);
                change({});
              }}
            >
              Keep mine
            </button>
          </div>
        )}
      </header>

      <div className="row note-toolbar">
        <div className="segmented" role="group" aria-label="View">
          {(['edit', 'split', 'preview'] as Mode[]).map((m) => (
            <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m[0]!.toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        {showEditor && (
          <div className="row tight">
            {tb('B', 'Bold (Ctrl/⌘ B)', () => editor.current?.wrap('**'))}
            {tb('I', 'Italic (Ctrl/⌘ I)', () => editor.current?.wrap('*'))}
            {tb('<>', 'Inline code', () => editor.current?.wrap('`'))}
            {tb('Σ', 'Inline math', () => editor.current?.wrap('$'))}
            {tb('☑', 'Task list', () => editor.current?.prefixLines('- [ ] '))}
            {tb('❝', 'Quote', () => editor.current?.prefixLines('> '))}
            {tb('[[ ]]', 'Link to a note', () => editor.current?.wrap('[[', ']]'))}
            {tb('{{c}}', 'Cloze deletion for flashcards', () => editor.current?.cloze())}
            {modules.flashcards &&
              tb('Card', 'Make a flashcard from the selected text (front = selection)', () => {
                const t = editor.current?.getSelection().trim();
                if (!t) return useUi.getState().toast('Select some text first');
                void post('/flashcards', {
                  front: t,
                  back: '',
                  noteId: note.id,
                  classId: draft.classId || null,
                }).then(() =>
                  useUi.getState().toast('Flashcard added. Add the back in Flashcards.'),
                );
              })}
          </div>
        )}
        <span className="grow" />
        <span className="muted small" aria-label="Word count">
          {effMode !== mode ? 'Window too narrow for split view · ' : ''}
          {stats.words} words · {stats.minutes ? `${stats.minutes} min read` : '—'}
        </span>
        {!focus && (
          <button className="btn ghost sm" aria-pressed={side} onClick={() => setSide(!side)}>
            Outline & links
          </button>
        )}
      </div>

      <div className="note-work" ref={workRef}>
        <div
          className="note-body"
          style={{ gridTemplateColumns: `repeat(${Math.max(cols, 1)}, minmax(0, 1fr))` }}
        >
          {showEditor && (
            <div className="note-pane card editor-pane">
              <MarkdownEditor
                ref={editor}
                value={draft.markdown}
                onChange={(v) => change({ markdown: v })}
                getTitles={() => titles.current}
              />
            </div>
          )}
          {showPreview && (
            <div className="note-pane card preview-pane" ref={previewBox}>
              {deferred.trim() ? (
                <Markdown
                  source={deferred}
                  onWikiLink={openWiki}
                  onOpenAttachment={openAttachment}
                />
              ) : (
                <p className="muted">Nothing to preview yet.</p>
              )}
            </div>
          )}
          {pdf && (
            <div className="note-pane card">
              <Suspense fallback={<Skeleton h={300} />}>
                <PdfViewer hash={pdf.hash} name={pdf.name} onClose={() => setPdf(null)} />
              </Suspense>
            </div>
          )}
        </div>
        {sideOk && (
          <aside className="note-side card" aria-label="Outline and links">
            <h3>Outline</h3>
            {heads.length === 0 ? (
              <p className="muted small">Add headings with # to build an outline.</p>
            ) : (
              <nav className="stack tight">
                {heads.map((h, i) => (
                  <button
                    key={i}
                    className="outline-item"
                    style={{ paddingLeft: 6 + (h.level - 1) * 12 }}
                    onClick={() => gotoHeading(h)}
                  >
                    {h.text}
                  </button>
                ))}
              </nav>
            )}
            <h3>
              Backlinks <span className="muted">{backlinks.length}</span>
            </h3>
            {backlinks.length === 0 ? (
              <p className="muted small">
                No notes link here yet. Use [[{draft.title || 'this note'}]] from another note.
              </p>
            ) : (
              <div className="stack tight">
                {backlinks.map((b) => (
                  <button key={b.id} className="tree-item" onClick={() => nav(`/notes/${b.id}`)}>
                    <span>{b.title}</span>
                    <span className="muted small snippet">{b.snippet}</span>
                  </button>
                ))}
              </div>
            )}
            <h3>Assignments</h3>
            <div className="stack tight">
              {linked.map((a) => (
                <div className="row tight" key={a!.id}>
                  <span className="grow small">{a!.title}</span>
                  <button
                    className="btn ghost sm icon"
                    aria-label={`Unlink ${a!.title}`}
                    onClick={() =>
                      change({ assignmentIds: draft.assignmentIds.filter((x) => x !== a!.id) })
                    }
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))}
              {linkable.length > 0 && (
                <select
                  className="select sm"
                  aria-label="Link an assignment"
                  value=""
                  onChange={(e) =>
                    e.target.value &&
                    change({ assignmentIds: [...draft.assignmentIds, e.target.value] })
                  }
                >
                  <option value="">Link an assignment…</option>
                  {linkable.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
