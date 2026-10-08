import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import {
  analyticsFixture,
  CREDIT_BUCKET,
  CV_BUCKET,
  ID,
  investmentFixture,
  investmentPageFixture,
  performanceFixture,
} from '../../test/fixtures.js';
import { renderWithQuery } from '../../test/render.js';
import {
  ClientAnalyticsTab,
  CreditTab,
  ExposureTab,
  PerformanceAnalyticsTab,
  RealizationsTab,
} from './Analytics.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const ANALYTICS = '/api/v1/analytics/summary';
const CREDIT = '/api/v1/investments?limit=100&dealType=deal_type.private_credit';
const REALIZED = '/api/v1/investments?limit=100&active=false';

const creditInvestment = () =>
  investmentFixture({
    id: ID.inv2,
    investmentNumber: 'INV-0013',
    companyName: 'Summit Services Co',
    sponsorFundName: 'Oysterbed Credit Fund I',
    vehicleName: 'Beach Credit Partners I',
    dealType: 'deal_type.private_credit',
    invested: '9937711.38',
    distributions: '2066965.86',
    nav: '9859053.48',
    grossMoic: '1.2000770483',
    grossIrr: '0.0310800657',
  });

describe('analytics tabs', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('exposure: bars and a table for the chosen dimension, plus NAV by vehicle and deal type', async () => {
    mockApi({ [ANALYTICS]: ok(analyticsFixture()) });
    renderWithQuery(<ExposureTab />);
    expect(await screen.findByRole('group', { name: 'NAV by sector' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Invested by sector' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Exposure by sector' });
    expect(within(table).getByText('Energy transition')).toBeInTheDocument();
    expect(within(table).getByText('27.0%')).toBeInTheDocument();
    expect(within(table).getByText('$125.1M')).toBeInTheDocument();

    // Drawn from the summary's own breakdown: the browser fetches no positions to sum.
    const stacked = await screen.findByRole('group', { name: 'NAV by vehicle and deal type' });
    expect(
      within(stacked).getByRole('img', {
        name: 'Beach CV Opportunities I: Continuation vehicle (single asset) $105.9M',
      }),
    ).toBeInTheDocument();
    expect(
      within(stacked).getByRole('img', { name: 'Beach Credit Partners I: Private credit $18.8M' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Legend' })).toHaveTextContent('Private credit');
    expect(screen.queryByText(/no Locked valuation and/)).not.toBeInTheDocument();
    const requested = vi
      .mocked(fetch)
      .mock.calls.map(([input]) =>
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
    expect(requested.some((url) => url.includes('/api/v1/investments'))).toBe(false);

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'Vehicle' }));
    expect(await screen.findByRole('group', { name: 'NAV by vehicle' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Exposure by vehicle' })).toHaveTextContent(
      'Beach CV Opportunities I',
    );
  });

  it('exposure: stacks each vehicle in the API order and notes positions without a Locked valuation', async () => {
    const coInvest = {
      key: 'deal_type.co_invest_equity',
      label: 'Co-investment (equity)',
      count: 1,
      invested: '6900000.00',
      nav: '27400000.00',
      navShare: '0.06',
    };
    const cv = { ...CV_BUCKET, invested: '68453708.54', nav: '78493922.44', navShare: '0.17' };
    const base = analyticsFixture();
    mockApi({
      [ANALYTICS]: ok(
        analyticsFixture({
          activeInvestments: 4,
          exposures: {
            ...base.exposures,
            dealType: [CV_BUCKET, coInvest, CREDIT_BUCKET],
            vehicleByDealType: [
              { key: ID.vehicle1, label: 'Beach CV Opportunities I', segments: [cv, coInvest] },
              { key: ID.vehicle2, label: 'Beach Credit Partners I', segments: [CREDIT_BUCKET] },
            ],
          },
        }),
      ),
    });
    renderWithQuery(<ExposureTab />);
    const stacked = await screen.findByRole('group', { name: 'NAV by vehicle and deal type' });
    expect(
      within(stacked).getByRole('img', {
        name: 'Beach CV Opportunities I: Continuation vehicle (single asset) $78.5M, Co-investment (equity) $27.4M',
      }),
    ).toBeInTheDocument();
    const legend = within(screen.getByRole('list', { name: 'Legend' })).getAllByRole('listitem');
    expect(legend.map((item) => item.textContent)).toEqual([
      'Continuation vehicle (single asset)',
      'Co-investment (equity)',
      'Private credit',
    ]);
    // Four active positions, three with a Locked valuation in the breakdown.
    expect(
      screen.getByText('1 active position has no Locked valuation and is not included.'),
    ).toBeInTheDocument();
  });

  it('exposure: says so when no active position has a Locked valuation', async () => {
    const base = analyticsFixture();
    mockApi({
      [ANALYTICS]: ok(
        analyticsFixture({ exposures: { ...base.exposures, vehicleByDealType: [] } }),
      ),
    });
    renderWithQuery(<ExposureTab />);
    expect(await screen.findByText('No Locked valuations')).toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: 'NAV by vehicle and deal type' }),
    ).not.toBeInTheDocument();
  });

  it('performance: totals, the NAV series, flows by year and the largest positions', async () => {
    mockApi({ [ANALYTICS]: ok(analyticsFixture()) });
    renderWithQuery(<PerformanceAnalyticsTab />);
    const tiles = await screen.findByTestId('performance-tiles');
    expect(within(tiles).getByRole('group', { name: 'Invested' })).toHaveTextContent('$474.1M');
    expect(within(tiles).getByRole('group', { name: 'RVPI' })).toHaveTextContent('0.98x');
    expect(within(tiles).getByRole('group', { name: 'Gross IRR' })).toHaveTextContent('7.6%');
    expect(screen.getByRole('group', { name: 'NAV by quarter' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Contributions by year' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Distributions by year' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Cumulative net cash flow' })).toBeInTheDocument();
    const flows = screen.getByRole('table', { name: 'Cash flows by year' });
    expect(within(flows).getByText('-$279.6M')).toBeInTheDocument();
    const top = screen.getByRole('table', { name: 'Largest positions' });
    expect(within(top).getByRole('link', { name: 'Ashby Renewables Group' })).toHaveAttribute(
      'href',
      `/portfolio/${ID.inv3}`,
    );
    expect(within(top).getByText('17.0%')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Ashby Renewables Group: $79.1M' })).toBeInTheDocument();
  });

  it('credit book: the positions table, and an empty state per position while performance is not implemented', async () => {
    mockApi({
      [CREDIT]: ok(investmentPageFixture([creditInvestment()])),
      [`/api/v1/investments/${ID.inv2}/performance`]: failing(
        501,
        `/api/v1/investments/${ID.inv2}/performance`,
      ),
    });
    renderWithQuery(<CreditTab />);
    const book = await screen.findByRole('table', { name: 'Credit positions' });
    expect(within(book).getByRole('link', { name: 'Summit Services Co' })).toHaveAttribute(
      'href',
      `/portfolio/${ID.inv2}`,
    );
    // Funded and fair value are both $9.9M for this position.
    expect(within(book).getAllByText('$9.9M').length).toBeGreaterThan(0);
    expect(within(book).getByText('3.1%')).toBeInTheDocument();
    const card = await screen.findByTestId('credit-INV-0013');
    expect(
      await within(card).findByText('The performance series: not available yet'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });

  it('credit book: terms, latest quarter metrics, the value series and the amortization schedule', async () => {
    mockApi({
      [CREDIT]: ok(investmentPageFixture([creditInvestment()])),
      [`/api/v1/investments/${ID.inv2}/performance`]: ok(performanceFixture()),
    });
    renderWithQuery(<CreditTab />);
    const card = await screen.findByTestId('credit-INV-0013');
    const terms = await within(card).findByRole('table', { name: 'Credit terms' });
    expect(within(terms).getByText('Past maturity')).toBeInTheDocument();
    expect(within(terms).getByText('9.00% / 2.00%')).toBeInTheDocument();
    expect(within(terms).getByText('Oct 22, 2024', { exact: false })).toBeInTheDocument();
    expect(within(terms).getByText('Maximum net leverage 6.0x (quarterly)')).toBeInTheDocument();
    expect(within(card).getByRole('group', { name: 'Current yield' })).toHaveTextContent('11.23%');
    expect(within(card).getByRole('group', { name: 'Interest coverage' })).toHaveTextContent(
      '1.8x',
    );
    expect(within(card).getByRole('group', { name: 'LTV' })).toHaveTextContent('55.0%');
    expect(within(card).getByText('Covenants: Waiver')).toBeInTheDocument();
    expect(within(card).getByText('Payments: Current')).toBeInTheDocument();
    expect(within(card).getByRole('group', { name: 'Fair value and par' })).toBeInTheDocument();
    expect(within(card).getByRole('list', { name: 'Legend' })).toHaveTextContent('Par');
    const schedule = within(card).getByRole('table', { name: 'Amortization schedule' });
    expect(within(schedule).getByText('May 22, 2020')).toBeInTheDocument();
    expect(within(schedule).getByText('$0.5M')).toBeInTheDocument();
  });

  it('credit book: says so when there are no private credit positions', async () => {
    mockApi({ [CREDIT]: ok(investmentPageFixture([])) });
    renderWithQuery(<CreditTab />);
    expect(await screen.findByText('No private credit positions')).toBeInTheDocument();
  });

  it('realizations: realized tiles and the table with holding period and NM', async () => {
    mockApi({
      [ANALYTICS]: ok(analyticsFixture()),
      [REALIZED]: ok(
        investmentPageFixture([
          investmentFixture({
            id: ID.inv3,
            investmentNumber: 'INV-0017',
            companyName: 'Penrose Foods Holdings',
            isActive: false,
            entryDate: '2018-09-01',
            exitDate: '2020-09-01',
            invested: '23200000',
            distributions: '23000000',
            nav: '0',
            grossMoic: '0.9913793103',
            grossIrr: null,
            irrFlag: 'multiple_irr',
          }),
        ]),
      ),
    });
    renderWithQuery(<RealizationsTab />);
    const tiles = await screen.findByTestId('realizations-tiles');
    expect(within(tiles).getByRole('group', { name: 'Realized positions' })).toHaveTextContent('1');
    expect(within(tiles).getByRole('group', { name: 'Gross MOIC' })).toHaveTextContent('1.87x');
    const table = await screen.findByRole('table', { name: 'Realized positions' });
    const row = within(table).getByRole('link', { name: 'Penrose Foods Holdings' }).closest('tr');
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent('2.0 years');
    expect(row).toHaveTextContent('Sep 1, 2018');
    expect(row).toHaveTextContent('NM');
    expect(row).toHaveTextContent('0.99x');
  });

  it('realizations: degrades each half on its own when a read is not visible to the role', async () => {
    mockApi({
      [ANALYTICS]: failing(403, ANALYTICS),
      [REALIZED]: ok(investmentPageFixture([])),
    });
    renderWithQuery(<RealizationsTab />);
    expect(
      await screen.findByText('Portfolio analytics: not visible to your role'),
    ).toBeInTheDocument();
    expect(await screen.findByText('No realized positions')).toBeInTheDocument();
  });

  it('clients: renders the shared client look-through, which degrades while clients are unavailable', async () => {
    mockApi({ '/api/v1/clients': failing(501, '/api/v1/clients') });
    renderWithQuery(<ClientAnalyticsTab />);
    expect(await screen.findByText('Client look-through is not available yet')).toBeInTheDocument();
  });
});
