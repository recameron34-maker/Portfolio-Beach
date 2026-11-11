import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { investmentValueCreation, valueCreation } from '@pb/contracts';
import { failing, mockApi, ok, problemFixture } from '../../test/api-mock.js';
import { renderWithQuery } from '../../test/render.js';
import { MISSING } from '../../lib/format.js';
import { EntryMetricsTab } from './EntryMetricsTab.js';
import { ValueCreationTab } from './ValueCreationTab.js';
import {
  investmentValueCreationFixture,
  saltmarsh,
  valueCreationFixture,
} from './value-creation.fixtures.js';
import {
  DEFAULT_SORT,
  formatSignedMoneyM,
  formatSignedTurns,
  growthPoints,
  leftOutText,
  moicBars,
  nextSort,
  portfolioBridgeSteps,
  sortPositions,
} from './value-creation.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const VIEW = '/api/v1/analytics/value-creation';
const EXPORT = '/api/v1/analytics/value-creation/export';

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** The first column of a table's body rows, top to bottom. */
const firstCells = (table: HTMLElement): string[] =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0]?.textContent ?? '');

const rowOf = (table: HTMLElement, text: string): HTMLElement => {
  const row = within(table).getByText(text).closest('tr');
  if (row === null) throw new Error(`no row for ${text}`);
  return row;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('value creation fixtures and helpers', () => {
  it('the fixtures match the contracts the API serves', () => {
    const view = valueCreation.safeParse(valueCreationFixture());
    expect(view.success, JSON.stringify(view.error?.issues)).toBe(true);
    const one = investmentValueCreation.safeParse(investmentValueCreationFixture());
    expect(one.success, JSON.stringify(one.error?.issues)).toBe(true);
  });

  it('writes changes with their sign and a missing figure as the placeholder, never as zero', () => {
    expect(formatSignedMoneyM('5947368.42')).toBe('+$5.9M');
    expect(formatSignedMoneyM('-368421.05')).toBe('-$0.4M');
    expect(formatSignedMoneyM('0')).toBe('$0.0M');
    expect(formatSignedMoneyM(null)).toBe(MISSING);
    expect(formatSignedTurns('1')).toBe('+1.0x');
    expect(formatSignedTurns('-1.9038461538')).toBe('-1.9x');
    expect(formatSignedTurns(null)).toBe(MISSING);
  });

  it('builds our bridge from invested capital to the value now, and opens EBITDA growth on request', () => {
    const { portfolio } = valueCreationFixture();
    expect(
      portfolioBridgeSteps(portfolio, false)?.map((s) => [s.label, s.display, s.kind]),
    ).toEqual([
      ['Invested', '$30.0M', 'total'],
      ['EBITDA growth', '+$5.9M', 'change'],
      ['Multiple expansion', '+$0.9M', 'change'],
      ['Debt paydown', '+$1.0M', 'change'],
      ['Value now', '$37.9M', 'total'],
    ]);
    expect(portfolioBridgeSteps(portfolio, true)?.map((s) => s.label)).toEqual([
      'Invested',
      'Revenue growth',
      'Margin change',
      'Multiple expansion',
      'Debt paydown',
      'Value now',
    ]);
    // Without the two parts the step stays whole; without a split there is no bridge at all.
    const whole = {
      ...portfolio,
      gainByDriver: { ...portfolio.gainByDriver!, revenueGrowth: null, marginChange: null },
    };
    expect(portfolioBridgeSteps(whole, true)?.map((s) => s.label)).toContain('EBITDA growth');
    expect(portfolioBridgeSteps({ ...portfolio, gainByDriver: null }, false)).toBeNull();
  });

  it('plots only positions with both figures, each on its side of the line where the two are equal', () => {
    const plotted = growthPoints(valueCreationFixture().positions);
    expect(plotted.points.map((p) => [p.label, p.xDisplay, p.yDisplay, p.series])).toEqual([
      ['Saltmarsh Holdings', '62.5%', '69.0%', 'Mark ahead of EBITDA growth'],
      ['Kelp Forest Foods', '16.7%', '5.0%', 'Mark at or behind EBITDA growth'],
      ['Dune Grass Logistics', '-125.0%', '-25.0%', 'Mark ahead of EBITDA growth'],
    ]);
    expect(plotted.leftOut).toBe(1);
    expect(plotted.ahead).toBe(2);
    expect(plotted.seriesNames).toEqual([
      'Mark ahead of EBITDA growth',
      'Mark at or behind EBITDA growth',
    ]);
    // With every mark on one side there is one series, so the chart draws no legend.
    expect(growthPoints([saltmarsh()]).seriesNames).toEqual(['Mark ahead of EBITDA growth']);
  });

  it('gives a band a bar only when it has a MOIC', () => {
    const bars = moicBars(valueCreationFixture().cohorts.byEntryMultiple);
    expect(bars.map((b) => [b.label, b.display])).toEqual([
      ['9.0x to 11.0x', '1.26x'],
      ['11.0x to 13.0x', '0.75x'],
    ]);
  });

  it('sorts with not calculable last in both directions, and flips a column pressed twice', () => {
    const rows = valueCreationFixture().positions;
    const by = (key: Parameters<typeof nextSort>[1], direction: 'ascending' | 'descending') =>
      sortPositions(rows, { key, direction }).map((p) => p.investmentNumber);
    expect(by('gain', 'descending')).toEqual(['INV-0001', 'INV-0002', 'INV-0003', 'INV-0004']);
    expect(by('gain', 'ascending')).toEqual(['INV-0004', 'INV-0002', 'INV-0003', 'INV-0001']);
    // The two positions with no entry multiple or no driver sort last either way.
    expect(by('gainEbitdaGrowth', 'descending')).toEqual([
      'INV-0001',
      'INV-0002',
      'INV-0003',
      'INV-0004',
    ]);
    expect(by('gainEbitdaGrowth', 'ascending')).toEqual([
      'INV-0002',
      'INV-0001',
      'INV-0003',
      'INV-0004',
    ]);
    expect(by('entryMultiple', 'ascending')).toEqual([
      'INV-0002',
      'INV-0001',
      'INV-0004',
      'INV-0003',
    ]);
    expect(by('companyName', 'ascending')).toEqual([
      'INV-0004',
      'INV-0002',
      'INV-0001',
      'INV-0003',
    ]);
    expect(nextSort(DEFAULT_SORT, 'gain')).toEqual({ key: 'gain', direction: 'ascending' });
    expect(nextSort(DEFAULT_SORT, 'grossMoic')).toEqual({
      key: 'grossMoic',
      direction: 'descending',
    });
    expect(nextSort(DEFAULT_SORT, 'companyName')).toEqual({
      key: 'companyName',
      direction: 'ascending',
    });
  });

  it('says which deal types are left out, in the response own words', () => {
    expect(leftOutText([])).toBeNull();
    expect(leftOutText(valueCreationFixture().leftOut)).toBe(
      '2 private credit positions are not part of this view: it covers equity co-investments and continuation vehicles.',
    );
    expect(
      leftOutText([
        { dealType: 'deal_type.private_credit', label: 'Private credit', count: 1 },
        { dealType: 'deal_type.primary_fund', label: 'Primary fund', count: 3 },
      ]),
    ).toMatch(/^1 private credit and 3 primary fund positions are not part of this view/);
  });
});

describe('Analytics: Value creation tab', () => {
  it('leads with our gain and its three drivers, then the bridge from invested capital to the value now', async () => {
    mockApi({ [VIEW]: ok(valueCreationFixture()) });
    renderWithQuery(<ValueCreationTab />);
    const tiles = await screen.findByTestId('value-creation-tiles');
    const tile = (name: string): HTMLElement => within(tiles).getByRole('group', { name });
    expect(tile('Our gain')).toHaveTextContent('$7.9M');
    expect(tile('Our gain')).toHaveTextContent('2 positions');
    expect(tile('EBITDA growth')).toHaveTextContent('+$5.9M');
    expect(tile('Multiple expansion')).toHaveTextContent('+$0.9M');
    expect(tile('Debt paydown')).toHaveTextContent('+$1.0M');
    // The headline comes before any detail on the page.
    const all = screen.getAllByRole('group').filter((g) => g.getAttribute('aria-label') !== null);
    expect(all[0]).toBe(tile('Our gain'));

    const bridge = screen.getByRole('group', { name: 'Our gain by driver' });
    for (const name of [
      'Invested: $30.0M',
      'EBITDA growth: +$5.9M',
      'Multiple expansion: +$0.9M',
      'Debt paydown: +$1.0M',
      'Value now: $37.9M',
    ])
      expect(within(bridge).getByRole('img', { name })).toBeInTheDocument();
    expect(screen.getByText(/As of Jun 30, 2025/)).toBeInTheDocument();
    expect(
      screen.getByText(/2 private credit positions are not part of this view/),
    ).toBeInTheDocument();
  });

  it('opens EBITDA growth into revenue growth and margin change, and offers the bridge as a table', async () => {
    mockApi({ [VIEW]: ok(valueCreationFixture()) });
    renderWithQuery(<ValueCreationTab />);
    const bridge = await screen.findByTestId('value-creation-bridge');
    expect(within(bridge).queryByRole('img', { name: /Revenue growth/ })).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('switch', {
        name: 'Open EBITDA growth into revenue growth and margin change',
      }),
    );
    expect(within(bridge).getByRole('img', { name: 'Revenue growth: +$4.1M' })).toBeInTheDocument();
    expect(within(bridge).getByRole('img', { name: 'Margin change: +$1.8M' })).toBeInTheDocument();
    expect(within(bridge).queryByRole('img', { name: /^EBITDA growth/ })).not.toBeInTheDocument();

    await userEvent.click(within(bridge).getByRole('button', { name: 'Show table' }));
    const table = within(bridge).getByRole('table', { name: 'Our gain by driver, as a table' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((r) => r.textContent),
    ).toEqual([
      'StepAmount',
      'Invested$30.0M',
      'Revenue growth+$4.1M',
      'Margin change+$1.8M',
      'Multiple expansion+$0.9M',
      'Debt paydown+$1.0M',
      'Value now$37.9M',
    ]);
  });

  it('counts the positions the split leaves out quietly, with the reasons on demand', async () => {
    mockApi({ [VIEW]: ok(valueCreationFixture()) });
    renderWithQuery(<ValueCreationTab />);
    const note = await screen.findByTestId('value-creation-not-calculable');
    expect(within(note).getByText('2 positions are not in this split')).toBeInTheDocument();
    const list = within(note).getByRole('list');
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Tidepool Analytics (INV-0003): No approved entry snapshot on or before the as-of date',
      'Dune Grass Logistics (INV-0004): EBITDA is at or below zero at entry or in the current quarter',
    ]);
    // With every position in the split there is nothing to say.
    cleanup();
    vi.restoreAllMocks();
    const base = valueCreationFixture();
    mockApi({
      [VIEW]: ok(
        valueCreationFixture({
          positions: base.positions.slice(0, 2),
          portfolio: { ...base.portfolio, notCalculable: [] },
        }),
      ),
    });
    renderWithQuery(<ValueCreationTab />);
    await screen.findByTestId('value-creation-tiles');
    expect(screen.queryByTestId('value-creation-not-calculable')).not.toBeInTheDocument();
  });

  it('plots valuation growth against EBITDA growth with the line where the two are equal', async () => {
    mockApi({ [VIEW]: ok(valueCreationFixture()) });
    renderWithQuery(<ValueCreationTab />);
    const chart = await screen.findByRole('group', {
      name: 'Valuation growth against EBITDA growth',
    });
    expect(
      within(chart).getByRole('img', {
        name: 'Saltmarsh Holdings: EBITDA growth since entry 62.5%, Growth in our mark 69.0%, Side of the line Mark ahead of EBITDA growth',
      }),
    ).toBeInTheDocument();
    expect(
      within(chart).getByRole('img', {
        name: 'Kelp Forest Foods: EBITDA growth since entry 16.7%, Growth in our mark 5.0%, Side of the line Mark at or behind EBITDA growth',
      }),
    ).toBeInTheDocument();
    expect(within(chart).queryByRole('img', { name: /Tidepool/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('value-creation-scatter-equal-line')).toBeInTheDocument();
    expect(
      screen.getByText(
        '2 of 3 marks sit above the line: our mark grew faster than the company EBITDA. 1 position has no EBITDA growth or no mark growth and is not plotted.',
      ),
    ).toBeInTheDocument();
    const figure = screen.getByTestId('value-creation-scatter');
    await userEvent.click(within(figure).getByRole('button', { name: 'Show table' }));
    const table = within(figure).getByRole('table', {
      name: 'Valuation growth against EBITDA growth, as a table',
    });
    expect(rowOf(table, 'Kelp Forest Foods')).toHaveTextContent(
      'Kelp Forest Foods16.7%5.0%Mark at or behind EBITDA growth',
    );
    await userEvent.click(within(figure).getByRole('button', { name: 'Show chart' }));
    expect(
      within(within(figure).getByRole('list', { name: 'Legend' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Mark ahead of EBITDA growth', 'Mark at or behind EBITDA growth']);
  });

  it('lists every position with its multiples, drivers, MOIC and IRR; a missing figure is the placeholder with its reason', async () => {
    mockApi({ [VIEW]: ok(valueCreationFixture()) });
    renderWithQuery(<ValueCreationTab />);
    const table = await screen.findByRole('table', { name: 'Value creation by position' });
    expect(firstCells(table)).toEqual(['INV-0001', 'INV-0002', 'INV-0003', 'INV-0004']);
    const first = rowOf(table, 'Saltmarsh Holdings');
    expect(first).toHaveTextContent(
      'INV-0001Saltmarsh Holdings10.0x11.0x3.8x1.8x62.5%69.0%$6.9M+$5.0M+$1.3M+$0.6M1.69x9.1%',
    );
    expect(within(first).getByRole('link', { name: 'Saltmarsh Holdings' })).toHaveAttribute(
      'href',
      `/portfolio/${saltmarsh().id}/performance`,
    );
    // No entry snapshot: no multiples at entry, no drivers, and the reason in words; never a zero.
    const none = rowOf(table, 'Tidepool Analytics');
    expect(none).toHaveTextContent(
      `INV-0003Tidepool Analytics${MISSING}11.0x${MISSING}1.8x${MISSING}20.0%$1.0M${MISSING} No approved entry snapshot on or before the as-of date1.20x6.2%`,
    );
    expect(none).not.toHaveTextContent('$0.0M');
    // The three driver columns share one cell, so the reason sits where the figures would.
    expect(within(none).getAllByRole('cell')).toHaveLength(12);
    expect(within(first).getAllByRole('cell')).toHaveLength(14);
    const negative = rowOf(table, 'Dune Grass Logistics');
    // A realized position says so under its name; an active one says nothing.
    expect(negative).toHaveTextContent('Dune Grass LogisticsRealized12.5x');
    expect(first).not.toHaveTextContent('Realized');
    expect(negative).toHaveTextContent('-$2.0M');
    expect(negative).toHaveTextContent(
      'EBITDA is at or below zero at entry or in the current quarter',
    );
    // No current multiple or leverage either: placeholders, each in its own cell.
    expect(within(negative).getAllByText(MISSING)).toHaveLength(2);
  });

  it('sorts by a column from its header, largest first, and the other way on a second press', async () => {
    mockApi({ [VIEW]: ok(valueCreationFixture()) });
    renderWithQuery(<ValueCreationTab />);
    const table = await screen.findByRole('table', { name: 'Value creation by position' });
    const header = (name: string): HTMLElement =>
      within(table).getByRole('columnheader', { name: new RegExp(`^${name}`) });
    expect(header('Our gain')).toHaveAttribute('aria-sort', 'descending');
    expect(header('Gross MOIC')).toHaveAttribute('aria-sort', 'none');

    await userEvent.click(within(header('Gross MOIC')).getByRole('button'));
    expect(header('Gross MOIC')).toHaveAttribute('aria-sort', 'descending');
    expect(header('Our gain')).toHaveAttribute('aria-sort', 'none');
    expect(firstCells(table)).toEqual(['INV-0001', 'INV-0003', 'INV-0002', 'INV-0004']);

    await userEvent.click(within(header('Gross MOIC')).getByRole('button'));
    expect(header('Gross MOIC')).toHaveAttribute('aria-sort', 'ascending');
    expect(firstCells(table)).toEqual(['INV-0004', 'INV-0002', 'INV-0003', 'INV-0001']);

    // A column with missing figures keeps them last whichever way it runs.
    await userEvent.click(within(header('Entry EV / EBITDA')).getByRole('button'));
    expect(firstCells(table)).toEqual(['INV-0004', 'INV-0001', 'INV-0002', 'INV-0003']);
    await userEvent.click(within(header('Entry EV / EBITDA')).getByRole('button'));
    expect(firstCells(table)).toEqual(['INV-0002', 'INV-0001', 'INV-0004', 'INV-0003']);
  });

  it('exports the positions as a CSV file fetched with the credential', async () => {
    mockApi({ [VIEW]: ok(valueCreationFixture()) });
    const csv =
      'investmentNumber,companyName\nINV-0001,Saltmarsh Holdings\nINV-0002,Kelp Forest Foods\n';
    const base = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation((input, init) =>
      urlOf(input).startsWith(EXPORT)
        ? Promise.resolve(
            new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } }),
          )
        : base(input, init),
    );
    const created: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn((blob: Blob) => {
        created.push(blob);
        return 'blob:value-creation';
      }),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, download: this.download });
    });
    renderWithQuery(<ValueCreationTab />);
    const button = await screen.findByTestId('value-creation-export');
    expect(button).toHaveTextContent('Export CSV');
    await userEvent.click(button);
    expect(await screen.findByTestId('value-creation-action-status')).toHaveTextContent(
      'Exported 2 rows to value-creation-2025-06-30.csv',
    );
    const call = vi.mocked(globalThis.fetch).mock.calls.find(([i]) => urlOf(i).startsWith(EXPORT));
    expect(call === undefined ? '' : urlOf(call[0])).toBe(EXPORT);
    expect(new Headers(call?.[1]?.headers).get('accept')).toBe('text/csv');
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe('text/csv');
    expect(clicked).toEqual([
      { href: 'blob:value-creation', download: 'value-creation-2025-06-30.csv' },
    ]);
  });

  it('words a refused export in the status region and keeps the view', async () => {
    mockApi({ [VIEW]: ok(valueCreationFixture()) });
    const base = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation((input, init) =>
      urlOf(input).startsWith(EXPORT)
        ? Promise.resolve(
            new Response(JSON.stringify(problemFixture(403, EXPORT)), {
              status: 403,
              headers: { 'content-type': 'application/problem+json' },
            }),
          )
        : base(input, init),
    );
    renderWithQuery(<ValueCreationTab />);
    await userEvent.click(await screen.findByTestId('value-creation-export'));
    expect(await screen.findByTestId('value-creation-action-status')).toHaveTextContent(
      /^Export CSV: /,
    );
    expect(screen.getByRole('table', { name: 'Value creation by position' })).toBeInTheDocument();
  });

  it('shows the placeholder, not a bridge of zeros, when no position can be split', async () => {
    const base = valueCreationFixture();
    mockApi({
      [VIEW]: ok(
        valueCreationFixture({
          positions: base.positions.slice(2),
          portfolio: {
            positions: 0,
            invested: null,
            nav: null,
            distributions: null,
            totalValue: null,
            gain: null,
            gainByDriver: null,
            notCalculable: base.portfolio.notCalculable,
          },
        }),
      ),
    });
    renderWithQuery(<ValueCreationTab />);
    const tiles = await screen.findByTestId('value-creation-tiles');
    expect(within(tiles).getByRole('group', { name: 'Our gain' })).toHaveTextContent(MISSING);
    expect(within(tiles).getByRole('group', { name: 'EBITDA growth' })).toHaveTextContent(MISSING);
    expect(screen.queryByRole('group', { name: 'Our gain by driver' })).not.toBeInTheDocument();
    expect(
      screen.getByText('No position can be split by driver as of this date'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.0M/)).not.toBeInTheDocument();
    // The positions are still listed, each with its reason.
    expect(firstCells(screen.getByRole('table', { name: 'Value creation by position' }))).toEqual([
      'INV-0003',
      'INV-0004',
    ]);
  });

  it('says so when there are no positions, or when the view cannot be read', async () => {
    mockApi({
      [VIEW]: ok(
        valueCreationFixture({
          positions: [],
          portfolio: {
            positions: 0,
            invested: null,
            nav: null,
            distributions: null,
            totalValue: null,
            gain: null,
            gainByDriver: null,
            notCalculable: [],
          },
          leftOut: [],
        }),
      ),
    });
    renderWithQuery(<ValueCreationTab />);
    expect(
      await screen.findByText('No equity or continuation vehicle positions'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();
    mockApi({ [VIEW]: failing(501, VIEW) });
    renderWithQuery(<ValueCreationTab />);
    expect(await screen.findByText('Value creation: not available yet')).toBeInTheDocument();
  });
});

describe('Analytics: Entry metrics tab', () => {
  it('shows performance by entry purchase multiple band: MOIC bars, the rest in the table beneath', async () => {
    mockApi({ [VIEW]: ok(valueCreationFixture()) });
    renderWithQuery(<EntryMetricsTab />);
    const bars = await screen.findByRole('group', {
      name: 'Gross MOIC by entry purchase multiple',
    });
    expect(within(bars).getByRole('img', { name: '9.0x to 11.0x: 1.26x' })).toBeInTheDocument();
    expect(within(bars).getByRole('img', { name: '11.0x to 13.0x: 0.75x' })).toBeInTheDocument();
    // An empty band has no bar (never a bar at zero) and still has its row.
    expect(within(bars).queryByRole('img', { name: /Under 9\.0x/ })).not.toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Performance by entry purchase multiple' });
    expect(firstCells(table)).toEqual([
      'Under 9.0x',
      '9.0x to 11.0x',
      '11.0x to 13.0x',
      '13.0x and over',
      'Not calculable',
    ]);
    expect(rowOf(table, '9.0x to 11.0x')).toHaveTextContent(
      '9.0x to 11.0x2$30.0M$35.9M$2.0M1.26x7.1%31.9%',
    );
    expect(rowOf(table, 'Under 9.0x')).toHaveTextContent(
      `Under 9.0x0${MISSING}${MISSING}${MISSING}${MISSING}${MISSING}${MISSING}`,
    );
    // The position with no entry multiple is counted in its own row, never dropped.
    expect(rowOf(table, 'Not calculable')).toHaveTextContent(
      `Not calculable1$5.0M$6.0M$0.0M1.20x6.2%${MISSING}`,
    );
  });

  it('shows performance by entry net leverage band the same way', async () => {
    mockApi({ [VIEW]: ok(valueCreationFixture()) });
    renderWithQuery(<EntryMetricsTab />);
    const bars = await screen.findByRole('group', { name: 'Gross MOIC by entry net leverage' });
    expect(within(bars).getByRole('img', { name: 'Under 4.0x: 1.69x' })).toBeInTheDocument();
    expect(within(bars).getByRole('img', { name: '6.0x and over: 0.75x' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Performance by entry net leverage' });
    expect(rowOf(table, '4.0x to 5.0x')).toHaveTextContent(
      '4.0x to 5.0x1$20.0M$21.0M$0.0M1.05x1.1%',
    );
    // The empty band keeps its row, with the placeholder in every figure.
    expect(rowOf(table, '5.0x to 6.0x')).toHaveTextContent(
      `5.0x to 6.0x0${MISSING}${MISSING}${MISSING}${MISSING}${MISSING}${MISSING}`,
    );
  });

  it('plots entry multiple against MOIC per company with the leverage band as the series', async () => {
    mockApi({ [VIEW]: ok(valueCreationFixture()) });
    renderWithQuery(<EntryMetricsTab />);
    const chart = await screen.findByRole('group', {
      name: 'Entry purchase multiple against gross MOIC',
    });
    expect(
      within(chart).getByRole('img', {
        name: 'Saltmarsh Holdings: Entry EV / EBITDA 10.0x, Gross MOIC 1.69x, Entry net leverage Under 4.0x',
      }),
    ).toBeInTheDocument();
    expect(
      within(chart).getByRole('img', {
        name: 'Dune Grass Logistics: Entry EV / EBITDA 12.5x, Gross MOIC 0.75x, Entry net leverage 6.0x and over',
      }),
    ).toBeInTheDocument();
    expect(within(chart).queryByRole('img', { name: /Tidepool/ })).not.toBeInTheDocument();
    const figure = screen.getByTestId('entry-scatter');
    // Only the bands that hold a plotted position are in the legend, in band order.
    expect(
      within(within(figure).getByRole('list', { name: 'Legend' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Under 4.0x', '4.0x to 5.0x', '6.0x and over']);
    expect(
      screen.getByText('1 position has no entry multiple or no MOIC and is not plotted.'),
    ).toBeInTheDocument();
  });

  it('takes the bands from the response, never from the page', async () => {
    const base = valueCreationFixture();
    const renamed = base.cohorts.byEntryMultiple.map((c) =>
      c.key === 'band_1' ? { ...c, label: '8.5x to 12.0x', lower: '8.5', upper: '12' } : c,
    );
    mockApi({
      [VIEW]: ok(valueCreationFixture({ cohorts: { ...base.cohorts, byEntryMultiple: renamed } })),
    });
    renderWithQuery(<EntryMetricsTab />);
    const bars = await screen.findByRole('group', {
      name: 'Gross MOIC by entry purchase multiple',
    });
    expect(within(bars).getByRole('img', { name: '8.5x to 12.0x: 1.26x' })).toBeInTheDocument();
    expect(screen.queryByText('9.0x to 11.0x')).not.toBeInTheDocument();
  });

  it('says so when there are no positions, or when the view cannot be read', async () => {
    mockApi({ [VIEW]: ok(valueCreationFixture({ positions: [] })) });
    renderWithQuery(<EntryMetricsTab />);
    expect(
      await screen.findByText('No equity or continuation vehicle positions'),
    ).toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();
    mockApi({ [VIEW]: failing(403, VIEW) });
    renderWithQuery(<EntryMetricsTab />);
    expect(await screen.findByText('Entry metrics: not visible to your role')).toBeInTheDocument();
  });
});
