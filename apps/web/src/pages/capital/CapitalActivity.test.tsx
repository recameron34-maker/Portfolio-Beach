import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import {
  commitmentListFixture,
  NOTICE_ID,
  noticeDetailFixture,
  noticePageFixture,
  settledDetailFixture,
} from '../../test/fixtures-capital.js';
import { rolePrincipal, sentRequests } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { CapitalActivityPage, CapitalNoticePage, CommitmentsPage } from './CapitalActivity.js';

const params = vi.hoisted(() => ({ id: '' }));

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: params.id }),
}));

const NOTICES = '/api/v1/capital-notices?limit=200';
const COMMITMENTS = '/api/v1/commitments';
const ME = '/api/v1/auth/me';
const detailPath = (id: string): string => `/api/v1/capital-notices/${id}`;

async function pick(combobox: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole('combobox', { name: combobox }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

const tile = (testId: string, name: string): HTMLElement =>
  within(screen.getByTestId(testId)).getByRole('group', { name });

/** The text of the first cell of each body row of a table. */
function firstColumn(table: HTMLElement): string[] {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.querySelector('td, th')?.textContent ?? '');
}

describe('capital activity board', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the alert window, the tiles and what needs attention', async () => {
    mockApi({ [NOTICES]: ok(noticePageFixture()) });
    renderWithQuery(<CapitalActivityPage />);
    expect(
      await screen.findByText('As of Jun 30, 2025. Alerts at 3 days before the due date.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Capital activity' })).toBeInTheDocument();
    expect(within(tile('notice-tiles', 'Overdue')).getByText('1')).toBeInTheDocument();
    expect(tile('notice-tiles', 'Overdue')).toHaveAttribute('data-tone', 'bad');
    expect(within(tile('notice-tiles', 'Due soon')).getByText('1')).toBeInTheDocument();
    expect(tile('notice-tiles', 'Due soon')).toHaveAttribute('data-tone', 'watch');
    expect(within(tile('notice-tiles', 'In flight')).getByText('5')).toBeInTheDocument();
    expect(within(tile('notice-tiles', 'Reconciled')).getByText('1')).toBeInTheDocument();

    const attention = screen.getByRole('table', { name: 'Notices needing attention' });
    expect(firstColumn(attention)).toEqual([
      'Jun 25, 2025',
      'Jun 27, 2025Overdue by 3 days',
      'Jul 2, 2025Due in 2 days',
      'Jul 12, 2025Due in 12 days',
      'Jul 20, 2025Due in 20 days',
    ]);
    const call = within(attention).getByRole('link', { name: 'Silverline Staffing Holdings' });
    expect(call).toHaveAttribute('href', `/capital-activity/${NOTICE_ID.extracted}`);
    expect(within(call.closest('tr')!).getByText('Wire change')).toHaveClass('pb-badge-plain');
    expect(within(call.closest('tr')!).getByText('Extracted')).toBeInTheDocument();
    expect(within(attention).getByText('Overdue by 3 days')).toHaveClass('pb-badge-bad');
    expect(within(attention).getByText('Due in 2 days')).toHaveClass('pb-badge-watch');
    expect(within(attention).getByText('Due in 12 days')).toHaveClass('pb-badge-neutral');
    expect(within(attention).getByRole('link', { name: 'Kelpwood Fund I' })).toBeInTheDocument();
  });

  it('lists every notice by due date, latest first, with client-side filters', async () => {
    mockApi({ [NOTICES]: ok(noticePageFixture()) });
    renderWithQuery(<CapitalActivityPage />);
    const table = await screen.findByRole('table', { name: 'Capital notices' });
    const firstCells = (): string[] =>
      firstColumn(screen.getByRole('table', { name: 'Capital notices' }));
    expect(firstCells()).toEqual([
      'Jul 20, 2025Due in 20 days',
      'Jul 12, 2025Due in 12 days',
      'Jul 2, 2025Due in 2 days',
      'Jun 27, 2025Overdue by 3 days',
      'Jun 25, 2025',
      'Jan 15, 2025',
    ]);
    const funded = within(table).getByText('Funded').closest('tr')!;
    expect(within(funded).getAllByText('$0.2M')).toHaveLength(2);
    expect(screen.getByTestId('notice-count')).toHaveTextContent('6 notices shown');

    await userEvent.click(screen.getByRole('switch', { name: 'Include reconciled' }));
    expect(screen.getByTestId('notice-count')).toHaveTextContent('5 notices shown');
    await pick('Type', 'Capital call');
    expect(firstCells()).toHaveLength(2);
    await pick('Vehicle', 'Beach Credit Partners I');
    expect(firstCells()).toEqual(['Jul 2, 2025Due in 2 days']);
    await pick('State', 'Reviewed');
    expect(screen.getByText('No notices match these filters')).toBeInTheDocument();
    expect(screen.getByTestId('notice-count')).toHaveTextContent('0 notices shown');

    const urls = sentRequests().map(([url]) => url);
    expect([...new Set(urls)]).toEqual([NOTICES]);
  });

  it('says only the first 200 are shown when more exist', async () => {
    mockApi({ [NOTICES]: ok(noticePageFixture(undefined, 'next-page')) });
    renderWithQuery(<CapitalActivityPage />);
    expect(await screen.findByTestId('notice-count')).toHaveTextContent(
      '6 notices shown. Showing the first 200; more exist.',
    );
  });

  it('says when nothing needs attention', async () => {
    mockApi({ [NOTICES]: ok({ ...noticePageFixture(), attention: [] }) });
    renderWithQuery(<CapitalActivityPage />);
    expect(await screen.findByText('Nothing needs attention')).toBeInTheDocument();
  });

  it('degrades while the endpoint answers 501, and names the role on a 403', async () => {
    mockApi({ [NOTICES]: failing(501, '/api/v1/capital-notices') });
    renderWithQuery(<CapitalActivityPage />);
    expect(await screen.findByText('Capital notices: not available yet')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Capital activity' })).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();
    mockApi({ [NOTICES]: failing(403, '/api/v1/capital-notices') });
    renderWithQuery(<CapitalActivityPage />);
    expect(
      await screen.findByText('Capital notices: not visible to your role'),
    ).toBeInTheDocument();
  });
});

describe('commitments and unfunded', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('takes the tiles and the total row from the API totals and charts unfunded honestly', async () => {
    mockApi({ [COMMITMENTS]: ok(commitmentListFixture()) });
    renderWithQuery(<CommitmentsPage />);
    expect(await screen.findByText('As of Jun 30, 2025')).toBeInTheDocument();
    expect(within(tile('commitment-tiles', 'Committed')).getByText('$120.0M')).toBeInTheDocument();
    expect(within(tile('commitment-tiles', 'Called')).getByText('$108.9M')).toBeInTheDocument();
    expect(within(tile('commitment-tiles', 'Distributed')).getByText('$4.8M')).toBeInTheDocument();
    expect(within(tile('commitment-tiles', 'Unfunded')).getByText('$6.1M')).toBeInTheDocument();

    const chart = screen.getByRole('group', { name: 'Unfunded by sponsor fund' });
    expect(
      within(chart).getByRole('img', { name: 'Oysterbed Credit Fund I: -$0.4M' }),
    ).toBeInTheDocument();
    expect(within(chart).getByRole('img', { name: 'Skerry Fund I: $3.8M' })).toBeInTheDocument();
    expect(within(chart).getAllByRole('img')).toHaveLength(4);
    expect(
      screen.getByText(
        /Unfunded by sponsor fund across 4 commitments; the largest is Skerry Fund I at \$3\.8M\. 1 commitment has no recorded cash flow/,
      ),
    ).toHaveClass('pb-visually-hidden');
    expect(screen.getByTestId('unfunded-caveats')).toHaveTextContent(
      'Oysterbed Credit Fund I is called beyond its commitment, so its unfunded reads below zero.',
    );

    const table = screen.getByRole('table', { name: 'Commitments' });
    expect(within(table).getByRole('columnheader', { name: 'Client' })).toBeInTheDocument();
    const client = within(table).getByText('Client Gamma Insurance').closest('tr')!;
    expect(within(client).getAllByText('-').length).toBeGreaterThanOrEqual(4);
    const over = within(table).getByText('Oysterbed Credit Fund I').closest('tr')!;
    expect(within(over).getByText('Over-called')).toBeInTheDocument();
    expect(within(over).getByText('-$0.4M')).toBeInTheDocument();
    const total = within(table).getByRole('rowheader', { name: 'Total' }).closest('tr')!;
    expect(within(total).getByText('$120.0M')).toBeInTheDocument();
    expect(within(total).getByText('$6.1M')).toBeInTheDocument();
    expect(screen.getByTestId('commitments-note')).toHaveTextContent(
      'Totals sum the commitments whose figures are known; a commitment with no recorded cash flow shows the missing placeholder. Calc version 0.1.0 (docs/08).',
    );
  });

  it('filters by vehicle, dropping the client column and the all-vehicle total', async () => {
    mockApi({ [COMMITMENTS]: ok(commitmentListFixture()) });
    renderWithQuery(<CommitmentsPage />);
    await screen.findByRole('table', { name: 'Commitments' });
    await pick('Vehicle', 'Beach Primary Program');
    const table = screen.getByRole('table', { name: 'Commitments' });
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(within(table).queryByRole('columnheader', { name: 'Client' })).not.toBeInTheDocument();
    expect(within(table).queryByRole('rowheader', { name: 'Total' })).not.toBeInTheDocument();
    expect(screen.getByText(/The total row covers every vehicle/)).toBeInTheDocument();
  });

  it('degrades when commitments are hidden from the role', async () => {
    mockApi({ [COMMITMENTS]: failing(403, '/api/v1/commitments') });
    renderWithQuery(<CommitmentsPage />);
    expect(await screen.findByText('Commitments: not visible to your role')).toBeInTheDocument();
  });
});

describe('capital notice detail (read-only build)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the notice, its progress, the hold and the bank-details rule, with every action disabled', async () => {
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
    expect(screen.getByTestId('bank-details-note')).toHaveTextContent(
      'Bank details are never extracted from documents or shown here (SEC-12.1). The wire register with callback verification arrives with M16, so ticket approval stays blocked in this build (SEC-12.2).',
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

    const review = screen.getByRole('button', { name: 'Review' });
    expect(review).toBeDisabled();
    expect(review).toHaveAttribute('title', 'Workflow actions arrive with Phase 3');
    expect(screen.queryByText('Simulated')).not.toBeInTheDocument();
  });

  it('shows a settled notice with its cash flows and no due alert', async () => {
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
