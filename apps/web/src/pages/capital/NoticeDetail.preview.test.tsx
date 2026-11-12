import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CapitalNoticeDetail, CapitalNoticeRow } from '@pb/contracts';
import { mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import { NOTICE_ID, noticeDetailFixture, noticeRows } from '../../test/fixtures-capital.js';
import { refusalFixture, rolePrincipal, sentPosts } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { CapitalNoticePage } from './CapitalActivity.js';

const params = vi.hoisted(() => ({ id: '' }));

vi.mock('../../app/env.js', () => ({ previewMode: true }));
vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: params.id }),
}));

const SUFFIX = '(simulated in this preview, not audited)';
const detailPath = (id: string): string => `/api/v1/capital-notices/${id}`;
const commandsPath = (id: string): string => `/api/v1/capital-notices/${id}/commands`;

function rowOf(id: string): CapitalNoticeRow {
  const row = noticeRows().find((n) => n.id === id);
  if (row === undefined) throw new Error(`no fixture notice ${id}`);
  return row;
}

function detailOf(id: string, overrides: Partial<CapitalNoticeDetail> = {}): CapitalNoticeDetail {
  return noticeDetailFixture({ ...rowOf(id), wireChangeHold: null, notes: [], ...overrides });
}

/**
 * Waits for the modal to unmount. The page's status region is then read by its test id: Fluent's
 * focus manager lifts the aria-hidden it put on the page when focus returns to the trigger, which
 * jsdom does not do after a submit, so the region may stay out of the accessibility tree here.
 */
async function dialogClosed(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  return screen.getByTestId('notice-action-status');
}

function open(
  id: string,
  roles: Parameters<typeof rolePrincipal>[0],
  detail: CapitalNoticeDetail,
  extra: MockRoutes = {},
): void {
  params.id = id;
  mockApi({
    '/api/v1/auth/me': ok(rolePrincipal(roles)),
    [detailPath(id)]: ok(detail),
    ...extra,
  });
  renderWithQuery(<CapitalNoticePage />);
}

describe('capital notice detail (preview)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps extraction for service accounts and lets operations review', async () => {
    open(NOTICE_ID.received, ['operations'], detailOf(NOTICE_ID.received));
    const extract = await screen.findByRole('button', { name: 'Extract' });
    expect(extract).toBeDisabled();
    expect(extract).toHaveAttribute('title', 'Service accounts only');
    expect(screen.getByText('Simulated')).toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();

    open(NOTICE_ID.extracted, ['operations'], noticeDetailFixture());
    expect(await screen.findByRole('button', { name: 'Review' })).toBeEnabled();
  });

  it('names the roles a command needs for a role that may not issue it', async () => {
    open(NOTICE_ID.drafted, ['deal_team'], detailOf(NOTICE_ID.drafted));
    const approve = await screen.findByRole('button', { name: 'Approve ticket' });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('title', 'Needs approver or operations');
    cleanup();
    vi.restoreAllMocks();

    open(NOTICE_ID.drafted, ['approver'], detailOf(NOTICE_ID.drafted));
    expect(await screen.findByRole('button', { name: 'Approve ticket' })).toBeEnabled();
  });

  it('shows the transition notes for an approved ticket', async () => {
    open(
      NOTICE_ID.drafted,
      ['operations'],
      detailOf(NOTICE_ID.drafted, { state: 'TicketApproved' }),
    );
    expect(await screen.findByRole('button', { name: 'Wire changed' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Confirm funding' })).toBeEnabled();
    expect(
      screen.getByText(
        'Wire changed: Any wire change returns the ticket to draft and requires callback verification.',
      ),
    ).toBeInTheDocument();
  });

  it('sends a command and reports the new state', async () => {
    open(NOTICE_ID.extracted, ['operations'], noticeDetailFixture(), {
      [commandsPath(NOTICE_ID.extracted)]: ok({ ...rowOf(NOTICE_ID.extracted), state: 'Reviewed' }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const message = `Capital call for Silverline Staffing Holdings is now Reviewed ${SUFFIX}`;
    expect(await within(screen.getByRole('status')).findByText(message)).toHaveClass(
      'pb-notice-good',
    );
    expect(sentPosts()).toEqual([[commandsPath(NOTICE_ID.extracted), { command: 'review' }]]);
    expect(
      within(screen.getByRole('list', { name: 'Actions this session' })).getByText(message),
    ).toBeInTheDocument();
  });

  it(
    'drafts the ticket from a dialog prefilled with the due date and the amount',
    { timeout: 20_000 },
    async () => {
      open(NOTICE_ID.reviewed, ['operations'], detailOf(NOTICE_ID.reviewed, { ticket: null }), {
        [commandsPath(NOTICE_ID.reviewed)]: ok({
          ...rowOf(NOTICE_ID.reviewed),
          state: 'TicketDrafted',
        }),
      });
      await userEvent.click(await screen.findByRole('button', { name: 'Draft ticket' }));
      const form = await screen.findByTestId('draft-ticket-form');
      const date = within(form).getByRole('textbox', { name: 'Funding date' });
      const amount = within(form).getByRole('textbox', { name: 'Amount (USD)' });
      expect(date).toHaveValue('2025-06-27');
      expect(amount).toHaveValue('3776500.00');
      expect(within(form).getByText('Reads as $3.8M.')).toBeInTheDocument();
      const submit = within(form).getByRole('button', { name: 'Draft ticket' });
      // A funding date that is no calendar date keeps the draft on the page.
      await userEvent.clear(date);
      await userEvent.type(date, '2025-06-31');
      expect(submit).toBeDisabled();
      await userEvent.clear(date);
      await userEvent.type(date, '2025-06-26');
      await userEvent.clear(amount);
      await userEvent.type(amount, '3776000.00');
      expect(submit).toBeEnabled();
      await userEvent.click(submit);
      const status = await dialogClosed();
      expect(
        await within(status).findByText(
          `Distribution for Kelpwood Fund I is now Ticket drafted ${SUFFIX}`,
        ),
      ).toHaveClass('pb-notice-good');
      expect(sentPosts()).toEqual([
        [
          commandsPath(NOTICE_ID.reviewed),
          { command: 'draftTicket', fundingDate: '2025-06-26', amount: '3776000.00' },
        ],
      ]);
    },
  );

  it('asks why before a person records a wire change', { timeout: 20_000 }, async () => {
    open(
      NOTICE_ID.drafted,
      ['operations'],
      detailOf(NOTICE_ID.drafted, { state: 'TicketApproved' }),
      {
        [commandsPath(NOTICE_ID.drafted)]: ok({
          ...rowOf(NOTICE_ID.drafted),
          state: 'TicketDrafted',
        }),
      },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Wire changed' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Capital call for Summit Services Co');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Changed account in a letter received by post',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Wire changed' }));
    const status = await dialogClosed();
    expect(
      await within(status).findByText(
        `Capital call for Summit Services Co is now Ticket drafted ${SUFFIX}`,
      ),
    ).toBeInTheDocument();
    expect(sentPosts()).toEqual([
      [
        commandsPath(NOTICE_ID.drafted),
        { command: 'wireChanged', reason: 'Changed account in a letter received by post' },
      ],
    ]);
  });

  it('shows a refusal through describeActionError', async () => {
    open(NOTICE_ID.drafted, ['approver'], detailOf(NOTICE_ID.drafted), {
      [commandsPath(NOTICE_ID.drafted)]: {
        status: 422,
        body: refusalFixture(
          422,
          'capital_notice: the wire instruction is not verified (SEC-12.2)',
        ),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Approve ticket' }));
    expect(
      await within(screen.getByRole('status')).findByText(
        'Approve ticket: Blocked by a rule. The wire instruction is not verified (SEC-12.2)',
      ),
    ).toHaveClass('pb-notice-bad');
    expect(sentPosts()).toEqual([[commandsPath(NOTICE_ID.drafted), { command: 'approveTicket' }]]);
  });
});
