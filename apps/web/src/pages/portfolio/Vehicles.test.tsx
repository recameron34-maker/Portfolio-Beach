import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { vehicleDetail, vehicleList } from '@pb/contracts';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import { AS_OF, ID } from '../../test/fixtures.js';
import {
  primaryProgramFixture,
  vehicleDetailFixture,
  vehicleListFixture,
  vehicleSummaryFixture,
  VS_ID,
} from '../../test/fixtures-vehicles-sponsors.js';
import { renderWithQuery } from '../../test/render.js';
import { CLIENT_DATA_VISIBILITY, NO_CASH_FLOW_NOTE } from './vehicle-ui.js';
import { VehicleDetailPage, VehiclesPage } from './Vehicles.js';

const params = vi.hoisted(() => ({ id: '' }));

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: params.id }),
}));

const VEHICLES = '/api/v1/vehicles';
const vehiclePath = (id: string): string => `/api/v1/vehicles/${id}`;
const EM_DASH = String.fromCharCode(0x2014);

/** The row of a table that holds a given text, for row-scoped assertions. */
function rowWith(table: HTMLElement, text: string): HTMLElement {
  const row = within(table).getByText(text).closest('tr');
  if (row === null) throw new Error(`no row holds ${text}`);
  return row;
}

describe('vehicle fixtures', () => {
  it('parse through the contract schemas', () => {
    expect(() => vehicleList.parse(vehicleListFixture())).not.toThrow();
    expect(() => vehicleDetail.parse(vehicleDetailFixture())).not.toThrow();
    expect(() => vehicleDetail.parse(primaryProgramFixture())).not.toThrow();
  });
});

describe('vehicles list', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists each vehicle with a link, its type, vintage, active positions and LP commitments', async () => {
    mockApi({ [VEHICLES]: ok(vehicleListFixture()) });
    renderWithQuery(<VehiclesPage />);
    const table = await screen.findByRole('table', { name: 'Vehicles' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByRole('link', { name: 'Beach CV Opportunities I' })).toHaveAttribute(
      'href',
      `/portfolio/vehicles/${VS_ID.vehicleCv}`,
    );
    const cv = rowWith(table, 'Beach CV Opportunities I');
    expect(within(cv).getByText('Cv')).toBeInTheDocument();
    expect(within(cv).getByText('2021')).toHaveClass('num');
    expect(within(cv).getByText('3')).toHaveClass('num');
    expect(within(cv).getByText('$200.0M')).toHaveClass('num');
    // A vintage that is not set shows the missing placeholder, muted.
    const primary = rowWith(table, 'Beach Primary Program');
    expect(within(primary).getByText('-')).toHaveClass('is-missing');
    expect(screen.getByTestId('vehicles-client-note')).toHaveTextContent(
      'LP commitments total the client commitments you are entitled to see.',
    );
    expect(screen.getByRole('heading', { name: 'Vehicles' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Portfolio' })).toHaveTextContent('Vehicles');

    const chart = screen.getByRole('group', { name: 'Active positions by vehicle' });
    const bars = within(chart).getAllByRole('img');
    expect(bars.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Beach Co-Invest Fund I: 4',
      'Beach CV Opportunities I: 3',
      'Beach Primary Program: 0',
    ]);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(EM_DASH);
  });

  it('keeps the LP commitments column with the placeholder and says who may see client data', async () => {
    mockApi({
      [VEHICLES]: ok(
        vehicleListFixture(
          vehicleListFixture().items.map((v) => ({ ...v, lpCommitmentsTotal: null })),
        ),
      ),
    });
    renderWithQuery(<VehiclesPage />);
    const table = await screen.findByRole('table', { name: 'Vehicles' });
    expect(within(table).getByRole('columnheader', { name: 'LP commitments' })).toBeInTheDocument();
    for (const row of within(table).getAllByRole('row').slice(1)) {
      const cells = within(row).getAllByRole('cell');
      expect(cells[cells.length - 1]).toHaveTextContent('-');
      expect(cells[cells.length - 1]).toHaveClass('is-missing');
    }
    expect(screen.getByTestId('vehicles-client-note')).toHaveTextContent(
      `${CLIENT_DATA_VISIBILITY}.`,
    );
  });

  it('says no vehicle is visible when the list is empty', async () => {
    mockApi({ [VEHICLES]: ok(vehicleListFixture([])) });
    renderWithQuery(<VehiclesPage />);
    expect(await screen.findByTestId('vehicles-empty')).toHaveTextContent('No vehicles visible');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says there is nothing to chart when no vehicle holds an active position', async () => {
    mockApi({
      [VEHICLES]: ok(vehicleListFixture([vehicleSummaryFixture({ activeInvestments: 0 })])),
    });
    renderWithQuery(<VehiclesPage />);
    expect(await screen.findByText('No active positions')).toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: 'Active positions by vehicle' }),
    ).not.toBeInTheDocument();
  });

  it('degrades a 403 or a 501 to an empty state that names the reason', async () => {
    mockApi({ [VEHICLES]: failing(403, VEHICLES) });
    renderWithQuery(<VehiclesPage />);
    expect(await screen.findByTestId('vehicles-unavailable')).toHaveTextContent(
      'Vehicles: not visible to your role',
    );
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();

    mockApi({ [VEHICLES]: failing(501, VEHICLES) });
    renderWithQuery(<VehiclesPage />);
    expect(await screen.findByTestId('vehicles-unavailable')).toHaveTextContent(
      'Vehicles: not available yet',
    );
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });

  it('shows any other failure as an error', async () => {
    mockApi({
      [VEHICLES]: {
        status: 500,
        body: {
          type: 'https://portfolio-beach.example/problems/internal',
          title: 'Internal error',
          status: 500,
          detail: 'The database did not answer',
          request_id: 'test',
        },
      },
    });
    renderWithQuery(<VehiclesPage />);
    expect(await screen.findByTestId('error-state')).toHaveTextContent('Vehicles could not load');
  });
});

describe('vehicle detail', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the banner, pooled tiles, NAV trend, schedule of investments and client commitments', async () => {
    params.id = VS_ID.vehicleCv;
    mockApi({ [vehiclePath(VS_ID.vehicleCv)]: ok(vehicleDetailFixture()) });
    renderWithQuery(<VehicleDetailPage />);
    const banner = await screen.findByTestId('vehicle-banner');
    expect(within(banner).getByRole('heading', { name: 'Beach CV Opportunities I' })).toBeVisible();
    for (const item of [
      'Cv',
      'Vintage 2021',
      'USD',
      '1 closing',
      'Final close Jun 30, 2021',
      'As of Jun 30, 2025',
    ]) {
      expect(within(banner).getByText(item)).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: 'All vehicles' })).toHaveAttribute(
      'href',
      '/portfolio/vehicles',
    );

    const tiles = screen.getByTestId('vehicle-tiles');
    const tile = (label: string): HTMLElement => within(tiles).getByRole('group', { name: label });
    expect(tile('Positions')).toHaveTextContent('21 active');
    expect(tile('Invested')).toHaveTextContent('$73.1M');
    expect(tile('Distributions')).toHaveTextContent('$23.0M');
    expect(tile('NAV')).toHaveTextContent('$79.1MLocked marks only');
    expect(tile('DPI')).toHaveTextContent('0.31x');
    expect(tile('TVPI')).toHaveTextContent('1.40x');
    expect(tile('Gross MOIC')).toHaveTextContent('1.40x');
    expect(tile('Gross IRR')).toHaveTextContent('6.9%Pooled cash flows, XIRR');

    expect(screen.getByRole('group', { name: 'NAV by quarter' })).toBeInTheDocument();

    const schedule = screen.getByRole('table', { name: 'Schedule of investments' });
    expect(within(schedule).getByRole('link', { name: 'Ashby Renewables Group' })).toHaveAttribute(
      'href',
      `/portfolio/${ID.inv3}`,
    );
    const ashby = rowWith(schedule, 'Ashby Renewables Group');
    expect(within(ashby).getByText('INV-0012')).toHaveClass('pb-key');
    expect(within(ashby).getByText('Skerry Partners')).toBeInTheDocument();
    expect(within(ashby).getByText('Cv single asset')).toBeInTheDocument();
    expect(within(ashby).getByText('Apr 27, 2019')).toBeInTheDocument();
    expect(within(ashby).getByText('5.8%')).toHaveClass('num');
    expect(within(ashby).getByText('Active')).toBeInTheDocument();
    const penrose = rowWith(schedule, 'Penrose Foods Holdings');
    expect(within(penrose).getByText('NM')).toHaveClass('is-missing');
    expect(within(penrose).getByText('Realized')).toBeInTheDocument();
    // The total row takes the pooled figures from the API, never a sum made in the browser.
    const total = within(schedule).getByRole('rowheader', { name: 'Total' }).closest('tr');
    expect(total).toHaveTextContent('$73.1M$23.0M$79.1M1.40x6.9%');

    expect(screen.getByTestId('vehicle-fund-commitments-empty')).toHaveTextContent(
      'No fund commitments',
    );

    const clients = screen.getByRole('table', { name: 'Client commitments' });
    const alpha = rowWith(clients, 'Client Alpha Pension');
    expect(within(alpha).getByText('$120.0M')).toBeInTheDocument();
    expect(within(alpha).getByText('60.0%')).toBeInTheDocument();
    expect(within(alpha).getByText('Jun 30, 2021')).toBeInTheDocument();
    expect(
      within(clients).getByRole('rowheader', { name: 'Total' }).closest('tr'),
    ).toHaveTextContent('$200.0M');
    expect(screen.queryByTestId('client-commitments-hidden')).not.toBeInTheDocument();

    expect(screen.getByTestId('vehicle-calc-version')).toHaveTextContent('Calc version 0.1.0.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(EM_DASH);
  });

  it('shows the primary program as fund commitments only, and who may see client data', async () => {
    params.id = VS_ID.vehiclePrimary;
    mockApi({ [vehiclePath(VS_ID.vehiclePrimary)]: ok(primaryProgramFixture()) });
    renderWithQuery(<VehicleDetailPage />);
    const banner = await screen.findByTestId('vehicle-banner');
    expect(within(banner).getByText('2 closings')).toBeInTheDocument();
    expect(within(banner).getByText('Final close not yet')).toBeInTheDocument();
    // Nothing pools without a position: no blank tiles and no NAV trend.
    expect(screen.queryByTestId('vehicle-tiles')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'NAV by quarter' })).not.toBeInTheDocument();
    expect(screen.getByTestId('vehicle-positions-empty')).toHaveTextContent(
      'No positions in this vehicle',
    );
    expect(screen.getByTestId('vehicle-positions-empty')).toHaveTextContent(
      'holds commitments to sponsor funds rather than positions',
    );

    const funds = screen.getByRole('table', { name: 'Fund commitments' });
    const kelpwood = rowWith(funds, 'Kelpwood Fund I');
    expect(
      within(kelpwood).getByRole('link', { name: 'Kelpwood Capital Partners' }),
    ).toHaveAttribute('href', `/sponsors/${VS_ID.sponsorKelpwood}`);
    expect(within(kelpwood).getByText('2015')).toBeInTheDocument();
    expect(within(kelpwood).getByText('Buyout')).toBeInTheDocument();
    expect(within(kelpwood).getByText('$25.0M')).toBeInTheDocument();
    expect(within(kelpwood).getByText('$22.8M')).toBeInTheDocument();
    expect(within(kelpwood).getByText('Mar 31, 2015')).toBeInTheDocument();
    // A commitment with no recorded cash flow yet: called, distributed, recallable and unfunded are missing.
    const marram = rowWith(funds, 'Marram Fund III');
    expect(within(marram).getAllByText('-')).toHaveLength(4);
    expect(screen.getByText(NO_CASH_FLOW_NOTE)).toBeInTheDocument();

    expect(screen.getByTestId('client-commitments-hidden')).toHaveTextContent(
      CLIENT_DATA_VISIBILITY,
    );
    expect(screen.queryByRole('table', { name: 'Client commitments' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(EM_DASH);
  });

  it('says there is no NAV trend yet with fewer than two quarters of Locked marks', async () => {
    params.id = VS_ID.vehicleCv;
    mockApi({
      [vehiclePath(VS_ID.vehicleCv)]: ok(
        vehicleDetailFixture({
          navSeries: [
            { periodEnd: '2025-03-31', value: null },
            { periodEnd: AS_OF, value: '79062720.52' },
          ],
        }),
      ),
    });
    renderWithQuery(<VehicleDetailPage />);
    expect(await screen.findByTestId('vehicle-nav-empty')).toHaveTextContent('No NAV trend yet');
    expect(screen.queryByRole('group', { name: 'NAV by quarter' })).not.toBeInTheDocument();
  });

  it('shows an IRR flag as a hint, a missing vintage, and an entitled caller with no client commitments', async () => {
    params.id = VS_ID.vehicleCv;
    const fixture = vehicleDetailFixture({
      vintage: null,
      lpCommitments: [],
      lpCommitmentsTotal: null,
    });
    mockApi({
      [vehiclePath(VS_ID.vehicleCv)]: ok({
        ...fixture,
        metrics: { ...fixture.metrics, grossIrr: null, irrFlag: 'short_period' },
      }),
    });
    renderWithQuery(<VehicleDetailPage />);
    expect(
      within(await screen.findByTestId('vehicle-banner')).getByText('Vintage -'),
    ).toBeInTheDocument();
    const tiles = screen.getByTestId('vehicle-tiles');
    expect(within(tiles).getByRole('group', { name: 'Gross IRR' })).toHaveTextContent(
      'NMNot meaningful: held for less than the minimum period',
    );
    expect(screen.getByTestId('client-commitments-empty')).toHaveTextContent(
      'No client commitments',
    );
  });

  it('says not found or not visible for a 404 and for a 403', async () => {
    for (const status of [404, 403] as const) {
      params.id = VS_ID.vehicleCv;
      mockApi({ [vehiclePath(VS_ID.vehicleCv)]: failing(status, vehiclePath(VS_ID.vehicleCv)) });
      renderWithQuery(<VehicleDetailPage />);
      expect(await screen.findByTestId('error-state')).toHaveTextContent(
        'Vehicle not found or not visible to you',
      );
      expect(screen.getByRole('link', { name: 'All vehicles' })).toHaveAttribute(
        'href',
        '/portfolio/vehicles',
      );
      expect(screen.queryByTestId('vehicle-banner')).not.toBeInTheDocument();
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('degrades a 501 to an empty state rather than an error', async () => {
    params.id = VS_ID.vehicleCv;
    mockApi({ [vehiclePath(VS_ID.vehicleCv)]: failing(501, vehiclePath(VS_ID.vehicleCv)) });
    renderWithQuery(<VehicleDetailPage />);
    expect(await screen.findByText('This vehicle: not available yet')).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });
});
