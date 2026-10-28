import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import {
  commitmentListFixture,
  NOTICE_ID,
  noticePageFixture,
} from '../../test/fixtures-capital.js';
import { sentRequests } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { CapitalActivityPage, CommitmentsPage } from './CapitalActivity.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

/* The notice page has its own tests beside it (NoticeDetail.test.tsx, NoticeDetail.preview.test.tsx). */

const NOTICES = '/api/v1/capital-notices?limit=200';
const COMMITMENTS = '/api/v1/commitments';

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

  it('lists every notice by due date, latest first, without a due alert once funded', async () => {
    mockApi({ [NOTICES]: ok(noticePageFixture()) });
    renderWithQuery(<CapitalActivityPage />);
    const table = await screen.findByRole('table', { name: 'Capital notices' });
    expect(firstColumn(table)).toEqual([
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
  });

  it('filters the one unfiltered list in the browser', { timeout: 15_000 }, async () => {
    mockApi({ [NOTICES]: ok(noticePageFixture()) });
    renderWithQuery(<CapitalActivityPage />);
    await screen.findByRole('table', { name: 'Capital notices' });
    const firstCells = (): string[] =>
      firstColumn(screen.getByRole('table', { name: 'Capital notices' }));
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

  it('pages a long register 25 notices at a time and starts again when a filter changes', async () => {
    const base = noticePageFixture().items[0]!;
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...base,
      id: `00000000-0000-4000-8000-${String(900 + i).padStart(12, '0')}`,
      dueDate: `2024-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
      state: 'Reconciled' as const,
    }));
    mockApi({ [NOTICES]: ok(noticePageFixture(many)) });
    renderWithQuery(<CapitalActivityPage />);
    const table = await screen.findByRole('table', { name: 'Capital notices' });
    expect(within(table).getAllByRole('row')).toHaveLength(26);
    expect(screen.getByTestId('notice-count')).toHaveTextContent('Notices 1 to 25 of 30');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('notice-count')).toHaveTextContent('Notices 26 to 30 of 30');
    expect(
      within(screen.getByRole('table', { name: 'Capital notices' })).getAllByRole('row'),
    ).toHaveLength(6);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    // Hiding reconciled notices leaves none; the pager goes away and the count says so.
    await userEvent.click(screen.getByRole('switch', { name: 'Include reconciled' }));
    expect(screen.getByTestId('notice-count')).toHaveTextContent('0 notices shown');
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });

  it('says only the first 200 are shown when more exist, and counts nothing from a partial page', async () => {
    mockApi({ [NOTICES]: ok(noticePageFixture(undefined, 'next-page')) });
    renderWithQuery(<CapitalActivityPage />);
    expect(await screen.findByTestId('notice-count')).toHaveTextContent(
      '6 notices shown. Showing the first 200; more exist.',
    );
    for (const label of ['Overdue', 'Due soon', 'In flight', 'Reconciled']) {
      expect(within(tile('notice-tiles', label)).getByText('-'), label).toBeInTheDocument();
      expect(
        within(tile('notice-tiles', label)).getByText(
          'Not calculable: more rows than one page holds',
        ),
        label,
      ).toBeInTheDocument();
      expect(tile('notice-tiles', label), label).not.toHaveAttribute('data-tone');
    }
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
