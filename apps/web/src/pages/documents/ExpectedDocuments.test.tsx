import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import { dataHealthFixture } from '../../test/fixtures.js';
import {
  POSITION_ID,
  rolePrincipal,
  sentPosts,
  sentRequests,
} from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { ExpectedDocumentsPage } from './ExpectedDocuments.js';
import {
  DOC_ID,
  expectedDocumentFixture,
  expectedPageFixture,
  generateResultFixture,
} from './fixtures.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const ME = '/api/v1/auth/me';
const HEALTH = '/api/v1/data-health';
const EXPECTED = '/api/v1/expected-documents';
const GENERATE = '/api/v1/expected-documents/generate';
/** Dropdown journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

function routes(
  roles: Parameters<typeof rolePrincipal>[0] = ['operations'],
  overrides: MockRoutes = {},
): MockRoutes {
  return {
    [ME]: ok(rolePrincipal(roles)),
    [HEALTH]: ok(dataHealthFixture()),
    [EXPECTED]: ok(expectedPageFixture()),
    ...overrides,
  };
}

/** The tracker requests sent so far, as their query strings. */
const listQueries = (): string[] =>
  sentRequests()
    .map(([url]) => url)
    .filter((url) => url.startsWith(`${EXPECTED}?`))
    .map((url) => url.slice(EXPECTED.length));

const table = (): HTMLElement => screen.getByRole('table', { name: 'Expected documents' });

const rowOf = (text: string): HTMLElement => {
  const row = within(table()).getByText(text).closest('tr');
  if (row === null) throw new Error(`no row holds ${text}`);
  return row;
};

async function pick(combobox: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole('combobox', { name: combobox }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

describe('expected documents', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists every expected row with its status, due date, age and document', async () => {
    mockApi(routes(['viewer']));
    renderWithQuery(<ExpectedDocumentsPage />);
    await screen.findByRole('table', { name: 'Expected documents' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Expected documents');
    expect(screen.getByRole('navigation', { name: 'Documents' })).toHaveTextContent('Extraction');
    expect(screen.getByTestId('expected-table')).toBe(table());
    expect(listQueries()).toEqual(['?limit=200']);
    expect(screen.getByText('4 rows')).toBeInTheDocument();
    expect(
      within(table())
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Company or fund', 'Type', 'Period', 'Due', 'Status', 'Age (days)', 'Document']);

    const received = rowOf('Meridian Data Partners');
    expect(within(received).getByRole('link', { name: 'Meridian Data Partners' })).toHaveAttribute(
      'href',
      `/portfolio/${POSITION_ID.meridian}`,
    );
    expect(within(received).getByText('INV-0001')).toHaveClass('pb-key');
    expect(within(received).getByText('Quarterly financials')).toBeInTheDocument();
    expect(within(received).getByText('Jun 30, 2025')).toBeInTheDocument();
    expect(within(received).getByText('Aug 14, 2025')).toBeInTheDocument();
    expect(within(received).getByText('Received')).toHaveClass('pb-badge-good');
    expect(within(received).getByText('-45')).toHaveAttribute(
      'title',
      'Received 45 days before due',
    );
    expect(within(received).getByRole('link', { name: 'Open document' })).toHaveAttribute(
      'href',
      `/documents/${DOC_ID.report}`,
    );

    const late = rowOf('Silverline Staffing Holdings');
    expect(within(late).getByText('Late')).toHaveClass('pb-badge-watch');
    expect(within(late).getByText('16')).toHaveAttribute('title', '16 days past due');
    expect(within(late).getByText('-')).toBeInTheDocument();

    const missing = rowOf('Cobalt Ridge Logistics');
    expect(within(missing).getByText('Missing')).toHaveClass('pb-badge-bad');
    expect(within(missing).getByText('76')).toHaveAttribute('title', '76 days past due');

    const fund = rowOf('Kelpwood Fund IV');
    expect(within(fund).queryByRole('link')).not.toBeInTheDocument();
    expect(within(fund).getByText('Capital account statement')).toBeInTheDocument();
    expect(within(fund).getByText('Expected')).toHaveClass('pb-badge-neutral');

    // A viewer reads the tracker; the generate card is for operations.
    expect(screen.queryByTestId('expected-generate')).not.toBeInTheDocument();
    expect(screen.getByTestId('expected-read-only')).toHaveTextContent(
      'Operations generates expected documents; your role reads the tracker.',
    );
    expect(sentRequests().map(([url]) => url)).not.toContain(HEALTH);
    expect(screen.queryByTestId('expected-truncated')).not.toBeInTheDocument();
  });

  it(
    'offers operations the generation for the latest quarter of the record, and reports the counts',
    TIMEOUT,
    async () => {
      mockApi(
        routes(['operations'], {
          [GENERATE]: ok(generateResultFixture()),
          [EXPECTED]: () =>
            ok(sentPosts().length === 0 ? expectedPageFixture([]) : expectedPageFixture()),
        }),
      );
      renderWithQuery(<ExpectedDocumentsPage />);
      const card = await screen.findByTestId('expected-generate');
      expect(await screen.findByTestId('expected-empty')).toHaveTextContent(
        'No expected documents yet',
      );
      expect(screen.queryByTestId('expected-read-only')).not.toBeInTheDocument();
      const quarter = within(card).getByLabelText('Quarter end');
      expect(quarter).toHaveValue(dataHealthFixture().asOf.slice(0, 8) + '30');
      const button = within(card).getByRole('button', { name: 'Generate expected documents' });
      expect(button).not.toHaveAttribute('aria-disabled', 'true');
      await userEvent.click(button);
      expect(
        await screen.findByText('Expected documents generated: 18 created, 0 existing (audited)'),
      ).toBeInTheDocument();
      expect(screen.getByTestId('expected-action-status')).toHaveTextContent('18 created');
      expect(sentPosts()).toEqual([[GENERATE, { periodEnd: '2025-06-30' }]]);
      await screen.findByRole('table', { name: 'Expected documents' });
      expect(within(table()).getAllByRole('row')).toHaveLength(5);
    },
  );

  it('runs a generation for a quarter end only', TIMEOUT, async () => {
    mockApi(routes(['operations']));
    renderWithQuery(<ExpectedDocumentsPage />);
    const card = await screen.findByTestId('expected-generate');
    const quarter = within(card).getByLabelText('Quarter end');
    await userEvent.clear(quarter);
    await userEvent.type(quarter, '2025-06-15');
    const button = within(card).getByRole('button', { name: 'Generate expected documents' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute(
      'title',
      'The date must be a quarter end (March 31, June 30, September 30 or December 31).',
    );
    await userEvent.clear(quarter);
    expect(button).toHaveAttribute('title', 'Pick a quarter end.');
  });

  it('says why a generation was refused', TIMEOUT, async () => {
    mockApi(routes(['operations'], { [GENERATE]: failing(403, GENERATE) }));
    renderWithQuery(<ExpectedDocumentsPage />);
    await screen.findByTestId('expected-generate');
    await userEvent.click(screen.getByRole('button', { name: 'Generate expected documents' }));
    expect(
      await screen.findByText(
        'Generate expected documents: Your role cannot do this. Your role may not read this',
      ),
    ).toBeInTheDocument();
  });

  it('sends the period, status and as-of filters to the API', TIMEOUT, async () => {
    mockApi(routes(['viewer']));
    renderWithQuery(<ExpectedDocumentsPage />);
    await screen.findByRole('table', { name: 'Expected documents' });
    await userEvent.type(screen.getByLabelText('Period end'), '2025-06-30');
    await waitFor(() => expect(listQueries()).toContain('?limit=200&periodEnd=2025-06-30'));
    await pick('Status', 'Missing');
    await waitFor(() =>
      expect(listQueries()).toContain('?limit=200&periodEnd=2025-06-30&status=missing'),
    );
    await userEvent.type(screen.getByLabelText('Judged as of'), '2025-10-29');
    await waitFor(() =>
      expect(listQueries()).toContain(
        '?limit=200&periodEnd=2025-06-30&status=missing&asOf=2025-10-29',
      ),
    );
  });

  it('says when nothing matches, and when more rows exist than one page holds', async () => {
    mockApi(
      routes(['viewer'], {
        [EXPECTED]: (url) =>
          ok(
            url.searchParams.get('status') === 'late'
              ? expectedPageFixture([])
              : expectedPageFixture([expectedDocumentFixture()], 'next'),
          ),
      }),
    );
    renderWithQuery(<ExpectedDocumentsPage />);
    await screen.findByRole('table', { name: 'Expected documents' });
    expect(screen.getByTestId('expected-truncated')).toHaveTextContent(
      'Showing the first 200 rows; more exist.',
    );
    await pick('Status', 'Late');
    expect(await screen.findByText('No expected documents match')).toBeInTheDocument();
  });

  it(
    'shows a skeleton while loading and the error when the tracker cannot load',
    TIMEOUT,
    async () => {
      mockApi(routes(['viewer'], { [EXPECTED]: { status: 500, body: {} } }));
      renderWithQuery(<ExpectedDocumentsPage />);
      expect(screen.getByText('Loading')).toBeInTheDocument();
      expect(
        await screen.findByText('Expected documents unavailable', {}, TIMEOUT),
      ).toBeInTheDocument();
    },
  );
});
