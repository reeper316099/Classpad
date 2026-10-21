import { APP_NAME } from '@classpad/shared';
import { defaultDataDir, startServer } from '@classpad/server';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMenu } from './menu.js';
import { allowFile, lockDown, revokeFile } from './security.js';
import { WindowState } from './windowState.js';

app.setName(APP_NAME);
// The data directory is the app's userData folder; Chromium's own files live in a subfolder of it.
const dataDir = defaultDataDir();
app.setPath('userData', dataDir);
app.setPath('sessionData', path.join(dataDir, 'electron'));

type Server = Awaited<ReturnType<typeof startServer>>;
let server: Server | null = null;
let win: BrowserWindow | null = null;
let token = '';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

const trusted = (e: IpcMainEvent | IpcMainInvokeEvent) =>
  !!server &&
  (e.senderFrame?.url === `${server.url}/` || !!e.senderFrame?.url.startsWith(`${server.url}/`));

async function createWindow(): Promise<void> {
  const state = new WindowState(path.join(app.getPath('sessionData'), 'window-state.json'));
  const b = await state.load();
  win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: APP_NAME,
    backgroundColor: '#0d0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      devTools: !app.isPackaged,
    },
  });
  state.track(win);
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });
  await win.loadURL(`${server!.url}/`);
}

/** Fetch the printable report into a temp file (the app's API needs the token, so the page can't just load it). */
async function reportToTempFile(hide = false): Promise<string> {
  if (!server) throw new Error('not running');
  const res = await fetch(`${server.url}/api/v1/export/report${hide ? '?hide=1' : ''}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`report failed: ${res.status}`);
  const tmp = path.join(os.tmpdir(), `classpad-report-${randomBytes(6).toString('hex')}.html`);
  await fs.writeFile(tmp, await res.text());
  allowFile(tmp); // the lockdown blocks every other local file
  return tmp;
}

/** Show the printable grade report in its own window (no scripts, no preload; Ctrl/Cmd+P prints it). */
async function openReportWindow(hide = false): Promise<void> {
  const tmp = await reportToTempFile(hide);
  const w = new BrowserWindow({
    width: 920,
    height: 900,
    title: `${APP_NAME} grade report`,
    backgroundColor: '#ffffff',
    parent: win ?? undefined,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      devTools: !app.isPackaged,
    },
  });
  w.setMenuBarVisibility(false);
  w.on('closed', () => {
    revokeFile(tmp);
    void fs.rm(tmp, { force: true });
  });
  await w.loadFile(tmp);
}

/** Render the grade report to a PDF the user picks a location for. */
async function saveReportPdf(): Promise<{ saved: boolean; path?: string }> {
  if (!server) return { saved: false };
  const tmp = await reportToTempFile();
  const hidden = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, javascript: false, contextIsolation: true },
  });
  try {
    await hidden.loadFile(tmp);
    const pdf = await hidden.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    });
    const out = await dialog.showSaveDialog(win ?? undefined!, {
      title: 'Save grade report',
      defaultPath: path.join(app.getPath('documents'), 'grade-report.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (out.canceled || !out.filePath) return { saved: false };
    await fs.writeFile(out.filePath, pdf);
    shell.showItemInFolder(out.filePath);
    return { saved: true, path: out.filePath };
  } finally {
    hidden.destroy();
    revokeFile(tmp);
    await fs.rm(tmp, { force: true });
  }
}

async function boot(): Promise<void> {
  token = randomBytes(32).toString('hex');
  try {
    server = await startServer({
      dataDir,
      token,
      watch: true,
      staticDir: path.join(__dirname, 'web'),
      port: 0,
    });
  } catch (e) {
    dialog.showErrorBox(
      `${APP_NAME} could not start`,
      `${(e as Error).message}\n\nIs ${APP_NAME} already running?`,
    );
    app.quit();
    return;
  }
  lockDown(server.url);
  ipcMain.on('classpad:config', (e) => {
    e.returnValue = trusted(e)
      ? { token, version: app.getVersion(), platform: process.platform, dataDir }
      : null;
  });
  ipcMain.handle('classpad:open-data-folder', (e) => {
    if (trusted(e)) return shell.openPath(dataDir).then(() => undefined);
  });
  ipcMain.handle('classpad:open-report', (e, hide: unknown) => {
    if (!trusted(e)) throw new Error('untrusted sender');
    return openReportWindow(hide === true);
  });
  ipcMain.handle('classpad:save-report-pdf', (e) => {
    if (!trusted(e)) throw new Error('untrusted sender');
    return saveReportPdf();
  });
  Menu.setApplicationMenu(
    buildMenu({
      win: () => win,
      appName: APP_NAME,
      exportPdf: () =>
        void saveReportPdf().catch((err) =>
          dialog.showErrorBox('Could not save the report', String(err.message ?? err)),
        ),
      openDataFolder: () => void shell.openPath(dataDir),
    }),
  );
  await createWindow();
}

app.whenReady().then(boot);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (server && BrowserWindow.getAllWindows().length === 0) void createWindow();
});

let closing = false;
app.on('before-quit', (e) => {
  if (closing || !server) return;
  closing = true;
  e.preventDefault();
  // release the data-directory lock and flush the file watcher before exiting
  void server.close().finally(() => app.exit(0));
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => app.quit());
