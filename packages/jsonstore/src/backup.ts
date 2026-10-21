import AdmZip from 'adm-zip';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const BACKUP_EXCLUDE = new Set([
  'backups',
  'quarantine',
  'logs',
  'attachments',
  'imports',
  'exports',
  '.lock',
]);

async function walk(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (!rel && BACKUP_EXCLUDE.has(e.name)) continue;
    if (e.name.endsWith('.tmp')) continue;
    if (e.isDirectory()) out.push(...(await walk(dir, r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

export async function createBackup(root: string, reason: string, keep = 20): Promise<string> {
  const dir = path.join(root, 'backups');
  await fs.mkdir(dir, { recursive: true });
  const zip = new AdmZip();
  for (const rel of await walk(root))
    zip.addLocalFile(path.join(root, rel), path.dirname(rel) === '.' ? '' : path.dirname(rel));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `backup-${stamp}-${reason.replace(/[^a-z0-9_-]/gi, '')}.zip`);
  await fs.writeFile(file, zip.toBuffer());
  const all = (await fs.readdir(dir)).filter((f) => f.endsWith('.zip')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) await fs.rm(path.join(dir, old));
  return file;
}

export async function listBackups(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(root, 'backups'))).filter((f) => f.endsWith('.zip')).sort();
  } catch {
    return [];
  }
}

/** Newest backup entry content for a relative path, or null. */
export async function readFromLatestBackup(root: string, rel: string): Promise<string | null> {
  const all = await listBackups(root);
  for (const f of all.reverse()) {
    try {
      const entry = new AdmZip(path.join(root, 'backups', f)).getEntry(rel);
      if (entry) return entry.getData().toString('utf8');
    } catch {
      /* try the next one */
    }
  }
  return null;
}
