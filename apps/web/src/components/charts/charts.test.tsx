import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HorizontalBars } from './HorizontalBars.js';
import { LineChart } from './LineChart.js';
import { StackedBars } from './StackedBars.js';

describe('charts', () => {
  afterEach(cleanup);

  it('renders bars with value labels, a tooltip on focus and a table twin', async () => {
    render(
      <HorizontalBars
        title="NAV by vehicle"
        data={[
          { label: 'Beach Co-Invest Fund I', value: 120_000_000, display: '$120.0M' },
          { label: 'Beach Credit Partners', value: 40_000_000, display: '$40.0M', emphasis: true },
        ]}
        kind="money"
        valueColumn="NAV"
        summary="NAV by vehicle, two bars"
      />,
    );
    expect(screen.getAllByText('$120.0M').length).toBeGreaterThan(0);
    const bar = screen.getByRole('img', { name: 'Beach Credit Partners: $40.0M' });
    fireEvent.focus(bar);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Beach Credit Partners');
    await userEvent.click(screen.getByRole('button', { name: 'Show table' }));
    expect(screen.getByRole('table', { name: 'NAV by vehicle, as a table' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show chart' })).toBeVisible();
  });

  it('shows a legend for two series and walks the crosshair with the keyboard', () => {
    render(
      <LineChart
        title="NAV and invested"
        x={['Q1', 'Q2', 'Q3']}
        series={[
          { name: 'NAV', values: [10, 12, 15] },
          { name: 'Invested', values: [10, 10, null] },
        ]}
        kind="money"
        format={(v) => `$${v}M`}
        summary="two series over three quarters"
      />,
    );
    expect(screen.getByRole('list', { name: 'Legend' })).toHaveTextContent('NAV');
    const svg = screen.getByRole('group', { name: 'NAV and invested' });
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('Q2: NAV $12M, Invested $10M');
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('Q3: NAV $15M, Invested n/a');
  });

  it('stacks segments with a legend in fixed order', () => {
    render(
      <StackedBars
        title="Exposure by sector"
        data={[
          {
            label: 'Fund I',
            segments: [
              { name: 'Healthcare', value: 3, display: '$3.0M' },
              { name: 'Software', value: 2, display: '$2.0M' },
            ],
          },
        ]}
        segmentNames={['Healthcare', 'Software']}
        kind="money"
        summary="one bar, two segments"
      />,
    );
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(legend.textContent).toBe('HealthcareSoftware');
    expect(
      screen.getByRole('img', { name: 'Fund I: Healthcare $3.0M, Software $2.0M' }),
    ).toBeTruthy();
  });
});
