// The desktop bridge: gives the page the same window.classpad the Electron preload did, backed by
// the Go shell (cmd/classpad/shell.go). Served at /classpad-bridge.js and loaded before the app.
import { Call, Events } from '/wails/runtime.js';

const cfg = __CONFIG__;
const call = (method, ...args) => Call.ByName(`${cfg.service}.${method}`, ...args);

window.classpad = {
  // same origin as the page; the token is per launch and never written to disk
  api: { baseUrl: '', token: cfg.token },
  platform: cfg.platform,
  version: cfg.version,
  dataDir: cfg.dataDir,
  /** Native menu → app actions. Returns an unsubscribe function. */
  onMenu: (cb) => Events.On('classpad:menu', (e) => cb(e.data)),
  /** Live updates (what the /events stream carries in a browser). */
  onEvent: (cb) => Events.On('classpad:event', (e) => cb(e.data)),
  openDataFolder: () => call('OpenDataFolder'),
  chooseFolder: async () => (await call('ChooseFolder')) || null,
  async paste() {
    const text = await call('ClipboardText');
    if (text) document.execCommand('insertText', false, text);
  },
  openReport: (hide = false) => call('OpenReport', hide === true),
  saveReportPdf: () => call('PrintReport'),
  /** Exports go through a native Save dialog: the web view cannot save downloads. */
  saveDownload: (path, filename) => call('SaveDownload', path, filename),
};

// Nothing navigates away from the app: https and mailto links open in the browser or mail app,
// anything else is ignored. (The page's Content-Security-Policy already blocks remote requests.)
const external = (href) => /^(https:|mailto:)/i.test(href);
const sameOrigin = (href) => {
  try {
    return new URL(href, location.href).origin === location.origin;
  } catch {
    return false;
  }
};
document.addEventListener(
  'click',
  (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!a || a.hasAttribute('download')) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || sameOrigin(href)) return;
    e.preventDefault();
    if (external(a.href)) void call('OpenURL', a.href);
  },
  true,
);
window.open = (url) => {
  const u = String(url ?? '');
  if (external(u)) void call('OpenURL', u);
  return null;
};

// CLASSPAD_SELFTEST=1: the app starts hidden, checks itself and quits (used by CI on every OS).
if (cfg.selfTest) {
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail) });
  const api = (method, path, body) =>
    fetch(`/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = async () => {
    check('bridge present', window.classpad?.api?.token === cfg.token);
    const health = await api('GET', '/health');
    check('API answers in-process', health.ok, health.status);
    const noToken = await fetch('/api/v1/health');
    check('API needs the token', noToken.status === 401, noToken.status);
    const event = new Promise((resolve) => {
      const off = window.classpad.onEvent((ev) => {
        if (ev?.collection === 'semesters') {
          off();
          resolve(ev);
        }
      });
      setTimeout(() => resolve(null), 5000);
    });
    const created = await api('POST', '/semesters', { name: 'Self-test term' });
    check('API writes', created.ok, created.status);
    const ev = await event;
    check('live updates arrive as app events', ev?.kind === 'created', JSON.stringify(ev));
    const sem = created.ok ? await created.json() : null;
    if (sem) await api('DELETE', `/semesters/${sem.id}`);
    for (let i = 0; i < 100 && !document.querySelector('#root')?.children.length; i++)
      await wait(100);
    check('the interface renders', document.querySelector('#root')?.children.length > 0);
    const wasm = await fetch('/editor/editor.wasm');
    check(
      'the editor core is served',
      wasm.ok,
      `${wasm.status} ${wasm.headers.get('content-type')}`,
    );
    const report = await fetch('/__classpad/report.html');
    check(
      'the grade report is served',
      report.ok && (await report.text()).includes('Grade report'),
    );
    const ok = checks.every((c) => c.ok);
    await call('SelfTestResult', ok, JSON.stringify({ ok, platform: cfg.platform, checks }));
  };
  window.addEventListener('load', () =>
    run().catch((e) => call('SelfTestResult', false, `self-test crashed: ${e?.stack ?? e}`)),
  );
}
