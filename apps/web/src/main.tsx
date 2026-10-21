import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/base.css';
import './styles/components.css';
import './styles/markdown.css';
import './styles/editor.css';
import { applyAppearance, useUi } from './lib/store.js';

applyAppearance(useUi.getState());
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
