// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api.js', () => ({
  get: vi.fn(async (path: string) =>
    path.includes('Known')
      ? { id: 'n1' }
      : path.startsWith('/notes/resolve')
        ? null
        : { items: [] },
  ),
  post: vi.fn(),
  apiConfig: () => ({ baseUrl: '', token: 't' }),
}));
import { Markdown } from './Markdown.js';

afterEach(cleanup);
const show = (source: string, props: Record<string, unknown> = {}) => {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <Markdown source={source} {...props} />
    </QueryClientProvider>,
  );
};

describe('Markdown sanitization (XSS)', () => {
  it('drops raw HTML: script, iframe, style, svg, event handlers', () => {
    const { container } = show(
      '<script>window.pwned=1</script>\n\n<iframe src="https://evil.example"></iframe>\n\n<style>body{display:none}</style>\n\n<svg onload="window.pwned=1"></svg>\n\n<img src=x onerror="window.pwned=1">\n\n<div onclick="window.pwned=1">hi</div>',
    );
    expect(
      container.querySelector('script, iframe, style, svg, img, [onerror], [onclick], [onload]'),
    ).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });
  it('neutralizes javascript:, data: and vbscript: links', () => {
    const { container } = show(
      '[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](data:text/html;base64,PHNjcmlwdD4=) [d](vbscript:x) [e](&#106;avascript:alert(1)) [f](https://ok.example)',
    );
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://ok.example']);
    expect(container.innerHTML).not.toMatch(/javascript:|vbscript:|data:text/i);
  });
  it('external links open safely', () => {
    const { container } = show('[ok](https://ok.example)');
    const a = container.querySelector('a')!;
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.getAttribute('target')).toBe('_blank');
  });
  it('never loads remote images (no remote content)', () => {
    const { container } = show(
      '![tracker](https://evil.example/p.png) ![x](http://evil.example/p.gif) ![d](data:image/svg+xml;base64,AAAA)',
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByText(/Image not loaded/).length).toBe(3);
  });
  it('math cannot smuggle links or scripts (trust off)', () => {
    const { container } = show(
      '$\\href{javascript:alert(1)}{click}$ and $\\htmlClass{x}{y}$ and $$\\url{javascript:alert(1)}$$',
    );
    expect(container.querySelector('a, script, [href], [src]')).toBeNull();
    // KaTeX keeps the TeX source as inert annotation text; no attribute may carry a script URL
    for (const el of container.querySelectorAll('*'))
      for (const attr of el.getAttributeNames())
        expect(`${attr}=${el.getAttribute(attr)}`).not.toMatch(/javascript:|^on/i);
  });
});

describe('Markdown rendering', () => {
  it('renders GFM: tables, task lists, strikethrough, autolinks', () => {
    const { container } = show(
      '| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~gone~~',
    );
    expect(container.querySelector('table')).toBeTruthy();
    const boxes = container.querySelectorAll('input[type=checkbox]');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect(boxes[0]!.hasAttribute('disabled')).toBe(true);
    expect(container.querySelector('del')).toBeTruthy();
  });
  it('renders inline and block math with KaTeX', () => {
    const { container } = show('Inline $E = mc^2$ and block:\n\n$$\n\\int_0^1 x^2\\,dx\n$$');
    expect(container.querySelectorAll('.katex').length).toBe(2);
    expect(container.querySelector('.katex-display')).toBeTruthy();
  });
  it('bad math does not crash the page', () => {
    const { container } = show('$\\frac{1}{$ still readable text');
    expect(container.textContent).toContain('still readable text');
  });
  it('highlights fenced code', () => {
    const { container } = show('```python\ndef f(x):\n    return x\n```');
    expect(container.querySelector('pre code.hljs, pre code.language-python')).toBeTruthy();
    expect(container.querySelector('.hljs-keyword')).toBeTruthy();
  });
  it('gives headings stable ids for the outline', () => {
    const { container } = show('# Big Idea\n\n## Sub Topic!');
    expect(container.querySelector('h1')!.id).toBe('h-big-idea');
    expect(container.querySelector('h2')!.id).toBe('h-sub-topic');
  });
});

describe('wiki links and attachments', () => {
  it('turns [[links]] into clickable links, marks missing targets, ignores code', async () => {
    const onWikiLink = vi.fn();
    const { container } = show(
      'See [[Known note]], [[Known note|the alias]], [[Ghost]] and `[[in code]]`.',
      { onWikiLink },
    );
    await waitFor(() => expect(container.querySelector('a.wikilink.missing')).toBeTruthy());
    const links = [...container.querySelectorAll('a.wikilink')];
    expect(links.map((a) => a.textContent)).toEqual(['Known note', 'the alias', 'Ghost']);
    expect(container.querySelector('code')!.textContent).toBe('[[in code]]');
    await userEvent.click(links[1]!);
    expect(onWikiLink).toHaveBeenCalledWith('Known note', undefined);
  });
  it('passes heading targets', async () => {
    const onWikiLink = vi.fn();
    show('[[Known#Part Two]]', { onWikiLink });
    await userEvent.click(await screen.findByText('Known'));
    expect(onWikiLink).toHaveBeenCalledWith('Known', 'Part Two');
  });
  it('attachment links open through the handler; malformed ones are inert', async () => {
    const onOpenAttachment = vi.fn();
    const hash = 'a'.repeat(64);
    const { container } = show(
      `[Lecture slides](attachment://${hash}.pdf) [bad](attachment://nothex.pdf)`,
      { onOpenAttachment },
    );
    const links = container.querySelectorAll('a.attachment-link');
    expect(links).toHaveLength(1);
    await userEvent.click(links[0]!);
    expect(onOpenAttachment).toHaveBeenCalledWith(hash, 'pdf', 'Lecture slides');
  });
});
