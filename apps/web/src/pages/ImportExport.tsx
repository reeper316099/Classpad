import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { SyncFolderCard } from '../components/SyncFolderCard.js';
import { PageHead } from '../components/ui.js';
import { download, get, openInTab, post, postBinary } from '../lib/api.js';
import { refreshAll } from '../lib/hooks.js';
import { useUi } from '../lib/store.js';
import type { ImportSummary } from '../lib/types.js';

type Kind = 'notion' | 'markdown' | 'csv' | 'gradebook' | 'ics' | 'json';
const KINDS: [Kind, string, string][] = [
  ['notion', 'Notion export (.zip)', '.zip'],
  ['markdown', 'Markdown folder (.zip)', '.zip'],
  ['csv', 'CSV spreadsheet', '.csv'],
  ['gradebook', 'Gradebook CSV (LMS export)', '.csv'],
  ['ics', 'Calendar (.ics)', '.ics'],
  ['json', 'Classpad backup (.json)', '.json'],
];
const COLLECTIONS = ['assignments', 'classes', 'semesters', 'tasks', 'readings'];
const STRATEGIES: [string, string][] = [
  ['update_empty', 'Fill in blanks only (keeps my edits)'],
  ['skip', 'Skip anything already imported'],
  ['overwrite', 'Overwrite with imported values'],
  ['keep_both', 'Keep both (create copies)'],
];
interface Commit {
  importId: string;
  created: Record<string, number>;
  updated: Record<string, number>;
  attachments: number;
  templates: number;
  warnings: string[];
}
interface History {
  id: string;
  source: string;
  at: string;
  strategy: string;
  undoneAt?: string;
}

interface PluginInfo {
  id: string;
  name: string;
  description?: string;
}
interface PluginList {
  builtin: PluginInfo[];
  user: PluginInfo[];
  errors: { file: string; message: string }[];
  folder: string;
}

export function ImportExportPage() {
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const file = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<Kind>('notion');
  const [collection, setCollection] = useState('assignments');
  const [csvAs, setIcsAs] = useState<'tasks' | 'assignments'>('tasks');
  const [pluginId, setPluginId] = useState('gradebook-rows');
  const [className, setClassName] = useState('');
  const [strategy, setStrategy] = useState('update_empty');
  const [sum, setSum] = useState<ImportSummary | null>(null);
  const [done, setDone] = useState<Commit | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: hist = [] } = useQuery({
    queryKey: ['import-history'],
    queryFn: () => get<History[]>('/import/history'),
  });

  const { data: plugins } = useQuery({
    queryKey: ['plugins'],
    queryFn: () => get<PluginList>('/plugins'),
    enabled: kind === 'gradebook',
  });
  const { data: classNames = [] } = useQuery({
    queryKey: ['class-names'],
    queryFn: async () =>
      (await get<{ items: { name: string }[] }>('/classes?limit=500')).items.map((c) => c.name),
    enabled: kind === 'gradebook',
  });

  const guard = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const preview = (f: File) =>
    guard(async () => {
      setDone(null);
      const isZip = kind === 'notion' || kind === 'markdown';
      if (isZip) setSum(await postBinary<ImportSummary>(`/import/preview?kind=${kind}`, f));
      else
        setSum(
          await post<ImportSummary>('/import/preview', {
            kind,
            ...(kind === 'gradebook'
              ? { kind: 'csv', pluginId, className: className.trim() || undefined }
              : {}),
            text: await f.text(),
            collection: kind === 'csv' ? collection : undefined,
            icsAs: kind === 'ics' ? csvAs : undefined,
          }),
        );
    });
  const commit = () =>
    guard(async () => {
      const r = await post<Commit>('/import/commit', { previewId: sum!.previewId, strategy });
      setDone(r);
      setSum(null);
      await refreshAll(qc);
    });
  const undo = (id: string) =>
    guard(async () => {
      await post(`/import/undo/${id}`);
      await refreshAll(qc);
      setDone(null);
      toast('Import undone');
    });
  const bad =
    sum?.validation.filter((v) => v.status === 'mismatch' || v.status === 'exported-only') ?? [];
  const grouped = Object.entries(
    (sum?.warnings ?? []).reduce<Record<string, string[]>>((a, w) => {
      (a[w.code] ??= []).push(w.message + (w.where ? ` (${w.where})` : ''));
      return a;
    }, {}),
  );

  return (
    <>
      <PageHead
        title="Import & export"
        sub="Nothing is written until you review the preview. Every import can be undone."
      />
      <section className="card stack">
        <h2>Import</h2>
        <div className="row">
          <select
            className="select"
            style={{ width: 'auto' }}
            aria-label="What to import"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as Kind);
              setSum(null);
            }}
          >
            {KINDS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          {kind === 'csv' && (
            <select
              className="select"
              style={{ width: 'auto' }}
              aria-label="Collection"
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
            >
              {COLLECTIONS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          )}
          {kind === 'csv' && (
            <button
              className="btn sm"
              onClick={() =>
                download(`/import/templates/${collection}`, `${collection}-template.csv`)
              }
            >
              Download template
            </button>
          )}
          {kind === 'gradebook' && (
            <>
              <select
                className="select"
                style={{ width: 'auto' }}
                aria-label="Gradebook format"
                value={pluginId}
                onChange={(e) => setPluginId(e.target.value)}
              >
                {[...(plugins?.builtin ?? []), ...(plugins?.user ?? [])].map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input
                className="input"
                style={{ width: 220 }}
                list="class-names"
                aria-label="Class for these assignments"
                placeholder="Class (if the file has none)"
                value={className}
                onChange={(e) => setClassName(e.target.value)}
              />
              <datalist id="class-names">
                {classNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </>
          )}
          {kind === 'ics' && (
            <select
              className="select"
              style={{ width: 'auto' }}
              aria-label="Import events as"
              value={csvAs}
              onChange={(e) => setIcsAs(e.target.value as 'tasks' | 'assignments')}
            >
              <option value="tasks">Events as tasks</option>
              <option value="assignments">Events as assignments</option>
            </select>
          )}
          {kind === 'gradebook' && !!plugins?.errors.length && (
            <span className="badge warning" role="status">
              {plugins.errors.length} plugin file(s) in <span className="mono">plugins/</span> could
              not be used: {plugins.errors[0]!.file}: {plugins.errors[0]!.message}
            </span>
          )}
          <input
            ref={file}
            type="file"
            hidden
            accept={KINDS.find(([k]) => k === kind)![2]}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void preview(f);
              e.target.value = '';
            }}
          />
          <button className="btn primary" disabled={busy} onClick={() => file.current?.click()}>
            <Icon name="import" size={16} /> Choose file…
          </button>
        </div>
        {kind === 'notion' && (
          <p className="muted small">
            In Notion: Settings → Export → Markdown & CSV (include subpages). Choose the .zip here.
            The file is read on this computer and never uploaded.
          </p>
        )}
      </section>

      {sum && (
        <section className="card stack" aria-live="polite">
          <h2>Preview</h2>
          <div className="row" style={{ gap: 20 }}>
            {Object.entries(sum.counts)
              .filter(([, n]) => n > 0)
              .map(([k, n]) => (
                <div key={k}>
                  <div className="grade-big" style={{ fontSize: '1.6rem' }}>
                    {n}
                  </div>
                  <div className="muted small">{k}</div>
                </div>
              ))}
          </div>
          {sum.validation.length > 0 && (
            <div className="stack tight">
              <h3>Grade check</h3>
              <p className="muted small">
                Classpad recomputed each class grade and compared it to the exported value.
              </p>
              {bad.length === 0 ? (
                <div className="badge success" style={{ alignSelf: 'flex-start' }}>
                  All {sum.validation.length} classes match (or have no graded work yet)
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Class</th>
                        <th>Exported</th>
                        <th>Recomputed</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bad.map((v) => (
                        <tr key={v.className}>
                          <td>{v.className}</td>
                          <td>{v.exported}</td>
                          <td>{v.recomputed}</td>
                          <td>
                            <span className="badge danger">
                              {v.status}
                              {v.diff ? ` (off by ${Number(v.diff).toFixed(2)})` : ''}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          {grouped.length > 0 && (
            <details>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                {sum.warnings.length} things to know
              </summary>
              <div className="stack tight" style={{ marginTop: 8 }}>
                {grouped.map(([code, msgs]) => (
                  <div key={code}>
                    <span className="badge warning">{code}</span>
                    <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
                      {msgs.slice(0, 8).map((m, i) => (
                        <li key={i} className="small">
                          {m}
                        </li>
                      ))}
                      {msgs.length > 8 && (
                        <li className="small muted">…and {msgs.length - 8} more</li>
                      )}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          )}
          {sum.skipped.length > 0 && (
            <div className="muted small">
              Not imported: {sum.skipped.map((s) => `${s.kind} (${s.count})`).join(', ')}.{' '}
              {sum.skipped[0]!.reason}.
            </div>
          )}
          <div className="row">
            <select
              className="select"
              style={{ width: 'auto' }}
              aria-label="If something already exists"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
            >
              {STRATEGIES.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <span className="grow" />
            <button className="btn" onClick={() => setSum(null)}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy} onClick={commit}>
              Import
            </button>
          </div>
        </section>
      )}

      {done && (
        <section className="card stack">
          <h2>Imported</h2>
          <div className="row">
            {Object.entries(done.created)
              .filter(([, n]) => n > 0)
              .map(([k, n]) => (
                <span key={k} className="badge success">
                  {n} {k} added
                </span>
              ))}
            {Object.entries(done.updated)
              .filter(([, n]) => n > 0)
              .map(([k, n]) => (
                <span key={k} className="badge accent">
                  {n} {k} updated
                </span>
              ))}
            {done.attachments > 0 && <span className="badge">{done.attachments} files</span>}
            {done.templates > 0 && <span className="badge">{done.templates} templates</span>}
          </div>
          {done.warnings.length > 0 && (
            <details>
              <summary style={{ cursor: 'pointer' }}>{done.warnings.length} notes</summary>
              <ul>
                {done.warnings.slice(0, 20).map((w, i) => (
                  <li key={i} className="small">
                    {w}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="row">
            <button className="btn" onClick={() => undo(done.importId)}>
              <Icon name="undo" size={16} /> Undo this import
            </button>
          </div>
        </section>
      )}

      <section className="card stack">
        <h2>Export</h2>
        <div className="row">
          {COLLECTIONS.map((c) => (
            <button
              key={c}
              className="btn sm"
              onClick={() => download(`/export/csv/${c}`, `${c}.csv`)}
            >
              {c}.csv
            </button>
          ))}
        </div>
        <div className="row">
          <button
            className="btn sm"
            onClick={() => download('/export/ics?kind=deadlines', 'deadlines.ics')}
          >
            Deadlines (.ics)
          </button>
          <button
            className="btn sm"
            onClick={() => download('/export/ics?kind=timetable', 'timetable.ics')}
          >
            Timetable (.ics)
          </button>
          <button
            className="btn sm"
            onClick={() => download('/export/markdown', 'classpad-notes.zip')}
          >
            Notes as Markdown (.zip)
          </button>
          <button
            className="btn sm"
            onClick={() => download('/export/json', 'classpad-backup.json')}
          >
            Full backup (.json)
          </button>
          <button className="btn sm" onClick={() => download('/export/gradebook', 'gradebook.csv')}>
            Gradebook (.csv)
          </button>
          <button className="btn sm primary" onClick={() => openInTab('/export/report')}>
            Printable grade report
          </button>
        </div>
      </section>

      <SyncFolderCard />

      {hist.length > 0 && (
        <section className="card stack tight">
          <h2>Past imports</h2>
          {hist.map((h) => (
            <div className="row" key={h.id}>
              <span>{new Date(h.at).toLocaleString()}</span>
              <span className="badge">{h.source}</span>
              <span className="muted small">{h.strategy}</span>
              <span className="grow" />
              {h.undoneAt ? (
                <span className="muted small">undone</span>
              ) : (
                <button className="btn sm" disabled={busy} onClick={() => undo(h.id)}>
                  Undo
                </button>
              )}
            </div>
          ))}
        </section>
      )}
    </>
  );
}
