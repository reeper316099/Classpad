import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, get, post } from '../lib/api.js';
import { Icon } from './Icon.js';

export interface LockStatus {
  enabled: boolean;
  locked: boolean;
  encryptedCollections: string[];
  available: string[];
  autoLockMinutes: number;
  lockOnHide: boolean;
  retryAfterMs: number;
}
export const lockKey = ['lock'];
export const useLockStatus = () =>
  useQuery({ queryKey: lockKey, queryFn: () => get<LockStatus>('/lock/status'), staleTime: 5_000 });

/** Shows the passphrase screen while the app is locked and handles idle / hide auto-lock. */
export function LockGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data: s } = useLockStatus();
  const lockedRef = useRef(false);
  lockedRef.current = !!s?.locked;

  useEffect(() => {
    if (!s?.enabled || s.locked) return;
    const lockNow = () => {
      if (lockedRef.current) return;
      void post<LockStatus>('/lock/lock')
        .then((n) => qc.setQueryData(lockKey, n))
        .catch(() => qc.invalidateQueries({ queryKey: lockKey }));
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reset = () => {
      clearTimeout(timer);
      if (s.autoLockMinutes > 0) timer = setTimeout(lockNow, s.autoLockMinutes * 60_000);
    };
    const onHide = () => {
      if (s.lockOnHide && document.visibilityState === 'hidden') lockNow();
    };
    const evs = ['keydown', 'pointerdown', 'wheel'] as const;
    evs.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    document.addEventListener('visibilitychange', onHide);
    reset();
    return () => {
      clearTimeout(timer);
      evs.forEach((e) => window.removeEventListener(e, reset));
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [s?.enabled, s?.locked, s?.autoLockMinutes, s?.lockOnHide, qc]);

  if (s?.locked) return <LockScreen retryAfterMs={s.retryAfterMs} />;
  return <>{children}</>;
}

function LockScreen({ retryAfterMs }: { retryAfterMs: number }) {
  const qc = useQueryClient();
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(Math.ceil(retryAfterMs / 1000));
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pass || busy || wait > 0) return;
    setBusy(true);
    setErr('');
    try {
      const n = await post<LockStatus>('/lock/unlock', { passphrase: pass });
      setPass('');
      qc.setQueryData(lockKey, n);
      await qc.invalidateQueries();
    } catch (x) {
      const a = x as ApiError;
      setErr(a.message);
      if (a.status === 429)
        setWait(Math.ceil(((a.details as { retryAfterMs?: number })?.retryAfterMs ?? 5000) / 1000));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="lock-screen">
      <form className="card stack lock-card" onSubmit={(e) => void submit(e)}>
        <div className="brand-mark" aria-hidden="true">
          <Icon name="lock" size={18} />
        </div>
        <h1 style={{ fontSize: '1.25rem' }}>Classpad is locked</h1>
        <label className="field">
          <span className="label">Passphrase</span>
          <input
            className="input"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            aria-describedby="lock-err"
          />
        </label>
        <div
          id="lock-err"
          role="alert"
          className="small"
          style={{ color: 'var(--danger)', minHeight: '1.2em' }}
        >
          {wait > 0 ? `Too many attempts. Try again in ${wait}s.` : err}
        </div>
        <button className="btn primary" disabled={!pass || busy || wait > 0}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
        <p className="muted small">
          Your data stays on this computer. There is no way to reset a forgotten passphrase.
        </p>
      </form>
    </main>
  );
}
