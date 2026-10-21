// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Sparkline } from './Sparkline.js';

afterEach(cleanup);
describe('Sparkline', () => {
  it('draws one path and colors by direction', () => {
    const { container, rerender } = render(<Sparkline points={[70, 75, 90]} />);
    expect(container.querySelectorAll('path')).toHaveLength(1);
    expect(container.querySelector('path')!.getAttribute('stroke')).toBe('var(--success)');
    rerender(<Sparkline points={[90, 80, 70]} />);
    expect(container.querySelector('path')!.getAttribute('stroke')).toBe('var(--danger)');
    expect(container.querySelector('svg')!.getAttribute('role')).toBe('img');
  });
  it('handles flat data and too little data without NaN', () => {
    const { container, rerender } = render(<Sparkline points={[80, 80, 80]} />);
    expect(container.querySelector('path')!.getAttribute('d')).not.toMatch(/NaN/);
    rerender(<Sparkline points={[80]} />);
    expect(container.querySelector('svg')).toBeNull();
    rerender(<Sparkline points={[]} />);
    expect(container.querySelector('svg')).toBeNull();
  });
});
