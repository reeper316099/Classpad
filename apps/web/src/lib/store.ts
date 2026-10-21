import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { setHour12Default } from './format.js';
import { DEFAULT_POMODORO, type PomodoroConfig } from './pomodoro.js';

export type Theme = 'system' | 'light' | 'dark';
export type Density = 'comfortable' | 'compact';

export interface Toast {
  id: number;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface UiState {
  theme: Theme;
  accent: string;
  density: Density;
  hideGrades: boolean;
  semesterId: string | null;
  /** Which optional modules are switched on (the reading tracker is on by default). */
  modules: Record<string, boolean>;
  hideJournal: boolean;
  weekStart: 'mon' | 'sun';
  hour12: boolean;
  /** Minutes before a deadline at which to notify (empty = never). */
  notifyLeads: number[];
  pomodoro: PomodoroConfig;
  paletteOpen: boolean;
  helpOpen: boolean;
  toasts: Toast[];
  set: (
    patch: Partial<
      Pick<
        UiState,
        | 'theme'
        | 'accent'
        | 'density'
        | 'hideGrades'
        | 'semesterId'
        | 'weekStart'
        | 'hour12'
        | 'notifyLeads'
        | 'pomodoro'
        | 'modules'
        | 'hideJournal'
      >
    >,
  ) => void;
  setPalette: (open: boolean) => void;
  setHelp: (open: boolean) => void;
  toast: (
    message: string,
    opts?: { actionLabel?: string; onAction?: () => void; ms?: number },
  ) => void;
  dismiss: (id: number) => void;
}

let seq = 0;
export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      accent: '#6366f1',
      density: 'comfortable',
      hideGrades: false,
      semesterId: null,
      modules: { reading: true },
      hideJournal: true,
      weekStart: 'mon',
      hour12: true,
      notifyLeads: [],
      pomodoro: DEFAULT_POMODORO,
      paletteOpen: false,
      helpOpen: false,
      toasts: [],
      set: (patch) => set(patch),
      setPalette: (paletteOpen) => set({ paletteOpen }),
      setHelp: (helpOpen) => set({ helpOpen }),
      toast: (message, opts = {}) => {
        const id = ++seq;
        set({
          toasts: [
            ...get().toasts,
            { id, message, actionLabel: opts.actionLabel, onAction: opts.onAction },
          ],
        });
        setTimeout(() => get().dismiss(id), opts.ms ?? (opts.onAction ? 8000 : 3500));
      },
      dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
    }),
    {
      name: 'classpad-ui',
      partialize: (s) => ({
        theme: s.theme,
        accent: s.accent,
        density: s.density,
        hideGrades: s.hideGrades,
        semesterId: s.semesterId,
        modules: s.modules,
        hideJournal: s.hideJournal,
        weekStart: s.weekStart,
        hour12: s.hour12,
        notifyLeads: s.notifyLeads,
        pomodoro: s.pomodoro,
      }),
    },
  ),
);

/** Apply appearance settings to <html>. */
export function applyAppearance(
  s: Pick<UiState, 'theme' | 'accent' | 'density' | 'hideGrades' | 'hideJournal'>,
  root: HTMLElement = document.documentElement,
) {
  root.dataset.theme = s.theme;
  root.dataset.density = s.density;
  root.style.setProperty('--accent', s.accent);
  root.classList.toggle('hide-grades', s.hideGrades);
  root.classList.toggle('hide-journal', s.hideJournal);
}

setHour12Default(useUi.getState().hour12);
useUi.subscribe((s) => setHour12Default(s.hour12));
