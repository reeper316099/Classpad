// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Breakdown, GradePill, Toasts } from './ui.js';
import type { GradeResult } from '../lib/types.js';

afterEach(cleanup);

describe('Breakdown', () => {
  it('renders every step with its terms, values and notes', () => {
    render(
      <Breakdown
        steps={[
          {
            kind: 'terms',
            label: 'Graded items',
            terms: [
              { label: 'Essay', score: '90', weight: '20', product: '1800', note: 'late penalty' },
            ],
          },
          {
            kind: 'result',
            label: 'Grade before rounding',
            formula: '42 ÷ 0.5',
            value: '84',
            note: 'keeps all digits',
          },
        ]}
      />,
    );
    expect(screen.getByText('How this was calculated')).toBeTruthy();
    expect(screen.getByText('Essay')).toBeTruthy();
    expect(screen.getByText('1800')).toBeTruthy();
    expect(screen.getByText('late penalty')).toBeTruthy();
    expect(screen.getByText('84')).toBeTruthy();
    expect(screen.getByText('42 ÷ 0.5')).toBeTruthy();
  });
  it('marks numbers as sensitive so hide-grades can blur them', () => {
    const { container } = render(<Breakdown steps={[{ kind: 'r', label: 'x', value: '84' }]} />);
    expect(container.querySelector('.sens')?.textContent).toBe('84');
  });
  it('renders nothing for no steps', () => {
    const { container } = render(<Breakdown steps={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('GradePill', () => {
  it('shows the letter, or a dash when there is no graded work', () => {
    const g = { status: 'graded', letter: 'B+', percentRounded: '87.5' } as GradeResult;
    const { rerender } = render(<GradePill grade={g} />);
    expect(screen.getByText('B+')).toBeTruthy();
    rerender(<GradePill grade={{ status: 'none' } as GradeResult} />);
    expect(screen.getByText('–')).toBeTruthy();
    expect(screen.getByTitle('No graded work yet')).toBeTruthy();
  });
});

describe('Toasts', () => {
  it('runs the undo action and dismisses', async () => {
    const onAction = vi.fn();
    const dismiss = vi.fn();
    render(
      <Toasts
        toasts={[{ id: 1, message: 'Deleted “Essay”', actionLabel: 'Undo', onAction }]}
        dismiss={dismiss}
      />,
    );
    await userEvent.click(screen.getByText('Undo'));
    expect(onAction).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledWith(1);
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });
});
