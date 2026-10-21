import { app, session, shell, type WebContents } from 'electron';
import { fileURLToPath } from 'node:url';

/** Exact local files the app itself has just written for a window to display (e.g. the printable report). */
const allowedFiles = new Set<string>();
export const allowFile = (p: string): void => void allowedFiles.add(p);
export const revokeFile = (p: string): void => void allowedFiles.delete(p);
const allowedFileUrl = (u: string): boolean => {
  if (!u.startsWith('file://')) return false;
  try {
    return allowedFiles.has(fileURLToPath(u));
  } catch {
    return false;
  }
};

/** Only these may be opened in the user's browser, and only on an explicit click. */
const EXTERNAL = /^(https:\/\/|mailto:)/i;

/**
 * Lock the app down: no remote requests, no permissions except notifications, no navigation away
 * from our own origin, no webviews, and no pop-up windows (the app opens its own report window).
 */
export function lockDown(origin: string): void {
  const ses = session.defaultSession;
  const mine = (url: string) => url === origin || url.startsWith(origin + '/');

  // "No network" is enforced, not just promised: anything that isn't our local server (or inline data) is cancelled.
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url;
    cb({
      cancel: !(
        allowedFileUrl(u) ||
        mine(u) ||
        u.startsWith('blob:' + origin) ||
        u.startsWith('data:') ||
        u.startsWith('devtools:') ||
        u.startsWith('chrome-extension:')
      ),
    });
  });
  ses.setPermissionRequestHandler((wc, permission, cb) =>
    cb(permission === 'notifications' && mine(wc.getURL())),
  );
  ses.setPermissionCheckHandler(
    (wc, permission) => permission === 'notifications' && !!wc && mine(wc.getURL()),
  );

  app.on('web-contents-created', (_e, contents: WebContents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.on('will-navigate', (e, url) => {
      if (mine(url)) return;
      e.preventDefault();
      if (EXTERNAL.test(url)) void shell.openExternal(url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (EXTERNAL.test(url)) {
        void shell.openExternal(url);
        return { action: 'deny' };
      }
      return { action: 'deny' };
    });
  });
}
