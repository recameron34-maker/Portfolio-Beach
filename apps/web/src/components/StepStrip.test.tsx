import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { StepStrip } from './StepStrip.js';
import type { Step } from './StepStrip.js';

const STEPS: readonly Step[] = [
  { key: 'draft', label: 'Draft', status: 'done' },
  { key: 'checks', label: 'QA failed', status: 'current' },
  { key: 'review', label: 'In review', status: 'upcoming' },
];

describe('the step strip', () => {
  afterEach(cleanup);

  it('lists the steps in order under its label and marks the current one', () => {
    render(<StepStrip label="Release gate" steps={STEPS} testId="gate" />);
    const strip = screen.getByRole('list', { name: 'Release gate' });
    expect(strip).toBe(screen.getByTestId('gate'));
    const items = within(strip).getAllByRole('listitem');
    expect(items.map((li) => li.firstElementChild?.textContent)).toEqual([
      'Draft',
      'QA failed',
      'In review',
    ]);
    expect(items.map((li) => li.getAttribute('data-status'))).toEqual([
      'done',
      'current',
      'upcoming',
    ]);
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(items[0]).not.toHaveAttribute('aria-current');
    expect(items[2]).not.toHaveAttribute('aria-current');
  });

  it('names the steps done and the current one, and a step ahead to a screen reader alone', () => {
    render(<StepStrip label="Release gate" steps={STEPS} />);
    const [done, current, upcoming] = screen.getAllByRole('listitem');
    expect(within(done!).getByText('Done')).toHaveClass('pb-step-state');
    expect(within(current!).getByText('Current')).toHaveClass('pb-step-state');
    expect(within(upcoming!).getByText('Upcoming')).toHaveClass('pb-visually-hidden');
    expect(upcoming!.querySelector('.pb-step-state')).toBeNull();
  });

  it('tells the stylesheet how many steps there are and how many make half a strip', () => {
    const { rerender } = render(<StepStrip label="Steps" steps={STEPS} />);
    const strip = screen.getByRole('list', { name: 'Steps' });
    expect(strip.style.getPropertyValue('--pb-steps')).toBe('3');
    expect(strip.style.getPropertyValue('--pb-steps-half')).toBe('2');
    rerender(
      <StepStrip
        label="Steps"
        steps={Array.from({ length: 8 }, (_, i) => ({
          key: String(i),
          label: `Step ${i + 1}`,
          status: 'upcoming' as const,
        }))}
      />,
    );
    expect(strip.style.getPropertyValue('--pb-steps')).toBe('8');
    expect(strip.style.getPropertyValue('--pb-steps-half')).toBe('4');
    // No step at all still gives the stylesheet a column to lay out.
    rerender(<StepStrip label="Steps" steps={[]} />);
    expect(strip.style.getPropertyValue('--pb-steps-half')).toBe('1');
    expect(within(strip).queryAllByRole('listitem')).toHaveLength(0);
  });
});
