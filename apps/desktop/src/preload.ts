// Runs in the sandboxed preload context: only `electron`'s renderer APIs are available here.
import { contextBridge, ipcRenderer } from 'electron';

interface Config {
  token: string;
  version: string;
  platform: string;
  dataDir: string;
}
const cfg = ipcRenderer.sendSync('classpad:config') as Config;

contextBridge.exposeInMainWorld('classpad', {
  // same origin as the page, so baseUrl is empty; the token is per launch and never written to disk
  api: { baseUrl: '', token: cfg.token },
  platform: cfg.platform,
  version: cfg.version,
  dataDir: cfg.dataDir,
  /** Native menu → app actions. Returns an unsubscribe function. */
  onMenu(cb: (action: string) => void): () => void {
    const handler = (_e: unknown, action: string) => cb(action);
    ipcRenderer.on('classpad:menu', handler);
    return () => ipcRenderer.removeListener('classpad:menu', handler);
  },
  openDataFolder: (): Promise<void> => ipcRenderer.invoke('classpad:open-data-folder'),
  paste: (): Promise<void> => ipcRenderer.invoke('classpad:paste'),
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('classpad:choose-folder'),
  openReport: (hide = false): Promise<void> => ipcRenderer.invoke('classpad:open-report', hide),
  saveReportPdf: (): Promise<{ saved: boolean; path?: string }> =>
    ipcRenderer.invoke('classpad:save-report-pdf'),
});
