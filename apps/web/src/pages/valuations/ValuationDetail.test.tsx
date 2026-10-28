import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { valuationLockText } from '@pb/contracts';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import {
  changeTypeTaxonomyFixture,
  POSITION_ID,
  refusalFixture,
  rolePrincipal,
  sentPosts,
  VAL_ID,
  valuationDetailFixture,
  valuationRowFixture,
} from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { clearTaxonomyLabels, registerTaxonomyLabels } from '../../lib/format.js';
import { ValuationDetailPage } from './ValuationDetail.js';

const params = vi.hoisted(() => ({ id: '00000000-0000-4000-8000-000000000104' }));

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: params.id }),
}));

/** The shell registers the taxonomy labels for labelOf; the tests register the change types the same way. */
beforeAll(() =>
  registerTaxonomyLabels(changeTypeTaxonomyFixture().domains.flatMap((d) => d.terms)),
);
afterAll(() => clearTaxonomyLabels());

const ME = '/api/v1/auth/me';
const detailPath = (id: string): string => `/api/v1/valuations/${id}`;
const commandsPath = (id: string): string => `/api/v1/valuations/${id}/commands`;
const NEW_DRAFT_ID = '00000000-0000-4000-8000-000000000199';
/** Dialog journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

function routes(
  roles: Parameters<typeof rolePrincipal>[0],
  overrides: MockRoutes = {},
): MockRoutes {
  params.id = VAL_ID.locked;
  return {
    [ME]: ok(rolePrincipal(roles)),
    [detailPath(VAL_ID.locked)]: ok(valuationDetailFixture()),
    ...overrides,
  };
}

const tile = (name: string): HTMLElement =>
  within(screen.getByTestId('valuation-detail-tiles')).getByRole('group', { name });

/**
 * The page's one status region, by its test id: the modal hides the rest of the page from
 * assistive technology while it is open, and in jsdom Fluent's focus manager lifts that late, so
 * the region is read by id rather than by role once a dialog has been used.
 */
const status = (): HTMLElement => screen.getByTestId('valuation-action-status');

async function dialogClosed(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

describe('valuation version screen', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the version, its progress, the figures, the approvals, the lock text and the open requests', async () => {
    mockApi(routes(['approver']));
    renderWithQuery(<ValuationDetailPage />);
    expect(await screen.findByTestId('valuation-detail')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Meridian Data Partners: Jun 30, 2025 v1',
    );
    const banner = screen.getByTestId('valuation-banner');
    expect(within(banner).getByRole('link', { name: 'INV-0001' })).toHaveAttribute(
      'href',
      `/portfolio/${POSITION_ID.meridian}`,
    );
    expect(within(banner).getByText('Locked')).toHaveClass('pb-badge-good');
    expect(screen.getByRole('link', { name: 'Valuation board' })).toHaveAttribute(
      'href',
      '/valuations',
    );

    const steps = within(screen.getByRole('list', { name: 'Valuation progress' })).getAllByRole(
      'listitem',
    );
    expect(steps).toHaveLength(4);
    expect(steps[0]).toHaveTextContent('DraftDone');
    expect(steps[3]).toHaveAttribute('aria-current', 'step');
    expect(steps[3]).toHaveTextContent('LockedCurrent');

    expect(within(tile('Fair value')).getByText('$27.4M')).toBeInTheDocument();
    expect(within(tile('Prior fair value')).getByText('$25.0M')).toBeInTheDocument();
    expect(within(tile('Change')).getByText('9.6%')).toBeInTheDocument();
    expect(tile('Change')).not.toHaveAttribute('data-tone');
    expect(within(tile('Locked')).getByText('Aug 9, 2025')).toBeInTheDocument();
    expect(within(tile('Locked')).getByText('By Morgan Lindqvist')).toBeInTheDocument();

    const approvals = within(screen.getByTestId('valuation-approvals')).getByRole('table', {
      name: 'Approvals',
    });
    const rows = within(approvals).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      'Ops preparedApprovedAvery MbekiJul 20, 2025 10:00:00 UTC-',
      'Deal teamApprovedBlake OkaforAug 1, 2025 10:00:00 UTC-',
      'Final approvalApprovedMorgan LindqvistAug 9, 2025 15:00:00 UTC-',
    ]);

    const lock = screen.getByTestId('valuation-lock');
    expect(screen.getByTestId('valuation-lock-text')).toHaveTextContent(
      valuationLockText(valuationRowFixture()),
    );
    expect(within(lock).getByText('h-00000104')).toHaveClass('pb-val-hash');

    const open = screen.getByTestId('valuation-open-changes');
    expect(open).toHaveTextContent('1 open request');
    const openRow = within(open).getByText('Add-on acquisition').closest('tr')!;
    expect(within(openRow).getByText('Submitted')).toHaveClass('pb-badge-watch');
    expect(within(openRow).getByText('May 15, 2025')).toBeInTheDocument();
    expect(
      within(open).getByRole('link', { name: 'Open the change request queue' }),
    ).toHaveAttribute('href', '/valuations/changes');

    // An approver may reopen a Locked version; the note names what a reopen does.
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeEnabled();
    expect(
      screen.getByText(/Creates a new Draft version and alerts prior approvers/),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x2014));
  });

  it('names the roles a viewer would need and keeps the screen read only', async () => {
    mockApi(routes(['viewer']));
    renderWithQuery(<ValuationDetailPage />);
    const reopen = await screen.findByRole('button', { name: 'Reopen' });
    expect(reopen).toBeDisabled();
    expect(reopen).toHaveAttribute('title', 'Needs operations or approver');
  });

  it('reopens with a reason and links to the new Draft version', TIMEOUT, async () => {
    mockApi(
      routes(['approver'], {
        [commandsPath(VAL_ID.locked)]: ok(
          valuationRowFixture({
            id: NEW_DRAFT_ID,
            version: 2,
            state: 'Draft',
            lockHash: null,
            preparedBy: null,
            dealTeamApprovedBy: null,
            approvedBy: null,
            approvedAt: null,
            rowVersion: 1,
          }),
        ),
      }),
    );
    renderWithQuery(<ValuationDetailPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reopen' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Sponsor restated',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reopen' }));
    await dialogClosed();
    expect(
      await within(status()).findByText(
        'Meridian Data Partners, Jun 30, 2025 v1 is now Reopened; the new Draft version is Meridian Data Partners, Jun 30, 2025 v2 (audited)',
      ),
    ).toHaveClass('pb-notice-good');
    // By text, not by role: the closed modal may still mark the page hidden for a moment in jsdom.
    const reopened = screen.getByTestId('valuation-reopened');
    const link = within(reopened).getByText('Meridian Data Partners, Jun 30, 2025 v2');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', `/valuations/${NEW_DRAFT_ID}`);
    expect(sentPosts()).toEqual([
      [commandsPath(VAL_ID.locked), { command: 'reopen', reason: 'Sponsor restated' }],
    ]);
  });

  it('offers the deal team its approval on an Ops prepared version and words a refusal', async () => {
    params.id = VAL_ID.prepared;
    mockApi({
      [ME]: ok(rolePrincipal(['deal_team'])),
      [detailPath(VAL_ID.prepared)]: ok(
        valuationDetailFixture({
          id: VAL_ID.prepared,
          state: 'OpsPrepared',
          lockHash: null,
          dealTeamApprovedBy: null,
          approvedBy: null,
          approvedAt: null,
          approvals: [
            {
              id: '00000000-0000-4000-8000-000000000611',
              step: 'ops_prepared',
              decision: 'approve',
              actorId: '00000000-0000-4000-8000-000000000301',
              actorName: 'Avery Mbeki',
              at: '2025-07-20T10:00:00Z',
              reason: null,
            },
          ],
          openChangeRequests: [],
          lockText: null,
        }),
      ),
      [commandsPath(VAL_ID.prepared)]: {
        status: 422,
        body: refusalFixture(
          422,
          'valuation: the preparer cannot approve their own valuation (SEC-5.6)',
        ),
      },
    });
    renderWithQuery(<ValuationDetailPage />);
    const approve = await screen.findByRole('button', { name: 'Deal team approve' });
    expect(approve).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send back' })).toBeEnabled();
    expect(
      within(screen.getByTestId('valuation-lock')).getByText('Not locked'),
    ).toBeInTheDocument();
    expect(screen.getByText('No open change requests')).toBeInTheDocument();
    expect(within(tile('Locked')).getByText('-')).toBeInTheDocument();
    expect(within(tile('Locked')).getByText('Not locked')).toBeInTheDocument();
    await userEvent.click(approve);
    expect(
      await within(screen.getByRole('status')).findByText(
        'Deal team approve for Meridian Data Partners, Jun 30, 2025 v1: Blocked by a rule. The preparer cannot approve their own valuation (SEC-5.6)',
      ),
    ).toHaveClass('pb-notice-bad');
    expect(sentPosts()).toEqual([[commandsPath(VAL_ID.prepared), { command: 'dealTeamApprove' }]]);
  });

  it('says the work continues on the next version once reopened', async () => {
    mockApi(
      routes(['operations'], {
        [detailPath(VAL_ID.locked)]: ok(
          valuationDetailFixture({
            state: 'Reopened',
            reopenReason: 'Quarterly financials restated',
          }),
        ),
      }),
    );
    renderWithQuery(<ValuationDetailPage />);
    expect(
      await screen.findByText(/Reopened is the last step of this version; the work continues/),
    ).toBeInTheDocument();
    expect(screen.getByText('Reopen reason: Quarterly financials restated')).toBeInTheDocument();
    const steps = within(screen.getByRole('list', { name: 'Valuation progress' })).getAllByRole(
      'listitem',
    );
    expect(steps.every((s) => s.textContent?.endsWith('Done'))).toBe(true);
  });

  it.each([404, 403] as const)('says not found or not visible on a %s', async (status) => {
    mockApi(routes(['operations'], { [detailPath(VAL_ID.locked)]: failing(status, 'x') }));
    renderWithQuery(<ValuationDetailPage />);
    expect(
      await screen.findByText('Valuation not found or not visible to you'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Valuation board' })).toBeInTheDocument();
  });

  it('degrades to a not-available state on a 501', async () => {
    mockApi(routes(['operations'], { [detailPath(VAL_ID.locked)]: failing(501, 'x') }));
    renderWithQuery(<ValuationDetailPage />);
    expect(await screen.findByText('This valuation: not available yet')).toBeInTheDocument();
  });
});
