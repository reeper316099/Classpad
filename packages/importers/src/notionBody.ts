import { cleanLabel } from './parse.js';

export interface BodyContext {
  /** Archive path of the page, for resolving relative links. */
  pagePath: string;
  /** Lower-cased property names whose "Key: value" header lines are dropped. */
  propertyNames: Set<string>;
  hasFile: (archivePath: string) => boolean;
  dropTooltips: boolean;
}
export interface BodyResult {
  markdown: string;
  attachments: string[];
  droppedTooltips: number;
  warnings: string[];
}

const TOOLTIP = /^(tool-?tip|tip|hint|how to use|template (tip|hint|note))\b\s*[:\-–—]?/i;
const ICON = /^([\p{Extended_Pictographic}️‍]+)\s*/u;

function joinPath(base: string, rel: string): string {
  const parts = base.split('/').slice(0, -1);
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

export function convertNotionMarkdown(input: string, ctx: BodyContext): BodyResult {
  const warnings: string[] = [];
  const attachments: string[] = [];
  let dropped = 0;
  let t = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  // title + property header block
  t = t.replace(/^\s*#\s+[^\n]*\n/, '');
  const lines = t.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  let j = i;
  let sawProp = false;
  while (j < lines.length) {
    const m = /^([^:\n]{1,48}):(?:\s.*)?$/.exec(lines[j]!);
    if (m && ctx.propertyNames.has(m[1]!.trim().toLowerCase())) {
      sawProp = true;
      j++;
    } else break;
  }
  if (sawProp) t = lines.slice(j).join('\n');

  // callouts
  t = t.replace(/<aside>\s*([\s\S]*?)\s*<\/aside>/g, (_m, inner: string) => {
    const icon = ICON.exec(inner);
    const text = icon ? inner.slice(icon[0].length) : inner;
    if (ctx.dropTooltips && TOOLTIP.test(text.trim())) {
      dropped++;
      return '';
    }
    const body = (icon ? `${icon[1]} ` : '') + text;
    return body
      .split('\n')
      .map((l) => `> ${l}`.trimEnd())
      .join('\n');
  });

  // toggles
  t = t.replace(
    /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g,
    (_m, s: string, body: string) =>
      [
        `> **${cleanLabel(s)}**`,
        '>',
        ...body
          .trim()
          .split('\n')
          .map((l) => `> ${l}`.trimEnd()),
      ].join('\n'),
  );

  // escaped checkboxes, equations, breaks, comments
  t = t.replace(/\\\[( |x|X)\\\]/g, '[$1]');
  t = t.replace(/\$`([^`]+)`\$/g, (_m, eq: string) => `$${eq}$`);
  t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<!--[\s\S]*?-->/g, '');

  // links and images
  t = t.replace(
    /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (m, bang: string, label: string, target: string) => {
      if (/^(https?:|mailto:|#)/i.test(target)) return m;
      let decoded = target;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        /* keep */
      }
      const resolved = joinPath(ctx.pagePath, decoded);
      if (/\.md$/i.test(decoded)) {
        const title =
          cleanLabel(label) ||
          cleanLabel(decoded.replace(/^.*\//, '').replace(/\s[0-9a-f]{32}\.md$/i, ''));
        return `[[${title}]]`;
      }
      // links to embedded database views (.csv) are not content: drop them silently
      if (/\.csv$/i.test(decoded)) return '';
      const hit = [resolved, decoded].find((p) => ctx.hasFile(p));
      if (hit) {
        attachments.push(hit);
        return `${bang}[${label}](attachment-ref:${encodeURI(hit)})`;
      }
      warnings.push(`Unresolved link target "${decoded}"`);
      return m;
    },
  );

  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return {
    markdown: t ? t + '\n' : '',
    attachments: [...new Set(attachments)],
    droppedTooltips: dropped,
    warnings,
  };
}
