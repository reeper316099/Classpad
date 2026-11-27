import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/base.css';
import './styles/components.css';
import './styles/markdown.css';
import './styles/editor.css';
import './styles/blockeditor.css';
import { loadPrefs, onPrefsLoaded } from './lib/prefs.js';
import { applyAppearance, useUi } from './lib/store.js';

// Preferences live in the data folder. Load them before the first render so the app opens the
// way it was left. While locked this fails; LockGate loads them again after unlocking.
onPrefsLoaded(() => {
  void useUi.persist.rehydrate();
});
void loadPrefs().then((ok) => {
  if (!ok) void useUi.persist.rehydrate(); // locked or offline: fall back to this browser's copy
  applyAppearance(useUi.getState());
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
