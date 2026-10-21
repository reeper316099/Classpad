import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { post, patch } from '../lib/api.js';
import { MODULES } from '../lib/modules.js';
import { useUi } from '../lib/store.js';
import { Field } from './ui.js';
import { lockKey, useLockStatus, type LockStatus } from './LockGate.js';

const LABELS: Record<string, string> = {
  notes: 'Notes',
  journal: 'Journal',
  contacts: 'Contacts',
  flashcards: 'Flashcards',
  budget: 'Budget',
  jobs: 'Jobs & internships',
  admissions: 'Admissions',
  activities: 'Activities',
  grades: 'Assignments and grades',
  study: 'Study sessions',
};

export function ModulesSettings() {
  const ui = useUi();
  return (
    <section className="card stack">
      <h2>Modules</h2>
      <p className="muted small">
        Turn on only what you use. Turning a module off hides it; your data is kept.
      </p>
      {MODULES.map((m) => (
        <label key={m.id} className="row" style={{ alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={ui.modules[m.id] ?? !!m.defaultOn}
            onChange={(e) => ui.set({ modules: { ...ui.modules, [m.id]: e.target.checked } })}
            style={{ marginTop: 4 }}
          />
          <span>
            <b>{m.label}</b>
            <span className="muted small" style={{ display: 'block' }}>
              {m.description}
            </span>
          </span>
        </label>
      ))}
    </section>
  );
}

export function PrivacySettings() {
  const ui = useUi();
  const qc = useQueryClient();
  const { data: s } = useLockStatus();
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [current, setCurrent] = useState('');
  const [sel, setSel] = useState<string[] | null>(null);
  const [ack, setAck] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const chosen = sel ?? (s.enabled ? s.encryptedCollections : ['notes', 'journal']);
  const done = (n: LockStatus, msg: string) => {
    qc.setQueryData(lockKey, n);
    setPass('');
    setAgain('');
    setCurrent('');
    setSel(null);
    setAck(false);
    setErr('');
    ui.toast(msg);
  };
  const run = async (fn: () => Promise<LockStatus>, msg: string) => {
    setBusy(true);
    setErr('');
    try {
      done(await fn(), msg);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const valid = pass.length >= 8 && pass === again && (s.enabled ? !!current : ack);

  return (
    <section className="card stack">
      <h2>Privacy & lock</h2>
      <p className="muted small">
        Classpad never uses the network. A passphrase locks the app window and can also encrypt
        chosen data on disk (AES-256-GCM, key from scrypt). Attachment files such as PDFs and images
        are <b>not</b> encrypted.
      </p>
      <label className="row">
        <input
          type="checkbox"
          checked={ui.hideJournal}
          onChange={(e) => ui.set({ hideJournal: e.target.checked })}
        />
        Blur journal entries until revealed
      </label>

      <fieldset className="stack tight" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label">Encrypt at rest</legend>
        <div className="row tight" style={{ flexWrap: 'wrap' }}>
          {s.available.map((k) => (
            <label key={k} className="row tight">
              <input
                type="checkbox"
                checked={chosen.includes(k)}
                onChange={(e) =>
                  setSel(e.target.checked ? [...chosen, k] : chosen.filter((x) => x !== k))
                }
              />
              {LABELS[k] ?? k}
            </label>
          ))}
        </div>
      </fieldset>

      {s.enabled && (
        <>
          <div className="row">
            <label className="row tight">
              Auto-lock after
              <select
                className="select sm"
                value={s.autoLockMinutes}
                onChange={(e) =>
                  void run(
                    () =>
                      patch<LockStatus>('/lock/settings', {
                        autoLockMinutes: Number(e.target.value),
                      }),
                    'Saved',
                  )
                }
              >
                {[0, 1, 5, 15, 30, 60].map((m) => (
                  <option key={m} value={m}>
                    {m === 0 ? 'never' : `${m} min`}
                  </option>
                ))}
              </select>
            </label>
            <label className="row tight">
              <input
                type="checkbox"
                checked={s.lockOnHide}
                onChange={(e) =>
                  void run(
                    () => patch<LockStatus>('/lock/settings', { lockOnHide: e.target.checked }),
                    'Saved',
                  )
                }
              />
              Lock when the window is hidden
            </label>
          </div>
          {sel && (
            <div className="row">
              <button
                className="btn"
                disabled={busy || !current}
                onClick={() =>
                  void run(
                    () =>
                      post<LockStatus>('/lock/collections', {
                        collections: chosen,
                        passphrase: current,
                      }),
                    'Encryption updated',
                  )
                }
              >
                Apply encryption choices
              </button>
              <span className="muted small">Needs your current passphrase below.</span>
            </div>
          )}
        </>
      )}

      <div className="form-grid">
        {s.enabled && (
          <Field label="Current passphrase">
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
        )}
        <Field label={s.enabled ? 'New passphrase (8+ characters)' : 'Passphrase (8+ characters)'}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
        </Field>
        <Field label="Repeat passphrase">
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
          />
        </Field>
      </div>
      {!s.enabled && (
        <label className="row" style={{ alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            style={{ marginTop: 4 }}
          />
          <span>
            I understand that if I lose this passphrase, encrypted data <b>cannot be recovered</b>{' '}
            by anyone.
          </span>
        </label>
      )}
      {err && (
        <div className="badge danger" role="alert">
          {err}
        </div>
      )}
      <div className="row">
        <button
          className="btn primary"
          disabled={!valid || busy}
          onClick={() =>
            void run(
              () =>
                post<LockStatus>('/lock/setup', {
                  passphrase: pass,
                  current: s.enabled ? current : undefined,
                  collections: chosen,
                }),
              s.enabled ? 'Passphrase changed' : 'Lock enabled',
            )
          }
        >
          {s.enabled ? 'Change passphrase' : 'Enable lock'}
        </button>
        {s.enabled && (
          <button
            className="btn danger"
            disabled={!current || busy}
            onClick={() => {
              if (confirm('Remove the lock and decrypt all data?'))
                void run(
                  () => post<LockStatus>('/lock/disable', { passphrase: current }),
                  'Lock removed',
                );
            }}
          >
            Remove lock…
          </button>
        )}
      </div>
    </section>
  );
}
