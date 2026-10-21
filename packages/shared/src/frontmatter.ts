import { parse, stringify } from 'yaml';

export interface Frontmatter {
  data: Record<string, unknown>;
  content: string;
}

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Minimal YAML frontmatter. Uses the YAML 1.2 "core" schema (no custom tags, no code execution;
 * dates stay strings). Anything that isn't a plain `---` YAML block is treated as plain content.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^﻿/, '');
  const m = FENCE.exec(src);
  if (!m) return { data: {}, content: src };
  let data: unknown;
  try {
    data = parse(m[1]!, { schema: 'core', maxAliasCount: 20 });
  } catch (e) {
    throw new Error(`invalid frontmatter: ${(e as Error).message.split('\n')[0]}`);
  }
  if (data == null) data = {};
  if (typeof data !== 'object' || Array.isArray(data))
    throw new Error('frontmatter must be a mapping');
  return { data: data as Record<string, unknown>, content: src.slice(m[0].length) };
}

export function stringifyFrontmatter(content: string, data: Record<string, unknown>): string {
  const clean = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  const body = content.endsWith('\n') || content === '' ? content : content + '\n';
  return `---\n${stringify(clean, { schema: 'core', lineWidth: 0 })}---\n${body}`;
}
