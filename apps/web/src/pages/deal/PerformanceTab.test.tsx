import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Principal } from '@pb/contracts';
import { failing, mockApi, ok, problemFixture } from '../../test/api-mock.js';
import type { MockResponse, MockRoutes } from '../../test/api-mock.js';
import {
  creditDetailFixture,
  creditPerformanceFixture,
  DEAL_DOCUMENT_ID,
  DEAL_PATHS,
  dealDetailFixture,
  defaultOutlookFixture,
  ENTRY_SNAPSHOT,
  equityPerformanceFixture,
  outlookFixture,
} from '../../test/fixtures-deal.js';
import { rolePrincipal, sentRequests } from '../../test/fixtures-valuations.js';
import { MISSING } from '../../lib/format.js';
import { renderWithQuery } from '../../test/render.js';
import { PerformanceTab } from './PerformanceTab.js';

vi.mock('@tanstack/react-router', async () => {
  const { routerMock } = await import('../../test/router-mock.js');
  const { DEAL_ID: id } = await import('../../test/fixtures-deal.js');
  const base = routerMock();
  const BaseLink = base.Link as (props: { to: string; children?: ReactNode }) => ReactNode;
  return {
    ...base,
    useParams: () => ({ id }),
    // The source links address the document hub by href (HubLink); the rest resolve a route.
    Link: (props: {
      to: string;
      href?: string;
      className?: string;
      'data-testid'?: string;
      children?: ReactNode;
    }) =>
      props.href === undefined ? (
        BaseLink(props)
      ) : (
        <a href={props.href} className={props.className} data-testid={props['data-testid']}>
          {props.children}
        </a>
      ),
  };
});

const EM_DASH = String.fromCharCode(0x2014);
/** Dialog and popover journeys drive Fluent controls; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

function routes(roles: Principal['roles'] = ['deal_team'], overrides: MockRoutes = {}): MockRoutes {
  return {
    [DEAL_PATHS.me]: ok(rolePrincipal(roles)),
    [DEAL_PATHS.detail]: ok(dealDetailFixture()),
    [DEAL_PATHS.performance]: ok(equityPerformanceFixture()),
    [DEAL_PATHS.outlook]: ok(outlookFixture()),
    ...overrides,
  };
}

/** The PUT requests only, as [path, parsed body]. */
const sentPuts = (): [string, unknown][] =>
  sentRequests()
    .filter(([, method]) => method === 'PUT')
    .map(([url, , body]) => [url, body]);

const outlookCard = (): HTMLElement => screen.getByTestId('outlook-card');
const outlookTable = (): HTMLElement =>
  within(outlookCard()).getByRole('table', { name: 'Realization outlook' });

describe('performance tab, equity position', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows growth since entry, the approved LTM series, the quarterly table, highlights and the outlook', async () => {
    mockApi(routes());
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
    expect(table).toHaveAttribute('data-testid', 'performance-sources');
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

    // The outlook comes from the monitoring API, with who set it and when.
    const kv = await screen.findByRole('table', { name: 'Realization outlook' });
    expect(kv).toHaveTextContent('Partial');
    expect(kv).toHaveTextContent('Within 18 months');
    expect(kv).toHaveTextContent('Sponsor has engaged advisors.');
    expect(kv).toHaveTextContent('Emerson Marchetti');
    expect(kv).toHaveTextContent('May 2, 2025 09:30:00 UTC');
    expect(outlookCard()).toHaveTextContent('Changes only by explicit edit');
    // The deal team gets the edit form; its status region is empty until an edit is made.
    expect(within(outlookCard()).getByTestId('outlook-form')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(document.body.textContent).not.toContain(EM_DASH);
  });

  it('shows the missing placeholder as the source of a quarter whose figures have no document', async () => {
    mockApi(routes());
    renderWithQuery(<PerformanceTab />);
    const table = await screen.findByRole('table', { name: 'Quarterly financials' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toContain('Source');
    for (const periodEnd of ['2025-06-30', '2025-03-31', '2024-12-31', '2018-09-30']) {
      const source = screen.getByTestId(`performance-source-${periodEnd}`);
      expect(source).toHaveTextContent(MISSING);
      expect(source.tagName).toBe('SPAN');
      expect(source.closest('td')).toHaveClass('is-missing');
    }
    expect(within(table).queryByRole('link')).not.toBeInTheDocument();
    expect(table.parentElement?.parentElement).toHaveTextContent(
      'a quarter with no source document shows',
    );
  });

  it('links a quarter to the page of the document it was read from, and to the run that read it', async () => {
    const perf = equityPerformanceFixture();
    // The fixture lists quarters oldest first: Dec 2024, Mar 2025, Jun 2025.
    mockApi(
      routes(['deal_team'], {
        [DEAL_PATHS.performance]: ok({
          ...perf,
          quarters: perf.quarters.map((q) =>
            q.periodEnd === '2025-06-30'
              ? {
                  ...q,
                  source: {
                    documentId: DEAL_DOCUMENT_ID.report,
                    runId: DEAL_DOCUMENT_ID.run,
                    page: 3,
                    locator: 'field:revenue_ltm',
                  },
                }
              : q.periodEnd === '2025-03-31'
                ? {
                    ...q,
                    source: {
                      documentId: DEAL_DOCUMENT_ID.scan,
                      runId: null,
                      page: null,
                      locator: null,
                    },
                  }
                : q,
          ),
        }),
      }),
    );
    renderWithQuery(<PerformanceTab />);
    const link = await screen.findByTestId('performance-source-2025-06-30');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', `/documents/${DEAL_DOCUMENT_ID.report}`);
    expect(link).toHaveTextContent('page 3');
    expect(link).toHaveAccessibleName('page 3, source of Jun 30, 2025');
    const run = screen.getByRole('link', { name: 'run that read Jun 30, 2025' });
    expect(run).toHaveAttribute('href', `/documents/extraction/${DEAL_DOCUMENT_ID.run}`);
    // A document without a page or run: the document link alone, no page invented.
    const imported = screen.getByTestId('performance-source-2025-03-31');
    expect(imported).toHaveAttribute('href', `/documents/${DEAL_DOCUMENT_ID.scan}`);
    expect(imported).toHaveTextContent('document');
    expect(screen.queryByRole('link', { name: /run that read Mar 31, 2025/ })).toBeNull();
    expect(screen.getByTestId('performance-source-2024-12-31')).toHaveTextContent(MISSING);
  });

  it('says the entry snapshot is dated after the as-of date instead of comparing against it', async () => {
    mockApi(
      routes(['deal_team'], {
        [DEAL_PATHS.performance]: ok(
          equityPerformanceFixture({
            entry: { ...ENTRY_SNAPSHOT, periodEnd: '2025-09-30' },
            sinceEntry: null,
          }),
        ),
      }),
    );
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
    mockApi(
      routes(['deal_team'], {
        [DEAL_PATHS.performance]: ok(
          equityPerformanceFixture({
            entry: null,
            sinceEntry: null,
            quarters: [],
            realizationOutlook: null,
          }),
        ),
        [DEAL_PATHS.outlook]: ok(defaultOutlookFixture()),
      }),
    );
    renderWithQuery(<PerformanceTab />);
    expect(await screen.findByText('No entry snapshot recorded')).toBeInTheDocument();
    expect(screen.getByText('No quarterly financials')).toBeInTheDocument();
    expect(screen.getByText('No highlights recorded')).toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: 'Revenue and EBITDA, LTM' }),
    ).not.toBeInTheDocument();
    // Nobody has set an outlook: the API's default, with the placeholder where nothing is known.
    const kv = await screen.findByRole('table', { name: 'Realization outlook' });
    const cells = within(kv)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells).toEqual(['None', 'Within 18 months', MISSING, MISSING, MISSING]);
  });

  it('names the gap when a snapshot exists but no approved quarter can be compared with it', async () => {
    mockApi(
      routes(['deal_team'], {
        [DEAL_PATHS.performance]: ok(equityPerformanceFixture({ sinceEntry: null })),
      }),
    );
    renderWithQuery(<PerformanceTab />);
    expect(
      await screen.findByText('No approved quarter to compare with the entry snapshot'),
    ).toBeInTheDocument();
  });
});

describe('realization outlook card', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([['viewer'], ['operations'], ['approver']] as const)(
    'reads only for %s: the sentence instead of the form',
    async (role) => {
      mockApi(routes([role]));
      renderWithQuery(<PerformanceTab />);
      const card = await screen.findByTestId('outlook-card');
      expect(await within(card).findByTestId('outlook-read-only')).toHaveTextContent(
        'The deal team sets the outlook; your role reads it.',
      );
      expect(within(card).queryByTestId('outlook-form')).not.toBeInTheDocument();
      expect(within(card).queryByRole('button', { name: 'Set outlook' })).not.toBeInTheDocument();
      expect(outlookTable()).toHaveTextContent('Partial');
    },
  );

  it('loads the outlook separately from the series and says so while it is in flight', async () => {
    mockApi(routes());
    const impl = vi.mocked(globalThis.fetch).getMockImplementation();
    if (impl === undefined) throw new Error('fetch is not mocked');
    // The outlook read never answers; every other read answers from the fixtures.
    const pending = new Promise<Response>(() => undefined);
    vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.includes('/monitoring/outlook/') ? pending : impl(input, init);
    });
    renderWithQuery(<PerformanceTab />);
    const card = await screen.findByTestId('outlook-card');
    expect(within(card).getByText('Loading the realization outlook')).toBeInTheDocument();
    expect(within(card).queryByTestId('outlook-form')).not.toBeInTheDocument();
    expect(within(card).queryByTestId('outlook-read-only')).not.toBeInTheDocument();
  });

  it(
    'sets the outlook through PUT with the reason, shows the status phrase and the new values',
    TIMEOUT,
    async () => {
      const after = outlookFixture({
        outlook: 'full',
        horizonMonths: 24,
        note: 'Sale process launched.',
        setAt: '2025-06-30T12:00:00.000Z',
      });
      mockApi(
        routes(['deal_team'], {
          // The answer to the PUT, and to the refetch that follows it.
          [DEAL_PATHS.outlook]: () => ok(sentPuts().length > 0 ? after : outlookFixture()),
        }),
      );
      renderWithQuery(<PerformanceTab />);
      const form = await screen.findByTestId('outlook-form');
      const button = within(form).getByRole('button', { name: 'Set outlook' });
      // Nothing is sent without a reason: the button cannot act yet, but keeps keyboard focus.
      expect(button).toHaveAttribute('aria-disabled', 'true');

      await userEvent.click(within(form).getByRole('combobox', { name: 'Outlook' }));
      await userEvent.click(await screen.findByRole('option', { name: 'Full' }, TIMEOUT));
      const horizon = within(form).getByLabelText('Horizon (months)');
      await userEvent.clear(horizon);
      await userEvent.type(horizon, '24');
      const note = within(form).getByLabelText('Note');
      await userEvent.clear(note);
      await userEvent.type(note, 'Sale process launched.');
      await userEvent.type(
        within(form).getByLabelText('Reason'),
        'Sponsor launched a sale process',
      );
      await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'));
      await userEvent.click(button);

      await waitFor(
        () =>
          expect(screen.getByTestId('outlook-action-status')).toHaveTextContent(
            'Outlook set to Full (audited)',
          ),
        TIMEOUT,
      );
      expect(sentPuts()).toEqual([
        [
          DEAL_PATHS.outlook,
          {
            outlook: 'full',
            horizonMonths: 24,
            note: 'Sale process launched.',
            reason: 'Sponsor launched a sale process',
          },
        ],
      ]);
      const kv = outlookTable();
      expect(kv).toHaveTextContent('Full');
      expect(kv).toHaveTextContent('Within 24 months');
      expect(kv).toHaveTextContent('Sale process launched.');
      expect(kv).toHaveTextContent('Jun 30, 2025 12:00:00 UTC');
      // The reason is for one edit only; the form asks for a new one.
      expect(screen.getByLabelText('Reason')).toHaveValue('');
      expect(document.body.textContent).not.toContain(EM_DASH);
    },
  );

  it(
    'sends an empty note as null and refuses a horizon outside the contract bounds',
    TIMEOUT,
    async () => {
      mockApi(
        routes(['deal_team'], {
          [DEAL_PATHS.outlook]: () =>
            ok(sentPuts().length > 0 ? outlookFixture({ note: null }) : outlookFixture()),
        }),
      );
      renderWithQuery(<PerformanceTab />);
      const form = await screen.findByTestId('outlook-form');
      const button = within(form).getByRole('button', { name: 'Set outlook' });
      const horizon = within(form).getByLabelText('Horizon (months)');
      await userEvent.type(within(form).getByLabelText('Reason'), 'Note withdrawn');
      await userEvent.clear(within(form).getByLabelText('Note'));
      await userEvent.clear(horizon);
      await userEvent.type(horizon, '121');
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).toHaveAttribute('title', expect.stringContaining('1 to 120 months'));
      await userEvent.clear(horizon);
      await userEvent.type(horizon, '12');
      await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'));
      await userEvent.click(button);
      await waitFor(() => expect(sentPuts()).toHaveLength(1), TIMEOUT);
      expect(sentPuts()[0]?.[1]).toEqual({
        outlook: 'partial',
        horizonMonths: 12,
        note: null,
        reason: 'Note withdrawn',
      });
    },
  );

  it(
    'shows a refusal as the status, worded for the user, and keeps the recorded outlook',
    TIMEOUT,
    async () => {
      const guard: MockResponse = {
        status: 409,
        body: {
          ...problemFixture(404, DEAL_PATHS.outlook),
          type: 'https://portfolio-beach.example/problems/realization-outlook-guard',
          title: 'Conflict',
          status: 409,
          detail:
            'The realization outlook is changed only by an explicit edit, and definitions.realizationFlagEditableOnlyManually is off',
        },
      };
      mockApi(
        routes(['deal_team'], {
          [DEAL_PATHS.outlook]: () => (sentPuts().length > 0 ? guard : ok(outlookFixture())),
        }),
      );
      renderWithQuery(<PerformanceTab />);
      const form = await screen.findByTestId('outlook-form');
      await userEvent.type(within(form).getByLabelText('Reason'), 'Trying an edit');
      await userEvent.click(within(form).getByRole('button', { name: 'Set outlook' }));
      const status = await screen.findByTestId('outlook-action-status');
      await waitFor(
        () =>
          expect(status).toHaveTextContent(
            /^Set outlook: Not allowed from the current state\. The realization outlook is changed only by an explicit edit/,
          ),
        TIMEOUT,
      );
      expect(status.querySelector('.pb-notice-bad')).not.toBeNull();
      expect(outlookTable()).toHaveTextContent('Partial');
      // The typed reason stays, so the user can retry without typing it again.
      expect(screen.getByLabelText('Reason')).toHaveValue('Trying an edit');
    },
  );

  it('shows the outlook as unavailable without hiding the rest of the tab', async () => {
    mockApi(
      routes(['deal_team'], {
        [DEAL_PATHS.outlook]: {
          status: 500,
          body: { ...problemFixture(404, DEAL_PATHS.outlook), status: 500, title: 'Server error' },
        },
      }),
    );
    renderWithQuery(<PerformanceTab />);
    expect(await screen.findByTestId('outlook-unavailable')).toHaveTextContent(
      'The realization outlook could not load',
    );
    expect(screen.getByTestId('deal-quarterly')).toBeInTheDocument();
    expect(screen.queryByTestId('outlook-form')).not.toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });

  it('degrades a 501 on the outlook to the not-built wording', async () => {
    mockApi(routes(['deal_team'], { [DEAL_PATHS.outlook]: failing(501, DEAL_PATHS.outlook) }));
    renderWithQuery(<PerformanceTab />);
    expect(await screen.findByTestId('outlook-unavailable')).toHaveTextContent(
      'The realization outlook is not available in this build',
    );
  });
});

describe('performance tab, private credit position', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the terms, the par and fair value series, the quarterly metrics and the schedules', async () => {
    mockApi(
      routes(['viewer'], {
        [DEAL_PATHS.detail]: ok(creditDetailFixture()),
        [DEAL_PATHS.performance]: ok(creditPerformanceFixture()),
        [DEAL_PATHS.outlook]: ok(defaultOutlookFixture()),
      }),
    );
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
    // The outlook card is shared with the equity layout; a viewer reads it.
    expect(await screen.findByRole('table', { name: 'Realization outlook' })).toHaveTextContent(
      'None',
    );
    expect(screen.getByTestId('outlook-read-only')).toBeInTheDocument();
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
    mockApi(
      routes(['deal_team'], { [DEAL_PATHS.performance]: failing(501, DEAL_PATHS.performance) }),
    );
    renderWithQuery(<PerformanceTab />);
    expect(
      await screen.findByText(
        'Performance history is not available for this position in this build',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });

  it('degrades a 403 to the role wording', async () => {
    mockApi(
      routes(['deal_team'], { [DEAL_PATHS.performance]: failing(403, DEAL_PATHS.performance) }),
    );
    renderWithQuery(<PerformanceTab />);
    expect(
      await screen.findByText('Performance history: not visible to your role'),
    ).toBeInTheDocument();
  });

  it('shows a 404 as an error rather than an empty tab', async () => {
    mockApi(
      routes(['deal_team'], { [DEAL_PATHS.performance]: failing(404, DEAL_PATHS.performance) }),
    );
    renderWithQuery(<PerformanceTab />);
    expect(await screen.findByTestId('error-state')).toHaveTextContent(
      'Performance history could not load',
    );
  });
});
