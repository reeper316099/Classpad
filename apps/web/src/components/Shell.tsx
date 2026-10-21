import { useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useDialogs } from '../lib/dialogs.js';
import { useSelectedSemester } from '../lib/hooks.js';
import { applyAppearance, useUi } from '../lib/store.js';
import { CommandPalette } from './CommandPalette.js';
import { Dialogs } from './Dialogs.js';
import { Icon, type IconName } from './Icon.js';
import { Dialog, Toasts } from './ui.js';

const NAV: [string, string, IconName][] = [
  ['/', 'Dashboard', 'home'],
  ['/classes', 'Classes', 'classes'],
  ['/assignments', 'Assignments', 'assignments'],
  ['/grades', 'Grades', 'grades'],
  ['/gpa', 'GPA', 'gpa'],
];
const SOON: [string, string, IconName][] = [
  ['/notes', 'Notes', 'notes'],
  ['/planner', 'Planner', 'planner'],
  ['/study', 'Study', 'study'],
];

const SHORTCUTS: [string, string][] = [
  ['Ctrl/⌘ K', 'Command palette'],
  ['/', 'Search'],
  ['A', 'New assignment'],
  ['G', 'Grades'],
  ['N', 'Notes (coming soon)'],
  ['T', 'Planner (coming soon)'],
  ['?', 'This help'],
  ['Esc', 'Close dialogs'],
];

export function Shell() {
  const ui = useUi();
  const nav = useNavigate();
  const dialogs = useDialogs();
  const { semester, semesters } = useSelectedSemester();

  useEffect(() => {
    applyAppearance(ui);
  }, [ui.theme, ui.accent, ui.density, ui.hideGrades]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ui.setPalette(!useUi.getState().paletteOpen);
        return;
      }
      if (meta || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"], dialog[open]')) return;
      const k = e.key;
      if (k === '/') {
        e.preventDefault();
        ui.setPalette(true);
      } else if (k === '?') ui.setHelp(true);
      else if (k.toLowerCase() === 'a') {
        e.preventDefault();
        dialogs.openAssignment();
      } else if (k.toLowerCase() === 'g') nav('/grades');
      else if (k.toLowerCase() === 'n') nav('/notes');
      else if (k.toLowerCase() === 't') nav('/planner');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const nextTheme = ui.theme === 'system' ? 'light' : ui.theme === 'light' ? 'dark' : 'system';
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="sparkle" size={16} />
          </span>
          Classpad
        </div>
        <nav className="nav" aria-label="Main">
          {NAV.map(([to, label, icon]) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => (isActive ? 'active' : '')}
            >
              <Icon name={icon} />
              {label}
            </NavLink>
          ))}
          <div className="nav-section">Coming soon</div>
          {SOON.map(([to, label, icon]) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>
              <Icon name={icon} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot nav">
          <NavLink to="/import" className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon name="import" />
            Import & export
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon name="settings" />
            Settings
          </NavLink>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button
            className="search-btn"
            onClick={() => ui.setPalette(true)}
            aria-label="Open command palette"
          >
            <Icon name="search" />{' '}
            <span className="grow" style={{ textAlign: 'left' }}>
              Search or run a command
            </span>{' '}
            <kbd>⌘K</kbd>
          </button>
          <span className="grow" />
          {semesters.length > 0 && (
            <select
              className="select sm"
              style={{ width: 'auto' }}
              aria-label="Semester"
              value={semester?.id ?? ''}
              onChange={(e) => ui.set({ semesterId: e.target.value })}
            >
              {semesters.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          <button
            className="btn ghost icon"
            onClick={() => ui.set({ hideGrades: !ui.hideGrades })}
            aria-pressed={ui.hideGrades}
            aria-label={ui.hideGrades ? 'Show grades' : 'Hide grades'}
            title="Hide grades (screen sharing)"
          >
            <Icon name={ui.hideGrades ? 'eye-off' : 'eye'} />
          </button>
          <button
            className="btn ghost icon"
            onClick={() => ui.set({ theme: nextTheme })}
            aria-label={`Theme: ${ui.theme}. Switch to ${nextTheme}`}
            title={`Theme: ${ui.theme}`}
          >
            <Icon name={ui.theme === 'dark' ? 'moon' : 'sun'} />
          </button>
          <button className="btn primary" onClick={() => dialogs.openAssignment()}>
            <Icon name="plus" size={16} />
            New
          </button>
        </header>
        <main className="content" id="main">
          <Outlet />
        </main>
      </div>
      <CommandPalette />
      <Dialogs />
      <Dialog
        open={ui.helpOpen}
        onClose={() => ui.setHelp(false)}
        title="Keyboard shortcuts"
        width={460}
      >
        <div className="dlg-body">
          <dl className="kv">
            {SHORTCUTS.map(([k, d]) => [
              <dt key={k}>
                <kbd>{k}</kbd>
              </dt>,
              <dd key={d}>{d}</dd>,
            ])}
          </dl>
        </div>
      </Dialog>
      <Toasts toasts={ui.toasts} dismiss={ui.dismiss} />
    </div>
  );
}
