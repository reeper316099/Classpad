/** WCAG-based helpers so per-class colors stay readable in both themes. */
const clamp = (n: number) => Math.min(255, Math.max(0, Math.round(n)));

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [99, 102, 241];
}
export const rgbToHex = ([r, g, b]: [number, number, number]) =>
  '#' + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('');

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
const mix = (a: string, b: string, t: number) => {
  const x = hexToRgb(a),
    y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
};

/** Move `color` toward black or white until it meets `min` contrast on `bg`. */
export function ensureContrast(color: string, bg: string, min = 4.5): string {
  if (contrast(color, bg) >= min) return color;
  const target = luminance(bg) > 0.5 ? '#000000' : '#ffffff';
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    const c = mix(color, target, t);
    if (contrast(c, bg) >= min) return c;
  }
  return target;
}

/** The effective surface a class chip sits on: its own 18% tint over the page surface. */
const tint = (color: string, surface: string) => mix(surface, color, 0.18);
export function classTokens(color: string): Record<string, string> {
  return {
    '--cc': color,
    '--cc-fg-light': ensureContrast(color, tint(color, '#ffffff')),
    '--cc-fg-dark': ensureContrast(color, tint(color, '#1a1d2e')),
  };
}

/** Readable text color for content drawn on top of `bg` (e.g. the accent gradient). */
export const onColor = (bg: string): string =>
  contrast('#ffffff', bg) >= 4.5 ? '#ffffff' : '#10121c';

export const ACCENTS = [
  { name: 'Indigo', hex: '#6366f1' },
  { name: 'Violet', hex: '#8b5cf6' },
  { name: 'Rose', hex: '#e11d74' },
  { name: 'Coral', hex: '#e8590c' },
  { name: 'Amber', hex: '#b7791f' },
  { name: 'Emerald', hex: '#0f9d6b' },
  { name: 'Teal', hex: '#0d9488' },
  { name: 'Sky', hex: '#0284c7' },
];
/** Colorblind-safe categorical palette (Okabe–Ito) for charts. */
export const CHART_COLORS = [
  '#0072B2',
  '#E69F00',
  '#009E73',
  '#CC79A7',
  '#56B4E9',
  '#D55E00',
  '#F0E442',
];
export const CLASS_COLORS = [
  '#6366f1',
  '#ec4899',
  '#10b981',
  '#f59e0b',
  '#06b6d4',
  '#8b5cf6',
  '#ef4444',
  '#84cc16',
];
