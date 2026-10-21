import AdmZip from 'adm-zip';
import { CSV_COLLECTIONS } from '@classpad/importers';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Context } from './context.js';
import { ApiError } from './errors.js';
import {
  exportCsv,
  exportGradebook,
  exportIcs,
  exportJson,
  exportMarkdownVault,
} from './exportService.js';

export const SYNC_FOLDER = 'Classpad Export';
const MANIFEST = '.classpad-export.json';

const README = `This folder is written by Classpad and replaced on every export.
Do not edit files here: your changes will be overwritten. Classpad never reads it back.

  classpad-backup.json   everything, re-importable with Import > JSON backup
  gradebook.csv          one row per assignment with class grades
  csv/                   one CSV per collection
  calendar/              deadlines.ics and timetable.ics
  notes/                 your notes as Markdown files
`;

const inside = (parent: string, child: string) => {
  const r = path.relative(parent, child);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

/**
 * One-way export to a folder other apps can read (a spreadsheet, a calendar, a notes app, a backup tool).
 * Everything goes into a "Classpad Export" subfolder that Classpad owns; nothing outside it is touched.
 */
export async function syncToFolder(ctx: Context, dataDir: string, dir: string) {
  if (!path.isAbsolute(dir)) throw new ApiError(422, 'BAD_PATH', 'Choose a full folder path');
  const base = path.resolve(dir);
  if (path.parse(base).root === base)
    throw new ApiError(422, 'BAD_PATH', 'Choose a folder, not the top of a drive');
  const data = path.resolve(dataDir);
  if (inside(data, base))
    throw new ApiError(
      422,
      'BAD_PATH',
      'The export folder cannot be inside Classpad’s own data folder',
    );
  const st = await fs.stat(base).catch(() => null);
  if (!st?.isDirectory()) throw new ApiError(422, 'BAD_PATH', 'That folder does not exist');

  const target = path.join(base, SYNC_FOLDER);
  const tst = await fs.lstat(target).catch(() => null);
  let previous: string[] = [];
  if (tst) {
    if (!tst.isDirectory() || tst.isSymbolicLink())
      throw new ApiError(409, 'NOT_OURS', `"${SYNC_FOLDER}" exists and is not a plain folder`);
    const m = await fs.readFile(path.join(target, MANIFEST), 'utf8').catch(() => null);
    if (m === null) {
      if ((await fs.readdir(target)).length)
        throw new ApiError(
          409,
          'NOT_OURS',
          `"${SYNC_FOLDER}" already exists and was not created by Classpad. Rename or remove it first.`,
        );
    } else previous = (JSON.parse(m) as { files?: string[] }).files ?? [];
  }

  const files = new Map<string, string | Buffer>();
  files.set('README.txt', README);
  files.set('classpad-backup.json', JSON.stringify(exportJson(ctx), null, 2));
  files.set('gradebook.csv', exportGradebook(ctx));
  for (const c of CSV_COLLECTIONS) files.set(`csv/${c}.csv`, exportCsv(ctx, c));
  files.set('calendar/deadlines.ics', exportIcs(ctx, 'deadlines'));
  files.set('calendar/timetable.ics', exportIcs(ctx, 'timetable'));
  for (const e of new AdmZip(await exportMarkdownVault(ctx)).getEntries()) {
    if (e.isDirectory) continue;
    const rel = e.entryName.replace(/\\/g, '/');
    if (rel.startsWith('/') || rel.split('/').includes('..')) continue; // never trust zip paths
    files.set(`notes/${rel}`, e.getData());
  }

  await fs.mkdir(target, { recursive: true });
  let bytes = 0;
  for (const [rel, content] of files) {
    const dest = path.join(target, ...rel.split('/'));
    if (!inside(target, dest)) continue;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp`;
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, dest);
    bytes += Buffer.byteLength(content);
  }
  // remove only files an earlier export wrote and this one no longer has (renamed or deleted notes)
  for (const rel of previous) {
    if (files.has(rel) || rel.startsWith('/') || rel.split('/').includes('..')) continue;
    await fs.rm(path.join(target, ...rel.split('/')), { force: true }).catch(() => null);
  }
  const exportedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(target, MANIFEST),
    JSON.stringify(
      { format: 'classpad-export', version: 1, exportedAt, files: [...files.keys()] },
      null,
      2,
    ),
  );
  return { folder: target, files: files.size, bytes, exportedAt };
}
