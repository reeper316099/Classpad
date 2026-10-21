import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../lib/api.js';
import { useDialogs } from '../lib/dialogs.js';
import { useClasses } from '../lib/hooks.js';
import { useUi } from '../lib/store.js';
import type { SearchHit } from '../lib/types.js';
import { Icon, type IconName } from './Icon.js';

interface Cmd {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: IconName;
  run: () => void;
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPalette);
  const ui = useUi();
  const nav = useNavigate();
  const dialogs = useDialogs();
  const { data: classes = [] } = useClasses();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setQ('');
      setSel(0);
      setTimeout(() => input.current?.focus(), 0);
    }
    if (!open && d.open) d.close();
  }, [open]);

  const go = (path: string) => () => nav(path);
  const base: Cmd[] = useMemo(
    () => [
      { id: 'p-dash', group: 'Go to', label: 'Dashboard', icon: 'home', run: go('/') },
      { id: 'p-classes', group: 'Go to', label: 'Classes', icon: 'classes', run: go('/classes') },
      {
        id: 'p-asg',
        group: 'Go to',
        label: 'Assignments',
        icon: 'assignments',
        hint: 'A',
        run: go('/assignments'),
      },
      {
        id: 'p-grades',
        group: 'Go to',
        label: 'Grades',
        icon: 'grades',
        hint: 'G',
        run: go('/grades'),
      },
      { id: 'p-gpa', group: 'Go to', label: 'GPA', icon: 'gpa', run: go('/gpa') },
      {
        id: 'p-import',
        group: 'Go to',
        label: 'Import & export',
        icon: 'import',
        run: go('/import'),
      },
      {
        id: 'p-settings',
        group: 'Go to',
        label: 'Settings',
        icon: 'settings',
        run: go('/settings'),
      },
      {
        id: 'a-asg',
        group: 'Create',
        label: 'New assignment',
        icon: 'plus',
        hint: 'A',
        run: () => dialogs.openAssignment(),
      },
      {
        id: 'a-task',
        group: 'Create',
        label: 'New task',
        icon: 'plus',
        hint: 'T',
        run: () => dialogs.openTask(),
      },
      {
        id: 'a-note',
        group: 'Create',
        label: 'New note',
        icon: 'plus',
        hint: 'N',
        run: () => dialogs.openNote(),
      },
      { id: 'p-notes', group: 'Go to', label: 'Notes', icon: 'notes', run: go('/notes') },
      { id: 'p-planner', group: 'Go to', label: 'Planner', icon: 'planner', run: go('/planner') },
      {
        id: 'p-tasks',
        group: 'Go to',
        label: 'Tasks',
        icon: 'check',
        run: go('/planner?tab=tasks'),
      },
      { id: 'p-study', group: 'Go to', label: 'Study timer', icon: 'study', run: go('/study') },
      {
        id: 'a-class',
        group: 'Create',
        label: 'New class',
        icon: 'plus',
        run: () => dialogs.openClass(),
      },
      {
        id: 'a-sem',
        group: 'Create',
        label: 'New semester',
        icon: 'plus',
        run: () => dialogs.openSemester(),
      },
      {
        id: 't-theme',
        group: 'Appearance',
        label: 'Cycle theme (system → light → dark)',
        icon: 'sun',
        run: () =>
          ui.set({
            theme: ui.theme === 'system' ? 'light' : ui.theme === 'light' ? 'dark' : 'system',
          }),
      },
      {
        id: 't-hide',
        group: 'Appearance',
        label: ui.hideGrades ? 'Show grades' : 'Hide grades (screen sharing)',
        icon: ui.hideGrades ? 'eye' : 'eye-off',
        run: () => ui.set({ hideGrades: !ui.hideGrades }),
      },
      {
        id: 't-help',
        group: 'Help',
        label: 'Keyboard shortcuts',
        icon: 'info',
        hint: '?',
        run: () => ui.setHelp(true),
      },
      ...classes.map((c): Cmd => ({
        id: `c-${c.id}`,
        group: 'Classes',
        label: c.name,
        hint: c.code,
        icon: 'classes',
        run: go(`/classes/${c.id}`),
      })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [classes, ui.theme, ui.hideGrades],
  );

  const term = q.trim().toLowerCase();
  const { data: hits = [] } = useQuery({
    queryKey: ['palette-search', term],
    enabled: open && term.length >= 2,
    queryFn: async () =>
      (await get<{ hits: SearchHit[] }>(`/search?q=${encodeURIComponent(term)}&limit=8`)).hits,
  });
  const results: Cmd[] = useMemo(() => {
    const cmds = term
      ? base.filter(
          (c) => c.label.toLowerCase().includes(term) || c.group.toLowerCase().includes(term),
        )
      : base.filter((c) => c.group !== 'Classes');
    const found = hits.map((h): Cmd => ({
      id: `h-${h.id}`,
      group: 'Results',
      label: h.title,
      hint: h.kind,
      icon: h.kind === 'note' ? 'notes' : 'assignments',
      run: () =>
        h.kind === 'assignment'
          ? dialogs.openAssignment({ id: h.id })
          : h.kind === 'note'
            ? nav('/notes')
            : nav('/assignments'),
    }));
    return [...cmds, ...found];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, term, hits]);

  useEffect(() => setSel(0), [term]);
  const pick = (c: Cmd | undefined) => {
    if (!c) return;
    setOpen(false);
    setTimeout(c.run, 0);
  };

  let lastGroup = '';
  return (
    <dialog
      ref={ref}
      className="dlg palette"
      aria-label="Command palette"
      onClose={() => setOpen(false)}
      onCancel={() => setOpen(false)}
      onClick={(e) => {
        if (e.target === ref.current) setOpen(false);
      }}
    >
      <input
        ref={input}
        className="palette-input"
        placeholder="Type a command or search…"
        value={q}
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={results[sel] ? `po-${results[sel]!.id}` : undefined}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(s + 1, results.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(s - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(results[sel]);
          }
        }}
      />
      <div className="palette-list" id="palette-list" role="listbox">
        {results.length === 0 && <div className="empty">No matches</div>}
        {results.map((c, i) => {
          const header =
            c.group !== lastGroup ? (
              <div className="palette-group" key={`g-${c.group}-${i}`}>
                {c.group}
              </div>
            ) : null;
          lastGroup = c.group;
          return (
            <div key={c.id} style={{ display: 'contents' }}>
              {header}
              <button
                id={`po-${c.id}`}
                role="option"
                aria-selected={i === sel}
                className="palette-item"
                onMouseMove={() => setSel(i)}
                onClick={() => pick(c)}
              >
                <Icon name={c.icon} /> <span>{c.label}</span>
                {c.hint && (
                  <span className="hint">{c.hint.length === 1 ? <kbd>{c.hint}</kbd> : c.hint}</span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </dialog>
  );
}
