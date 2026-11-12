import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { capitalNoticePageFixture, principalFixture } from '../../test/fixtures.js';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import {
  auditPageFixture,
  DEAL_PATHS,
  dealDetailFixture,
  dealNoticePageFixture,
  operationsPrincipalFixture,
} from '../../test/fixtures-deal.js';
import { renderWithQuery } from '../../test/render.js';
import { ActivityTab } from './ActivityTab.js';

vi.mock('@tanstack/react-router', async () => {
  const { routerMock } = await import('../../test/router-mock.js');
  const { DEAL_ID: id } = await import('../../test/fixtures-deal.js');
  return { ...routerMock(), useParams: () => ({ id }) };
});

const EM_DASH = String.fromCharCode(0x2014);

/** Every path the page asked fetch for, so a test can prove a read was never made. */
function requestedPaths(): string[] {
  return vi.mocked(globalThis.fetch).mock.calls.map(([input]) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://test.local');
    return url.pathname + url.search;
  });
}

const timelineTexts = (): string[] =>
  within(screen.getByRole('list', { name: 'Activity timeline' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '');

describe('activity tab', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('builds the timeline from cash flows, valuation versions and notices, newest first', async () => {
    mockApi({
      [DEAL_PATHS.me]: ok(principalFixture()),
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.notices]: ok(dealNoticePageFixture()),
    });
    renderWithQuery(<ActivityTab />);
    await screen.findByRole('list', { name: 'Activity timeline' });
    await waitFor(() => expect(timelineTexts()).toHaveLength(9));
    expect(timelineTexts()).toEqual([
      'Jun 30, 2025ValuationValuation Jun 30, 2025 v1: Ops prepared',
      'Jun 24, 2025NoticeCapital call issued, due Jul 2, 2025',
      'Jun 20, 2025NoticeCapital call issued, due Jun 28, 2025',
      'Mar 31, 2025ValuationValuation Mar 31, 2025 v2: Locked',
      'Mar 31, 2025ValuationValuation Mar 31, 2025 v1: Reopened',
      'Dec 31, 2024ValuationValuation Dec 31, 2024 v1: Locked',
      'Jul 30, 2024Cash flowDistribution of $2.2M',
      'Jul 20, 2024NoticeDistribution issued, due Jul 30, 2024',
      'Nov 15, 2018Cash flowContribution of -$6.9M',
    ]);
    const first = within(screen.getByRole('list', { name: 'Activity timeline' })).getAllByRole(
      'listitem',
    )[0]!;
    expect(first.querySelector('time')).toHaveAttribute('datetime', '2025-06-30');
    expect(within(first).getByText('Valuation')).toHaveClass('pb-badge-plain');
    expect(screen.queryByText(/Showing the latest/)).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(EM_DASH);
  });

  it('caps the timeline at 40 entries and says so', async () => {
    const flows = Array.from({ length: 45 }, (_, i) => ({
      date: `2020-01-${String((i % 28) + 1).padStart(2, '0')}`,
      flowType: 'flow_type.fee',
      amount: '-10000.00',
    }));
    mockApi({
      [DEAL_PATHS.me]: ok(principalFixture()),
      [DEAL_PATHS.detail]: ok(dealDetailFixture({ cashFlows: flows })),
      [DEAL_PATHS.notices]: ok(capitalNoticePageFixture([])),
    });
    renderWithQuery(<ActivityTab />);
    expect(await screen.findByText('Showing the latest 40 of 49 entries.')).toBeInTheDocument();
    expect(timelineTexts()).toHaveLength(40);
    expect(timelineTexts()[0]).toBe('Jun 30, 2025ValuationValuation Jun 30, 2025 v1: Ops prepared');
  });

  it('leaves notices out with a note while the notices list answers 501', async () => {
    mockApi({
      [DEAL_PATHS.me]: ok(principalFixture()),
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.notices]: failing(501, '/api/v1/capital-notices'),
    });
    renderWithQuery(<ActivityTab />);
    expect(
      await screen.findByText('Capital notices are not in this timeline yet'),
    ).toBeInTheDocument();
    expect(timelineTexts()).toHaveLength(6);
    expect(timelineTexts().some((t) => t.includes('Notice'))).toBe(false);
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });

  it('tells other roles who can read the audit trail, and never asks for it', async () => {
    mockApi({
      [DEAL_PATHS.me]: ok(principalFixture()),
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.notices]: ok(dealNoticePageFixture()),
    });
    renderWithQuery(<ActivityTab />);
    const audit = await screen.findByTestId('deal-audit');
    expect(
      await within(audit).findByText(
        'The audit trail is available to operations, approvers, auditors and platform admins.',
      ),
    ).toHaveClass('pb-meta');
    expect(within(audit).queryByRole('table')).not.toBeInTheDocument();
    expect(requestedPaths().some((p) => p.startsWith('/api/v1/audit'))).toBe(false);
  });

  it('shows the audit trail for this record to operations', async () => {
    mockApi({
      [DEAL_PATHS.me]: ok(operationsPrincipalFixture()),
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.notices]: ok(dealNoticePageFixture()),
      [DEAL_PATHS.audit]: ok(auditPageFixture()),
    });
    renderWithQuery(<ActivityTab />);
    const table = await screen.findByRole('table', { name: 'Audit trail for this record' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent(
      'Jul 1, 2025 09:15:00 UTCAvery Mbekiinvestment.performance.readnone given',
    );
    expect(within(rows[0]!).getByText('investment.performance.read')).toHaveClass('pb-key');
    expect(rows[1]).toHaveTextContent(
      'Jun 30, 2025 17:02:11 UTCservicevaluation.lockQuarter-end close',
    );
    expect(within(rows[1]!).getByText('service')).toHaveClass('pb-badge-plain');
    expect(screen.getByTestId('deal-audit')).toHaveTextContent('2 events, newest first');
    expect(screen.getByRole('link', { name: 'Open the audit trail' })).toHaveAttribute(
      'href',
      '/admin/audit',
    );
    expect(requestedPaths()).toContain(DEAL_PATHS.audit);
  });

  it('says so when the record has no audit events yet', async () => {
    mockApi({
      [DEAL_PATHS.me]: ok(operationsPrincipalFixture()),
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.notices]: ok(dealNoticePageFixture()),
      [DEAL_PATHS.audit]: ok(auditPageFixture({ items: [] })),
    });
    renderWithQuery(<ActivityTab />);
    expect(await screen.findByText('No audit events yet')).toBeInTheDocument();
  });

  it('degrades an audit refusal to the role wording', async () => {
    mockApi({
      [DEAL_PATHS.me]: ok(operationsPrincipalFixture()),
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.notices]: ok(dealNoticePageFixture()),
      [DEAL_PATHS.audit]: failing(403, '/api/v1/audit/events'),
    });
    renderWithQuery(<ActivityTab />);
    const audit = await screen.findByTestId('deal-audit');
    expect(
      await within(audit).findByText(
        'The audit trail is available to operations, approvers, auditors and platform admins.',
      ),
    ).toHaveClass('pb-empty-title');
  });
});
