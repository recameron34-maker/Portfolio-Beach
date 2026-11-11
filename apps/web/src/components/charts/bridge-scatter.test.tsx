import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BridgeChart, bridgeSpans, ScatterChart } from './index.js';
import type { BridgeStep, ScatterPoint } from './index.js';

const STEPS: BridgeStep[] = [
  { label: 'Invested', value: 30, display: '$30.0M', kind: 'total' },
  { label: 'EBITDA growth', value: 9, display: '+$9.0M', kind: 'change' },
  { label: 'Multiple expansion', value: -4, display: '-$4.0M', kind: 'change' },
  { label: 'Debt paydown', value: 3, display: '+$3.0M', kind: 'change' },
  { label: 'Value now', value: 38, display: '$38.0M', kind: 'total' },
];

const POINTS: ScatterPoint[] = [
  { label: 'Alpha', x: 0.1, y: 0.3, xDisplay: '10.0%', yDisplay: '30.0%', emphasis: true },
  { label: 'Beta', x: 0.4, y: 0.2, xDisplay: '40.0%', yDisplay: '20.0%', emphasis: false },
];

afterEach(cleanup);

describe('BridgeChart', () => {
  it('runs each change from the level the previous step reached, and totals from zero', () => {
    expect(bridgeSpans(STEPS)).toEqual([
      { from: 0, to: 30 },
      { from: 30, to: 39 },
      { from: 39, to: 35 },
      { from: 35, to: 38 },
      { from: 0, to: 38 },
    ]);
    expect(bridgeSpans([])).toEqual([]);
  });

  it('names every step with its figure, keeps colour from being the only signal and has a table twin', async () => {
    render(
      <BridgeChart
        title="Gain bridge"
        steps={STEPS}
        kind="money"
        summary="From 30 to 38."
        testId="bridge"
      />,
    );
    const chart = screen.getByRole('group', { name: 'Gain bridge' });
    expect(
      within(chart)
        .getAllByRole('img')
        .map((m) => m.getAttribute('aria-label')),
    ).toEqual([
      'Invested: $30.0M',
      'EBITDA growth: +$9.0M',
      'Multiple expansion: -$4.0M',
      'Debt paydown: +$3.0M',
      'Value now: $38.0M',
    ]);
    // Every mark can take keyboard focus, and the sign is in the text of the label.
    for (const mark of within(chart).getAllByRole('img'))
      expect(mark).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('From 30 to 38.')).toHaveClass('pb-visually-hidden');
    expect(
      within(screen.getByRole('list', { name: 'Legend' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Increase', 'Decrease']);
    await userEvent.click(screen.getByRole('button', { name: 'Show table' }));
    const table = screen.getByRole('table', { name: 'Gain bridge, as a table' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((r) => r.textContent),
    ).toEqual([
      'StepAmount',
      'Invested$30.0M',
      'EBITDA growth+$9.0M',
      'Multiple expansion-$4.0M',
      'Debt paydown+$3.0M',
      'Value now$38.0M',
    ]);
  });
});

describe('ScatterChart', () => {
  it('names every mark with its two figures and draws the line where the two are equal', async () => {
    render(
      <ScatterChart
        title="Mark against earnings"
        points={POINTS}
        xLabel="EBITDA growth"
        yLabel="Mark growth"
        xKind="pct"
        yKind="pct"
        equalLine
        summary="Two marks."
        testId="scatter"
      />,
    );
    const chart = screen.getByRole('group', { name: 'Mark against earnings' });
    expect(
      within(chart)
        .getAllByRole('img')
        .map((m) => m.getAttribute('aria-label')),
    ).toEqual([
      'Alpha: EBITDA growth 10.0%, Mark growth 30.0%',
      'Beta: EBITDA growth 40.0%, Mark growth 20.0%',
    ]);
    expect(screen.getByTestId('scatter-equal-line')).toBeInTheDocument();
    // One series: no legend. The table twin lists every mark.
    expect(screen.queryByRole('list', { name: 'Legend' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show table' }));
    const table = screen.getByRole('table', { name: 'Mark against earnings, as a table' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((r) => r.textContent),
    ).toEqual(['PositionEBITDA growthMark growth', 'Alpha10.0%30.0%', 'Beta40.0%20.0%']);
  });

  it('lists two or more series in the legend and names the series of each mark', () => {
    render(
      <ScatterChart
        title="Entry against outcome"
        points={[
          {
            ...POINTS[0]!,
            series: 'Under 4.0x',
            x: 9,
            y: 1.6,
            xDisplay: '9.0x',
            yDisplay: '1.60x',
          },
          {
            ...POINTS[1]!,
            series: '4.0x and over',
            x: 12,
            y: 1.1,
            xDisplay: '12.0x',
            yDisplay: '1.10x',
          },
        ]}
        xLabel="Entry multiple"
        yLabel="MOIC"
        xKind="multiple"
        yKind="multiple"
        seriesNames={['Under 4.0x', '4.0x and over']}
        seriesLabel="Entry leverage"
        summary="Two marks in two bands."
        testId="scatter"
      />,
    );
    expect(
      within(screen.getByRole('list', { name: 'Legend' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Under 4.0x', '4.0x and over']);
    expect(
      screen.getByRole('img', {
        name: 'Alpha: Entry multiple 9.0x, MOIC 1.60x, Entry leverage Under 4.0x',
      }),
    ).toBeInTheDocument();
    // No reference line unless one is asked for.
    expect(screen.queryByTestId('scatter-equal-line')).not.toBeInTheDocument();
  });

  it('draws no reference line where the two axes share no range', () => {
    render(
      <ScatterChart
        title="Apart"
        points={[
          { label: 'A', x: 9, y: 1.2, xDisplay: '9.0x', yDisplay: '1.20x' },
          { label: 'B', x: 12, y: 1.6, xDisplay: '12.0x', yDisplay: '1.60x' },
        ]}
        xLabel="Entry multiple"
        yLabel="MOIC"
        xKind="multiple"
        yKind="multiple"
        equalLine
        summary="No overlap."
        testId="apart"
      />,
    );
    expect(screen.queryByTestId('apart-equal-line')).not.toBeInTheDocument();
  });
});
