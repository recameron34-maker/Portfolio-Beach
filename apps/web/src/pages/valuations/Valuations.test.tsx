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
  sentPosts,
  sentRequests,
  VAL_ID,
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
const BATCH = '/api/v1/valuations/batch-commands';
/** Dialog and checkbox journeys drive Fluent controls; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

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

const button = (name: string): HTMLElement => screen.getByRole('button', { name });

describe('valuation board', () => {
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

  it('offers operations its own commands live, names the roles the others need, and shows no batch bar', async () => {
    mockApi(routes());
    renderWithQuery(<ValuationsPage />);
    await screen.findByRole('table', { name: 'Valuations' });
    for (const name of [
      'Prepare, Cobalt Energy Group, Jun 30, 2025 v1',
      'Send back, Silverline Staffing Holdings, Jun 30, 2025 v1',
      'Reopen, Meridian Data Partners, Jun 30, 2025 v1',
    ]) {
      expect(button(name), name).toBeEnabled();
      expect(button(name), name).not.toHaveAttribute('title');
    }
    const approve = button('Deal team approve, Silverline Staffing Holdings, Jun 30, 2025 v1');
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('title', 'Needs deal team');
    const lock = button('Lock, Summit Services Co, Jun 30, 2025 v1');
    expect(lock).toBeDisabled();
    expect(lock).toHaveAttribute('title', 'Needs approver');
    expect(await screen.findByRole('button', { name: 'New valuation' })).toBeEnabled();
    expect(screen.queryByText(/This build reads only/)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    // The batch approvals belong to the deal team and approvers (docs/04 M10).
    expect(screen.queryByTestId('valuation-batch-bar')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('links each version to its screen and shows the Valuations tabs', async () => {
    mockApi(routes());
    renderWithQuery(<ValuationsPage />);
    const table = await screen.findByRole('table', { name: 'Valuations' });
    const meridian = within(table)
      .getByRole('link', { name: 'Meridian Data Partners' })
      .closest('tr')!;
    expect(within(meridian).getByRole('link', { name: 'Jun 30, 2025' })).toHaveAttribute(
      'href',
      `/valuations/${VAL_ID.locked}`,
    );
    const tabs = screen.getByRole('navigation', { name: 'Valuations' });
    expect(within(tabs).getByRole('link', { name: 'Board' })).toHaveAttribute(
      'href',
      '/valuations',
    );
    expect(within(tabs).getByRole('link', { name: 'Change requests' })).toHaveAttribute(
      'href',
      '/valuations/changes',
    );
  });

  it(
    'gives the deal team a checkbox per Ops prepared version and approves the selection in one batch',
    TIMEOUT,
    async () => {
      mockApi(
        routes({
          [ME]: ok(rolePrincipal(['deal_team'])),
          [BATCH]: ok({ results: [{ id: VAL_ID.prepared, ok: true, state: 'DealTeamApproved' }] }),
        }),
      );
      renderWithQuery(<ValuationsPage />);
      await screen.findByRole('table', { name: 'Valuations' });
      const bar = screen.getByTestId('valuation-batch-bar');
      expect(bar).toHaveTextContent('0 versions selected');
      const approve = within(bar).getByRole('button', { name: 'Approve selected' });
      expect(approve).toBeDisabled();
      expect(approve).toHaveAttribute('title', 'Select at least one Ops prepared version');
      expect(within(bar).queryByRole('button', { name: /Lock selected/ })).not.toBeInTheDocument();
      // Only the versions the deal team's command starts from carry a checkbox.
      expect(screen.getByTestId(`valuation-batch-select-${VAL_ID.prepared}`)).toBeInTheDocument();
      expect(
        screen.queryByTestId(`valuation-batch-select-${VAL_ID.approved}`),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId(`valuation-batch-select-${VAL_ID.draft}`),
      ).not.toBeInTheDocument();

      await userEvent.click(
        screen.getByRole('checkbox', {
          name: 'Select Silverline Staffing Holdings, Jun 30, 2025 v1',
        }),
      );
      expect(bar).toHaveTextContent('1 version selected');
      const run = within(bar).getByRole('button', { name: 'Approve selected (1)' });
      expect(run).toBeEnabled();
      await userEvent.click(run);
      const status = screen.getByRole('status');
      expect(
        await within(status).findByText('Deal team approve on 1 version: 1 done, 0 refused.'),
      ).toHaveClass('pb-notice-good');
      expect(sentPosts()).toEqual([
        [BATCH, { command: 'dealTeamApprove', ids: [VAL_ID.prepared] }],
      ]);
      const log = screen.getByRole('list', { name: 'Actions this session' });
      expect(
        within(log).getByText(
          'Silverline Staffing Holdings, Jun 30, 2025 v1 is now Deal team approved (audited)',
        ),
      ).toBeInTheDocument();
      expect(bar).toHaveTextContent('0 versions selected');
    },
  );

  it(
    'gives an approver a checkbox per Deal team approved version and reports each refusal of a batch lock',
    TIMEOUT,
    async () => {
      mockApi(
        routes({
          [ME]: ok(rolePrincipal(['approver'])),
          [BATCH]: ok({
            results: [
              {
                id: VAL_ID.approved,
                ok: false,
                problem: {
                  status: 422,
                  code: 'workflow-precondition',
                  detail: 'valuation: the preparer cannot approve their own valuation (SEC-5.6)',
                },
              },
            ],
          }),
        }),
      );
      renderWithQuery(<ValuationsPage />);
      await screen.findByRole('table', { name: 'Valuations' });
      const bar = screen.getByTestId('valuation-batch-bar');
      expect(
        within(bar).queryByRole('button', { name: /Approve selected/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId(`valuation-batch-select-${VAL_ID.prepared}`),
      ).not.toBeInTheDocument();
      await userEvent.click(
        screen.getByRole('checkbox', { name: 'Select Summit Services Co, Jun 30, 2025 v1' }),
      );
      await userEvent.click(within(bar).getByRole('button', { name: 'Lock selected (1)' }));
      const status = screen.getByRole('status');
      expect(await within(status).findByText('Lock on 1 version: 0 done, 1 refused.')).toHaveClass(
        'pb-notice-bad',
      );
      expect(
        within(screen.getByRole('list', { name: 'Actions this session' })).getByText(
          'Lock for Summit Services Co, Jun 30, 2025 v1: Blocked by a rule. The preparer cannot approve their own valuation (SEC-5.6)',
        ),
      ).toBeInTheDocument();
      expect(sentPosts()).toEqual([[BATCH, { command: 'lock', ids: [VAL_ID.approved] }]]);
    },
  );

  it('filters by state, vehicle and search in the browser', { timeout: 15_000 }, async () => {
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

    await userEvent.click(screen.getByRole('textbox', { name: 'Search' }));
    await userEvent.paste('cobalt');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Cobalt Energy Group')).toBeInTheDocument();
  });

  it(
    'switches period on the one unfiltered list the recorder knows',
    { timeout: 15_000 },
    async () => {
      mockApi(routes());
      renderWithQuery(<ValuationsPage />);
      await screen.findByRole('table', { name: 'Valuations' });
      await pick('Period', 'Mar 31, 2025');
      const prior = screen.getByRole('table', { name: 'Valuations' });
      expect(within(prior).getAllByRole('row')).toHaveLength(3);
      expect(within(prior).getByText('Summit Care Holdings')).toBeInTheDocument();
      expect(within(tile('In flight')).getByText('0')).toBeInTheDocument();
      expect(await within(tile('Missing marks')).findByText('4')).toBeInTheDocument();

      // Every filter is applied in the browser: the list is requested once, unfiltered, and the
      // page issues exactly the reads the preview recorder knows about.
      const urls = sentRequests().map(([url]) => url);
      expect(urls.filter((u) => u.startsWith('/api/v1/valuations'))).toEqual([BOARD]);
      expect([...new Set(urls)].sort()).toEqual([ME, VEHICLES, ACTIVE, BOARD].sort());
    },
  );

  it('lists the active positions with no mark and offers operations a start button', async () => {
    mockApi(routes());
    renderWithQuery(<ValuationsPage />);
    const card = await screen.findByTestId('missing-marks');
    const table = await within(card).findByRole('table', { name: 'Missing marks' });
    expect(within(table).getByRole('link', { name: 'Summit Care Holdings' })).toHaveAttribute(
      'href',
      `/portfolio/${POSITION_ID.summitCare}`,
    );
    expect(
      within(card).getByRole('button', { name: 'Start valuation, Summit Care Holdings' }),
    ).toBeEnabled();
    expect(
      within(screen.getByTestId('action-log')).getByText('No actions yet'),
    ).toBeInTheDocument();
  });

  it('offers no start button to a role that cannot create a version', async () => {
    mockApi(routes({ [ME]: ok(rolePrincipal(['deal_team'])) }));
    renderWithQuery(<ValuationsPage />);
    const card = await screen.findByTestId('missing-marks');
    await within(card).findByRole('table', { name: 'Missing marks' });
    expect(within(card).queryByRole('button', { name: /Start valuation/ })).not.toBeInTheDocument();
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
    // Counts of the first page are not counts of the board, so the count tiles say so too.
    for (const label of ['Locked', 'In flight', 'Reopened']) {
      expect(within(tile(label)).getByText('-'), label).toBeInTheDocument();
      expect(
        within(tile(label)).getByText('Not calculable: more rows than one page holds'),
        label,
      ).toBeInTheDocument();
    }
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
