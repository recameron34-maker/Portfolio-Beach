import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import {
  NOTICE_ID,
  noticeDetailFixture,
  settledDetailFixture,
  ticketRows,
  WIRE_ID,
} from '../../test/fixtures-capital.js';
import { rolePrincipal } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { CapitalNoticePage } from './NoticeDetail.js';
import { RELEASE_ALLOWED } from './tickets.js';

const params = vi.hoisted(() => ({ id: '' }));

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: params.id }),
}));

const ME = '/api/v1/auth/me';
const detailPath = (id: string): string => `/api/v1/capital-notices/${id}`;

const tile = (testId: string, name: string): HTMLElement =>
  within(screen.getByTestId(testId)).getByRole('group', { name });

describe('capital notice detail', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the notice, its progress, the hold, the alerts and the bank-details rule', async () => {
    params.id = NOTICE_ID.extracted;
    mockApi({
      [ME]: ok(rolePrincipal(['operations'])),
      [detailPath(NOTICE_ID.extracted)]: ok(noticeDetailFixture()),
    });
    renderWithQuery(<CapitalNoticePage />);
    const banner = await screen.findByTestId('notice-banner');
    expect(within(banner).getByRole('heading', { level: 1 })).toHaveTextContent(
      'Capital call: Silverline Staffing Holdings',
    );
    expect(banner).toHaveTextContent('Beach Co-Invest Fund I');
    expect(banner).toHaveTextContent('Issued Jul 10, 2025');
    expect(banner).toHaveTextContent('Due Jul 12, 2025');
    expect(banner).toHaveTextContent('$2.5M USD');

    const progress = screen.getByRole('list', { name: 'Notice progress' });
    const steps = within(progress).getAllByRole('listitem');
    expect(steps).toHaveLength(7);
    expect(steps[0]).toHaveTextContent('ReceivedDone');
    expect(steps[1]).toHaveAttribute('aria-current', 'step');
    expect(steps[1]).toHaveTextContent('ExtractedCurrent');
    expect(steps[2]).toHaveTextContent('ReviewedUpcoming');
    expect(within(progress).getAllByText('Done')).toHaveLength(1);

    expect(screen.getByTestId('wire-hold')).toHaveTextContent(
      'Wire instructions changed within the hold window. Ticket approval is held until Jul 30, 2025 (30 days, SEC-12.3).',
    );
    // The SEC-12.4 alerts: a badge and a plain sentence each, in the contract's order.
    const alerts = within(screen.getByTestId('notice-alerts')).getAllByRole('listitem');
    expect(alerts).toHaveLength(3);
    expect(alerts[0]).toHaveTextContent(
      "Wire changedThe counterparty's wire instructions changed; the ticket releases only after a second person's callback verifies the new version (SEC-12.3).",
    );
    expect(within(alerts[0]!).getByText('Wire changed')).toHaveClass('pb-badge-bad');
    expect(alerts[1]).toHaveTextContent('Urgency languageThe notice presses for a quick payment');
    expect(within(alerts[1]!).getByText('Urgency language')).toHaveClass('pb-badge-watch');
    expect(alerts[2]).toHaveTextContent('Due soonThe due date is under two business days away.');

    expect(screen.getByTestId('bank-details-note')).toHaveTextContent(
      'Bank details are never extracted from documents (SEC-12.1); tickets release only against a Verified instruction (SEC-12.2, SEC-12.3).',
    );
    expect(
      within(tile('notice-tiles', 'Days to due')).getByText('Due in 12 days'),
    ).toBeInTheDocument();
    expect(
      within(tile('notice-tiles', 'Settled')).getByText('No approved cash flow yet'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('table', { name: 'Split' })).getByText('Investment'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('They are created when the ticket is approved and funding is confirmed.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/changed bank details; the instructions on file are unchanged/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument();
    expect(screen.queryByText(/arrive with Phase 3/)).not.toBeInTheDocument();
  });

  it('shows the drafted ticket with every release blocker in words, and the active instruction', async () => {
    params.id = NOTICE_ID.extracted;
    mockApi({
      [ME]: ok(rolePrincipal(['operations'])),
      [detailPath(NOTICE_ID.extracted)]: ok(noticeDetailFixture()),
    });
    renderWithQuery(<CapitalNoticePage />);
    const panel = await screen.findByTestId('ticket-panel');
    expect(within(panel).getByText('Drafted')).toHaveClass('pb-badge-watch');
    const ticket = within(panel).getByRole('table', { name: 'Trade ticket' });
    expect(within(ticket).getByText('$2.5M')).toBeInTheDocument();
    expect(within(ticket).getByText('Jul 12, 2025')).toBeInTheDocument();
    expect(
      within(ticket).getByText('Priya Lindqvist, Jul 10, 2025 09:05:00 UTC'),
    ).toBeInTheDocument();
    // No approver and no instruction version yet: the missing placeholder, never a blank or a zero.
    expect(within(ticket).getAllByText('-')).toHaveLength(3);
    const release = within(panel).getByTestId('ticket-release');
    expect(release).toHaveClass('pb-notice-bad');
    const blockers = within(release).getAllByRole('listitem');
    expect(blockers.map((b) => b.textContent)).toEqual([
      "The wire instructions changed within the hold window and wait for a second person's callback (SEC-12.3).",
      'You prepared this ticket; a different person must approve it (SEC-12.3).',
    ]);

    const wire = screen.getByTestId('notice-wire');
    expect(within(wire).getByRole('link', { name: 'Wire register' })).toHaveAttribute(
      'href',
      '/capital-activity/wires',
    );
    const active = within(wire).getByRole('table', { name: 'Active wire instruction' });
    expect(
      within(active).getByText('Silverline Partners Fund II (Sponsor fund)'),
    ).toBeInTheDocument();
    expect(within(active).getByRole('link', { name: 'Version 1' })).toHaveAttribute(
      'href',
      `/capital-activity/wires/${WIRE_ID.verified}`,
    );
    expect(within(active).getByText('Verified')).toHaveClass('pb-badge-good');
    expect(within(active).getByText('Harbor Street Bank ****4821')).toBeInTheDocument();
    expect(within(active).getByText('Mar 5, 2024 15:30:00 UTC')).toBeInTheDocument();
    expect(
      within(active).getByText('Tomas Achterberg (Prior instruction on file, confirmed)'),
    ).toBeInTheDocument();
  });

  it('shows an approved ticket with the version it was approved against and that release is allowed', async () => {
    params.id = NOTICE_ID.drafted;
    const approved = ticketRows()[1]!;
    mockApi({
      [ME]: ok(rolePrincipal(['approver'])),
      [detailPath(NOTICE_ID.drafted)]: ok(
        noticeDetailFixture({ id: NOTICE_ID.drafted, state: 'TicketApproved', ticket: approved }),
      ),
    });
    renderWithQuery(<CapitalNoticePage />);
    const panel = await screen.findByTestId('ticket-panel');
    expect(within(panel).getByText('Approved')).toHaveClass('pb-badge-brand');
    const ticket = within(panel).getByRole('table', { name: 'Trade ticket' });
    expect(
      within(ticket).getByText('Mina Halvorsen, Jun 24, 2025 09:00:00 UTC'),
    ).toBeInTheDocument();
    expect(within(ticket).getByRole('link', { name: 'Version 1' })).toHaveAttribute(
      'href',
      `/capital-activity/wires/${WIRE_ID.summit}`,
    );
    expect(within(ticket).getByText('Meridian Clearing ****2204')).toBeInTheDocument();
    const release = within(panel).getByTestId('ticket-release');
    expect(release).toHaveClass('pb-notice-good');
    expect(release).toHaveTextContent(RELEASE_ALLOWED);
  });

  it('shows a settled notice: its cash flows, a funded ticket with nothing to release, no alerts', async () => {
    params.id = NOTICE_ID.reconciled;
    mockApi({
      [ME]: ok(rolePrincipal(['operations'])),
      [detailPath(NOTICE_ID.reconciled)]: ok(settledDetailFixture()),
    });
    renderWithQuery(<CapitalNoticePage />);
    expect(await screen.findByText('Equalization: Kelpwood Fund I')).toBeInTheDocument();
    expect(within(tile('notice-tiles', 'Days to due')).getByText('Settled')).toBeInTheDocument();
    expect(tile('notice-tiles', 'Days to due')).not.toHaveAttribute('data-tone');
    const flows = screen.getByRole('table', { name: 'Cash flows created' });
    expect(within(flows).getByText('Recallable')).toBeInTheDocument();
    expect(within(flows).getByText('Approved')).toHaveClass('pb-badge-good');
    expect(
      screen.getByText('Reconciled is the last step; nothing further to do.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('wire-hold')).not.toBeInTheDocument();
    expect(screen.getByText('No notes')).toBeInTheDocument();
    expect(screen.getByTestId('notice-alerts')).toHaveTextContent('No alerts on this notice.');
    expect(screen.getByTestId('ticket-release')).toHaveTextContent(
      'Nothing to release: the ticket is Funded.',
    );
    expect(within(screen.getByTestId('ticket-panel')).getByText('Funded')).toHaveClass(
      'pb-badge-good',
    );
  });

  it('says when no ticket is drafted and no Verified instruction is on file', async () => {
    params.id = NOTICE_ID.reviewed;
    mockApi({
      [ME]: ok(rolePrincipal(['operations'])),
      [detailPath(NOTICE_ID.reviewed)]: ok(
        noticeDetailFixture({
          id: NOTICE_ID.reviewed,
          state: 'Reviewed',
          wireChangeHold: null,
          ticket: null,
          activeWireInstruction: null,
          alerts: ['unverified_instruction'],
        }),
      ),
    });
    renderWithQuery(<CapitalNoticePage />);
    expect(await screen.findByText('No trade ticket yet')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-release')).not.toBeInTheDocument();
    expect(screen.getByText('No Verified instruction on file')).toBeInTheDocument();
    const alerts = within(screen.getByTestId('notice-alerts')).getAllByRole('listitem');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(
      'No verified instructionThe counterparty has no Verified wire instruction on file (SEC-12.2).',
    );
  });

  it.each([404, 403] as const)('says not found or not visible on a %s', async (status) => {
    params.id = NOTICE_ID.received;
    mockApi({
      [ME]: ok(rolePrincipal(['viewer'])),
      [detailPath(NOTICE_ID.received)]: failing(status, detailPath(NOTICE_ID.received)),
    });
    renderWithQuery(<CapitalNoticePage />);
    expect(await screen.findByTestId('error-state')).toHaveTextContent(
      'Notice not found or not visible to you',
    );
  });

  it('degrades while the endpoint answers 501', async () => {
    params.id = NOTICE_ID.received;
    mockApi({
      [ME]: ok(rolePrincipal(['viewer'])),
      [detailPath(NOTICE_ID.received)]: failing(501, detailPath(NOTICE_ID.received)),
    });
    renderWithQuery(<CapitalNoticePage />);
    expect(await screen.findByText('This capital notice: not available yet')).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });
});
