import AdmZip from 'adm-zip';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** Read-only view over an export. Nothing is ever extracted to disk, so zip-slip can't happen. */
export interface Archive {
  files: string[];
  read(p: string): Buffer;
  has(p: string): boolean;
}

const MAX_ENTRIES = 50_000;
const MAX_TOTAL = 1024 * 1024 * 1024;

export function openMemory(map: Record<string, Buffer | string>): Archive {
  const files = Object.keys(map).sort();
  return {
    files,
    has: (p) => p in map,
    read: (p) => {
      const v = map[p];
      if (v === undefined) throw new Error(`missing archive entry: ${p}`);
      return Buffer.isBuffer(v) ? v : Buffer.from(v);
    },
  };
}

export function openZip(buf: Buffer): Archive {
  const zip = new AdmZip(buf);
  const entries = zip
    .getEntries()
    .filter((e) => !e.isDirectory && !e.entryName.startsWith('__MACOSX/'));
  if (entries.length > MAX_ENTRIES) throw new Error('archive has too many entries');
  const total = entries.reduce((n, e) => n + e.header.size, 0);
  if (total > MAX_TOTAL) throw new Error('archive is too large when uncompressed');
  const byName = new Map(entries.map((e) => [e.entryName.replaceAll('\\', '/'), e]));
  const a: Archive = {
    files: [...byName.keys()].sort(),
    has: (p) => byName.has(p),
    read: (p) => {
      const e = byName.get(p);
      if (!e) throw new Error(`missing archive entry: ${p}`);
      return e.getData();
    },
  };
  // Some exports wrap everything in one nested .zip
  const hasContent = a.files.some((f) => /\.(csv|md)$/i.test(f));
  const nested = a.files.filter((f) => /\.zip$/i.test(f));
  if (!hasContent && nested.length === 1) return openZip(a.read(nested[0]!));
  return a;
}

export function openDir(dir: string): Archive {
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(path.join(dir, r)).isDirectory()) walk(r);
      else files.push(r);
    }
  };
  walk('');
  const set = new Set(files);
  return {
    files: files.sort(),
    has: (p) => set.has(p),
    read: (p) => readFileSync(path.join(dir, p)),
  };
}
