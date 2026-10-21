import type { Srs } from './modules.js';

export type Rating = 'again' | 'hard' | 'good' | 'easy';
const DAY = 86_400_000;
/** A card is never scheduled more than 100 years out (and dates can never overflow). */
export const MAX_INTERVAL_DAYS = 36_500;

export const newSrs = (now = new Date()): Srs => ({
  ease: 2.5,
  intervalDays: 0,
  dueAt: now.toISOString(),
  reps: 0,
  lapses: 0,
});

/**
 * SM-2 style scheduling.
 * - again: relearn (due in 10 minutes), ease −0.2, counts as a lapse
 * - hard: interval × 1.2, ease −0.15
 * - good: 1 day, then 3, then interval × ease
 * - easy: like good × 1.3 with a bonus, ease +0.15
 * Ease stays within 1.3–3.5. Intervals are whole days (at least 1) except for "again".
 */
export function schedule(s: Srs, rating: Rating, now = new Date()): Srs {
  const clamp = (e: number) => Math.min(3.5, Math.max(1.3, Math.round(e * 100) / 100));
  if (rating === 'again') {
    return {
      ...s,
      ease: clamp(s.ease - 0.2),
      intervalDays: 0,
      dueAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      reps: 0,
      lapses: s.lapses + 1,
    };
  }
  let days: number;
  let ease = s.ease;
  if (rating === 'hard') {
    days = s.reps === 0 ? 1 : Math.max(1, Math.round(s.intervalDays * 1.2));
    ease -= 0.15;
  } else if (rating === 'good') {
    days =
      s.reps === 0
        ? 1
        : s.reps === 1
          ? 3
          : Math.max(s.intervalDays + 1, Math.round(s.intervalDays * s.ease));
  } else {
    days =
      s.reps === 0 ? 3 : Math.max(s.intervalDays + 2, Math.round(s.intervalDays * s.ease * 1.3));
    ease += 0.15;
  }
  days = Math.min(days, MAX_INTERVAL_DAYS);
  return {
    ease: clamp(ease),
    intervalDays: days,
    dueAt: new Date(now.getTime() + days * DAY).toISOString(),
    reps: s.reps + 1,
    lapses: s.lapses,
  };
}

export const isDue = (s: Srs, now = new Date()) => Date.parse(s.dueAt) <= now.getTime();

// ------------------------------------------------------------------ cloze extraction
export interface ClozeCard {
  cloze: number;
  front: string;
  back: string;
  sourceKey: string;
}

/** Small, stable non-cryptographic hash for change detection. */
export function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const CLOZE = /\{\{c(\d+)::([\s\S]*?)(?:::([^}]*?))?\}\}/g;

/**
 * One card per cloze number found in a paragraph/line: that cloze is hidden ("[…]" or its hint),
 * the others are shown. Code fences are ignored. The back shows the full sentence.
 */
export function extractClozeCards(markdown: string): ClozeCard[] {
  const text = markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, (m) =>
    m.replace(/\{\{/g, '{ {'),
  );
  const out: ClozeCard[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const nums = [...new Set([...block.matchAll(CLOZE)].map((m) => Number(m[1])))].sort(
      (a, b) => a - b,
    );
    for (const n of nums) {
      const front = block.replace(CLOZE, (_m, k: string, body: string, hint?: string) =>
        Number(k) === n ? `[${hint ? hint.trim() : '…'}]` : body,
      );
      const back = block.replace(CLOZE, (_m, _k, body: string) => body);
      out.push({
        cloze: n,
        front: front.trim(),
        back: back.trim(),
        sourceKey: `${n}:${hashText(block.trim())}`,
      });
    }
  }
  return out;
}
