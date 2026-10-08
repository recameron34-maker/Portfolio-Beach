import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import {
  creditDetailFixture,
  creditPerformanceFixture,
  DEAL_PATHS,
  dealDetailFixture,
  ENTRY_SNAPSHOT,
  equityPerformanceFixture,
} from '../../test/fixtures-deal.js';
import { MISSING } from '../../lib/format.js';
import { renderWithQuery } from '../../test/render.js';
import { PerformanceTab } from './PerformanceTab.js';

vi.mock('@tanstack/react-router', async () => {
  const { routerMock } = await import('../../test/router-mock.js');
  const { DEAL_ID: id } = await import('../../test/fixtures-deal.js');
  return { ...routerMock(), useParams: () => ({ id }) };
});

const EM_DASH = String.fromCharCode(0x2014);

describe('performance tab, equity position', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows growth since entry, the approved LTM series, the quarterly table, highlights and the outlook', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.performance]: ok(equityPerformanceFixture()),
    });
    renderWithQuery(<PerformanceTab />);

    const since = await screen.findByTestId('deal-since-entry');
    expect(since).toHaveTextContent('Entry snapshot Sep 30, 2018 to Mar 31, 2025');
    expect(within(since).getByRole('group', { name: 'Revenue growth' })).toHaveTextContent('19.1%');
    expect(within(since).getByRole('group', { name: 'EBITDA growth' })).toHaveTextContent('15.3%');
    expect(within(since).getByRole('group', { name: 'Multiple change' })).toHaveTextContent(
      '-0.2xEV / EBITDA 10.5x at entry',
    );
    expect(within(since).getByRole('group', { name: 'EV / EBITDA at entry' })).toHaveTextContent(
      '10.5xLatest 10.3x',
    );
    expect(
      within(since).getByRole('group', { name: 'Net debt / EBITDA at entry' }),
    ).toHaveTextContent('3.6xLatest 2.8x');

    // Two series over the two approved quarters; the draft quarter is not charted.
    const chart = screen.getByRole('group', { name: 'Revenue and EBITDA, LTM' });
    expect(chart).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Legend' })).toHaveTextContent('RevenueEBITDA');
    expect(
      screen.getByText(/over 2 approved quarters: revenue from \$13\.6M to \$13\.9M/),
    ).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Quarterly financials' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual([
      'Jun 30, 2025',
      'Mar 31, 2025',
      'Dec 31, 2024',
      'Sep 30, 2018Entry',
    ]);
    expect(rows[0]).toHaveTextContent('Draft');
    expect(rows[0]).toHaveTextContent('$14.1M');
    expect(rows[1]).toHaveTextContent('Approved');
    expect(rows[1]).toHaveTextContent('9.5%');
    expect(rows[3]).toHaveTextContent('$11.7M');
    // The entry snapshot has no year-on-year figures: the missing placeholder, never zero.
    expect(within(rows[3]!).getAllByRole('cell')[11]).toHaveTextContent(MISSING);
    expect(within(rows[3]!).getAllByRole('cell')[11]).toHaveClass('is-missing');
    expect(screen.getByRole('region', { name: 'Quarterly financials' })).toHaveAttribute(
      'tabindex',
      '0',
    );

    const highlights = screen.getByTestId('deal-highlights');
    expect(highlights).toHaveTextContent('Latest 3 quarters');
    expect(
      within(highlights).getByText('Draft commentary from the quarterly letter.'),
    ).toBeVisible();
    expect(
      within(highlights).getByText('Management completed one add-on acquisition.'),
    ).toBeVisible();

    const outlook = screen.getByTestId('deal-outlook');
    const kv = within(outlook).getByRole('table', { name: 'Realization outlook' });
    expect(kv).toHaveTextContent('Partial');
    expect(kv).toHaveTextContent('Within 18 months');
    expect(kv).toHaveTextContent('Sponsor has engaged advisors.');
    expect(outlook).toHaveTextContent('Set May 2, 2025.');
    expect(outlook).toHaveTextContent('Changes only by explicit edit (docs/04 M9)');

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(EM_DASH);
  });

  it('says the entry snapshot is dated after the as-of date instead of comparing against it', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.performance]: ok(
        equityPerformanceFixture({
          entry: { ...ENTRY_SNAPSHOT, periodEnd: '2025-09-30' },
          sinceEntry: null,
        }),
      ),
    });
    renderWithQuery(<PerformanceTab />);
    const since = await screen.findByTestId('deal-since-entry');
    expect(since).toHaveTextContent('The entry snapshot is dated after the as-of date');
    expect(since).toHaveTextContent('dated Sep 30, 2025, after Jun 30, 2025');
    expect(within(since).queryByRole('group')).not.toBeInTheDocument();
    // The forward-dated snapshot still sits in the table, at the top, marked as the entry.
    const table = screen.getByRole('table', { name: 'Quarterly financials' });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Sep 30, 2025Entry');
  });

  it('says so when no entry snapshot is recorded, and when nothing is recorded at all', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.performance]: ok(
        equityPerformanceFixture({
          entry: null,
          sinceEntry: null,
          quarters: [],
          realizationOutlook: null,
        }),
      ),
    });
    renderWithQuery(<PerformanceTab />);
    expect(await screen.findByText('No entry snapshot recorded')).toBeInTheDocument();
    expect(screen.getByText('No quarterly financials')).toBeInTheDocument();
    expect(screen.getByText('No highlights recorded')).toBeInTheDocument();
    expect(screen.getByText('No outlook recorded')).toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: 'Revenue and EBITDA, LTM' }),
    ).not.toBeInTheDocument();
  });

  it('names the gap when a snapshot exists but no approved quarter can be compared with it', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.performance]: ok(equityPerformanceFixture({ sinceEntry: null })),
    });
    renderWithQuery(<PerformanceTab />);
    expect(
      await screen.findByText('No approved quarter to compare with the entry snapshot'),
    ).toBeInTheDocument();
  });
});

describe('performance tab, private credit position', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the terms, the par and fair value series, the quarterly metrics and the schedules', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(creditDetailFixture()),
      [DEAL_PATHS.performance]: ok(creditPerformanceFixture()),
    });
    renderWithQuery(<PerformanceTab />);

    const pricing = await screen.findByRole('table', { name: 'Facility and pricing' });
    expect(pricing).toHaveTextContent('Unitranche');
    expect(pricing).toHaveTextContent('Rank 1');
    expect(pricing).toHaveTextContent('$9.9M');
    expect(within(pricing).getByText('9.00% / 2.00%')).toBeInTheDocument();
    const fees = screen.getByRole('table', { name: 'Fees, yield and maturity' });
    expect(fees).toHaveTextContent('11.00%');
    expect(fees).toHaveTextContent('11.50%');
    expect(within(fees).getByText('Oct 22, 2024')).toBeInTheDocument();
    expect(within(fees).getByText('Past maturity')).toBeInTheDocument();
    expect(fees).toHaveTextContent('Quarterly');

    expect(screen.getByRole('group', { name: 'Par and fair value' })).toBeInTheDocument();
    const metrics = screen.getByRole('table', { name: 'Quarterly credit metrics' });
    const rows = within(metrics).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Jun 30, 2025');
    expect(rows[0]).toHaveTextContent('11.23%');
    expect(rows[0]).toHaveTextContent('1.8x');
    expect(rows[0]).toHaveTextContent('55.0%');
    expect(within(rows[0]!).getByText('Waiver')).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('Covenant Waiver');
    expect(rows[0]).toHaveTextContent('Payment Current');
    expect(rows[1]).toHaveTextContent('Mar 31, 2025');

    expect(
      within(screen.getByTestId('deal-amortization')).getByRole('table', {
        name: 'Amortization schedule',
      }),
    ).toHaveTextContent('May 22, 2020$0.5M');
    expect(screen.getByTestId('deal-call-protection')).toHaveTextContent(
      'No call protection on record',
    );
    expect(screen.getByRole('table', { name: 'Covenants' })).toHaveTextContent(
      'Maximum net leverage6.0xQuarterly',
    );
    expect(screen.getByTestId('deal-outlook')).toHaveTextContent('No outlook recorded');
    // Equity-only sections are hidden for credit (docs/06 section 2).
    expect(screen.queryByTestId('deal-since-entry')).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Quarterly financials' })).not.toBeInTheDocument();
  });
});

describe('performance tab, unavailable', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('degrades a 501 to the not-built wording', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.performance]: failing(501, DEAL_PATHS.performance),
    });
    renderWithQuery(<PerformanceTab />);
    expect(
      await screen.findByText(
        'Performance history is not available for this position in this build',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });

  it('degrades a 403 to the role wording', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.performance]: failing(403, DEAL_PATHS.performance),
    });
    renderWithQuery(<PerformanceTab />);
    expect(
      await screen.findByText('Performance history: not visible to your role'),
    ).toBeInTheDocument();
  });

  it('shows a 404 as an error rather than an empty tab', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.performance]: failing(404, DEAL_PATHS.performance),
    });
    renderWithQuery(<PerformanceTab />);
    expect(await screen.findByTestId('error-state')).toHaveTextContent(
      'Performance history could not load',
    );
  });
});
