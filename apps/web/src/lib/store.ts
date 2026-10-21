import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  paletteOpen: boolean;
  helpOpen: boolean;
  toasts: Toast[];
  set: (
    patch: Partial<Pick<UiState, 'theme' | 'accent' | 'density' | 'hideGrades' | 'semesterId'>>,
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
      }),
    },
  ),
);

/** Apply appearance settings to <html>. */
export function applyAppearance(
  s: Pick<UiState, 'theme' | 'accent' | 'density' | 'hideGrades'>,
  root: HTMLElement = document.documentElement,
) {
  root.dataset.theme = s.theme;
  root.dataset.density = s.density;
  root.style.setProperty('--accent', s.accent);
  root.classList.toggle('hide-grades', s.hideGrades);
}
