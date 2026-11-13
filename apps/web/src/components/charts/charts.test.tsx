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

/** Each new canvas measures the next width in the list, so a remounted canvas reads a new size. */
function measureInTurn(widths: number[]): void {
  let mounted = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly callback: (entries: { contentRect: { width: number } }[]) => void;
      constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
        this.callback = callback;
      }
      observe(): void {
        const width = widths[Math.min(mounted, widths.length - 1)] ?? 0;
        mounted += 1;
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

  it('measures the canvas again after the table view and back, so the chart keeps its real width', async () => {
    measureInTurn([316, 500]);
    render(
      <LineChart
        title="NAV by quarter"
        x={['Q1', 'Q2']}
        series={[{ name: 'NAV', values: [1, 2] }]}
        kind="money"
        format={(v) => `$${v}M`}
        summary="two quarters"
      />,
    );
    const svg = () => screen.getByRole('group', { name: 'NAV by quarter' });
    expect(svg().getAttribute('width')).toBe('316');
    await userEvent.click(screen.getByRole('button', { name: 'Show table' }));
    await userEvent.click(screen.getByRole('button', { name: 'Show chart' }));
    expect(svg().getAttribute('width')).toBe('500');
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

  it('draws a series through the dates it has no point at by design, and keeps the placeholder in the table', async () => {
    const { container } = render(
      <LineChart
        title="EBITDA, actual and plan"
        x={['Dec 2022', 'Jan 2023', 'Mar 2023']}
        series={[
          // January is a plan date no quarter ends on: the actual has nothing to miss there.
          { name: 'Actual', values: [10, null, 11], absent: [false, true, false] },
          { name: 'Plan', values: [9, 12, 12.5] },
        ]}
        kind="money"
        format={(v) => `$${v}M`}
        summary="actual and plan over three dates"
      />,
    );
    const lines = [...container.querySelectorAll('path[fill="none"]')];
    // One stroke per series: the actual is not cut in two at the plan date.
    expect(lines).toHaveLength(2);
    expect(lines[0]?.getAttribute('d')?.match(/L/g)).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Show table' }));
    expect(
      screen.getByRole('table', { name: 'EBITDA, actual and plan, as a table' }),
    ).toHaveTextContent('Jan 2023-$12M');
  });

  it('places points by their own positions when given, so uneven dates are drawn that far apart', () => {
    const drawn = (dates: string[], at: number[]): { xs: string[]; named: (string | null)[] } => {
      cleanup();
      measureAs(552);
      const { container } = render(
        <LineChart
          title="Plan by date"
          x={dates}
          at={at}
          series={[{ name: 'Plan', values: [10, 11, 14] }]}
          kind="money"
          format={(v) => `$${v}M`}
          summary="a plan over three dates"
        />,
      );
      const path = container.querySelector('path[fill="none"]')?.getAttribute('d') ?? '';
      return {
        xs: path.split('L').map((point) => point.replace('M', '').split(' ')[0] ?? ''),
        named: [...container.querySelectorAll('text.pb-chart-tick[text-anchor="middle"]')].map(
          (t) => t.textContent,
        ),
      };
    };
    // Days since the first date: the middle point is a quarter of the way along, not half. 552
    // wide less the 56 and 96 of padding leaves 400 to plot over, from 56.
    const spread = drawn(['Dec 2022', 'Mar 2023', 'Dec 2023'], [0, 90, 360]);
    expect(spread.xs).toEqual(['56', '156', '456']);
    expect(spread.named).toEqual(['Dec 2022', 'Mar 2023', 'Dec 2023']);
    // A date too close to the one named after it goes without a label; the table twin has all.
    const close = drawn(['Dec 2022', 'Jan 2023', 'Dec 2023'], [0, 36, 360]);
    expect(close.xs).toEqual(['56', '96', '456']);
    expect(close.named).toEqual(['Jan 2023', 'Dec 2023']);
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
