import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import type { ValuationRow } from '@pb/contracts';
import { AS_OF, investmentPageFixture } from '../../test/fixtures.js';
import {
  activePositions,
  POSITION_ID,
  refusalFixture,
  rolePrincipal,
  sentPosts,
  VAL_ID,
  valuationPageFixture,
  valuationRowFixture,
  valuationRows,
  vehicleListFixture,
} from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { ValuationsPage } from './Valuations.js';

vi.mock('../../app/env.js', () => ({ previewMode: true }));
vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const ME = '/api/v1/auth/me';
const BOARD = '/api/v1/valuations?limit=200';
const ACTIVE = '/api/v1/investments?limit=200&active=true';
const SUFFIX = '(simulated in this preview, not audited)';
/** Dialog journeys drive several Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

function routes(
  roles: Parameters<typeof rolePrincipal>[0],
  overrides: MockRoutes = {},
): MockRoutes {
  return {
    [ME]: ok(rolePrincipal(roles)),
    [BOARD]: ok(valuationPageFixture()),
    [ACTIVE]: ok(investmentPageFixture(activePositions())),
    '/api/v1/vehicles': ok(vehicleListFixture()),
    ...overrides,
  };
}

function rowOf(id: string): ValuationRow {
  const row = valuationRows().find((r) => r.id === id);
  if (row === undefined) throw new Error(`no fixture row ${id}`);
  return row;
}

const posts = sentPosts;

const button = (name: string): HTMLElement => screen.getByRole('button', { name });

/**
 * The modal hides the rest of the page from assistive technology while it is open; Fluent's focus
 * manager lifts that a moment after the dialog unmounts, then the status region is reachable again.
 */
async function dialogClosed(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await screen.findByRole('status');
}

describe('valuation board (preview)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('marks the simulation and lets operations prepare, send back and reopen, but not approve or lock', async () => {
    mockApi(routes(['operations']));
    renderWithQuery(<ValuationsPage />);
    await screen.findByRole('table', { name: 'Valuations' });
    await screen.findByRole('button', { name: 'New valuation' });
    expect(screen.getAllByText('Simulated').length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText(
        'Simulated changes do not recalculate NAV, MOIC or IRR; portfolio figures stay as recorded.',
      ),
    ).toBeInTheDocument();
    expect(button('New valuation')).toBeEnabled();
    expect(button('Reset preview')).toBeEnabled();
    expect(button('Prepare, Cobalt Energy Group, Jun 30, 2025 v1')).toBeEnabled();
    expect(button('Send back, Silverline Staffing Holdings, Jun 30, 2025 v1')).toBeEnabled();
    expect(button('Reopen, Meridian Data Partners, Jun 30, 2025 v1')).toBeEnabled();
    const approve = button('Deal team approve, Silverline Staffing Holdings, Jun 30, 2025 v1');
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('title', 'Needs deal team');
    const lock = button('Lock, Summit Services Co, Jun 30, 2025 v1');
    expect(lock).toBeDisabled();
    expect(lock).toHaveAttribute('title', 'Needs approver');
    expect(
      await screen.findByRole('button', { name: 'Start valuation, Summit Care Holdings' }),
    ).toBeEnabled();
  });

  it('lets the deal team approve but not prepare or reopen, and hides the operations-only actions', async () => {
    mockApi(routes(['deal_team']));
    renderWithQuery(<ValuationsPage />);
    await screen.findByRole('table', { name: 'Valuations' });
    await screen.findByTestId('missing-marks');
    expect(
      button('Deal team approve, Silverline Staffing Holdings, Jun 30, 2025 v1'),
    ).toBeEnabled();
    const prepare = button('Prepare, Cobalt Energy Group, Jun 30, 2025 v1');
    expect(prepare).toBeDisabled();
    expect(prepare).toHaveAttribute('title', 'Needs operations');
    expect(button('Reopen, Meridian Data Partners, Jun 30, 2025 v1')).toHaveAttribute(
      'title',
      'Needs operations or approver',
    );
    expect(screen.queryByRole('button', { name: 'New valuation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start valuation/ })).not.toBeInTheDocument();
  });

  it('sends a command and reports the new state in the status region and the session list', async () => {
    mockApi(
      routes(['operations'], {
        [`/api/v1/valuations/${VAL_ID.draft}/commands`]: ok({
          ...rowOf(VAL_ID.draft),
          state: 'OpsPrepared',
          preparedBy: rolePrincipal(['operations']).userId,
          rowVersion: 2,
        }),
      }),
    );
    renderWithQuery(<ValuationsPage />);
    await screen.findByRole('table', { name: 'Valuations' });
    await userEvent.click(button('Prepare, Cobalt Energy Group, Jun 30, 2025 v1'));
    const status = screen.getByRole('status');
    const message = `Cobalt Energy Group, Jun 30, 2025 v1 is now Ops prepared ${SUFFIX}`;
    expect(await within(status).findByText(message)).toHaveClass('pb-notice', 'pb-notice-good');
    expect(posts()).toEqual([
      [`/api/v1/valuations/${VAL_ID.draft}/commands`, { command: 'prepare' }],
    ]);
    const log = screen.getByRole('list', { name: 'Actions this session' });
    expect(within(log).getByText(message)).toBeInTheDocument();
    expect(within(log).getByText('Done')).toBeInTheDocument();
  });

  it('shows a refusal through describeActionError', async () => {
    mockApi(
      routes(['deal_team'], {
        [`/api/v1/valuations/${VAL_ID.prepared}/commands`]: {
          status: 422,
          body: refusalFixture(
            422,
            'valuation: the preparer cannot approve their own valuation (SEC-5.6)',
          ),
        },
      }),
    );
    renderWithQuery(<ValuationsPage />);
    await screen.findByRole('table', { name: 'Valuations' });
    await userEvent.click(
      button('Deal team approve, Silverline Staffing Holdings, Jun 30, 2025 v1'),
    );
    const notice = await within(screen.getByRole('status')).findByText(
      'Deal team approve for Silverline Staffing Holdings, Jun 30, 2025 v1: Blocked by a rule. The preparer cannot approve their own valuation (SEC-5.6)',
    );
    expect(notice).toHaveClass('pb-notice', 'pb-notice-bad');
    expect(
      within(screen.getByRole('list', { name: 'Actions this session' })).getByText('Refused'),
    ).toBeInTheDocument();
  });

  it('asks for a reason of at least three characters before sending back', TIMEOUT, async () => {
    mockApi(
      routes(['operations'], {
        [`/api/v1/valuations/${VAL_ID.prepared}/commands`]: ok({
          ...rowOf(VAL_ID.prepared),
          state: 'Draft',
          rowVersion: 3,
        }),
      }),
    );
    renderWithQuery(<ValuationsPage />);
    await screen.findByRole('table', { name: 'Valuations' });
    await userEvent.click(button('Send back, Silverline Staffing Holdings, Jun 30, 2025 v1'));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Send back' });
    expect(submit).toBeDisabled();
    const reason = within(dialog).getByRole('textbox', { name: /Reason/ });
    await userEvent.type(reason, 'ab');
    expect(submit).toBeDisabled();
    expect(posts()).toEqual([]);
    await userEvent.paste('c, cash figure missing');
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await dialogClosed();
    expect(
      await within(screen.getByRole('status')).findByText(
        `Silverline Staffing Holdings, Jun 30, 2025 v1 is now Draft ${SUFFIX}`,
      ),
    ).toBeInTheDocument();
    expect(posts()).toEqual([
      [
        `/api/v1/valuations/${VAL_ID.prepared}/commands`,
        { command: 'sendBack', reason: 'abc, cash figure missing' },
      ],
    ]);
  });

  it(
    'checks the fair value against the decimal contract before anything is sent',
    TIMEOUT,
    async () => {
      mockApi(routes(['operations']));
      renderWithQuery(<ValuationsPage />);
      await userEvent.click(
        await screen.findByRole('button', { name: 'Start valuation, Summit Care Holdings' }),
      );
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByDisplayValue('Jun 30, 2025')).toHaveAttribute('readonly');
      const value = within(dialog).getByRole('textbox', { name: /Fair value/ });
      await userEvent.click(value);
      await userEvent.paste('41.5M');
      // Leave the field (jsdom cannot tab inside the dialog's focus trap; a click elsewhere blurs it).
      await userEvent.click(within(dialog).getByText(/Starts a Draft version/));
      expect(
        within(dialog).getByText(
          'Use digits with an optional decimal point, for example 12500000.00.',
        ),
      ).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Create draft' })).toBeDisabled();
      expect(posts()).toEqual([]);
    },
  );

  it('creates a Draft valuation from the form', TIMEOUT, async () => {
    mockApi(
      routes(['operations'], {
        '/api/v1/valuations': {
          status: 201,
          body: valuationRowFixture({
            id: '00000000-0000-4000-8000-000000000199',
            investmentId: POSITION_ID.summitCare,
            investmentNumber: 'INV-0015',
            companyName: 'Summit Care Holdings',
            vehicleName: 'Beach CV Opportunities I',
            dealType: 'deal_type.cv_single_asset',
            state: 'Draft',
            fairValue: '41500000.00',
            priorFairValue: '41000000.00',
            changePct: '0.0122',
            lockHash: null,
            preparedBy: null,
            dealTeamApprovedBy: null,
            approvedBy: null,
            approvedAt: null,
            rowVersion: 1,
          }),
        },
      }),
    );
    renderWithQuery(<ValuationsPage />);
    await screen.findByRole('table', { name: 'Valuations' });
    await userEvent.click(await screen.findByRole('button', { name: 'New valuation' }));
    const dialog = await screen.findByRole('dialog');
    const create = within(dialog).getByRole('button', { name: 'Create draft' });
    expect(create).toBeDisabled();

    await userEvent.click(within(dialog).getByRole('combobox', { name: /Investment/ }));
    await userEvent.click(
      await screen.findByRole('option', { name: 'INV-0015 Summit Care Holdings' }),
    );
    await userEvent.click(within(dialog).getByRole('combobox', { name: /Method/ }));
    const methods = await screen.findAllByRole('option');
    expect(methods.map((o) => o.textContent)).toEqual([
      'Market multiple',
      'Par plus accrued',
      'Sponsor mark',
    ]);
    await userEvent.click(screen.getByRole('option', { name: 'Sponsor mark' }));
    await userEvent.click(within(dialog).getByRole('textbox', { name: /Fair value/ }));
    await userEvent.paste('41500000.00');
    expect(within(dialog).getByText('Reads as $41.5M.')).toBeInTheDocument();
    expect(create).toBeEnabled();
    await userEvent.click(create);
    await dialogClosed();
    expect(
      await within(screen.getByRole('status')).findByText(
        `Draft valuation created for Summit Care Holdings, Jun 30, 2025 ${SUFFIX}`,
      ),
    ).toBeInTheDocument();
    expect(posts()).toEqual([
      [
        '/api/v1/valuations',
        {
          investmentId: POSITION_ID.summitCare,
          periodEnd: AS_OF,
          method: 'valuation_method.sponsor_mark',
          fairValue: '41500000.00',
        },
      ],
    ]);
  });

  it('opens the form with the position chosen from the missing marks', TIMEOUT, async () => {
    mockApi(routes(['operations']));
    renderWithQuery(<ValuationsPage />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Start valuation, Summit Care Holdings' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: /Investment/ })).toHaveTextContent(
      'INV-0015 Summit Care Holdings',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await dialogClosed();
    expect(posts()).toEqual([]);
  });

  it('resets the preview after a confirm step', TIMEOUT, async () => {
    mockApi(routes(['deal_team'], { '/api/v1/preview/reset': ok({ reset: true }) }));
    renderWithQuery(<ValuationsPage />);
    await screen.findByRole('table', { name: 'Valuations' });
    await userEvent.click(button('Reset preview'));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Forget every simulated change in this page session?'),
    ).toBeInTheDocument();
    expect(posts()).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Forget changes' }));
    await dialogClosed();
    expect(
      await within(screen.getByRole('status')).findByText(
        'Preview reset. Every simulated change in this page session is forgotten.',
      ),
    ).toBeInTheDocument();
    expect(posts()).toEqual([['/api/v1/preview/reset', undefined]]);
  });
});
