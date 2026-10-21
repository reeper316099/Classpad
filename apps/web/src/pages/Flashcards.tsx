import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Markdown } from '../components/Markdown.js';
import { Dialog, Empty, Field, PageHead, Skeleton } from '../components/ui.js';
import { get, post } from '../lib/api.js';
import { refreshAll, useClasses, useNotes } from '../lib/hooks.js';
import { isOn, MODULES } from '../lib/modules.js';
import { useUi } from '../lib/store.js';
import { ModuleOff } from './Module.js';

interface Card {
  id: string;
  front: string;
  back: string;
  classId?: string;
  noteId?: string;
  srs: { reps: number; lapses: number; dueAt: string; intervalDays: number };
}
interface Queue {
  cards: Card[];
  counts: { due: number; new: number; total: number };
}
interface Deck {
  classId: string | null;
  total: number;
  due: number;
  new: number;
}
const RATINGS = [
  ['again', 'Again', '1'],
  ['hard', 'Hard', '2'],
  ['good', 'Good', '3'],
  ['easy', 'Easy', '4'],
] as const;

export function FlashcardsPage() {
  const ui = useUi();
  const qc = useQueryClient();
  const { data: classes = [] } = useClasses();
  const { data: notes = [] } = useNotes();
  const [session, setSession] = useState<{ classId?: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const { data: decks, isLoading } = useQuery({
    queryKey: ['decks'],
    queryFn: () => get<Deck[]>('/study/decks'),
  });
  const { data: queue } = useQuery({
    queryKey: ['queue-all'],
    queryFn: () => get<Queue>('/study/queue?limit=1'),
  });
  const def = MODULES.find((m) => m.id === 'flashcards')!;
  if (!isOn(ui.modules, 'flashcards')) return <ModuleOff def={def} />;
  const name = (id: string | null) =>
    id ? (classes.find((c) => c.id === id)?.name ?? 'Class') : 'No class';

  const sync = async () => {
    let made = 0,
      removed = 0;
    for (const n of notes.filter((x) => x.markdown.includes('{{c'))) {
      const r = await post<{ created: number; removed: number }>(`/flashcards/sync-note/${n.id}`);
      made += r.created;
      removed += r.removed;
    }
    await refreshAll(qc);
    ui.toast(
      made || removed
        ? `Cards updated: ${made} new, ${removed} removed`
        : 'Cards are already up to date',
    );
  };

  if (session)
    return (
      <Review
        classId={session.classId}
        onDone={() => {
          setSession(null);
          void refreshAll(qc);
        }}
      />
    );
  const due = queue?.counts.due ?? 0,
    fresh = queue?.counts.new ?? 0;
  return (
    <>
      <PageHead
        title="Flashcards"
        sub="Spaced repetition: cards you find hard come back sooner."
        actions={
          <>
            <button className="btn" onClick={() => void sync()}>
              Sync from notes
            </button>
            <button className="btn" onClick={() => setAdding(true)}>
              <Icon name="plus" size={16} /> Add card
            </button>
            <button
              className="btn primary"
              disabled={due + fresh === 0}
              onClick={() => setSession({})}
            >
              Review {due + fresh > 0 ? `(${Math.min(30, due + fresh)})` : ''}
            </button>
          </>
        }
      />
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <div className="card">
          <div className="muted small">Due now</div>
          <div className="grade-big">{due}</div>
        </div>
        <div className="card">
          <div className="muted small">New</div>
          <div className="grade-big">{fresh}</div>
        </div>
        <div className="card">
          <div className="muted small">Total cards</div>
          <div className="grade-big">{queue?.counts.total ?? 0}</div>
        </div>
      </div>
      {isLoading ? (
        <Skeleton h={120} />
      ) : (decks ?? []).length === 0 ? (
        <Empty
          icon="study"
          title="No cards yet"
          action={
            <button className="btn primary" onClick={() => setAdding(true)}>
              Add a card
            </button>
          }
        >
          Write <code>{'{{c1::a hidden term}}'}</code> in a note (the note editor has a cloze
          button), then press “Sync from notes”. Or add cards by hand.
        </Empty>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Table, scrollable">
          <table className="t">
            <thead>
              <tr>
                <th>Deck</th>
                <th className="num">Due</th>
                <th className="num">New</th>
                <th className="num">Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(decks ?? []).map((d) => (
                <tr key={d.classId ?? 'none'}>
                  <td>{name(d.classId)}</td>
                  <td className="num">{d.due}</td>
                  <td className="num">{d.new}</td>
                  <td className="num">{d.total}</td>
                  <td className="actions">
                    <button
                      className="btn sm"
                      disabled={d.due + d.new === 0}
                      onClick={() => setSession({ classId: d.classId ?? undefined })}
                    >
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AddCard open={adding} onClose={() => setAdding(false)} onSaved={() => refreshAll(qc)} />
    </>
  );
}

function Review({ classId, onDone }: { classId?: string; onDone: () => void }) {
  const [queue, setQueue] = useState<Card[] | null>(null);
  const [shown, setShown] = useState(false);
  const [tally, setTally] = useState({ again: 0, hard: 0, good: 0, easy: 0 });
  const [total, setTotal] = useState(0);
  useEffect(() => {
    get<Queue>(`/study/queue?limit=40${classId ? `&classId=${classId}` : ''}`).then((q) => {
      setQueue(q.cards);
      setTotal(q.cards.length);
    });
  }, [classId]);
  const card = queue?.[0];
  const answer = useCallback(
    async (rating: (typeof RATINGS)[number][0]) => {
      if (!card) return;
      await post('/study/answer', { cardId: card.id, rating });
      setTally((t) => ({ ...t, [rating]: t[rating] + 1 }));
      // "again" cards return at the end of this session; everything else is scheduled for later
      setQueue((q) => (q ? [...q.slice(1), ...(rating === 'again' ? [card] : [])] : q));
      setShown(false);
    },
    [card],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) return;
      if (e.key === 'Escape') onDone();
      else if (!shown && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        setShown(true);
      } else if (shown) {
        const r = RATINGS.find(([, , k]) => k === e.key);
        if (r) {
          e.preventDefault();
          void answer(r[0]);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, answer, onDone]);

  if (!queue) return <Skeleton h={300} />;
  const done = total - queue.length;
  return (
    <>
      <PageHead
        title="Review"
        sub={`${Math.min(done, total)} of ${total} done · Esc to stop`}
        actions={
          <button className="btn" onClick={onDone}>
            End session
          </button>
        }
      />
      <div
        className="meter"
        role="progressbar"
        aria-label="Session progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={Math.min(done, total)}
      >
        <i style={{ width: `${total ? (Math.min(done, total) / total) * 100 : 100}%` }} />
      </div>
      {!card ? (
        <Empty
          icon="check"
          title={total ? 'All done for now' : 'Nothing to review'}
          action={
            <button className="btn primary" onClick={onDone}>
              Back to decks
            </button>
          }
        >
          {total
            ? `Again ${tally.again} · Hard ${tally.hard} · Good ${tally.good} · Easy ${tally.easy}`
            : 'No cards are due.'}
        </Empty>
      ) : (
        <div
          className="card stack"
          style={{ maxWidth: 760, margin: '0 auto', width: '100%', minHeight: 260 }}
          aria-live="polite"
        >
          <div className="small muted">
            {card.srs.reps === 0 && card.srs.lapses === 0
              ? 'New card'
              : `Reviewed ${card.srs.reps}×`}
          </div>
          <div style={{ fontSize: '1.25rem' }}>
            <Markdown source={card.front} />
          </div>
          {shown ? (
            <>
              <hr
                style={{ border: 0, borderTop: '1px solid var(--border-strong)', width: '100%' }}
              />
              <div style={{ fontSize: '1.15rem' }}>
                <Markdown source={card.back || '*(no back)*'} />
              </div>
            </>
          ) : null}
          <div className="row" style={{ marginTop: 'auto' }}>
            {!shown ? (
              <button className="btn primary" onClick={() => setShown(true)}>
                Show answer <kbd>Space</kbd>
              </button>
            ) : (
              RATINGS.map(([k, label, key]) => (
                <button
                  key={k}
                  className={`btn ${k === 'good' ? 'primary' : ''}`}
                  onClick={() => void answer(k)}
                >
                  {label} <kbd>{key}</kbd>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}

function AddCard({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const { data: classes = [] } = useClasses();
  const [f, setF] = useState({ front: '', back: '', classId: '' });
  const [err, setErr] = useState('');
  useEffect(() => {
    if (open) {
      setF({ front: '', back: '', classId: '' });
      setErr('');
    }
  }, [open]);
  const save = async () => {
    if (!f.front.trim()) return setErr('The front of the card cannot be empty.');
    await post('/flashcards', {
      front: f.front.trim(),
      back: f.back.trim(),
      classId: f.classId || null,
    });
    await onSaved();
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New flashcard"
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Add card
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
        <Field label="Front">
          <textarea
            className="textarea"
            value={f.front}
            onChange={(e) => setF({ ...f, front: e.target.value })}
          />
        </Field>
        <Field label="Back">
          <textarea
            className="textarea"
            value={f.back}
            onChange={(e) => setF({ ...f, back: e.target.value })}
          />
        </Field>
        <Field label="Class">
          <select
            className="select"
            value={f.classId}
            onChange={(e) => setF({ ...f, classId: e.target.value })}
          >
            <option value="">—</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Dialog>
  );
}
