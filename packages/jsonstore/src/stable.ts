/** Deterministic pretty JSON: sorted keys, 2-space indent, trailing newline. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => [k, sortKeys(o[k])]),
    );
  }
  return v;
}

/** Best-effort 1-based line number from a JSON.parse error message. */
export function jsonErrorLine(text: string, err: unknown): number | undefined {
  const m = /position (\d+)/.exec(String((err as Error)?.message ?? ''));
  if (!m) return undefined;
  return text.slice(0, Number(m[1])).split('\n').length;
}
