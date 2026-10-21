import { describe, expect, it } from 'vitest';
import { classTokens, contrast, ensureContrast, ACCENTS } from './color.js';

describe('color contrast', () => {
  it('computes WCAG ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#777777', '#ffffff')).toBeGreaterThan(4.4);
  });
  it('every class color gets AA text in both themes', () => {
    for (const c of [
      '#f59e0b',
      '#84cc16',
      '#06b6d4',
      '#ec4899',
      '#6366f1',
      '#ffff00',
      '#111111',
      ...ACCENTS.map((a) => a.hex),
    ]) {
      const t = classTokens(c);
      const light = (parseInt(c.slice(1), 16), t['--cc-fg-light']!);
      expect(contrast(light, mixed(c, '#ffffff'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--cc-fg-dark']!, mixed(c, '#1a1d2e'))).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('leaves already-readable colors untouched', () =>
    expect(ensureContrast('#000000', '#ffffff')).toBe('#000000'));
});

function mixed(color: string, surface: string): string {
  const h = (x: string) => [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16));
  const [c, s] = [h(color), h(surface)];
  return (
    '#' +
    c
      .map((v, i) =>
        Math.round(s[i]! + (v - s[i]!) * 0.18)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
