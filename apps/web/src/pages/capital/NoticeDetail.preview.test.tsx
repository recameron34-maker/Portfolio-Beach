import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
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
