import { describe, expect, it } from 'vitest';
import { codeBlock, toggleBlock } from './noteBlocks.js';

describe('code blocks', () => {
  it('wraps the selection in a fenced block with the language and selects the code', () => {
    const r = codeBlock('print(1)', 'python');
    expect(r.text).toBe('```python\nprint(1)\n```\n');
    expect(r.text.slice(...r.select)).toBe('print(1)');
  });
  it('puts the cursor inside an empty block', () => {
    const r = codeBlock('', '');
    expect(r.text).toBe('```\n\n```\n');
    expect(r.select[0]).toBe(r.select[1]);
    expect(r.text.slice(0, r.select[0])).toBe('```\n');
  });
  it('uses a longer fence when the code itself contains backticks', () => {
    const r = codeBlock('a ```b``` c', 'md');
    expect(r.text.startsWith('````md\n')).toBe(true);
    expect(r.text.trimEnd().endsWith('````')).toBe(true);
  });
  it('strips characters that could break out of the info string', () => {
    expect(codeBlock('x', 'py thon\n```').text.startsWith('```python\n')).toBe(true);
  });
});

describe('toggles', () => {
  it('builds a toggle list with the title selected', () => {
    const r = toggleBlock('', 0);
    expect(r.text).toBe('<details>\n<summary>Title</summary>\n\n\n</details>\n');
    expect(r.text.slice(...r.select)).toBe('Title');
  });
  it('builds toggle headings 1-3 and keeps the selected text as the body', () => {
    for (const n of [1, 2, 3] as const) {
      const r = toggleBlock('some text', n);
      expect(r.text).toContain(`<summary><h${n}>Title</h${n}></summary>`);
      expect(r.text).toContain('\n\nsome text\n\n</details>');
      expect(r.text.slice(...r.select)).toBe('Title');
    }
  });
});
