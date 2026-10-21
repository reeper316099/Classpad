import { parseFrontmatter } from '@classpad/shared';
import type { Archive } from './archive.js';
import { nameRef } from './csvImport.js';
import { normTitle } from './parse.js';
import { emptyPreview, type ImportPreview } from './types.js';

const IMG = /\.(png|jpe?g|gif|webp|svg|pdf)$/i;

/** Obsidian-style vault or plain folder of Markdown. Top-level folder name = class name. */
export function previewMarkdownFolder(archive: Archive): ImportPreview {
  const out = emptyPreview('markdown');
  const baseIndex = new Map<string, string>();
  for (const f of archive.files) baseIndex.set(f.split('/').pop()!.toLowerCase(), f);
  const seen = new Set<string>();
  for (const f of archive.files.filter(
    (x) => /\.md$/i.test(x) && !x.split('/').some((s) => s.startsWith('.')),
  )) {
    let fm;
    try {
      fm = parseFrontmatter(archive.read(f).toString('utf8'));
    } catch (e) {
      out.warnings.push({ code: 'FRONTMATTER', message: (e as Error).message, where: f });
      fm = { data: {}, content: archive.read(f).toString('utf8') };
    }
    const parts = f.split('/');
    const file = parts[parts.length - 1]!.replace(/\.md$/i, '');
    const h1 = /^#\s+(.+)$/m.exec(fm.content)?.[1]?.trim();
    const title = String(fm.data.title ?? h1 ?? file);
    const folder = parts.length > 1 ? parts[0]! : '';
    let md = fm.content;
    // Obsidian image embeds -> markdown images pointing at imported attachments
    md = md.replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (m, name: string) => {
      const hit = archive.has(name) ? name : baseIndex.get(name.split('/').pop()!.toLowerCase());
      if (!hit || !IMG.test(hit)) {
        out.warnings.push({ code: 'EMBED', message: `Embed "${name}" not found`, where: f });
        return m;
      }
      if (!out.attachments.some((a) => a.archivePath === hit))
        out.attachments.push({ archivePath: hit, filename: hit.split('/').pop()! });
      return `![${name}](attachment-ref:${encodeURI(hit)})`;
    });
    md = md.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, target: string) => {
      if (/^(https?:|data:)/i.test(target)) return m;
      let dec = target;
      try {
        dec = decodeURIComponent(target);
      } catch {
        /* keep */
      }
      const hit = [parts.slice(0, -1).concat(dec).join('/'), dec].find((c) => archive.has(c));
      if (!hit) return m;
      if (!out.attachments.some((a) => a.archivePath === hit))
        out.attachments.push({ archivePath: hit, filename: hit.split('/').pop()! });
      return `![${alt}](attachment-ref:${encodeURI(hit)})`;
    });
    const rawTags = fm.data.tags ?? fm.data.tag;
    const tags = (
      Array.isArray(rawTags) ? rawTags : typeof rawTags === 'string' ? rawTags.split(/[,\s]+/) : []
    )
      .map((t) => String(t).replace(/^#/, ''))
      .filter(Boolean);
    let ref = `md:note:${normTitle(f.replace(/\.md$/i, ''))}`;
    for (let n = 2; seen.has(ref); n++) ref = `${ref.replace(/#\d+$/, '')}#${n}`;
    seen.add(ref);
    out.notes.push({
      ref,
      title,
      classRef: folder ? nameRef('class', folder) : undefined,
      date: fm.data.date ? String(fm.data.date).slice(0, 10) : undefined,
      markdown: md.trim() ? md.trim() + '\n' : '',
      tags: [...new Set(['imported', ...tags])],
      assignmentRefs: [],
      readingRefs: [],
    });
  }
  if (!out.notes.length)
    out.warnings.push({ code: 'NO_NOTES', message: 'No Markdown files found' });
  return out;
}
