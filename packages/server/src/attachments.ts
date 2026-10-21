import { createHash } from 'node:crypto';
import type { JsonStore } from '@classpad/jsonstore';
import type { Attachment } from '@classpad/shared';
import { ApiError } from './errors.js';
import type { Repo } from './repo.js';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  zip: 'application/zip',
};
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/** Types a browser could execute in the app origin: always served as downloads. */
const INLINE_SAFE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'audio/mpeg',
  'video/mp4',
]);
export const isInlineSafe = (mime: string): boolean => INLINE_SAFE.has(mime);

export const extOf = (filename: string): string => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename);
  return m ? m[1]!.toLowerCase() : 'bin';
};

/** Content-addressed files under attachments/<sha256>.<ext>; the path is never user-controlled. */
export class AttachmentService {
  constructor(
    private store: JsonStore,
    private repo: Repo<Attachment>,
  ) {}

  async add(filename: string, data: Buffer): Promise<{ record: Attachment; created: boolean }> {
    if (data.length > MAX_ATTACHMENT_BYTES)
      throw new ApiError(413, 'TOO_LARGE', 'attachment exceeds 50 MB');
    const hash = createHash('sha256').update(data).digest('hex');
    const existing = this.repo.list().find((a) => a.hash === hash);
    if (existing) return { record: existing, created: false };
    const ext = extOf(filename);
    const rel = `attachments/${hash}.${ext}`;
    await this.store.writeBinary(rel, data);
    const clean = filename.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200) || 'file';
    const record = await this.repo.create({
      filename: clean,
      mime: MIME[ext] ?? 'application/octet-stream',
      size: data.length,
      hash,
      path: rel,
    });
    return { record, created: true };
  }

  /** Link form used inside Markdown. */
  static link(a: Pick<Attachment, 'hash' | 'path'>): string {
    return `attachment://${a.hash}.${extOf(a.path)}`;
  }

  async read(a: Attachment): Promise<Buffer> {
    const b = await this.store.readBinary(a.path);
    if (!b) throw new ApiError(404, 'NOT_FOUND', 'attachment file is missing');
    return b;
  }

  async remove(a: Attachment): Promise<void> {
    await this.repo.delete(a.id);
    await this.store.remove(a.path);
  }
}
