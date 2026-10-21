export interface Heading {
  level: number;
  text: string;
  line: number;
}

/** ATX headings outside fenced code, with 1-based line numbers. */
export function outline(md: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  md.split('\n').forEach((raw, i) => {
    const f = /^\s{0,3}(```|~~~)/.exec(raw);
    if (f) {
      fence = fence === null ? f[1]! : fence === f[1] ? null : fence;
      return;
    }
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (m) out.push({ level: m[1]!.length, text: m[2]!.replace(/[*_`[\]]/g, ''), line: i + 1 });
  });
  return out;
}

/** Counts words in prose (code blocks and math are left out) plus an estimated reading time. */
export function wordStats(md: string): { words: number; chars: number; minutes: number } {
  const prose = md
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  const words = (prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
  return { words, chars: md.length, minutes: Math.max(words ? 1 : 0, Math.round(words / 220)) };
}

/** Fill {{title}}, {{date}} and {{class}} in a template. Unknown placeholders are left as written. */
export function applyTemplate(
  template: string,
  vars: { title: string; date: string; className?: string },
): string {
  return template
    .replace(/\{\{\s*title\s*\}\}/gi, vars.title)
    .replace(/\{\{\s*date\s*\}\}/gi, vars.date)
    .replace(/\{\{\s*class\s*\}\}/gi, vars.className ?? '—');
}

/** Subsequence fuzzy score (higher is better, null = no match): prefers prefix and consecutive matches. */
export function fuzzy(query: string, text: string): number | null {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 0;
  const sub = t.indexOf(q);
  if (sub >= 0) return 1000 - sub - t.length * 0.01;
  let ti = 0,
    score = 0,
    streak = 0;
  for (const c of q) {
    const at = t.indexOf(c, ti);
    if (at < 0) return null;
    streak = at === ti ? streak + 1 : 0;
    score += 1 + streak * 2 - (at - ti) * 0.1;
    ti = at + 1;
  }
  return score;
}
