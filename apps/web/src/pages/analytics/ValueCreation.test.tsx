import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { investmentValueCreation, valueCreation } from '@pb/contracts';
import { failing, mockApi, ok, problemFixture } from '../../test/api-mock.js';
import { renderWithQuery } from '../../test/render.js';
import { navigate } from '../../test/router-mock.js';
import { MISSING } from '../../lib/format.js';
import { EntryMetricsTab } from './EntryMetricsTab.js';
import { ValueCreationTab } from './ValueCreationTab.js';
import {
  investmentValueCreationFixture,
  kelp,
  saltmarsh,
  valueCreationFixture,
  VC_ID,
} from './value-creation.fixtures.js';
import {
  filterOptions,
  filterQueryString,
  parseValueCreationSearch,
  valueCreationSearch,
  withFilter,
} from './value-creation-filters.js';
import { shownView } from './value-creation-view.js';
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

/**
 * The address a tab reads its filters from. The stand-in router keeps it and tells the page when
 * a navigation replaces it, as the real one does, so a filter picked in the bar reaches the page
 * through the URL and not through a side door.
 */
const route = vi.hoisted((): { search: Record<string, unknown>; listeners: Set<() => void> } => ({
  search: {},
  listeners: new Set(),
}));

vi.mock('@tanstack/react-router', async () => {
  const { useSyncExternalStore } = await import('react');
  const mock = await import('../../test/router-mock.js');
  return {
    ...mock.routerMock(),
    useSearch: () =>
      useSyncExternalStore(
        (listener) => {
          route.listeners.add(listener);
          return () => route.listeners.delete(listener);
        },
        () => route.search,
      ),
    useNavigate: () => (to: { search?: Record<string, unknown> }) => {
      mock.navigate(to);
      route.search = to.search ?? {};
      for (const listener of route.listeners) listener();
    },
  };
});

const VIEW = '/api/v1/analytics/value-creation';
const EXPORT = '/api/v1/analytics/value-creation/export';
/** Dropdown journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = 20_000;

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

async function pick(combobox: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole('combobox', { name: combobox }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

const tile = (name: string): HTMLElement =>
  within(screen.getByTestId('value-creation-tiles')).getByRole('group', { name });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  navigate.mockClear();
  route.search = {};
  route.listeners.clear();
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

  it('builds our bridge from invested capital through the drivers and mark and timing to the value now', () => {
    const { portfolio } = valueCreationFixture();
    expect(
      portfolioBridgeSteps(portfolio, false)?.map((s) => [s.label, s.display, s.kind]),
    ).toEqual([
      ['Invested', '$30.0M', 'total'],
      ['EBITDA growth', '+$16.0M', 'change'],
      ['Multiple expansion', '+$0.3M', 'change'],
      ['Debt paydown', '+$3.9M', 'change'],
      ['Mark and timing', '-$4.6M', 'change'],
      ['Value now', '$45.5M', 'total'],
    ]);
    expect(portfolioBridgeSteps(portfolio, true)?.map((s) => s.label)).toEqual([
      'Invested',
      'Revenue growth',
      'Margin change',
      'Multiple expansion',
      'Debt paydown',
      'Mark and timing',
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
    const { positions } = valueCreationFixture();
    const plotted = growthPoints(positions);
    expect(plotted.points.map((p) => [p.label, p.xDisplay, p.yDisplay, p.series])).toEqual([
      ['Saltmarsh Holdings', '62.5%', '145.0%', 'Mark ahead of EBITDA growth'],
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

  it('measures valuation growth on our mark, the company equity value or the enterprise value', () => {
    const { positions } = valueCreationFixture();
    expect(growthPoints(positions, 'mark')).toEqual(growthPoints(positions));
    // Levered equity ran ahead of EBITDA at every company; on enterprise value Kelp did not.
    const equity = growthPoints(positions, 'equity');
    expect(equity.points.map((p) => [p.label, p.yDisplay, p.series])).toEqual([
      ['Saltmarsh Holdings', '138.0%', 'Equity value ahead of EBITDA growth'],
      ['Kelp Forest Foods', '31.7%', 'Equity value ahead of EBITDA growth'],
      ['Dune Grass Logistics', '-66.7%', 'Equity value ahead of EBITDA growth'],
    ]);
    expect(equity.seriesNames).toEqual(['Equity value ahead of EBITDA growth']);
    const ev = growthPoints(positions, 'ev');
    expect(ev.points.map((p) => [p.label, p.xDisplay, p.yDisplay, p.series])).toEqual([
      ['Saltmarsh Holdings', '62.5%', '78.8%', 'Enterprise value ahead of EBITDA growth'],
      ['Kelp Forest Foods', '16.7%', '10.2%', 'Enterprise value at or behind EBITDA growth'],
      ['Dune Grass Logistics', '-125.0%', '-28.0%', 'Enterprise value ahead of EBITDA growth'],
    ]);
    expect(ev.ahead).toBe(2);
    // A position without the measure is left out, never plotted at zero.
    const noEv = kelp({ growth: { ...kelp().growth, evGrowth: null } });
    expect(growthPoints([noEv], 'ev')).toEqual({
      points: [],
      leftOut: 1,
      seriesNames: [],
      ahead: 0,
    });
    expect(growthPoints([noEv], 'mark').points).toHaveLength(1);
  });

  it('gives a band a bar only when it has a MOIC', () => {
    const bars = moicBars(valueCreationFixture().cohorts.byEntryMultiple);
    expect(bars.map((b) => [b.label, b.display])).toEqual([
      ['9.0x to 11.0x', '1.52x'],
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
    // Mark and timing, and the stake it is measured at, sort the same way.
    expect(by('gainOther', 'descending')).toEqual(['INV-0001', 'INV-0002', 'INV-0003', 'INV-0004']);
    expect(by('gainOther', 'ascending')).toEqual(['INV-0002', 'INV-0001', 'INV-0003', 'INV-0004']);
    expect(by('stake', 'ascending')).toEqual(['INV-0001', 'INV-0002', 'INV-0004', 'INV-0003']);
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

describe('value creation filters and the roll-up of a filtered view', () => {
  it('reads the filters from a URL search, dropping what it does not know', () => {
    expect(parseValueCreationSearch({})).toEqual({});
    expect(
      parseValueCreationSearch({
        vehicleId: VC_ID.vehicle,
        sponsorId: VC_ID.sponsor,
        sector: 'sector.software',
        dealType: 'deal_type.co_invest_equity',
        // The router reads a bare year as a number.
        entryYear: 2021,
        status: 'realized',
      }),
    ).toEqual({
      vehicleId: VC_ID.vehicle,
      sponsorId: VC_ID.sponsor,
      sector: 'sector.software',
      dealType: 'deal_type.co_invest_equity',
      entryYear: '2021',
      status: 'realized',
    });
    expect(
      parseValueCreationSearch({
        vehicleId: 'not-an-id',
        status: 'held',
        entryYear: '21',
        sector: '',
        tab: 'x',
        dealType: 'deal_type.cv_single_asset',
      }),
    ).toEqual({ dealType: 'deal_type.cv_single_asset' });
  });

  it('writes the filters to the address and to the export in one order, only the ones that are set', () => {
    const filters = { status: 'active', entryYear: '2021', vehicleId: VC_ID.vehicle } as const;
    expect(valueCreationSearch(filters)).toEqual({
      vehicleId: VC_ID.vehicle,
      entryYear: 2021,
      status: 'active',
    });
    expect(parseValueCreationSearch(valueCreationSearch(filters))).toEqual(filters);
    expect(filterQueryString(filters)).toBe(
      `?vehicleId=${VC_ID.vehicle}&entryYear=2021&status=active`,
    );
    expect(filterQueryString({})).toBe('');
    expect(withFilter(filters, 'status', '')).toEqual({
      entryYear: '2021',
      vehicleId: VC_ID.vehicle,
    });
    expect(withFilter({}, 'sector', 'sector.consumer')).toEqual({ sector: 'sector.consumer' });
  });

  it('offers the values the positions hold: names A to Z, years newest first', () => {
    const options = filterOptions(valueCreationFixture().positions);
    expect(options.vehicleId).toEqual([
      { value: VC_ID.vehicle, label: 'Beach Co-Invest Fund I' },
      { value: VC_ID.cvVehicle, label: 'Beach CV Opportunities I' },
    ]);
    expect(options.sponsorId.map((o) => o.label)).toEqual([
      'Harborlight Partners',
      'Tidewater Capital',
    ]);
    expect(options.sector.map((o) => o.value)).toEqual([
      'sector.consumer',
      'sector.industrials',
      'sector.software',
    ]);
    expect(options.dealType.map((o) => o.value)).toEqual([
      'deal_type.co_invest_equity',
      'deal_type.cv_single_asset',
    ]);
    expect(options.entryYear.map((o) => o.value)).toEqual(['2022', '2021', '2017']);
    expect(options.status).toEqual([
      { value: 'active', label: 'Active' },
      { value: 'realized', label: 'Realized' },
    ]);
    // A book with no realized position does not offer the status that would empty it.
    expect(filterOptions([saltmarsh()]).status).toEqual([{ value: 'active', label: 'Active' }]);
  });

  it('rolls the unfiltered rows up to the answer of the API, field for field', () => {
    const view = valueCreationFixture();
    const shown = shownView(view, {});
    expect(shown.positions).toEqual(view.positions);
    expect(shown.portfolio).toEqual(view.portfolio);
    expect(shown.cohorts).toEqual(view.cohorts);
    expect(shown.total).toBe(4);
  });

  it('rolls a filter to one vehicle up exactly: the figures worked by hand', () => {
    // Beach Co-Invest Fund I holds Saltmarsh (split) and Tidepool (entry snapshot forward-dated).
    const shown = shownView(valueCreationFixture(), { vehicleId: VC_ID.vehicle });
    expect(shown.positions.map((p) => p.investmentNumber)).toEqual(['INV-0001', 'INV-0003']);
    expect(shown.total).toBe(4);
    expect(shown.portfolio).toEqual({
      positions: 1,
      invested: '10000000',
      nav: '22500000',
      distributions: '2000000',
      totalValue: '24500000',
      // 2,000,000 + 22,500,000 - 10,000,000, and 4% of the company's 250, 65 and 30 million.
      gain: '14500000',
      gainByDriver: {
        ebitdaGrowth: '10000000',
        multipleExpansion: '2600000',
        debtPaydown: '1200000',
        other: '700000',
        revenueGrowth: '4800000',
        marginChange: '5200000',
      },
      notCalculable: [{ reason: 'entry_snapshot_forward_dated', count: 1 }],
    });
    expect(
      shown.cohorts.byEntryMultiple.map((c) => [
        c.label,
        c.count,
        c.invested,
        c.nav,
        c.grossMoic,
        c.grossIrr,
        c.ebitdaGrowth,
      ]),
    ).toEqual([
      ['Under 9.0x', 0, null, null, null, null, null],
      // Saltmarsh alone: 24,500,000 back on 10,000,000 after 1,461 days, (1 + r)^(1461/365) = 2.45.
      ['9.0x to 11.0x', 1, '10000000', '22500000', '2.45', '0.2509067289', '0.625'],
      // Dune and Kelp are in the other vehicle: their bands are emptied, with no figure.
      ['11.0x to 13.0x', 0, null, null, null, null, null],
      ['13.0x and over', 0, null, null, null, null, null],
      // Tidepool: 6,000,000 on 5,000,000 after 1,096 days, (1 + r)^(1096/365) = 1.2.
      ['Not calculable', 1, '5000000', '6000000', '1.2', '0.0625996458', null],
    ]);
    expect(shown.cohorts.byEntryMultiple[0]?.irrFlag).toBe('insufficient_flows');
    // The other vehicle: Kelp alone is split; Dune (realized, EBITDA below zero) is counted.
    const other = shownView(valueCreationFixture(), { vehicleId: VC_ID.cvVehicle });
    expect(other.portfolio.gain).toBe('1000000');
    expect(other.portfolio.gainByDriver?.other).toBe('-5333333.3333333334');
    expect(other.portfolio.notCalculable).toEqual([{ reason: 'non_positive_ebitda', count: 1 }]);
    // The two vehicles add up to the whole book, part by part.
    const all = shownView(valueCreationFixture(), {});
    expect(Number(shown.portfolio.gain) + Number(other.portfolio.gain)).toBe(
      Number(all.portfolio.gain),
    );
    // A filter that leaves nothing has no figure, never a zero.
    const none = shownView(valueCreationFixture(), {
      vehicleId: VC_ID.vehicle,
      status: 'realized',
    });
    expect(none.positions).toEqual([]);
    expect(none.portfolio.gain).toBeNull();
    expect(none.portfolio.gainByDriver).toBeNull();
    expect(none.cohorts.byEntryLeverage.every((c) => c.count === 0 && c.grossMoic === null)).toBe(
      true,
    );
  });
});

describe('Analytics: Value creation tab', () => {
  it('leads with our gain, its three drivers and mark and timing, then the bridge to the value now', async () => {
    mockApi({ [VIEW]: ok(valueCreationFixture()) });
    renderWithQuery(<ValueCreationTab />);
    await screen.findByTestId('value-creation-tiles');
    expect(tile('Our gain')).toHaveTextContent('$15.5M');
    expect(tile('Our gain')).toHaveTextContent('2 positions');
    expect(tile('EBITDA growth')).toHaveTextContent('+$16.0M');
    expect(tile('Multiple expansion')).toHaveTextContent('+$0.3M');
    expect(tile('Debt paydown')).toHaveTextContent('+$3.9M');
    expect(tile('Mark and timing')).toHaveTextContent('-$4.6M');
    // The headline comes before any detail, and before the filters, on the page.
    const all = screen.getAllByRole('group').filter((g) => g.getAttribute('aria-label') !== null);
    expect(all[0]).toBe(tile('Our gain'));
    const filters = screen.getByTestId('value-creation-filters');
    expect(
      screen.getByTestId('value-creation-tiles').compareDocumentPosition(filters) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const bridge = screen.getByRole('group', { name: 'Our gain by driver' });
    for (const name of [
      'Invested: $30.0M',
      'EBITDA growth: +$16.0M',
      'Multiple expansion: +$0.3M',
      'Debt paydown: +$3.9M',
      'Mark and timing: -$4.6M',
      'Value now: $45.5M',
    ])
      expect(within(bridge).getByRole('img', { name })).toBeInTheDocument();
    // One plain sentence on what mark and timing is; nothing about large shares any more.
    const note = screen.getByTestId('value-creation-bridge-note');
    expect(note).toHaveTextContent(
      "Mark and timing is the rest of our gain: our mark against the company's value, fees, the timing of cash flows, follow-on investments and realizations.",
    );
    expect(note).toHaveTextContent('at our entry stake');
    expect(note).not.toHaveTextContent('large shares');
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
    expect(
      within(bridge).getByRole('img', { name: 'Revenue growth: +$15.6M' }),
    ).toBeInTheDocument();
    expect(within(bridge).getByRole('img', { name: 'Margin change: +$0.4M' })).toBeInTheDocument();
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
      'Revenue growth+$15.6M',
      'Margin change+$0.4M',
      'Multiple expansion+$0.3M',
      'Debt paydown+$3.9M',
      'Mark and timing-$4.6M',
      'Value now$45.5M',
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
      // A forward-dated entry snapshot has its own reason, in the words of the Since entry card.
      'Tidepool Analytics (INV-0003): The entry snapshot is dated after the as-of date',
      'Dune Grass Logistics (INV-0004): EBITDA is at or below zero at entry or in the current quarter',
    ]);
    // With every position in the split there is nothing to say.
    cleanup();
    vi.restoreAllMocks();
    mockApi({ [VIEW]: ok(valueCreationFixture({ positions: [saltmarsh(), kelp()] })) });
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
        name: 'Saltmarsh Holdings: EBITDA growth since entry 62.5%, Growth in our mark 145.0%, Side of the line Mark ahead of EBITDA growth',
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

  it(
    'compares like with like on demand: the measure selector moves the chart and its table to enterprise value',
    async () => {
      mockApi({ [VIEW]: ok(valueCreationFixture()) });
      renderWithQuery(<ValueCreationTab />);
      await screen.findByTestId('value-creation-scatter');
      // Our mark is the default, and one quiet line says what the other measures are for.
      expect(screen.getByRole('combobox', { name: 'Valuation measure' })).toHaveTextContent(
        'Our mark',
      );
      expect(screen.getByTestId('value-creation-measure-note')).toHaveTextContent(
        'Levered equity usually grows faster than EBITDA; enterprise value is the like-for-like view.',
      );
      await pick('Valuation measure', 'Enterprise value');
      const chart = screen.getByRole('group', { name: 'Valuation growth against EBITDA growth' });
      expect(
        within(chart).getByRole('img', {
          name: 'Saltmarsh Holdings: EBITDA growth since entry 62.5%, Enterprise value growth 78.8%, Side of the line Enterprise value ahead of EBITDA growth',
        }),
      ).toBeInTheDocument();
      expect(
        within(chart).getByRole('img', {
          name: 'Kelp Forest Foods: EBITDA growth since entry 16.7%, Enterprise value growth 10.2%, Side of the line Enterprise value at or behind EBITDA growth',
        }),
      ).toBeInTheDocument();
      expect(within(chart).queryByRole('img', { name: /Growth in our mark/ })).toBeNull();
      expect(
        screen.getByText(
          '2 of 3 marks sit above the line: the enterprise value grew faster than the company EBITDA. 1 position has no EBITDA growth or no enterprise value growth and is not plotted.',
        ),
      ).toBeInTheDocument();
      // The table twin follows the selector.
      const figure = screen.getByTestId('value-creation-scatter');
      await userEvent.click(within(figure).getByRole('button', { name: 'Show table' }));
      const table = within(figure).getByRole('table', {
        name: 'Valuation growth against EBITDA growth, as a table',
      });
      expect(
        within(table)
          .getAllByRole('columnheader')
          .map((h) => h.textContent),
      ).toContain('Enterprise value growth');
      expect(rowOf(table, 'Kelp Forest Foods')).toHaveTextContent(
        'Kelp Forest Foods16.7%10.2%Enterprise value at or behind EBITDA growth',
      );
      await pick('Valuation measure', 'Company equity value');
      // Every company's equity value ran ahead, so there is one side and no column for it.
      expect(rowOf(table, 'Kelp Forest Foods')).toHaveTextContent('Kelp Forest Foods16.7%31.7%');
      expect(
        within(table)
          .getAllByRole('columnheader')
          .map((h) => h.textContent),
      ).toEqual(['Position', 'EBITDA growth since entry', 'Equity value growth']);
      expect(
        screen.getByText(/3 of 3 marks sit above the line: the company equity value grew faster/),
      ).toBeInTheDocument();
    },
    TIMEOUT,
  );

  it('lists every position with its multiples, entry stake, the parts of its gain, MOIC and IRR; a missing figure is the placeholder with its reason', async () => {
    mockApi({ [VIEW]: ok(valueCreationFixture()) });
    renderWithQuery(<ValueCreationTab />);
    const table = await screen.findByRole('table', { name: 'Value creation by position' });
    expect(firstCells(table)).toEqual(['INV-0001', 'INV-0002', 'INV-0003', 'INV-0004']);
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent?.replace(/[▲▼]/g, '')),
    ).toEqual([
      'Inv #',
      'Company',
      'Entry EV / EBITDA',
      'Current EV / EBITDA',
      'Entry net debt / EBITDA',
      'Current net debt / EBITDA',
      'EBITDA growth',
      'Mark growth',
      'Entry stake',
      'Our gain',
      'Gain: EBITDA growth',
      'Gain: multiple expansion',
      'Gain: debt paydown',
      'Gain: mark and timing',
      'Gross MOIC',
      'Gross IRR',
    ]);
    const first = rowOf(table, 'Saltmarsh Holdings');
    // A stake of 4.0%: +$10.0M, +$2.6M and +$1.2M of the company's drivers, and +$0.7M besides.
    expect(first).toHaveTextContent(
      'INV-0001Saltmarsh Holdings10.0x11.0x3.8x1.8x62.5%145.0%4.0%$14.5M+$10.0M+$2.6M+$1.2M+$0.7M2.45x25.1%',
    );
    expect(within(first).getByRole('link', { name: 'Saltmarsh Holdings' })).toHaveAttribute(
      'href',
      `/portfolio/${saltmarsh().id}/performance`,
    );
    // A mark that trails the company's value shows as a negative mark and timing, never hidden.
    expect(rowOf(table, 'Kelp Forest Foods')).toHaveTextContent(
      '6.7%$1.0M+$6.0M-$2.3M+$2.7M-$5.3M1.05x1.2%',
    );
    // Forward-dated entry snapshot: no entry multiples, no stake, no parts, and the reason in
    // words; never a zero.
    const none = rowOf(table, 'Tidepool Analytics');
    expect(none).toHaveTextContent(
      `INV-0003Tidepool Analytics${MISSING}11.0x${MISSING}1.8x${MISSING}20.0%${MISSING}$1.0M${MISSING} The entry snapshot is dated after the as-of date1.20x6.3%`,
    );
    expect(none).not.toHaveTextContent('$0.0M');
    // The four parts share one cell, so the reason sits where the figures would.
    expect(within(none).getAllByRole('cell')).toHaveLength(13);
    expect(within(first).getAllByRole('cell')).toHaveLength(16);
    const negative = rowOf(table, 'Dune Grass Logistics');
    // A realized position says so under its name; an active one says nothing.
    expect(negative).toHaveTextContent('Dune Grass LogisticsRealized12.5x');
    expect(first).not.toHaveTextContent('Realized');
    expect(negative).toHaveTextContent('-$2.0M');
    // Its stake stands although its bridge does not.
    expect(negative).toHaveTextContent('6.7%');
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

  it(
    'filters to one vehicle and recomputes every figure: tiles, bridge, chart, table and the count',
    async () => {
      mockApi({ [VIEW]: ok(valueCreationFixture()) });
      renderWithQuery(<ValueCreationTab />);
      await screen.findByTestId('value-creation-tiles');
      expect(screen.getByTestId('value-creation-filter-count')).toHaveTextContent('4 positions');
      expect(screen.queryByTestId('value-creation-filters-clear')).not.toBeInTheDocument();
      for (const [name, all] of [
        ['Vehicle', 'All vehicles'],
        ['Sponsor', 'All sponsors'],
        ['Sector', 'All sectors'],
        ['Deal type', 'All deal types'],
        ['Entry year', 'All entry years'],
        ['Status', 'Active and realized'],
      ] as const)
        expect(screen.getByRole('combobox', { name })).toHaveTextContent(all);

      await pick('Vehicle', 'Beach Co-Invest Fund I');
      // The filter lives in the address, so the view can be shared.
      expect(navigate).toHaveBeenLastCalledWith({
        to: '.',
        search: { vehicleId: VC_ID.vehicle },
        replace: true,
      });
      expect(screen.getByRole('combobox', { name: 'Vehicle' })).toHaveTextContent(
        'Beach Co-Invest Fund I',
      );
      expect(screen.getByTestId('value-creation-filter-count')).toHaveTextContent(
        '2 of 4 positions',
      );
      // Saltmarsh alone is split: 4% of its company's drivers and the rest of its gain.
      expect(tile('Our gain')).toHaveTextContent('$14.5M');
      expect(tile('Our gain')).toHaveTextContent('1 position');
      expect(tile('EBITDA growth')).toHaveTextContent('+$10.0M');
      expect(tile('Multiple expansion')).toHaveTextContent('+$2.6M');
      expect(tile('Debt paydown')).toHaveTextContent('+$1.2M');
      expect(tile('Mark and timing')).toHaveTextContent('+$0.7M');
      const bridge = screen.getByRole('group', { name: 'Our gain by driver' });
      for (const name of [
        'Invested: $10.0M',
        'EBITDA growth: +$10.0M',
        'Multiple expansion: +$2.6M',
        'Debt paydown: +$1.2M',
        'Mark and timing: +$0.7M',
        'Value now: $24.5M',
      ])
        expect(within(bridge).getByRole('img', { name })).toBeInTheDocument();
      const table = screen.getByRole('table', { name: 'Value creation by position' });
      expect(firstCells(table)).toEqual(['INV-0001', 'INV-0003']);
      expect(screen.getByText('1 position is not in this split')).toBeInTheDocument();
      const chart = screen.getByRole('group', { name: 'Valuation growth against EBITDA growth' });
      expect(within(chart).getByRole('img', { name: /^Saltmarsh Holdings/ })).toBeInTheDocument();
      expect(within(chart).queryByRole('img', { name: /^Kelp Forest Foods/ })).toBeNull();
      expect(screen.getByText(/narrowed by the filters above/)).toBeInTheDocument();

      // A second filter narrows further; clearing brings the whole book back.
      await pick('Entry year', '2021');
      expect(navigate).toHaveBeenLastCalledWith({
        to: '.',
        search: { vehicleId: VC_ID.vehicle, entryYear: 2021 },
        replace: true,
      });
      expect(firstCells(table)).toEqual(['INV-0001']);
      expect(screen.queryByTestId('value-creation-not-calculable')).not.toBeInTheDocument();
      await userEvent.click(screen.getByTestId('value-creation-filters-clear'));
      expect(navigate).toHaveBeenLastCalledWith({ to: '.', search: {}, replace: true });
      expect(tile('Our gain')).toHaveTextContent('$15.5M');
      expect(
        firstCells(screen.getByRole('table', { name: 'Value creation by position' })),
      ).toHaveLength(4);
    },
    TIMEOUT,
  );

  it(
    'shows the empty state, not zeros, when a filter leaves no position',
    async () => {
      mockApi({ [VIEW]: ok(valueCreationFixture()) });
      // A shared address: realized positions of a vehicle that holds none.
      route.search = { vehicleId: VC_ID.vehicle, status: 'realized' };
      renderWithQuery(<ValueCreationTab />);
      expect(await screen.findByText('No position matches these filters')).toBeInTheDocument();
      expect(screen.queryByTestId('value-creation-tiles')).not.toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.queryByText(/\$0\.0M/)).not.toBeInTheDocument();
      // The filters stay, so the reader can undo them, and say what they are set to.
      expect(screen.getByRole('combobox', { name: 'Vehicle' })).toHaveTextContent(
        'Beach Co-Invest Fund I',
      );
      expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Realized');
      expect(screen.getByTestId('value-creation-filter-count')).toHaveTextContent(
        '0 of 4 positions',
      );
      await pick('Status', 'Active and realized');
      expect(await screen.findByTestId('value-creation-tiles')).toBeInTheDocument();
      expect(tile('Our gain')).toHaveTextContent('$14.5M');
    },
    TIMEOUT,
  );

  it('reads a filtered view from the address: realized positions only', async () => {
    mockApi({ [VIEW]: ok(valueCreationFixture()) });
    route.search = { status: 'realized' };
    renderWithQuery(<ValueCreationTab />);
    const table = await screen.findByRole('table', { name: 'Value creation by position' });
    expect(firstCells(table)).toEqual(['INV-0004']);
    // The one realized position has no bridge, so nothing is split: placeholders, never zeros.
    expect(tile('Our gain')).toHaveTextContent(MISSING);
    expect(tile('Mark and timing')).toHaveTextContent(MISSING);
    expect(
      screen.getByText('No position can be split by driver as of this date'),
    ).toBeInTheDocument();
    // A value from someone else's address that these positions do not hold is said plainly.
    cleanup();
    route.search = { sponsorId: '00000000-0000-4000-8000-0000000009c9' };
    renderWithQuery(<ValueCreationTab />);
    expect(await screen.findByText('No position matches these filters')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Sponsor' })).toHaveTextContent('Not in this view');
  });

  it('exports the positions as a CSV file fetched with the credential and the filters of the view', async () => {
    mockApi({ [VIEW]: ok(valueCreationFixture()) });
    route.search = { vehicleId: VC_ID.vehicle, entryYear: 2021 };
    const csv = 'investmentNumber,companyName\nINV-0001,Saltmarsh Holdings\n';
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
      'Exported 1 row to value-creation-2025-06-30.csv',
    );
    const call = vi.mocked(globalThis.fetch).mock.calls.find(([i]) => urlOf(i).startsWith(EXPORT));
    // The export follows the filters: the API applies the rule the page filtered its rows with.
    expect(call === undefined ? '' : urlOf(call[0])).toBe(
      `${EXPORT}?vehicleId=${VC_ID.vehicle}&entryYear=2021`,
    );
    expect(new Headers(call?.[1]?.headers).get('accept')).toBe('text/csv');
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe('text/csv');
    expect(clicked).toEqual([
      { href: 'blob:value-creation', download: 'value-creation-2025-06-30.csv' },
    ]);
  });

  it('exports every position when no filter is set, and words a refused export in the status region', async () => {
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
    const call = vi.mocked(globalThis.fetch).mock.calls.find(([i]) => urlOf(i).startsWith(EXPORT));
    expect(call === undefined ? '' : urlOf(call[0])).toBe(EXPORT);
    expect(screen.getByRole('table', { name: 'Value creation by position' })).toBeInTheDocument();
  });

  it('shows the placeholder, not a bridge of zeros, when no position can be split', async () => {
    const base = valueCreationFixture();
    mockApi({ [VIEW]: ok(valueCreationFixture({ positions: base.positions.slice(2) })) });
    renderWithQuery(<ValueCreationTab />);
    await screen.findByTestId('value-creation-tiles');
    expect(tile('Our gain')).toHaveTextContent(MISSING);
    expect(tile('EBITDA growth')).toHaveTextContent(MISSING);
    expect(tile('Mark and timing')).toHaveTextContent(MISSING);
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
    mockApi({ [VIEW]: ok(valueCreationFixture({ positions: [], leftOut: [] })) });
    renderWithQuery(<ValueCreationTab />);
    expect(
      await screen.findByText('No equity or continuation vehicle positions'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // With nothing to filter there is no filter row either.
    expect(screen.queryByTestId('value-creation-filters')).not.toBeInTheDocument();
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
    expect(within(bars).getByRole('img', { name: '9.0x to 11.0x: 1.52x' })).toBeInTheDocument();
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
    // Saltmarsh and Kelp pooled: 45,500,000 back on 30,000,000 after 1,461 days (11.0% a year),
    // and EBITDA growth weighted by invested capital, (10 x 62.5% + 20 x 16.7%) / 30.
    expect(rowOf(table, '9.0x to 11.0x')).toHaveTextContent(
      '9.0x to 11.0x2$30.0M$43.5M$2.0M1.52x11.0%31.9%',
    );
    expect(rowOf(table, 'Under 9.0x')).toHaveTextContent(
      `Under 9.0x0${MISSING}${MISSING}${MISSING}${MISSING}${MISSING}${MISSING}`,
    );
    // The position with no entry multiple is counted in its own row, never dropped.
    expect(rowOf(table, 'Not calculable')).toHaveTextContent(
      `Not calculable1$5.0M$6.0M$0.0M1.20x6.3%${MISSING}`,
    );
  });

  it('shows performance by entry net leverage band the same way', async () => {
    mockApi({ [VIEW]: ok(valueCreationFixture()) });
    renderWithQuery(<EntryMetricsTab />);
    const bars = await screen.findByRole('group', { name: 'Gross MOIC by entry net leverage' });
    expect(within(bars).getByRole('img', { name: 'Under 4.0x: 2.45x' })).toBeInTheDocument();
    expect(within(bars).getByRole('img', { name: '6.0x and over: 0.75x' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Performance by entry net leverage' });
    expect(rowOf(table, '4.0x to 5.0x')).toHaveTextContent(
      '4.0x to 5.0x1$20.0M$21.0M$0.0M1.05x1.2%16.7%',
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
        name: 'Saltmarsh Holdings: Entry EV / EBITDA 10.0x, Gross MOIC 2.45x, Entry net leverage Under 4.0x',
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

  it(
    'pools each cohort again over the positions a filter leaves: count, invested, NAV, MOIC and IRR',
    async () => {
      mockApi({ [VIEW]: ok(valueCreationFixture()) });
      renderWithQuery(<EntryMetricsTab />);
      await screen.findByRole('table', { name: 'Performance by entry purchase multiple' });
      await pick('Vehicle', 'Beach Co-Invest Fund I');
      expect(navigate).toHaveBeenLastCalledWith({
        to: '.',
        search: { vehicleId: VC_ID.vehicle },
        replace: true,
      });
      expect(screen.getByTestId('value-creation-filter-count')).toHaveTextContent(
        '2 of 4 positions',
      );
      const table = screen.getByRole('table', { name: 'Performance by entry purchase multiple' });
      // Saltmarsh alone: (1 + r)^(1461/365) = 24,500,000 / 10,000,000, 25.1% a year.
      expect(rowOf(table, '9.0x to 11.0x')).toHaveTextContent(
        '9.0x to 11.0x1$10.0M$22.5M$2.0M2.45x25.1%62.5%',
      );
      // Dune is in the other vehicle: its band is emptied and shows no figure, never a zero.
      expect(rowOf(table, '11.0x to 13.0x')).toHaveTextContent(
        `11.0x to 13.0x0${MISSING}${MISSING}${MISSING}${MISSING}${MISSING}${MISSING}`,
      );
      expect(rowOf(table, 'Not calculable')).toHaveTextContent(
        `Not calculable1$5.0M$6.0M$0.0M1.20x6.3%${MISSING}`,
      );
      const bars = screen.getByRole('group', { name: 'Gross MOIC by entry purchase multiple' });
      expect(within(bars).getByRole('img', { name: '9.0x to 11.0x: 2.45x' })).toBeInTheDocument();
      expect(within(bars).queryByRole('img', { name: /11\.0x to 13\.0x/ })).toBeNull();
      const leverage = screen.getByRole('table', { name: 'Performance by entry net leverage' });
      expect(rowOf(leverage, 'Under 4.0x')).toHaveTextContent(
        'Under 4.0x1$10.0M$22.5M$2.0M2.45x25.1%62.5%',
      );
      const chart = screen.getByRole('group', {
        name: 'Entry purchase multiple against gross MOIC',
      });
      expect(within(chart).getAllByRole('img', { name: /Entry EV \/ EBITDA/ })).toHaveLength(1);

      // A filter that leaves nothing: the empty state, with the filters still there to undo.
      await pick('Status', 'Realized');
      expect(await screen.findByText('No position matches these filters')).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.queryByText(/\$0\.0M/)).not.toBeInTheDocument();
      await userEvent.click(screen.getByTestId('value-creation-filters-clear'));
      expect(
        rowOf(
          await screen.findByRole('table', { name: 'Performance by entry purchase multiple' }),
          '9.0x to 11.0x',
        ),
      ).toHaveTextContent('9.0x to 11.0x2$30.0M$43.5M$2.0M1.52x11.0%31.9%');
    },
    TIMEOUT,
  );

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
    expect(within(bars).getByRole('img', { name: '8.5x to 12.0x: 1.52x' })).toBeInTheDocument();
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
