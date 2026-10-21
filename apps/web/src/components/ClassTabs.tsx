import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, lazy, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon.js';
import { Empty, Skeleton } from './ui.js';
import { get, patch } from '../lib/api.js';
import { attachmentBlobUrl, parseAttachmentLink, uploadForMarkdown } from '../lib/attachments.js';
import { useDialogs } from '../lib/dialogs.js';
import { refreshAll, useAssignments, useClasses, useNotes, useReadings } from '../lib/hooks.js';
import { MODULES, isOn } from '../lib/modules.js';
import { useUi } from '../lib/store.js';
import type { Attachment, ClassEntity, Page } from '../lib/types.js';
import { ModuleDialog } from '../pages/Module.js';

const PdfViewer = lazy(() => import('./PdfViewer.js').then((m) => ({ default: m.PdfViewer })));

const snippet = (md: string) =>
  md
    .replace(/<[^>]+>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`[\]$!-]|\(attachment:[^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);

export function ClassNotesTab({ c }: { c: ClassEntity }) {
  const dialogs = useDialogs();
  const { data: notes = [], isLoading } = useNotes();
  const mine = notes
    .filter((n) => n.classId === c.id)
    .sort((a, b) => (b.date ?? b.updatedAt).localeCompare(a.date ?? a.updatedAt));
  return (
    <section className="stack" aria-label="Class notes">
      <div className="row">
        <span className="muted">
          {mine.length} {mine.length === 1 ? 'note' : 'notes'} for this class
        </span>
        <span className="grow" />
        <Link className="btn" to="/notes">
          All notes
        </Link>
        <button className="btn primary" onClick={() => dialogs.openNote(c.id)}>
          <Icon name="plus" size={16} /> New note
        </button>
      </div>
      {isLoading ? (
        <Skeleton h={120} />
      ) : mine.length === 0 ? (
        <Empty
          icon="notes"
          title="No notes for this class yet"
          action={
            <button className="btn primary" onClick={() => dialogs.openNote(c.id)}>
              Write the first one
            </button>
          }
        >
          Notes you create here, or import with this class, show up in this list.
        </Empty>
      ) : (
        <div className="grid cards">
          {mine.map((n) => (
            <Link key={n.id} to={`/notes/${n.id}`} className="card hover stack tight note-card">
              <b>{n.title}</b>
              <span className="muted small">{snippet(n.markdown) || 'Empty note'}</span>
              <span className="row tight">
                {n.date && <span className="badge">{n.date.slice(0, 10)}</span>}
                {n.tags
                  .filter((t) => t !== 'imported')
                  .slice(0, 3)
                  .map((t) => (
                    <span key={t} className="badge accent">
                      {t}
                    </span>
                  ))}
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export function ClassReadingsTab({ c }: { c: ClassEntity }) {
  const ui = useUi();
  const { data: classes = [] } = useClasses();
  const { data: readings = [], isLoading } = useReadings();
  const [dlg, setDlg] = useState<{ id?: string } | null>(null);
  const def = MODULES.find((m) => m.id === 'reading')!;
  if (!isOn(ui.modules, 'reading'))
    return (
      <Empty
        icon="book"
        title="Reading is turned off"
        action={
          <button
            className="btn primary"
            onClick={() => ui.set({ modules: { ...ui.modules, reading: true } })}
          >
            Turn on Reading
          </button>
        }
      >
        Track books and articles for this class, with page progress.
      </Empty>
    );
  const mine = readings.filter((r) => r.classId === c.id);
  const item = mine.find((r) => r.id === dlg?.id);
  return (
    <section className="stack" aria-label="Class readings">
      <div className="row">
        <span className="muted">
          {mine.length} {mine.length === 1 ? 'reading' : 'readings'} for this class
        </span>
        <span className="grow" />
        <Link className="btn" to="/modules/reading">
          Reading tracker
        </Link>
        <button className="btn primary" onClick={() => setDlg({})}>
          <Icon name="plus" size={16} /> Add reading
        </button>
      </div>
      {isLoading ? (
        <Skeleton h={100} />
      ) : mine.length === 0 ? (
        <Empty icon="book" title="No readings for this class">
          Add a book or article to track your progress.
        </Empty>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Table, scrollable">
          <table className="t">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Progress</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((r) => {
                const pct = r.totalPages
                  ? Math.min(100, ((r.pagesRead ?? 0) / r.totalPages) * 100)
                  : 0;
                return (
                  <tr key={r.id}>
                    <td>
                      <button className="link-btn" onClick={() => setDlg({ id: r.id })}>
                        {r.title}
                      </button>
                    </td>
                    <td>
                      <span className={`badge ${r.status === 'complete' ? 'success' : ''}`}>
                        {r.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td>
                      {r.totalPages ? (
                        <span className="row tight">
                          <span
                            className="meter"
                            role="progressbar"
                            aria-label={`${r.title} progress`}
                            aria-valuemin={0}
                            aria-valuemax={r.totalPages}
                            aria-valuenow={r.pagesRead ?? 0}
                            style={{ width: 120 }}
                          >
                            <i style={{ width: `${pct}%` }} />
                          </span>
                          <span className="muted small">
                            {r.pagesRead ?? 0}/{r.totalPages}
                          </span>
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ModuleDialog
        def={def}
        classes={classes}
        item={item as never}
        initial={{ classId: c.id }}
        open={!!dlg}
        onClose={() => {
          setDlg(null);
        }}
      />
    </section>
  );
}

interface FileRow {
  att: Attachment;
  source: string;
}

export function ClassFilesTab({ c }: { c: ClassEntity }) {
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const { data: assignments = [] } = useAssignments();
  const { data: notes = [] } = useNotes();
  const { data: atts, isLoading } = useQuery({
    queryKey: ['attachments-all'],
    queryFn: async () => (await get<Page<Attachment>>('/attachments?limit=1000')).items,
  });
  const [pdf, setPdf] = useState<{ hash: string; name: string } | null>(null);
  const pick = useRef<HTMLInputElement>(null);

  const byId = new Map((atts ?? []).map((a) => [a.id, a]));
  const byHash = new Map((atts ?? []).map((a) => [a.hash, a]));
  const rows = new Map<string, FileRow>();
  const add = (a: Attachment | undefined, source: string) => {
    if (a && !rows.has(a.id)) rows.set(a.id, { att: a, source });
  };
  if (c.syllabusAttachmentId) add(byId.get(c.syllabusAttachmentId), 'Syllabus');
  for (const a of assignments.filter((x) => x.classId === c.id))
    for (const id of a.attachmentIds) add(byId.get(id), `Assignment: ${a.title}`);
  for (const n of notes.filter((x) => x.classId === c.id))
    for (const m of n.markdown.matchAll(/attachment:\/\/([0-9a-f]{64}\.[a-z0-9]{1,8})/gi)) {
      const link = parseAttachmentLink(`attachment://${m[1]}`);
      if (link) add(byHash.get(link.hash), `Note: ${n.title}`);
    }
  const list = [...rows.values()].sort((a, b) => a.att.filename.localeCompare(b.att.filename));

  const open = async (a: Attachment) => {
    if (/\.pdf$/i.test(a.filename) || a.mime === 'application/pdf')
      return setPdf({ hash: a.hash, name: a.filename });
    const url = await attachmentBlobUrl(a.hash);
    const el = document.createElement('a');
    el.href = url;
    el.download = a.filename;
    el.click();
  };
  const upload = async (f: File) => {
    try {
      await uploadForMarkdown(f);
      const found = (await get<Page<Attachment>>('/attachments?limit=1000')).items.find(
        (a) => a.filename === f.name,
      );
      if (!found) throw new Error('Upload failed');
      await patch(`/classes/${c.id}`, { syllabusAttachmentId: found.id });
      await refreshAll(qc);
      toast('Syllabus saved');
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <section className="stack" aria-label="Class files">
      <div className="row">
        <span className="muted">
          {list.length} {list.length === 1 ? 'file' : 'files'}: the syllabus plus files attached to
          this class's assignments and notes
        </span>
        <span className="grow" />
        <button className="btn" onClick={() => pick.current?.click()}>
          <Icon name="import" size={16} />{' '}
          {c.syllabusAttachmentId ? 'Replace syllabus' : 'Add syllabus'}
        </button>
        <input
          ref={pick}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }}
        />
      </div>
      {isLoading ? (
        <Skeleton h={100} />
      ) : list.length === 0 ? (
        <Empty icon="import" title="No files yet">
          Add the syllabus here, or attach files to this class's assignments and notes.
        </Empty>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Table, scrollable">
          <table className="t">
            <thead>
              <tr>
                <th>File</th>
                <th>From</th>
                <th className="num">Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map(({ att, source }) => (
                <tr key={att.id}>
                  <td>{att.filename}</td>
                  <td className="muted">{source}</td>
                  <td className="num">
                    {att.size < 1_000_000
                      ? `${Math.max(1, Math.round(att.size / 1024))} KB`
                      : `${(att.size / 1_048_576).toFixed(1)} MB`}
                  </td>
                  <td className="actions">
                    <button className="btn sm" onClick={() => void open(att)}>
                      {/\.pdf$/i.test(att.filename) ? 'View' : 'Download'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pdf && (
        <div className="card" style={{ height: 600 }}>
          <Suspense fallback={<Skeleton h={300} />}>
            <PdfViewer hash={pdf.hash} name={pdf.name} onClose={() => setPdf(null)} />
          </Suspense>
        </div>
      )}
    </section>
  );
}
