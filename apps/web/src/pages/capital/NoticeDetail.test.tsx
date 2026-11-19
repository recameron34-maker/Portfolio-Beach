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
    // The trail replaces the back link; the state sits on the title's line, outside the heading.
    const trail = within(banner).getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByRole('link', { name: 'Capital activity' })).toHaveAttribute(
      'href',
      '/capital-activity',
    );
    expect(within(trail).getByRole('link', { name: 'Notices' })).toHaveAttribute(
      'href',
      '/capital-activity',
    );
    expect(screen.queryByRole('link', { name: 'All capital notices' })).not.toBeInTheDocument();
    expect(within(banner).getByText('Extracted')).toHaveClass('pb-badge-watch');
    expect(within(banner).getByRole('heading', { level: 1 })).not.toHaveTextContent('Extracted');
    // The command that moves the notice on leads, in the block under the header, with no heading.
    const block = screen.getByTestId('notice-workflow');
    expect(within(block).queryByRole('heading')).not.toBeInTheDocument();
    expect(within(block).getByRole('button', { name: 'Review' })).toBeEnabled();
    // Currency joins the amount's hint; the header already states it.
    expect(within(tile('notice-tiles', 'Amount')).getByText('USD')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('notice-tiles')).queryByRole('group', { name: 'Currency' }),
    ).not.toBeInTheDocument();

    const progress = screen.getByRole('list', { name: 'Notice progress' });
    const steps = within(progress).getAllByRole('listitem');
    expect(steps).toHaveLength(7);
    // The shared step strip: a done step says so, the current one too, a step ahead to a screen
    // reader only.
    expect(steps[0]).toHaveAttribute('data-status', 'done');
    expect(steps[0]).toHaveTextContent(/^Received.*Done$/);
    expect(steps[1]).toHaveAttribute('aria-current', 'step');
    expect(steps[1]).toHaveTextContent('ExtractedCurrent');
    expect(steps[2]).toHaveTextContent('ReviewedUpcoming');
    expect(within(steps[2]!).getByText('Upcoming')).toHaveClass('pb-visually-hidden');
    expect(within(progress).getAllByText('Done')).toHaveLength(1);

    // The hold and the alerts are one block under the header, on the page's one bad band.
    const holds = screen.getByRole('region', { name: 'Holds and alerts' });
    expect(holds).toHaveClass('is-bad');
    expect(within(holds).getByTestId('wire-hold')).toHaveTextContent(
      'HeldWire instructions changed within the hold window. Ticket approval is held until Jul 30, 2025 (30 days).',
    );
    expect(within(screen.getByTestId('wire-hold')).getByText('Held')).toHaveClass('pb-badge-bad');
    expect(within(holds).getByTestId('notice-alerts')).toBeInTheDocument();
    // The SEC-12.4 alerts: a badge and a plain sentence each, in the contract's order.
    const alerts = within(screen.getByTestId('notice-alerts')).getAllByRole('listitem');
    expect(alerts).toHaveLength(3);
    expect(alerts[0]).toHaveTextContent(
      "Wire changedThe counterparty's wire instructions changed; the ticket releases only after a second person's callback verifies the new version.",
    );
    expect(within(alerts[0]!).getByText('Wire changed')).toHaveClass('pb-badge-bad');
    expect(alerts[1]).toHaveTextContent('Urgency languageThe notice presses for a quick payment');
    expect(within(alerts[1]!).getByText('Urgency language')).toHaveClass('pb-badge-watch');
    expect(alerts[2]).toHaveTextContent('Due soonThe due date is under two business days away.');

    expect(screen.getByTestId('bank-details-note')).toHaveTextContent(
      'Bank details are never extracted from documents; tickets release only against a Verified instruction.',
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
    expect(screen.getByTestId('notice-cash-flows')).toHaveTextContent(
      'No cash flows yet. They are created when the ticket is approved and funding is confirmed.',
    );
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
    // A dot list with no box: the page's one band is the holds and alerts block.
    expect(release).not.toHaveClass('pb-notice-bad');
    expect(release).toHaveTextContent(/^Release is blocked:/);
    const blockers = within(release).getAllByRole('listitem');
    expect(blockers.map((b) => b.textContent)).toEqual([
      "The wire instructions changed within the hold window and wait for a second person's callback.",
      'You prepared this ticket; a different person must approve it.',
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
    expect(release).not.toHaveClass('pb-notice-good');
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
      'No verified instructionThe counterparty has no Verified wire instruction on file.',
    );
  });

  it('tells a reader outside the register that a Verified instruction is on file and that the register is restricted (D1-05)', async () => {
    params.id = NOTICE_ID.drafted;
    const approved = ticketRows()[1]!;
    mockApi({
      [ME]: ok(rolePrincipal(['viewer'])),
      // What the API answers a viewer, the deal team and investor relations: no register row on
      // the notice or the ticket, and alerts without unverified_instruction.
      [detailPath(NOTICE_ID.drafted)]: ok(
        noticeDetailFixture({
          id: NOTICE_ID.drafted,
          state: 'TicketApproved',
          wireChangeHold: null,
          ticket: { ...approved, wireInstruction: null },
          activeWireInstruction: null,
          alerts: ['urgency_language'],
        }),
      ),
    });
    renderWithQuery(<CapitalNoticePage />);
    const wire = await screen.findByTestId('notice-wire');
    expect(within(wire).getByText('A Verified instruction is on file')).toBeInTheDocument();
    expect(wire).toHaveTextContent(
      'Its details are kept in the wire register, which operations, approvers, auditors and platform admins read.',
    );
    expect(within(wire).queryByText('No Verified instruction on file')).not.toBeInTheDocument();
    expect(wire).not.toHaveTextContent('Operations propose one');
    // No link into a register this reader cannot open, and no table of an instruction.
    expect(within(wire).queryByRole('link')).not.toBeInTheDocument();
    expect(within(wire).queryByRole('table')).not.toBeInTheDocument();

    // The approved ticket names its approver; the version it was approved against is a
    // register row, so the panel says it is restricted, never the missing placeholder.
    const ticket = within(screen.getByTestId('ticket-panel')).getByRole('table', {
      name: 'Trade ticket',
    });
    expect(
      within(ticket).getByText('Mina Halvorsen, Jun 24, 2025 09:00:00 UTC'),
    ).toBeInTheDocument();
    expect(within(ticket).getAllByText('Restricted to the wire register')).toHaveLength(2);
    expect(within(ticket).queryByText('-')).not.toBeInTheDocument();
    expect(within(ticket).queryByRole('link')).not.toBeInTheDocument();
  });

  it('still says no Verified instruction is on file to a reader outside the register when the alert says so', async () => {
    params.id = NOTICE_ID.reviewed;
    mockApi({
      [ME]: ok(rolePrincipal(['deal_team'])),
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
    const wire = await screen.findByTestId('notice-wire');
    expect(within(wire).getByText('No Verified instruction on file')).toBeInTheDocument();
    expect(within(wire).queryByText('A Verified instruction is on file')).not.toBeInTheDocument();
  });

  it('says a third person must release when the reader proposed or verified a recent change (W2-3)', async () => {
    params.id = NOTICE_ID.extracted;
    mockApi({
      [ME]: ok(rolePrincipal(['operations'])),
      [detailPath(NOTICE_ID.extracted)]: ok(
        noticeDetailFixture({
          wireChangeHold: null,
          ticket: {
            ...ticketRows()[0]!,
            release: { allowed: false, blockers: ['verifier_within_hold'] },
          },
        }),
      ),
    });
    renderWithQuery(<CapitalNoticePage />);
    const release = await screen.findByTestId('ticket-release');
    expect(release).toHaveTextContent(/^Release is blocked:/);
    expect(
      within(release)
        .getAllByRole('listitem')
        .map((b) => b.textContent),
    ).toEqual([
      'The wire instructions changed recently and you proposed or verified that change; a third person must approve this ticket.',
    ]);
    // The sentence for an allowed release names the same rule.
    expect(RELEASE_ALLOWED).toContain(
      'you neither proposed nor verified a change inside the hold window',
    );
  });

  it('shows the note that the funded amount differs from the notice amount (W2-2)', async () => {
    params.id = NOTICE_ID.funded;
    mockApi({
      [ME]: ok(rolePrincipal(['operations'])),
      [detailPath(NOTICE_ID.funded)]: ok(
        noticeDetailFixture({
          id: NOTICE_ID.funded,
          state: 'Funded',
          wireChangeHold: null,
          notes: [
            'No cash flow has been recorded for this notice.',
            'Funded amount differs from the notice amount.',
          ],
          ticket: { ...ticketRows()[2]!, amount: '2000000.00' },
        }),
      ),
    });
    renderWithQuery(<CapitalNoticePage />);
    const notes = await screen.findByTestId('notice-notes');
    expect(
      within(notes)
        .getAllByRole('listitem')
        .map((n) => n.textContent),
    ).toEqual([
      'No cash flow has been recorded for this notice.',
      'Funded amount differs from the notice amount.',
    ]);
    // The ticket panel shows what was funded beside the notice's own amount in the tiles.
    expect(
      within(screen.getByRole('table', { name: 'Trade ticket' })).getByText('$2.0M'),
    ).toBeInTheDocument();
    expect(within(tile('notice-tiles', 'Amount')).getByText('$2.5M')).toBeInTheDocument();
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
