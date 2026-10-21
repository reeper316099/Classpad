import { apiConfig, get, post } from './api.js';
import type { Attachment, Page } from './types.js';

const blobCache = new Map<string, Promise<string>>();

/** `attachment://<hash>.<ext>` → { hash, ext } (null when it isn't one). */
export function parseAttachmentLink(
  href: string,
): { hash: string; ext: string; name: string } | null {
  const m = /^attachment:\/\/([0-9a-f]{64})\.([a-z0-9]{1,8})$/i.exec(href);
  return m
    ? { hash: m[1]!.toLowerCase(), ext: m[2]!.toLowerCase(), name: `${m[1]}.${m[2]}` }
    : null;
}

export async function findAttachment(hash: string): Promise<Attachment | undefined> {
  return (await get<Page<Attachment>>(`/attachments?hash=${hash}&limit=1`)).items[0];
}

/** The file API needs the bearer token, so images/PDFs are fetched and shown from blob URLs. */
export function attachmentBlobUrl(hash: string): Promise<string> {
  let p = blobCache.get(hash);
  if (!p) {
    p = (async () => {
      const a = await findAttachment(hash);
      if (!a) throw new Error('Attachment not found');
      const { baseUrl, token } = apiConfig();
      const res = await fetch(`${baseUrl}/api/v1/attachments/${a.id}/file`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Could not load attachment');
      return URL.createObjectURL(await res.blob());
    })();
    p.catch(() => blobCache.delete(hash));
    blobCache.set(hash, p);
  }
  return p;
}

/** Raw bytes of an attachment (used by pdf.js, which must not fetch blob: URLs under our CSP). */
export async function attachmentBytes(hash: string): Promise<Uint8Array> {
  const a = await findAttachment(hash);
  if (!a) throw new Error('Attachment not found');
  const { baseUrl, token } = apiConfig();
  const res = await fetch(`${baseUrl}/api/v1/attachments/${a.id}/file`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Could not load attachment');
  return new Uint8Array(await res.arrayBuffer());
}

const toBase64 = (buf: ArrayBuffer) => {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Upload a file and return the Markdown that references it. */
export async function uploadForMarkdown(file: File): Promise<string> {
  const rec = await post<Attachment>('/attachments', {
    filename: file.name || 'pasted-image.png',
    dataBase64: toBase64(await file.arrayBuffer()),
  });
  const ext = /\.([a-z0-9]{1,8})$/i.exec(rec.path)?.[1] ?? 'bin';
  const link = `attachment://${rec.hash}.${ext}`;
  const label = rec.filename.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');
  return /^image\//.test(rec.mime)
    ? `![${label}](${link})`
    : `[${rec.filename.replace(/[[\]]/g, '')}](${link})`;
}
