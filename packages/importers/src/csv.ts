import Papa from 'papaparse';

export interface Table {
  fields: string[];
  rows: Record<string, string>[];
}

export function parseCsv(text: string): Table {
  const r = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });
  return { fields: (r.meta.fields ?? []).filter(Boolean), rows: r.data };
}

export function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const cell = (v: unknown) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; // neutralize spreadsheet formulas
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (
    [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\r\n') +
    '\r\n'
  );
}
