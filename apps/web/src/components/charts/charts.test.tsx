import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HorizontalBars } from './HorizontalBars.js';
import { LineChart } from './LineChart.js';
import { StackedBars } from './StackedBars.js';

/** Every chart canvas measures this many pixels wide (useWidth reads a ResizeObserver). */
function measureAs(width: number): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly callback: (entries: { contentRect: { width: number } }[]) => void;
      constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
        this.callback = callback;
      }
      observe(): void {
        this.callback([{ contentRect: { width } }]);
      }
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
}

describe('charts', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

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
    expect(screen.getByText('Q2: NAV $12M, Invested $10M')).toBeInTheDocument();
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByText('Q3: NAV $15M, Invested n/a')).toBeInTheDocument();
  });

  it('leaves a gap for a missing value instead of drawing the line through it', async () => {
    const { container } = render(
      <LineChart
        title="NAV by quarter"
        x={['Q1', 'Q2', 'Q3', 'Q4', 'Q5']}
        series={[{ name: 'NAV', values: [10, 12, null, 14, 15] }]}
        kind="money"
        format={(v) => `$${v}M`}
        summary="NAV over five quarters, one not calculable"
      />,
    );
    const lines = [...container.querySelectorAll('path[fill="none"]')];
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.getAttribute('d')?.match(/L/g)).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Show table' }));
    const table = screen.getByRole('table', { name: 'NAV by quarter, as a table' });
    expect(table).toHaveTextContent('Q3-');
  });

  it('at phone width keeps the ends of similar labels, the full names elsewhere and the values inside', async () => {
    const width = 316;
    measureAs(width);
    const { container } = render(
      <HorizontalBars
        title="NAV by vehicle"
        data={[
          { label: 'Beach Co-Invest Fund II', value: 120_000_000, display: '$1,120.0M' },
          { label: 'Beach Co-Invest Fund III', value: 40_000_000, display: '$40.0M' },
        ]}
        kind="money"
        valueColumn="NAV"
        summary="NAV by vehicle, two bars"
      />,
    );
    const labels = [...container.querySelectorAll('.pb-chart-label')].map((t) => t.textContent);
    expect(labels).toEqual(['Beach...Fund II', 'Beac...Fund III']);
    expect(screen.getByRole('img', { name: 'Beach Co-Invest Fund III: $40.0M' })).toBeTruthy();
    for (const value of container.querySelectorAll('.pb-chart-value')) {
      const x = Number(value.getAttribute('x'));
      expect(x).toBeLessThanOrEqual(width - 4);
      // A label that starts after the plot must still fit before the right edge.
      if (value.getAttribute('text-anchor') !== 'end')
        expect(x + (value.textContent ?? '').length * 6.6).toBeLessThanOrEqual(width);
    }
    await userEvent.click(screen.getByRole('button', { name: 'Show table' }));
    expect(screen.getByRole('table', { name: 'NAV by vehicle, as a table' })).toHaveTextContent(
      'Beach Co-Invest Fund III',
    );
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

  it('at phone width gives stacked bars distinct short labels and keeps the ticks inside', () => {
    const width = 300;
    measureAs(width);
    const segments = (a: number) => [
      { name: 'Healthcare', value: a, display: `$${a}.0M` },
      { name: 'Software', value: 2, display: '$2.0M' },
    ];
    const { container } = render(
      <StackedBars
        title="Exposure by vehicle"
        data={[
          { label: 'Seagrass Fund II', segments: segments(3) },
          { label: 'Seagrass Growth Fund II', segments: segments(4) },
          { label: 'Beach Co-Invest Fund III', segments: segments(5) },
        ]}
        segmentNames={['Healthcare', 'Software']}
        kind="money"
        summary="three bars, two segments"
      />,
    );
    const labels = [...container.querySelectorAll('.pb-chart-label')].map((t) => t.textContent);
    expect(new Set(labels).size).toBe(3);
    for (const label of labels) expect((label ?? '').length).toBeLessThanOrEqual(14);
    expect(
      screen.getByRole('img', {
        name: 'Seagrass Growth Fund II: Healthcare $4.0M, Software $2.0M',
      }),
    ).toBeTruthy();
    for (const tick of container.querySelectorAll('.pb-chart-tick')) {
      const half = ((tick.textContent ?? '').length * 6.6) / 2;
      expect(Number(tick.getAttribute('x')) + half).toBeLessThanOrEqual(width);
    }
  });
});
