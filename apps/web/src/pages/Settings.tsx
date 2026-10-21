import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../components/Icon.js';
import { ModulesSettings, PrivacySettings } from '../components/PrivacySettings.js';
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
      <ModulesSettings />
      <PrivacySettings />
      <section className="card stack">
        <h2>Calendar & time</h2>
        <div className="row">
          <span className="label" style={{ width: 120 }}>
            Week starts on
          </span>
          <div className="segmented" role="group" aria-label="Week starts on">
            {(['mon', 'sun'] as const).map((d) => (
              <button
                key={d}
                aria-pressed={ui.weekStart === d}
                onClick={() => ui.set({ weekStart: d })}
              >
                {d === 'mon' ? 'Monday' : 'Sunday'}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <span className="label" style={{ width: 120 }}>
            Time format
          </span>
          <div className="segmented" role="group" aria-label="Time format">
            {[true, false].map((h) => (
              <button
                key={String(h)}
                aria-pressed={ui.hour12 === h}
                onClick={() => ui.set({ hour12: h })}
              >
                {h ? '12-hour' : '24-hour'}
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="card stack">
        <h2>Reminders</h2>
        <p className="muted small">
          Desktop notifications for deadlines and dated tasks, generated on this computer. Nothing
          is sent anywhere.
        </p>
        <div className="row">
          {[
            [1440, '1 day before'],
            [60, '1 hour before'],
            [15, '15 minutes before'],
          ].map(([m, label]) => (
            <label key={m} className="check">
              <input
                type="checkbox"
                checked={ui.notifyLeads.includes(m as number)}
                onChange={(e) =>
                  ui.set({
                    notifyLeads: e.target.checked
                      ? [...ui.notifyLeads, m as number]
                      : ui.notifyLeads.filter((x) => x !== m),
                  })
                }
              />{' '}
              {label}
            </label>
          ))}
        </div>
        <div className="row">
          <span className="muted small">
            Permission:{' '}
            {typeof Notification === 'undefined' ? 'not supported here' : Notification.permission}
          </span>
          {typeof Notification !== 'undefined' && Notification.permission !== 'granted' && (
            <button
              className="btn sm"
              onClick={async () => {
                await Notification.requestPermission();
                ui.set({});
              }}
            >
              Allow notifications
            </button>
          )}
          {typeof Notification !== 'undefined' && Notification.permission === 'granted' && (
            <button
              className="btn sm"
              onClick={() => new Notification('Classpad', { body: 'Reminders are working.' })}
            >
              Send a test
            </button>
          )}
          {ui.notifyLeads.length > 0 &&
            typeof Notification !== 'undefined' &&
            Notification.permission !== 'granted' && (
              <span className="muted small">
                Without permission you will see in-app messages instead.
              </span>
            )}
        </div>
      </section>
      <section className="card stack">
        <h2>Pomodoro timer</h2>
        <div className="form-grid">
          {(
            [
              ['focusMin', 'Focus (min)'],
              ['shortMin', 'Short break (min)'],
              ['longMin', 'Long break (min)'],
              ['longEvery', 'Long break every'],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="field">
              <span className="label">{label}</span>
              <input
                className="input num"
                type="number"
                min={1}
                max={k === 'longEvery' ? 12 : 180}
                value={ui.pomodoro[k]}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (n >= 1) ui.set({ pomodoro: { ...ui.pomodoro, [k]: n } });
                }}
              />
            </label>
          ))}
        </div>
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
        {window.classpad && (
          <div className="row">
            <span className="muted small mono" title="Data folder">
              {window.classpad.dataDir}
            </span>
            <button className="btn sm" onClick={() => void window.classpad!.openDataFolder()}>
              Show in folder
            </button>
          </div>
        )}
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
