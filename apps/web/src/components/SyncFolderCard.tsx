import { useState } from 'react';
import { ApiError, post } from '../lib/api.js';
import { useUi } from '../lib/store.js';

const KEY = 'classpad.syncDir';
const read = () => {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
};

interface Result {
  folder: string;
  files: number;
  bytes: number;
  exportedAt: string;
}

/** One-way export into a folder that other apps (spreadsheets, calendars, notes apps) can read. */
export function SyncFolderCard() {
  const toast = useUi((s) => s.toast);
  const [dir, setDir] = useState(read);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<Result | null>(null);
  const [err, setErr] = useState('');

  const save = (v: string) => {
    setDir(v);
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* private mode: just don't remember it */
    }
  };
  const run = async (acknowledgePlaintext = false) => {
    setBusy(true);
    setErr('');
    try {
      const r = await post<Result>('/sync/export', { dir: dir.trim(), acknowledgePlaintext });
      setLast(r);
      toast(`Exported ${r.files} files`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NEEDS_ACK') {
        if (confirm(`${e.message}\n\nExport anyway?`)) return void (await run(true));
      } else setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack">
      <h2>Export to a folder</h2>
      <p className="muted small">
        Writes a “Classpad Export” folder with a backup, a gradebook spreadsheet, CSVs, calendar
        files and your notes as Markdown, for other apps to read. It is one-way: Classpad never
        reads it back, and re-running replaces the previous export. Nothing is sent over the
        network.
      </p>
      <div className="row">
        <input
          className="input grow"
          aria-label="Export folder"
          placeholder="/path/to/a/folder"
          value={dir}
          onChange={(e) => save(e.target.value)}
        />
        {window.classpad?.chooseFolder && (
          <button
            className="btn"
            onClick={() => void window.classpad!.chooseFolder().then((p) => p && save(p))}
          >
            Choose…
          </button>
        )}
        <button className="btn primary" disabled={!dir.trim() || busy} onClick={() => void run()}>
          {busy ? 'Exporting…' : 'Export now'}
        </button>
      </div>
      {err && (
        <div className="badge danger" role="alert">
          {err}
        </div>
      )}
      {last && (
        <p className="small" aria-live="polite">
          Last export: {last.files} files ({Math.max(1, Math.round(last.bytes / 1024))} KB) to{' '}
          <span className="mono">{last.folder}</span> at{' '}
          {new Date(last.exportedAt).toLocaleTimeString()}.
        </p>
      )}
    </section>
  );
}
