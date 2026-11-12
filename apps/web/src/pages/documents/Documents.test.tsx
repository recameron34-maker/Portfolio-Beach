import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import {
  POSITION_ID,
  rolePrincipal,
  sentPosts,
  sentRequests,
} from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { DocumentsPage } from './Documents.js';
import {
  DOC_ID,
  docTypeTaxonomyFixture,
  documentFixture,
  documentPageFixture,
  indexResultFixture,
  REPORT_FILE,
  REPORT_TITLE,
  RUN_ID_FIXTURE,
} from './fixtures.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const ME = '/api/v1/auth/me';
const TAXONOMY = '/api/v1/taxonomy';
const DOCUMENTS = '/api/v1/documents';
const INDEX = '/api/v1/documents/index';
/** Dropdown journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

function routes(
  roles: Parameters<typeof rolePrincipal>[0] = ['operations'],
  overrides: MockRoutes = {},
): MockRoutes {
  return {
    [ME]: ok(rolePrincipal(roles)),
    [TAXONOMY]: ok(docTypeTaxonomyFixture()),
    [DOCUMENTS]: ok(documentPageFixture()),
    ...overrides,
  };
}

/** The document list requests sent so far, as their query strings. */
const listQueries = (): string[] =>
  sentRequests()
    .map(([url]) => url)
    .filter((url) => url.startsWith(`${DOCUMENTS}?`))
    .map((url) => url.slice(DOCUMENTS.length));

const table = (): HTMLElement => screen.getByRole('table', { name: 'Documents' });

async function pick(combobox: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole('combobox', { name: combobox }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

describe('documents hub', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists every document newest first with its type, subject, period, status, confidence and run', async () => {
    mockApi(routes());
    renderWithQuery(<DocumentsPage />);
    await screen.findByRole('table', { name: 'Documents' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Documents');
    expect(screen.getByRole('navigation', { name: 'Documents' })).toHaveTextContent('Review queue');
    expect(screen.getByTestId('documents-table')).toBe(table());
    expect(listQueries()).toEqual(['?limit=200']);
    expect(
      within(table())
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Title',
      'Type',
      'Company or fund',
      'Period',
      'Status',
      'Received',
      'Confidence',
      'Latest run',
    ]);
    const rows = within(table()).getAllByRole('row');
    expect(rows).toHaveLength(5);
    expect(screen.getByText('4 documents')).toBeInTheDocument();

    // The report: linked to its position, classified, a succeeded run linked to its review page.
    const report = within(table()).getByRole('link', { name: REPORT_TITLE }).closest('tr')!;
    expect(within(report).getByRole('link', { name: REPORT_TITLE })).toHaveAttribute(
      'href',
      `/documents/${DOC_ID.report}`,
    );
    expect(within(report).getByText(REPORT_FILE)).toBeInTheDocument();
    expect(within(report).getByText('Quarterly financials')).toBeInTheDocument();
    expect(within(report).getByRole('link', { name: 'Meridian Data Partners' })).toHaveAttribute(
      'href',
      `/portfolio/${POSITION_ID.meridian}`,
    );
    expect(within(report).getByText('INV-0001')).toHaveClass('pb-key');
    expect(within(report).getByText('Jun 30, 2025')).toBeInTheDocument();
    expect(within(report).getByText('Jul 1, 2025')).toBeInTheDocument();
    expect(within(report).getByText('Classified')).toHaveClass('pb-badge-good');
    expect(within(report).getByText('97%')).toBeInTheDocument();
    expect(within(report).getByRole('link', { name: 'Succeeded' })).toHaveAttribute(
      'href',
      `/documents/extraction/${RUN_ID_FIXTURE}`,
    );

    // The scan: nothing linked, waiting for a person, no run.
    const scan = within(table()).getByRole('link', { name: 'scan_0042' }).closest('tr')!;
    expect(within(scan).getByText('Needs review')).toHaveClass('pb-badge-watch');
    expect(within(scan).getByText('30%')).toBeInTheDocument();
    expect(within(scan).getAllByText('-')).toHaveLength(4);

    // The copy: a Duplicate, no type or confidence of its own.
    const copy = within(table())
      .getByText(`${REPORT_FILE.slice(0, -4)} (1)`)
      .closest('tr')!;
    expect(within(copy).getByText('Duplicate')).toHaveClass('pb-badge-neutral');

    // The statement: linked to the fund through its sponsor.
    const statement = within(table()).getByText('Capital account statement').closest('tr')!;
    expect(within(statement).getByRole('link', { name: 'Kelpwood Fund IV' })).toHaveAttribute(
      'href',
      `/sponsors/${documentFixture().sponsorId}`,
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('offers the index to operations and reports the counts; the list is read again', async () => {
    mockApi(
      routes(['operations'], {
        [INDEX]: ok(indexResultFixture()),
        [DOCUMENTS]: () =>
          ok(
            sentPosts().length === 0
              ? documentPageFixture([])
              : documentPageFixture([documentFixture()]),
          ),
      }),
    );
    renderWithQuery(<DocumentsPage />);
    await screen.findByTestId('documents-empty');
    expect(screen.getByText('No documents indexed yet')).toBeInTheDocument();
    expect(screen.queryByTestId('documents-read-only')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Index documents' }));
    expect(
      await screen.findByText('Indexed 77 documents, 1 duplicates, 0 unchanged (audited)'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('documents-action-status')).toHaveTextContent('Indexed 77');
    expect(sentPosts()).toEqual([[INDEX, undefined]]);
    await screen.findByRole('table', { name: 'Documents' });
    expect(within(table()).getAllByRole('row')).toHaveLength(2);
  });

  it('tells any other role that operations indexes; no button', async () => {
    mockApi(routes(['deal_team']));
    renderWithQuery(<DocumentsPage />);
    await screen.findByRole('table', { name: 'Documents' });
    expect(screen.queryByRole('button', { name: 'Index documents' })).not.toBeInTheDocument();
    expect(screen.getByTestId('documents-read-only')).toHaveTextContent(
      'Operations indexes documents; your role reads the hub.',
    );
  });

  it('says why the index was refused', async () => {
    mockApi(routes(['operations'], { [INDEX]: failing(403, INDEX) }));
    renderWithQuery(<DocumentsPage />);
    await screen.findByRole('table', { name: 'Documents' });
    await userEvent.click(screen.getByRole('button', { name: 'Index documents' }));
    expect(
      await screen.findByText(
        'Index documents: Your role cannot do this. Your role may not read this',
      ),
    ).toBeInTheDocument();
  });

  it('searches on Enter and sends the filters to the API', TIMEOUT, async () => {
    mockApi(routes());
    renderWithQuery(<DocumentsPage />);
    await screen.findByRole('table', { name: 'Documents' });
    const search = screen.getByTestId('documents-search');
    await userEvent.type(search, 'Meridian{Enter}');
    await waitFor(() => expect(listQueries()).toContain('?limit=200&q=Meridian'));
    await pick('Type', 'Quarterly financials');
    await waitFor(() =>
      expect(listQueries()).toContain(
        '?limit=200&q=Meridian&docType=doc_type.quarterly_financials',
      ),
    );
    await pick('Status', 'Needs review');
    await waitFor(() =>
      expect(listQueries()).toContain(
        '?limit=200&q=Meridian&docType=doc_type.quarterly_financials&reviewStatus=NeedsReview',
      ),
    );
    const period = screen.getByLabelText('Period end');
    await userEvent.type(period, '2025-06-30');
    await waitFor(() =>
      expect(listQueries()).toContain(
        '?limit=200&q=Meridian&docType=doc_type.quarterly_financials&reviewStatus=NeedsReview&periodEnd=2025-06-30',
      ),
    );
    // The type filter lists the active terms of the taxonomy only.
    await userEvent.click(screen.getByRole('combobox', { name: 'Type' }));
    expect(screen.queryByRole('option', { name: 'CIM' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Other' })).toBeInTheDocument();
  });

  it('says when nothing matches the filters', async () => {
    mockApi(routes(['viewer'], { [DOCUMENTS]: ok(documentPageFixture([])) }));
    renderWithQuery(<DocumentsPage />);
    await screen.findByTestId('documents-empty');
    const search = screen.getByTestId('documents-search');
    await userEvent.type(search, 'nothing{Enter}');
    expect(await screen.findByText('No documents match')).toBeInTheDocument();
  });

  it('loads the next page on the cursor', async () => {
    const second = documentFixture({ id: DOC_ID.notice, title: 'Older notice' });
    mockApi(
      routes(['viewer'], {
        [DOCUMENTS]: (url) =>
          ok(
            url.searchParams.get('cursor') === 'c1'
              ? documentPageFixture([second])
              : documentPageFixture([documentFixture()], 'c1'),
          ),
      }),
    );
    renderWithQuery(<DocumentsPage />);
    await screen.findByRole('table', { name: 'Documents' });
    expect(within(table()).getAllByRole('row')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByRole('link', { name: 'Older notice' });
    expect(within(table()).getAllByRole('row')).toHaveLength(3);
    expect(listQueries()).toEqual(['?limit=200', '?limit=200&cursor=c1']);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it(
    'shows the error when the list cannot load, and a skeleton while it loads',
    TIMEOUT,
    async () => {
      mockApi(routes(['viewer'], { [DOCUMENTS]: { status: 500, body: {} } }));
      renderWithQuery(<DocumentsPage />);
      expect(screen.getByText('Loading')).toBeInTheDocument();
      // A server failure is retried once before it is shown.
      expect(await screen.findByText('Documents unavailable', {}, TIMEOUT)).toBeInTheDocument();
      expect(screen.getByText('Request failed')).toBeInTheDocument();
    },
  );

  it('degrades to the reason when the role may not read the hub', async () => {
    mockApi(routes(['viewer'], { [DOCUMENTS]: failing(403, DOCUMENTS) }));
    renderWithQuery(<DocumentsPage />);
    expect(await screen.findByText('Documents: not visible to your role')).toBeInTheDocument();
  });
});
