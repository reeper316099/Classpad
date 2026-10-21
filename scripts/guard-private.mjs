#!/usr/bin/env node
// Fails if private data or third-party branding is staged. Used by pre-commit hook and CI.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, 'guard-config.json'), 'utf8'));
const NOTION_ID = /\s[0-9a-f]{32}(\.|\/|$)/;
const TEXT_EXT = /\.(md|mdx|txt|json|ts|tsx|js|mjs|cjs|css|html|yml|yaml|csv)$/i;

export function checkPath(path) {
  const p = path.replaceAll('\\', '/');
  const allowed = config.allowedPrefixes.some((a) => p.startsWith(a));
  if (p.startsWith('private-fixtures/')) return `private fixture staged: ${p}`;
  if (allowed) return null;
  if (/\.zip$/i.test(p)) return `zip archive outside fixtures/synthetic: ${p}`;
  if (NOTION_ID.test(p)) return `Notion-style id-suffixed file name: ${p}`;
  return null;
}

export function checkText(path, text) {
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (word.length < 4 || word.length > 24) continue;
    const h = createHash('sha256').update(word).digest('hex');
    if (config.deniedTokenHashes.includes(h)) return `denied third-party token in ${path}`;
  }
  return null;
}

export function run(paths, read = (p) => readFileSync(p, 'utf8')) {
  const problems = [];
  for (const p of paths) {
    const bad = checkPath(p);
    if (bad) problems.push(bad);
    else if (TEXT_EXT.test(p) && !p.startsWith('scripts/guard-config')) {
      try {
        const t = checkText(p, read(p));
        if (t) problems.push(t);
      } catch {
        /* deleted or unreadable file */
      }
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const all = process.argv.includes('--all');
  const args = all ? ['ls-files'] : ['diff', '--cached', '--name-only', '--diff-filter=ACMR'];
  const files = execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
  const problems = run(files);
  if (problems.length) {
    console.error('guard-private failed:\n' + problems.map((x) => ' - ' + x).join('\n'));
    process.exit(1);
  }
}
