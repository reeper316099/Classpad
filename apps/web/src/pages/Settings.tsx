import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../components/Icon.js';
import { PageHead } from '../components/ui.js';
import { del, get } from '../lib/api.js';
import { ACCENTS } from '../lib/color.js';
import { refreshAll } from '../lib/hooks.js';
import { useUi } from '../lib/store.js';
import type { GradingScheme } from '../lib/types.js';

export function SettingsPage() {
  const ui = useUi();
  const qc = useQueryClient();
  const { data: about } = useQuery({
    queryKey: ['about'],
    queryFn: () => get<{ demoLoaded: boolean; counts: Record<string, number> }>('/about'),
  });
  const { data: schemes = [] } = useQuery({
    queryKey: ['schemes'],
    queryFn: () => get<GradingScheme[]>('/grading-schemes'),
  });
  return (
    <>
      <PageHead title="Settings" />
      <section className="card stack">
        <h2>Appearance</h2>
        <div className="row">
          <span className="label" style={{ width: 90 }}>
            Theme
          </span>
          <div className="segmented" role="group" aria-label="Theme">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <button key={t} aria-pressed={ui.theme === t} onClick={() => ui.set({ theme: t })}>
                {t[0]!.toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <span className="label" style={{ width: 90 }}>
            Density
          </span>
          <div className="segmented" role="group" aria-label="Density">
            {(['comfortable', 'compact'] as const).map((t) => (
              <button
                key={t}
                aria-pressed={ui.density === t}
                onClick={() => ui.set({ density: t })}
              >
                {t[0]!.toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <span className="label" style={{ width: 90 }}>
            Accent
          </span>
          <div className="swatches">
            {ACCENTS.map((a) => (
              <button
                key={a.hex}
                className="swatch"
                style={{ background: a.hex }}
                aria-label={a.name}
                aria-pressed={ui.accent === a.hex}
                onClick={() => ui.set({ accent: a.hex })}
              />
            ))}
            <input
              type="color"
              aria-label="Custom accent"
              value={ui.accent}
              onChange={(e) => ui.set({ accent: e.target.value })}
              style={{ width: 34, height: 30, border: 0, background: 'none' }}
            />
          </div>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={ui.hideGrades}
            onChange={(e) => ui.set({ hideGrades: e.target.checked })}
          />{' '}
          Hide grades (blur numbers for screen sharing)
        </label>
      </section>
      <section className="card stack">
        <h2>Grading schemes</h2>
        <p className="muted small">
          Each class picks one. “Assignment weights” matches a weighted-percent system normalized
          over graded work only.
        </p>
        {schemes.map((s) => (
          <div key={s.id} className="row">
            <b>{s.name}</b>
            <span className="badge">{s.mode.replace(/_/g, ' ')}</span>
            <span className="muted small">
              {s.scale.cutoffs
                .map((c) => `${c.letter} ≥ ${c.min}`)
                .slice(0, 4)
                .join(', ')}
              …
            </span>
          </div>
        ))}
      </section>
      <section className="card stack">
        <h2>Your data</h2>
        <p className="muted small">
          Stored as readable JSON and Markdown files in your app-data folder. No network, no
          accounts.{' '}
          {about &&
            `${about.counts.classes} classes · ${about.counts.assignments} assignments · ${about.counts.notes} notes.`}
        </p>
        {about?.demoLoaded && (
          <div className="row">
            <span>Demo data is loaded.</span>
            <button
              className="btn danger sm"
              onClick={async () => {
                if (!confirm('Remove the demo data? Your own data is not touched.')) return;
                await del('/demo');
                await refreshAll(qc);
                ui.toast('Demo data removed');
              }}
            >
              <Icon name="trash" size={14} /> Remove demo data
            </button>
          </div>
        )}
      </section>
    </>
  );
}
