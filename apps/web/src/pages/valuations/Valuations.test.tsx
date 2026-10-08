import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import { investmentPageFixture } from '../../test/fixtures.js';
import {
  activePositions,
  POSITION_ID,
  rolePrincipal,
  sentRequests,
  valuationPageFixture,
  vehicleListFixture,
} from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { ValuationsPage } from './Valuations.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const ME = '/api/v1/auth/me';
const BOARD = '/api/v1/valuations?limit=200';
const ACTIVE = '/api/v1/investments?limit=200&active=true';
const VEHICLES = '/api/v1/vehicles';
const PHASE_3 = 'Workflow actions arrive with Phase 3';

function routes(overrides: MockRoutes = {}): MockRoutes {
  return {
    [ME]: ok(rolePrincipal(['operations'])),
    [BOARD]: ok(valuationPageFixture()),
    [ACTIVE]: ok(investmentPageFixture(activePositions())),
    [VEHICLES]: ok(vehicleListFixture()),
    ...overrides,
  };
}

const tile = (name: string): HTMLElement =>
  within(screen.getByTestId('valuation-tiles')).getByRole('group', { name });

async function pick(combobox: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole('combobox', { name: combobox }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

describe('valuation board (read-only build)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the latest period: tiles, the gate, every version with its change and state', async () => {
    mockApi(routes());
    renderWithQuery(<ValuationsPage />);
    const table = await screen.findByRole('table', { name: 'Valuations' });
    expect(
      screen.getByText('As of Jun 30, 2025. Reports read Locked valuations only.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('valuation-gate')).toHaveTextContent(
      'Reports read Locked valuations only. Draft, Ops prepared and Deal team approved versions never reach a report.',
    );
    expect(within(tile('Locked')).getByText('2')).toBeInTheDocument();
    expect(within(tile('In flight')).getByText('3')).toBeInTheDocument();
    expect(within(tile('Reopened')).getByText('1')).toBeInTheDocument();
    expect(await within(tile('Missing marks')).findByText('1')).toBeInTheDocument();
    expect(tile('Missing marks')).toHaveAttribute('data-tone', 'watch');

    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(7);
    const silverline = within(table).getByText('Silverline Staffing Holdings').closest('tr')!;
    expect(within(silverline).getByText('INV-0004')).toHaveClass('pb-key');
    expect(within(silverline).getByText('Ops prepared')).toBeInTheDocument();
    expect(within(silverline).getByText('-20.6%')).toBeInTheDocument();
    expect(within(silverline).getByText('Variance').closest('[title]')).toHaveAttribute(
      'title',
      'Above the 10.0% flag (config/definitions.json)',
    );
    expect(within(silverline).getByText('$10.2M')).toBeInTheDocument();
    expect(within(silverline).getByText('$8.1M')).toBeInTheDocument();

    const meridian = within(table).getByRole('link', { name: 'Meridian Data Partners' });
    expect(meridian).toHaveAttribute('href', `/portfolio/${POSITION_ID.meridian}`);
    const meridianRow = meridian.closest('tr')!;
    expect(within(meridianRow).getByText('Aug 9, 2025')).toBeInTheDocument();
    expect(within(meridianRow).getByText('9.6%')).toBeInTheDocument();
    expect(within(meridianRow).queryByText('Variance')).not.toBeInTheDocument();
    expect(within(meridianRow).getByText('Sponsor mark')).toBeInTheDocument();

    const reopened = within(table).getByText('Reopened').closest('tr')!;
    expect(within(reopened).getByText('None')).toBeInTheDocument();
    expect(screen.queryByText('Showing the first 200', { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByText('Simulated')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset preview' })).not.toBeInTheDocument();
  });

  it('disables every action outside the preview, with the Phase 3 reason', async () => {
    mockApi(routes());
    renderWithQuery(<ValuationsPage />);
    await screen.findByRole('table', { name: 'Valuations' });
    for (const name of [
      'Prepare, Cobalt Energy Group, Jun 30, 2025 v1',
      'Deal team approve, Silverline Staffing Holdings, Jun 30, 2025 v1',
      'Send back, Silverline Staffing Holdings, Jun 30, 2025 v1',
      'Lock, Summit Services Co, Jun 30, 2025 v1',
      'Reopen, Meridian Data Partners, Jun 30, 2025 v1',
    ]) {
      const button = screen.getByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('title', PHASE_3);
    }
    const create = await screen.findByRole('button', { name: 'New valuation' });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute('title', PHASE_3);
    expect(
      screen.getByText(/This build reads only, so every action is shown but disabled/),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('filters by period, state, vehicle and search on the one unfiltered list', async () => {
    mockApi(routes());
    renderWithQuery(<ValuationsPage />);
    const table = await screen.findByRole('table', { name: 'Valuations' });

    await pick('State', 'Ops prepared');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Silverline Staffing Holdings')).toBeInTheDocument();
    await pick('State', 'All states');

    await pick('Vehicle', 'Beach Credit Partners I');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Summit Services Co')).toBeInTheDocument();
    await pick('Vehicle', 'All vehicles');

    await userEvent.type(screen.getByRole('textbox', { name: 'Search' }), 'cobalt');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    await userEvent.clear(screen.getByRole('textbox', { name: 'Search' }));

    await pick('Period', 'Mar 31, 2025');
    const prior = screen.getByRole('table', { name: 'Valuations' });
    expect(within(prior).getAllByRole('row')).toHaveLength(3);
    expect(within(prior).getByText('Summit Care Holdings')).toBeInTheDocument();
    expect(within(tile('In flight')).getByText('0')).toBeInTheDocument();
    expect(within(tile('Missing marks')).getByText('4')).toBeInTheDocument();

    // Every filter is applied in the browser: the list is requested once, unfiltered, and the
    // page issues exactly the reads the preview recorder knows about.
    const urls = sentRequests().map(([url]) => url);
    expect(urls.filter((u) => u.startsWith('/api/v1/valuations'))).toEqual([BOARD]);
    expect([...new Set(urls)].sort()).toEqual([ME, VEHICLES, ACTIVE, BOARD].sort());
  });

  it('lists the active positions with no mark, without a start button outside the preview', async () => {
    mockApi(routes());
    renderWithQuery(<ValuationsPage />);
    const card = await screen.findByTestId('missing-marks');
    const table = await within(card).findByRole('table', { name: 'Missing marks' });
    expect(within(table).getByRole('link', { name: 'Summit Care Holdings' })).toHaveAttribute(
      'href',
      `/portfolio/${POSITION_ID.summitCare}`,
    );
    expect(within(card).queryByRole('button', { name: /Start valuation/ })).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('action-log')).getByText('No actions yet'),
    ).toBeInTheDocument();
  });

  it('says when every active position has a mark', async () => {
    mockApi(
      routes({
        [ACTIVE]: ok(
          investmentPageFixture(activePositions().filter((p) => p.id !== POSITION_ID.summitCare)),
        ),
      }),
    );
    renderWithQuery(<ValuationsPage />);
    expect(
      await screen.findByText('Every active position has a mark for this period'),
    ).toBeInTheDocument();
    expect(tile('Missing marks')).not.toHaveAttribute('data-tone');
  });

  it('does not guess missing marks from a partial page, and says only the first 200 are shown', async () => {
    mockApi(routes({ [BOARD]: ok(valuationPageFixture(undefined, 'next-page')) }));
    renderWithQuery(<ValuationsPage />);
    expect(await screen.findByTestId('valuations-truncated')).toHaveTextContent(
      'Showing the first 200 valuation versions; more exist.',
    );
    expect(await screen.findByText('Missing marks need the full lists')).toBeInTheDocument();
    expect(within(tile('Missing marks')).getByText('-')).toBeInTheDocument();
    expect(
      within(tile('Missing marks')).getByText('Not calculable: more rows than one page holds'),
    ).toBeInTheDocument();
  });

  it('keeps the board when active positions are hidden from the role', async () => {
    mockApi(routes({ [ACTIVE]: failing(403, '/api/v1/investments') }));
    renderWithQuery(<ValuationsPage />);
    expect(
      await screen.findByText('Active positions: not visible to your role'),
    ).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Valuations' })).toBeInTheDocument();
    expect(
      within(tile('Missing marks')).getByText('Active positions could not load'),
    ).toBeInTheDocument();
  });

  it('degrades to a not-available state while the endpoint answers 501', async () => {
    mockApi(routes({ [BOARD]: failing(501, '/api/v1/valuations') }));
    renderWithQuery(<ValuationsPage />);
    expect(await screen.findByText('The valuation board: not available yet')).toBeInTheDocument();
    expect(screen.getByTestId('valuation-gate')).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Valuations' })).not.toBeInTheDocument();
  });

  it('says who can see the board when the role may not', async () => {
    mockApi(routes({ [BOARD]: failing(403, '/api/v1/valuations') }));
    renderWithQuery(<ValuationsPage />);
    expect(
      await screen.findByText('The valuation board: not visible to your role'),
    ).toBeInTheDocument();
  });

  it('offers New valuation to operations only', async () => {
    mockApi(routes({ [ME]: ok(rolePrincipal(['deal_team'])) }));
    renderWithQuery(<ValuationsPage />);
    await screen.findByRole('table', { name: 'Valuations' });
    expect(screen.queryByRole('button', { name: 'New valuation' })).not.toBeInTheDocument();
  });

  it('never shows an em dash', async () => {
    mockApi(routes());
    const { container } = renderWithQuery(<ValuationsPage />);
    await screen.findByRole('table', { name: 'Valuations' });
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});
