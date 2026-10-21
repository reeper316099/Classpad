import { describe, expect, it } from 'vitest';
import { applyTemplate, fuzzy, outline, wordStats } from './notes.js';

describe('outline', () => {
  it('finds headings with line numbers and ignores code fences', () => {
    const md =
      '# One\ntext\n```\n# not a heading\n```\n## Two *styled*\n####### too deep\n### Three ###';
    expect(outline(md)).toEqual([
      { level: 1, text: 'One', line: 1 },
      { level: 2, text: 'Two styled', line: 6 },
      { level: 3, text: 'Three', line: 8 },
    ]);
  });
});

describe('wordStats', () => {
  it('counts prose words, skipping code and display math', () => {
    const s = wordStats(
      "Hello there, it's a test.\n\n```js\nconst a = 1; const b = 2;\n```\n\n$$\nx = y\n$$\n`inline code` end",
    );
    expect(s.words).toBe(6);
    expect(s.minutes).toBe(1);
    expect(wordStats('').words).toBe(0);
    expect(wordStats('').minutes).toBe(0);
    expect(wordStats('word '.repeat(660)).minutes).toBe(3);
  });
});

describe('applyTemplate', () => {
  it('fills placeholders case-insensitively and leaves unknown ones', () => {
    expect(
      applyTemplate('# {{Title}} {{ date }} {{class}} {{other}}', {
        title: 'T',
        date: '2031-01-02',
        className: 'C',
      }),
    ).toBe('# T 2031-01-02 C {{other}}');
    expect(applyTemplate('{{class}}', { title: '', date: '' })).toBe('—');
  });
});

describe('fuzzy', () => {
  it('prefers substring, then subsequence, else no match', () => {
    expect(fuzzy('lec', 'Lecture 1')!).toBeGreaterThan(fuzzy('lc1', 'Lecture 1')!);
    expect(fuzzy('lc1', 'Lecture 1')).not.toBeNull();
    expect(fuzzy('zzz', 'Lecture 1')).toBeNull();
    expect(fuzzy('', 'anything')).toBe(0);
    expect(fuzzy('lec', 'Lecture')!).toBeGreaterThan(fuzzy('lec', 'A long lecture')!);
  });
});
