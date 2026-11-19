import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MISSING } from '../../lib/format.js';
import {
  BridgeChart,
  HorizontalBars,
  LineChart,
  ScatterChart,
  SharedScale,
  StackedBars,
} from './index.js';
import type { BridgeStep, ScatterPoint, StackDatum } from './index.js';

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

/** The browser allows motion (matchMedia answers no to the reduced-motion query). */
function motionAllowed(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

const STEPS: BridgeStep[] = [
  { label: 'Invested', value: 30, display: '$30.0M', kind: 'total' },
  { label: 'EBITDA growth', value: 9, display: '+$9.0M', kind: 'change' },
  { label: 'Multiple expansion', value: -4, display: '-$4.0M', kind: 'change' },
  { label: 'Value now', value: 35, display: '$35.0M', kind: 'total' },
];

const STACKS: StackDatum[] = [
  {
    label: 'Fund I',
    segments: [
      { name: 'Equity', value: 60, display: '$60.0M' },
      { name: 'Credit', value: 40, display: '$40.0M' },
      // Too narrow for its figure: the tooltip and the table carry it.
      { name: 'Fund', value: 1, display: '$1.0M' },
    ],
  },
  { label: 'Fund II', segments: [{ name: 'Equity', value: 30, display: '$30.0M' }] },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('chart marks', () => {
  it('grows only the bar and step paths, never the row that holds a label or a printed figure', () => {
    measureAs(600);
    const { container } = render(
      <>
        <HorizontalBars
          title="Bars"
          data={[
            { label: 'Up', value: 5, display: '$5' },
            { label: 'Down', value: -3, display: '-$3' },
          ]}
          kind="money"
          valueColumn="Value"
          summary="two bars"
        />
        <StackedBars
          title="Stacks"
          data={STACKS}
          segmentNames={['Equity', 'Credit', 'Fund']}
          kind="money"
          summary="two stacks"
        />
        <BridgeChart title="Bridge" steps={STEPS} kind="money" summary="a bridge" />
      </>,
    );
    const grown = [...container.querySelectorAll('.pb-chart-bar, .pb-chart-step')];
    expect(grown.length).toBe(2 + 4 + 4);
    for (const el of grown) expect(el.tagName.toLowerCase()).toBe('path');
    expect(container.querySelectorAll('g.pb-chart-bar, g.pb-chart-step')).toHaveLength(0);
    // The row group stays the interaction hook and carries its place in the stagger.
    const rows = [...container.querySelectorAll('g.pb-chart-mark')];
    expect(rows.map((g) => (g as SVGGElement).style.getPropertyValue('--i'))).toEqual([
      '0',
      '1',
      '0',
      '1',
      '0',
      '1',
      '2',
      '3',
    ]);
    // A negative bar and a decrease grow from their right ends.
    expect(
      screen.getByRole('img', { name: 'Down: -$3' }).querySelector('.pb-chart-bar'),
    ).toHaveClass('is-negative');
    expect(
      screen
        .getByRole('img', { name: 'Multiple expansion: -$4.0M' })
        .querySelector('.pb-chart-step'),
    ).toHaveClass('is-negative');
  });

  it('draws bars 12px tall with square ends in 26px rows beside their labels', () => {
    measureAs(600);
    const { container } = render(
      <HorizontalBars
        title="Bars"
        data={[
          { label: 'A', value: 5, display: '$5' },
          { label: 'B', value: 2, display: '$2' },
        ]}
        kind="money"
        valueColumn="Value"
        summary="two bars"
      />,
    );
    const [first, second] = [...container.querySelectorAll('.pb-chart-bar')].map(
      (p) => p.getAttribute('d') ?? '',
    );
    const topOf = (d: string | undefined): number =>
      Number(/^M[\d.-]+ ([\d.]+)H/.exec(d ?? '')?.[1]);
    // Each bar runs 12px down its side ("V" to the top plus 12, less the 1px end) ...
    const top = topOf(first);
    expect(first).toContain(`V${top + 12 - 1}`);
    // ... with at most a 1px softening at the data end, and the next row 26px lower.
    expect(first).toMatch(/a1 1 0 0 1 1 1/);
    expect(topOf(second) - top).toBe(26);
  });

  it('prints each stacked value that fits inside its segment, and a lone segment past its tip', () => {
    measureAs(600);
    const { container } = render(
      <StackedBars
        title="Stacks"
        data={STACKS}
        segmentNames={['Equity', 'Credit', 'Fund']}
        kind="money"
        summary="two stacks"
      />,
    );
    const inside = [...container.querySelectorAll('.pb-chart-inlabel-text')].map(
      (t) => t.textContent,
    );
    expect(inside).toEqual(['$60.0M', '$40.0M']);
    for (const plate of container.querySelectorAll('.pb-chart-inlabel-plate')) {
      expect(plate.getAttribute('rx')).toBe('2');
    }
    // The bar of one segment carries its figure after its end, as a single bar does.
    const lone = screen.getByRole('img', { name: 'Fund II: Equity $30.0M' });
    const value = lone.querySelector('.pb-chart-value');
    expect(value).toHaveTextContent('$30.0M');
    expect(lone.querySelector('.pb-chart-inlabel')).toBeNull();
    const path = lone.querySelector('.pb-chart-bar')?.getAttribute('d') ?? '';
    const barEnd = Number(/H([\d.]+)a/.exec(path)?.[1]) + 1;
    expect(Number(value?.getAttribute('x'))).toBeGreaterThan(barEnd);
    // The segments are parted by a 1px rule in the page colour.
    const parted = container.querySelectorAll('.pb-chart-bar[stroke="var(--pb-bg)"]');
    expect(parted).toHaveLength(3);
    for (const p of parted) expect(p.getAttribute('stroke-width')).toBe('1');
  });

  it('gives charts set side by side in a SharedScale one value axis', () => {
    measureAs(600);
    render(
      <SharedScale>
        <HorizontalBars
          title="Contributions"
          data={[{ label: '2024', value: 200, display: '$200' }]}
          kind="money"
          valueColumn="Contributions"
          summary="one year"
        />
        <HorizontalBars
          title="Distributions"
          data={[{ label: '2024', value: 50, display: '$50' }]}
          kind="money"
          valueColumn="Distributions"
          summary="one year"
        />
      </SharedScale>,
    );
    const ticks = (name: string) =>
      [...screen.getByRole('group', { name }).querySelectorAll('.pb-chart-tick')].map(
        (t) => t.textContent,
      );
    expect(ticks('Distributions')).toEqual(ticks('Contributions'));
    expect(ticks('Contributions').at(-1)).toBe('$200');
    // Equal lengths are equal figures: $50 is a quarter of the $200 bar.
    const width = (name: string): number => {
      const d = screen
        .getByRole('group', { name })
        .querySelector('.pb-chart-bar')
        ?.getAttribute('d');
      const [start, end] = [/^M([\d.]+)/.exec(d ?? '')?.[1], /H([\d.]+)a/.exec(d ?? '')?.[1]];
      return Number(end) + 1 - Number(start);
    };
    expect(width('Distributions') / width('Contributions')).toBeCloseTo(0.25, 2);
  });

  it('keeps each chart on its own axis outside a SharedScale', () => {
    measureAs(600);
    render(
      <HorizontalBars
        title="Distributions"
        data={[{ label: '2024', value: 50, display: '$50' }]}
        kind="money"
        valueColumn="Distributions"
        summary="one year"
      />,
    );
    const ticks = [
      ...screen.getByRole('group', { name: 'Distributions' }).querySelectorAll('.pb-chart-tick'),
    ].map((t) => t.textContent);
    expect(ticks.at(-1)).toBe('$50');
  });
});

describe('line charts', () => {
  it('draws one series as a line with no wash under it, and no end label', () => {
    measureAs(600);
    const { container } = render(
      <LineChart
        title="NAV by quarter"
        x={['Q1', 'Q2', 'Q3']}
        series={[{ name: 'NAV', values: [10, 12, 15] }]}
        kind="money"
        format={(v) => `$${v}M`}
        summary="three quarters"
      />,
    );
    const paths = container.querySelectorAll('svg.pb-chart-svg path');
    expect(paths).toHaveLength(1);
    const line = paths[0];
    expect(line).toHaveClass('pb-chart-line');
    expect(line?.getAttribute('fill')).toBe('none');
    expect(line?.getAttribute('stroke-width')).toBe('1.75');
    expect(line?.getAttribute('pathLength')).toBe('1');
    expect(container.querySelectorAll('.pb-chart-label')).toHaveLength(0);
    // The end marker fades in after the line has drawn.
    expect(container.querySelectorAll('circle.pb-chart-end')).toHaveLength(1);
  });

  it('moves end labels apart instead of dropping one, each joined to its line by a leader', () => {
    measureAs(600);
    const { container } = render(
      <LineChart
        title="Two close lines"
        x={['Q1', 'Q2']}
        // On a 0 to 120 axis 200px tall these two end about 3px apart.
        series={[
          { name: 'Revenue', values: [100, 102] },
          { name: 'EBITDA', values: [98, 100] },
        ]}
        kind="money"
        format={(v) => `$${v}M`}
        summary="two lines"
      />,
    );
    const labels = [...container.querySelectorAll('g.pb-chart-end text')];
    expect(labels.map((t) => t.textContent)).toEqual(['Revenue', 'EBITDA']);
    const [a, b] = labels.map((t) => Number(t.getAttribute('y')));
    expect((b ?? 0) - (a ?? 0)).toBeGreaterThanOrEqual(14);
    expect(container.querySelectorAll('.pb-chart-leader').length).toBeGreaterThanOrEqual(1);
  });

  it('frames the axis by the figures when the baseline need not be zero', () => {
    measureAs(600);
    const ticksOf = (baselineZero: boolean): string[] => {
      cleanup();
      const { container } = render(
        <LineChart
          title="Indexed"
          x={['Entry', 'Q1', 'Q2']}
          series={[{ name: 'EBITDA', values: [100, 120, 135] }]}
          kind="count"
          format={(v) => v.toFixed(1)}
          summary="three points"
          baselineZero={baselineZero}
        />,
      );
      return [...container.querySelectorAll('.pb-chart-tick[text-anchor="end"]')].map(
        (t) => t.textContent ?? '',
      );
    };
    expect(ticksOf(true)[0]).toBe('0');
    const framed = ticksOf(false);
    // The lowest gridline is labelled with its own figure, and no zero line is drawn.
    expect(framed[0]).toBe('100');
    expect(framed).not.toContain('0');
    expect(document.querySelector('.pb-chart-axis')).toBeNull();
  });

  it('marks the axis broken after a point, and the line runs on across the break', () => {
    measureAs(600);
    const { container } = render(
      <LineChart
        title="Indexed since entry"
        x={['Entry', 'Mar 2025', 'Jun 2025']}
        series={[{ name: 'EBITDA', values: [100, 120, 135] }]}
        kind="count"
        format={(v) => v.toFixed(1)}
        summary="three points"
        breakAfter={0}
      />,
    );
    expect(container.querySelectorAll('.pb-chart-break line')).toHaveLength(2);
    expect(container.querySelectorAll('.pb-chart-line')).toHaveLength(1);
  });

  it('shows the missing placeholder in the tooltip and names the gap in the live region', () => {
    render(
      <LineChart
        title="NAV and invested"
        x={['Q1', 'Q2']}
        series={[
          { name: 'NAV', values: [10, 12] },
          { name: 'Invested', values: [10, null] },
        ]}
        kind="money"
        format={(v) => `$${v}M`}
        summary="two series"
      />,
    );
    const svg = screen.getByRole('group', { name: 'NAV and invested' });
    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent(`${MISSING}Invested`);
    expect(tip).not.toHaveTextContent('n/a');
    expect(screen.getByText('Q2: NAV $12M, Invested n/a')).toBeInTheDocument();
  });
});

describe('scatter outliers', () => {
  const points: ScatterPoint[] = [
    { label: 'A', x: 0.05, y: 0.1, xDisplay: '5.0%', yDisplay: '10.0%' },
    { label: 'B', x: 0.08, y: 0.2, xDisplay: '8.0%', yDisplay: '20.0%' },
    { label: 'C', x: 0.1, y: 0.3, xDisplay: '10.0%', yDisplay: '30.0%' },
    { label: 'D', x: 0.12, y: 0.25, xDisplay: '12.0%', yDisplay: '25.0%' },
    { label: 'E', x: 0.15, y: 0.4, xDisplay: '15.0%', yDisplay: '40.0%' },
    { label: 'Far', x: -1.18, y: 0.05, xDisplay: '-118.0%', yDisplay: '5.0%' },
  ];

  it('holds a mark far beyond the rest at the axis edge, prints its figure and says so', async () => {
    measureAs(600);
    const { container } = render(
      <ScatterChart
        title="Growth"
        points={points}
        xLabel="EBITDA growth"
        yLabel="Mark growth"
        xKind="pct"
        yKind="pct"
        clampOutliers
        summary="six marks"
        testId="scatter"
      />,
    );
    const held = screen.getByRole('img', {
      name: 'Far: EBITDA growth -118.0%, Mark growth 5.0%',
    });
    expect(held).toHaveAttribute('data-held', 'left');
    // A hollow ring with an arrow pointing out of the plot.
    const ring = held.querySelector('circle:not(.pb-chart-hit)');
    expect(ring?.getAttribute('fill')).toBe('var(--pb-bg)');
    expect(held.querySelector('path')).not.toBeNull();
    expect(within(container).getByText('-118.0%')).toHaveClass('pb-chart-value');
    expect(screen.getByText('1 mark beyond the axis is drawn at its edge.')).toBeInTheDocument();
    // The axis no longer reaches down to the outlier.
    const xTicks = [...container.querySelectorAll('.pb-chart-tick[text-anchor="middle"]')].map(
      (t) => t.textContent,
    );
    expect(xTicks).not.toContain('-120%');
    // The tooltip and the table keep the exact figure.
    fireEvent.focus(held);
    expect(screen.getByRole('tooltip')).toHaveTextContent('-118.0%');
    await userEvent.click(screen.getByRole('button', { name: 'Show table' }));
    expect(screen.getByRole('table', { name: 'Growth, as a table' })).toHaveTextContent(
      'Far-118.0%5.0%',
    );
  });

  it('holds nothing without the option, or when no mark is far from the rest', () => {
    measureAs(600);
    const { container } = render(
      <ScatterChart
        title="Growth"
        points={points}
        xLabel="EBITDA growth"
        yLabel="Mark growth"
        xKind="pct"
        yKind="pct"
        summary="six marks"
      />,
    );
    expect(container.querySelector('[data-held]')).toBeNull();
    expect(screen.queryByText(/beyond the axis/)).toBeNull();
    cleanup();
    render(
      <ScatterChart
        title="Growth"
        points={points.slice(0, 5)}
        xLabel="EBITDA growth"
        yLabel="Mark growth"
        xKind="pct"
        yKind="pct"
        clampOutliers
        summary="five marks"
      />,
    );
    expect(document.querySelector('[data-held]')).toBeNull();
  });

  it('stands 360px tall from 900px of width, 300px below it', () => {
    measureAs(960);
    render(
      <ScatterChart
        title="Wide"
        points={points}
        xLabel="x"
        yLabel="y"
        xKind="pct"
        yKind="pct"
        summary="wide"
      />,
    );
    expect(screen.getByRole('group', { name: 'Wide' }).getAttribute('height')).toBe('360');
    cleanup();
    measureAs(600);
    render(
      <ScatterChart
        title="Narrow"
        points={points}
        xLabel="x"
        yLabel="y"
        xKind="pct"
        yKind="pct"
        summary="narrow"
      />,
    );
    expect(screen.getByRole('group', { name: 'Narrow' }).getAttribute('height')).toBe('300');
  });
});

describe('the chart figure', () => {
  const line = (
    <LineChart
      title="NAV by quarter"
      x={['Q1', 'Q2']}
      series={[{ name: 'NAV', values: [1, 2] }]}
      kind="money"
      format={(v) => `$${v}M`}
      summary="two quarters"
      testId="nav"
    />
  );

  it('plays the entrance once the canvas is measured, then clears it for good', () => {
    vi.useFakeTimers();
    motionAllowed();
    measureAs(500);
    render(line);
    const figure = screen.getByTestId('nav');
    expect(figure).toHaveAttribute('data-entering');
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(figure).not.toHaveAttribute('data-entering');
    // The table and back do not replay it.
    fireEvent.click(screen.getByRole('button', { name: 'Show table' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show chart' }));
    expect(screen.getByTestId('nav')).not.toHaveAttribute('data-entering');
  });

  it('never plays the entrance under reduced motion', () => {
    measureAs(500);
    render(line);
    expect(screen.getByTestId('nav')).not.toHaveAttribute('data-entering');
    expect(screen.getByTestId('nav')).not.toHaveAttribute('data-waiting');
  });

  it('fades in only the view the reader swaps to, never the first one', async () => {
    measureAs(500);
    const { container } = render(line);
    expect(container.querySelector('.pb-swap-in')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show table' }));
    const table = screen.getByRole('table', { name: 'NAV by quarter, as a table' });
    expect(table.closest('.pb-swap-in')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show chart' }));
    expect(container.querySelector('.pb-chart-wrap')).toHaveClass('pb-swap-in');
  });

  it('keeps a hidden caption as the name of the figure and of its table', async () => {
    measureAs(500);
    render(
      <HorizontalBars
        title="NAV by vehicle"
        hideCaption
        data={[{ label: 'Fund I', value: 5, display: '$5' }]}
        kind="money"
        valueColumn="NAV"
        summary="one bar"
        testId="bars"
      />,
    );
    expect(screen.getByRole('figure', { name: 'NAV by vehicle' })).toBeInTheDocument();
    expect(screen.getByText('NAV by vehicle', { selector: 'span' })).toHaveClass(
      'pb-visually-hidden',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Show table' }));
    expect(screen.getByRole('table', { name: 'NAV by vehicle, as a table' })).toBeInTheDocument();
  });
});
