import { promises as fs } from 'node:fs';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

/** Policy for the app shell itself: everything from this origin, API on this origin, nothing remote. */
export const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface StaticFile {
  body: Buffer;
  type: string;
  immutable: boolean;
}

/**
 * Resolve a URL path to a file under `root`. Traversal-proof: the resolved path must stay inside root.
 * Unknown paths without an extension fall back to index.html (client-side routes); missing assets 404.
 */
export async function readStatic(root: string, urlPath: string): Promise<StaticFile | null> {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0]!.split('#')[0]!);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  if (file !== base && !file.startsWith(base + path.sep)) return null;
  const tryRead = async (f: string): Promise<StaticFile | null> => {
    try {
      const st = await fs.stat(f);
      if (!st.isFile()) return null;
      return {
        body: await fs.readFile(f),
        type: MIME[path.extname(f).toLowerCase()] ?? 'application/octet-stream',
        immutable:
          /[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(path.basename(f)) &&
          f.includes(`${path.sep}assets${path.sep}`),
      };
    } catch {
      return null;
    }
  };
  const direct = await tryRead(file === base ? path.join(base, 'index.html') : file);
  if (direct) return direct;
  return path.extname(rel) ? null : tryRead(path.join(base, 'index.html'));
}
