import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { classTokens } from '../lib/color.js';
import { pct } from '../lib/format.js';
import type { GradeResult, Step } from '../lib/types.js';
import { Icon } from './Icon.js';

export const classStyle = (color: string | undefined): CSSProperties =>
  classTokens(color ?? '#6366f1') as CSSProperties;

export function ClassChip({ name, color, code }: { name: string; color?: string; code?: string }) {
  return (
    <span className="badge cc" style={classStyle(color)} title={name}>
      <span className="dot" />
      {code ?? name}
    </span>
  );
}

/** Marks a value as sensitive so "hide grades" can blur it. */
export const Sens = ({ children }: { children: ReactNode }) => (
  <span className="sens">{children}</span>
);

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dlg"
      style={width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined}
      onClose={onClose}
      onCancel={onClose}
      aria-label={title}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <>
          <div className="dlg-head">
            <h2>{title}</h2>
            <button className="btn ghost icon" onClick={onClose} aria-label="Close">
              <Icon name="x" />
            </button>
          </div>
          {children}
          {footer && <div className="dlg-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon?: Parameters<typeof Icon>[0]['name'];
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <Icon name={icon} size={32} />}
      <h2>{title}</h2>
      {children && <p style={{ maxWidth: 440 }}>{children}</p>}
      {action}
    </div>
  );
}

export function PageHead({
  title,
  sub,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      <div className="row">{actions}</div>
    </div>
  );
}

export function GradePill({ grade, size }: { grade?: GradeResult | null; size?: 'sm' }) {
  const none = !grade || grade.status === 'none';
  return (
    <span
      className={`grade-letter ${size ?? ''} ${none ? 'none' : ''}`}
      title={none ? 'No graded work yet' : `${pct(grade!.percentRounded)}`}
    >
      <Sens>{none ? '–' : grade!.letter}</Sens>
    </span>
  );
}

/** "How this was calculated": renders the engine's structured breakdown. */
export function Breakdown({
  steps,
  title = 'How this was calculated',
}: {
  steps: Step[];
  title?: string;
}) {
  if (!steps.length) return null;
  return (
    <details className="stack tight" open>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{title}</summary>
      <div className="steps">
        {steps.map((s, i) => (
          <div className="step" key={i}>
            <div className="lbl">
              <span>{s.label}</span>
              {s.value !== undefined && <b className="sens">{s.value}</b>}
              {s.formula && <code className="muted sens">{s.formula}</code>}
            </div>
            {s.terms && s.terms.length > 0 && (
              <table className="sens">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Score</th>
                    <th>Weight</th>
                    <th>Product</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {s.terms.map((t, j) => (
                    <tr key={j}>
                      <td>{t.label}</td>
                      <td>{t.score}</td>
                      <td>{t.weight}</td>
                      <td>{t.product}</td>
                      <td className="muted">{t.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {s.note && <div className="note">{s.note}</div>}
          </div>
        ))}
      </div>
    </details>
  );
}

export function Toasts({
  toasts,
  dismiss,
}: {
  toasts: { id: number; message: string; actionLabel?: string; onAction?: () => void }[];
  dismiss: (id: number) => void;
}) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id}>
          <span>{t.message}</span>
          {t.actionLabel && (
            <button
              className="btn sm"
              onClick={() => {
                t.onAction?.();
                dismiss(t.id);
              }}
            >
              {t.actionLabel}
            </button>
          )}
          <button className="btn ghost sm icon" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export const Skeleton = ({ h = 20 }: { h?: number }) => (
  <div className="skeleton" style={{ height: h }} />
);
