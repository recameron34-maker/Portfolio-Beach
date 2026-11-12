import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import { ID } from '../../test/fixtures.js';
import { rolePrincipal, sentPosts, sentRequests } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { ExtractionPage } from './Extraction.js';
import {
  BATCH_ID,
  batchFixture,
  batchPageFixture,
  RUN_ID,
  runPageFixture,
  runs,
} from './test-fixtures.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const ME = '/api/v1/auth/me';
const BATCHES = '/api/v1/extraction/batches?limit=200';
const BATCH_POST = '/api/v1/extraction/batches';
const RUNS = '/api/v1/extraction/runs?limit=200';
const TAXONOMY = '/api/v1/taxonomy';
/** Dialog and dropdown journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

const taxonomy = {
  domains: [
    {
      domain: 'doc_type',
      terms: [
        {
          code: 'doc_type.quarterly_financials',
          label: 'Quarterly financials',
          parentCode: null,
          active: true,
          sortOrder: 1,
        },
        {
          code: 'doc_type.capital_call',
          label: 'Capital call',
          parentCode: null,
          active: true,
          sortOrder: 3,
        },
      ],
    },
  ],
};

function routes(
  roles: Parameters<typeof rolePrincipal>[0] = ['operations'],
  overrides: MockRoutes = {},
): MockRoutes {
  return {
    [ME]: ok(rolePrincipal(roles)),
    [BATCHES]: ok(batchPageFixture()),
    [RUNS]: ok(runPageFixture()),
    [TAXONOMY]: ok(taxonomy),
    ...overrides,
  };
}

const killSwitch = {
  status: 409,
  body: {
    type: 'https://portfolio-beach.example/problems/kill-switch',
    title: 'Conflict',
    status: 409,
    detail: 'AI extraction is switched off (ai.extraction)',
    instance: BATCH_POST,
    request_id: 'test',
  },
};

const rowOf = (table: string, text: string): HTMLElement => {
  const row = within(screen.getByRole('table', { name: table }))
    .getByText(text)
    .closest('tr');
  if (row === null) throw new Error(`no row holds ${text}`);
  return row;
};

async function pick(combobox: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole('combobox', { name: combobox }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

describe('extraction page', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists the batches and the runs with their states, flags and approval, and links each run to its review', async () => {
    mockApi(routes());
    renderWithQuery(<ExtractionPage />);
    const batches = await screen.findByRole('table', { name: 'Extraction batches' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Extraction');
    expect(screen.getByRole('navigation', { name: 'Documents' })).toHaveTextContent('Extraction');
    expect(screen.getByTestId('extraction-batches')).toBe(batches);
    expect(within(batches).getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText('2 batches')).toBeInTheDocument();

    const failed = rowOf('Extraction batches', 'runs_failed');
    expect(within(failed).getByText('Failed')).toHaveClass('pb-badge-bad');
    expect(within(failed).getByText('2 runs')).toBeInTheDocument();
    expect(within(failed).getByText('1 failed, 1 succeeded')).toBeInTheDocument();
    expect(within(failed).getByText('$0.0142')).toBeInTheDocument();
    const done = rowOf('Extraction batches', '12 runs');
    expect(within(done).getByText('Succeeded')).toHaveClass('pb-badge-good');
    expect(within(done).getByText('100%')).toBeInTheDocument();
    expect(within(done).getByText('24576 in, 768 out')).toBeInTheDocument();
    expect(within(done).getByText('$0.0852')).toBeInTheDocument();
    expect(within(done).getByText('Avery Castellanos')).toBeInTheDocument();

    const table = await screen.findByRole('table', { name: 'Extraction runs' });
    expect(screen.getByTestId('extraction-runs')).toBe(table);
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(screen.getByText('3 runs')).toBeInTheDocument();

    const pending = rowOf('Extraction runs', '2 flagged, 1 invalid');
    expect(within(pending).getByRole('link', { name: 'Meridian Data Partners' })).toHaveAttribute(
      'href',
      `/portfolio/${ID.inv1}`,
    );
    expect(within(pending).getByText('INV-0001')).toHaveClass('pb-key');
    expect(within(pending).getByText('Jun 30, 2025')).toBeInTheDocument();
    expect(within(pending).getByText('Succeeded')).toHaveClass('pb-badge-good');
    expect(within(pending).getByText('Awaiting approval')).toHaveClass('pb-badge-watch');
    // The router stand-in renders the link's text only; the app gives it the file name as its label.
    expect(within(pending).getByRole('link', { name: 'Review' })).toHaveAttribute(
      'href',
      `/documents/extraction/${RUN_ID.succeeded}`,
    );

    const approved = rowOf('Extraction runs', 'Approved by Blake Mbeki');
    expect(within(approved).getByText('Approved by Blake Mbeki')).toHaveClass('pb-badge-good');
    expect(within(approved).getByText('-')).toBeInTheDocument();

    const failedRun = rowOf('Extraction runs', 'schema_invalid');
    expect(within(failedRun).getByText('Failed')).toHaveClass('pb-badge-bad');
    expect(within(failedRun).getByText('Ashby Renewables Group')).toBeInTheDocument();
    expect(within(failedRun).getAllByText('-')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Load more runs' })).not.toBeInTheDocument();
  });

  it('offers the batch form to operations only', async () => {
    mockApi(routes(['operations']));
    renderWithQuery(<ExtractionPage />);
    const form = await screen.findByTestId('extraction-batch-form');
    expect(within(form).getByRole('textbox', { name: 'Period end' })).toHaveValue('');
    expect(within(form).getByRole('combobox', { name: 'Document type' })).toHaveTextContent(
      'Quarterly financials',
    );
    expect(within(form).getByRole('button', { name: 'Start extraction' })).toBeEnabled();
    expect(screen.queryByTestId('extraction-read-only')).not.toBeInTheDocument();

    cleanup();
    vi.restoreAllMocks();
    mockApi(routes(['deal_team']));
    renderWithQuery(<ExtractionPage />);
    expect(await screen.findByTestId('extraction-read-only')).toHaveTextContent(
      'Operations starts extraction batches; your role reads the runs.',
    );
    expect(screen.queryByRole('button', { name: 'Start extraction' })).not.toBeInTheDocument();
    await screen.findByRole('table', { name: 'Extraction runs' });
    expect(sentRequests().map(([url]) => url)).not.toContain(TAXONOMY);
  });

  it('refuses a period that is not a quarter end before anything is sent', async () => {
    mockApi(routes());
    renderWithQuery(<ExtractionPage />);
    const form = await screen.findByTestId('extraction-batch-form');
    await userEvent.click(within(form).getByRole('button', { name: 'Start extraction' }));
    expect(within(form).getByRole('alert')).toHaveTextContent(
      'Enter a quarter end as YYYY-MM-DD, for example 2025-06-30.',
    );
    await userEvent.type(within(form).getByRole('textbox', { name: 'Period end' }), '2025-06-15');
    await userEvent.click(within(form).getByRole('button', { name: 'Start extraction' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('quarter end');
    expect(sentPosts()).toEqual([]);
  });

  it(
    'starts a batch for a quarter and type, reports the runs and refreshes the lists',
    TIMEOUT,
    async () => {
      mockApi(
        routes(['operations'], {
          [BATCH_POST]: { status: 201, body: batchFixture() },
        }),
      );
      renderWithQuery(<ExtractionPage />);
      const form = await screen.findByTestId('extraction-batch-form');
      await userEvent.type(within(form).getByRole('textbox', { name: 'Period end' }), '2025-06-30');
      await pick('Document type', 'Capital call');
      await pick('Document type', 'Quarterly financials');
      await userEvent.click(within(form).getByRole('button', { name: 'Start extraction' }));
      expect(await screen.findByText('Batch started: 12 runs (audited)')).toBeInTheDocument();
      expect(screen.getByTestId('extraction-action-status')).toHaveTextContent('Batch started');
      expect(sentPosts()).toEqual([
        [BATCH_POST, { periodEnd: '2025-06-30', docType: 'doc_type.quarterly_financials' }],
      ]);
      // The lists are read again once the batch is through.
      await waitFor(() =>
        expect(sentRequests().filter(([url]) => url === BATCHES).length).toBeGreaterThan(1),
      );
    },
  );

  it('shows the kill switch refusal as the problem sentence', async () => {
    mockApi(routes(['operations'], { [BATCH_POST]: killSwitch }));
    renderWithQuery(<ExtractionPage />);
    const form = await screen.findByTestId('extraction-batch-form');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Period end' }), '2025-06-30');
    await userEvent.click(within(form).getByRole('button', { name: 'Start extraction' }));
    expect(
      await screen.findByText('Start extraction: AI extraction is switched off (ai.extraction)'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('extraction-action-status').firstChild).toHaveClass('pb-notice-bad');
  });

  it('filters the runs by state on the API and loads more on the cursor', TIMEOUT, async () => {
    mockApi(
      routes(['operations'], {
        [RUNS]: ok(runPageFixture(runs(), 'c1')),
        [`${RUNS}&cursor=c1`]: ok(runPageFixture([runs()[2]!], null)),
        [`${RUNS}&state=Failed`]: ok(runPageFixture([runs()[0]!], null)),
      }),
    );
    renderWithQuery(<ExtractionPage />);
    await screen.findByRole('table', { name: 'Extraction runs' });
    await userEvent.click(screen.getByRole('button', { name: 'Load more runs' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Extraction runs' })).getAllByRole('row'),
      ).toHaveLength(5),
    );
    expect(screen.queryByRole('button', { name: 'Load more runs' })).not.toBeInTheDocument();

    await pick('State', 'Failed');
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Extraction runs' })).getAllByRole('row'),
      ).toHaveLength(2),
    );
    expect(sentRequests().map(([url]) => url)).toContain(`${RUNS}&state=Failed`);
    expect(screen.getByText('1 run')).toBeInTheDocument();
  });

  it('says so when there are no batches or runs yet', async () => {
    mockApi(
      routes(['viewer'], {
        [BATCHES]: ok(batchPageFixture([])),
        [RUNS]: ok(runPageFixture([], null)),
      }),
    );
    renderWithQuery(<ExtractionPage />);
    expect(await screen.findByTestId('extraction-batches-empty')).toHaveTextContent(
      'No batches yet',
    );
    expect(await screen.findByTestId('extraction-runs-empty')).toHaveTextContent(
      'No extraction runs yet',
    );
  });

  it('shows the loading state, then a refused read as who may see it and a failed read as an error', async () => {
    mockApi(
      routes(['viewer'], {
        [BATCHES]: failing(403, BATCHES),
        [RUNS]: failing(501, RUNS),
      }),
    );
    renderWithQuery(<ExtractionPage />);
    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(await screen.findByTestId('extraction-batches-unavailable')).toHaveTextContent(
      'Extraction runs are not visible to your role',
    );
    expect(await screen.findByTestId('extraction-runs-unavailable')).toHaveTextContent(
      'Extraction runs: not available yet',
    );
    expect(screen.queryByTestId(`batch-${BATCH_ID.done}`)).not.toBeInTheDocument();
  });
});
