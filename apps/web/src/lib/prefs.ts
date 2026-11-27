import type { StateStorage } from 'zustand/middleware';
import { api } from './api.js';

/**
 * Preferences (appearance, which modules are on, the chosen semester…) live in the data folder,
 * in config/settings.json under "prefs", not in the browser's localStorage. The desktop app's
 * page is served from a new port on every launch, and localStorage belongs to an origin
 * (scheme + host + port), so anything kept only there was forgotten each time the app opened.
 *
 * localStorage is still written as a mirror: it is the fallback when the server can't be read
 * (while the app is locked) and the source for moving old preferences over once.
 */
const SAVE_DELAY_MS = 300;

let settings: Record<string, unknown> = {};
let prefs: Record<string, string> = {};
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

const local = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  },
};

/** Keys that used to be kept only in localStorage; moved into the data folder on first load. */
export const LEGACY_KEYS = [
  'classpad-ui',
  'classpad-notes-source',
  'classpad.syncDir',
  'classpad-notified',
  'classpad-pomodoro',
];

/**
 * Read preferences from the server. Returns false when it can't (for example while locked); call
 * again after unlocking. Until it succeeds nothing is written to the server, so a locked or
 * offline start can never replace saved preferences with defaults.
 */
export async function loadPrefs(legacyKeys: string[] = LEGACY_KEYS): Promise<boolean> {
  try {
    settings = (await api<Record<string, unknown> | null>('GET', '/settings')) ?? {};
  } catch {
    return false;
  }
  const saved = settings.prefs;
  prefs =
    saved && typeof saved === 'object' && !Array.isArray(saved)
      ? Object.fromEntries(
          Object.entries(saved as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === 'string',
          ),
        )
      : {};
  // one-time move of preferences that were only in this browser profile
  let moved = false;
  for (const key of legacyKeys) {
    const v = local.get(key);
    if (!(key in prefs) && v !== null) {
      prefs[key] = v;
      moved = true;
    }
  }
  for (const [k, v] of Object.entries(prefs)) local.set(k, v);
  loaded = true;
  if (moved) save();
  listeners.forEach((l) => l());
  return true;
}

/** Called after preferences were (re)loaded from the server. */
export function onPrefsLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function save() {
  if (!loaded) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    settings = { ...settings, prefs: { ...prefs } };
    void api('PUT', '/settings', settings).catch(() => {
      /* locked or offline: kept in memory and localStorage, saved with the next change */
    });
  }, SAVE_DELAY_MS);
}

/** Write any pending change now (tests, page unload). */
export function flushPrefs() {
  if (saveTimer === undefined || !loaded) return;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  settings = { ...settings, prefs: { ...prefs } };
  void api('PUT', '/settings', settings).catch(() => undefined);
}

export function getPref(key: string): string | null {
  return loaded ? (prefs[key] ?? null) : local.get(key);
}

export function setPref(key: string, value: string | null) {
  if ((prefs[key] ?? null) === value && loaded) return;
  if (value === null) delete prefs[key];
  else prefs[key] = value;
  local.set(key, value);
  save();
}

/** Storage for zustand's persist middleware. */
export const prefStorage: StateStorage = {
  getItem: (name) => getPref(name),
  setItem: (name, value) => setPref(name, value),
  removeItem: (name) => setPref(name, null),
};

if (typeof window !== 'undefined') window.addEventListener('beforeunload', flushPrefs);
