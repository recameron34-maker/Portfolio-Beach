import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clearCredential, setCredential } from '../../app/session.js';
import { failing, mockApi, ok, problemFixture } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import { ID, investmentFixture, investmentPageFixture } from '../../test/fixtures.js';
import { rolePrincipal, sentRequests } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { BOARD_CSV, BOARD_ID, boardFixture, boardRowFixture } from './fixtures.js';
import { MonitoringPage } from './Monitoring.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const ME = '/api/v1/auth/me';
const BOARD = '/api/v1/monitoring/board';
const EXPORT = '/api/v1/monitoring/board/export';
const POSITIONS = '/api/v1/investments?limit=200';

/** The two positions the quarter picker reads its range from: entered in Q4 2024 and Q1 2025. */
function positions() {
  return investmentPageFixture([
    investmentFixture({ entryDate: '2024-11-15' }),
    investmentFixture({ id: ID.inv2, investmentNumber: 'INV-0002', entryDate: '2025-02-01' }),
  ]);
}

function routes(
  roles: Parameters<typeof rolePrincipal>[0] = ['deal_team'],
  overrides: MockRoutes = {},
): MockRoutes {
  return {
    [ME]: ok(rolePrincipal(roles)),
    // The board answers the quarter and the as-of day it was asked for, the fixture rows either way.
    [BOARD]: (url) =>
      ok(
        boardFixture(undefined, {
          periodEnd: url.searchParams.get('periodEnd') ?? '2025-06-30',
          asOf: url.searchParams.get('asOf') ?? '2025-06-30',
        }),
      ),
    [POSITIONS]: ok(positions()),
    ...overrides,
  };
}

/** The paths the page asked the board for, in order. */
function boardRequests(): string[] {
  return sentRequests()
    .map(([url]) => url)
    .filter((url) => url.startsWith(BOARD) && !url.startsWith(EXPORT));
}

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** Answers the export path with a CSV text (or a problem), everything else from the routes. */
function mockExport(text: string, status: 200 | 403 = 200): void {
  const base = vi.mocked(globalThis.fetch).getMockImplementation();
  if (base === undefined) throw new Error('mockApi must run first');
  vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
    if (!urlOf(input).startsWith(EXPORT)) return base(input, init);
    return Promise.resolve(
      status === 200
        ? new Response(text, { status, headers: { 'content-type': 'text/csv; charset=utf-8' } })
        : new Response(JSON.stringify(problemFixture(status, EXPORT)), {
            status,
            headers: { 'content-type': 'application/problem+json' },
          }),
    );
  });
}

const table = (): HTMLElement => screen.getByRole('table', { name: 'Monitoring board' });
const rowOf = (investmentNumber: string): HTMLElement => {
  const row = within(table()).getByText(investmentNumber).closest('tr');
  if (row === null) throw new Error(`no row for ${investmentNumber}`);
  return row;
};
const dateInput = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>('As of');

/** The text of a Blob through FileReader, which jsdom's Blob supports (it has no text()). */
function blobText(blob: Blob | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    if (blob === undefined) {
      reject(new Error('no blob was created'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('the blob could not be read'));
    reader.readAsText(blob);
  });
}

describe('monitoring board', () => {
  beforeEach(() => {
    setCredential('deal.three');
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    clearCredential();
  });

  it('shows the loading state, then the tiles and one row per position with its three statuses', async () => {
    mockApi(routes());
    const { container } = renderWithQuery(<MonitoringPage />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    const tiles = await screen.findByTestId('monitoring-tiles');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Monitoring');
    expect(
      screen.getByText(/Quarter ended Jun 30, 2025, judged as of Jun 30, 2025/),
    ).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Portfolio' })).toHaveTextContent('Monitoring');
    const count = (label: string): string =>
      within(within(tiles).getByRole('group', { name: label })).getByText(/^\d+$/, {
        selector: '.pb-stat-value',
      }).textContent ?? '';
    expect(count('Expected')).toBe('1');
    expect(count('Received')).toBe('2');
    expect(count('Late')).toBe('1');
    expect(count('Missing')).toBe('0');
    expect(count('In review')).toBe('1');
    expect(count('Approved')).toBe('2');
    expect(within(tiles).getByRole('group', { name: 'Late' })).toHaveAttribute(
      'data-tone',
      'watch',
    );
    expect(within(tiles).getByRole('group', { name: 'Missing' })).not.toHaveAttribute('data-tone');

    expect(screen.getByTestId('monitoring-board')).toBeInTheDocument();
    expect(
      within(table())
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Inv #',
      'Company',
      'Vehicle',
      'Sponsor fund',
      'Deal type',
      'Report',
      'Run',
      'Flags',
      'Approval',
    ]);
    expect(within(table()).getAllByRole('row')).toHaveLength(5);
    expect(screen.getByText('4 positions')).toBeInTheDocument();

    // A received report with a run awaiting approval: every link and the flags count.
    const meridian = rowOf('INV-0001');
    expect(within(meridian).getByText('INV-0001')).toHaveClass('pb-key');
    expect(within(meridian).getByRole('link', { name: 'Meridian Data Partners' })).toHaveAttribute(
      'href',
      `/portfolio/${ID.inv1}`,
    );
    expect(within(meridian).getByText('Kelpwood Fund IV')).toBeInTheDocument();
    expect(within(meridian).getByText('Co invest equity')).toBeInTheDocument();
    expect(within(meridian).getByText('Received')).toHaveClass('pb-badge-good');
    expect(within(meridian).getByText('Due Aug 14, 2025')).toBeInTheDocument();
    expect(within(meridian).getByText('received 30 days early')).toBeInTheDocument();
    // The page names each link by its company (aria-label); the router stand-in keeps the text only.
    expect(within(meridian).getByRole('link', { name: 'Document' })).toHaveAttribute(
      'href',
      `/documents/${BOARD_ID.docMeridian}`,
    );
    expect(within(meridian).getByText('Succeeded')).toHaveClass('pb-badge-good');
    expect(within(meridian).getByRole('link', { name: 'Run' })).toHaveAttribute(
      'href',
      `/documents/extraction/${BOARD_ID.runMeridian}`,
    );
    expect(within(meridian).getByText('2')).toHaveClass('num');
    expect(within(meridian).getByText('Pending')).toHaveClass('pb-badge-watch');

    // A report still expected: no document, no run, so the flags show the placeholder.
    const summit = rowOf('INV-0002');
    expect(within(summit).getByText('Expected')).toHaveClass('pb-badge-neutral');
    expect(within(summit).getByText('due in 45 days')).toBeInTheDocument();
    expect(within(summit).queryByRole('link', { name: 'Document' })).not.toBeInTheDocument();
    expect(within(summit).queryByRole('link', { name: 'Run' })).not.toBeInTheDocument();
    expect(within(summit).getAllByText('-')).toHaveLength(2);
    expect(within(summit).getByText('None')).toHaveClass('pb-badge-neutral');

    // A late report whose seeded quarter is approved without a time: the placeholder, never an error.
    const ashby = rowOf('INV-0003');
    expect(within(ashby).getByText('Late')).toHaveClass('pb-badge-watch');
    expect(within(ashby).getByText('16 days past due')).toBeInTheDocument();
    expect(within(ashby).getByText('Approved')).toHaveClass('pb-badge-good');
    expect(within(ashby).getByText('Cv single asset')).toBeInTheDocument();
    // Sponsor fund, run, flags and the approval time all show the placeholder.
    expect(within(ashby).getAllByText('-')).toHaveLength(4);

    // A credit position received on its fund's statement, approved with a time.
    const credit = rowOf('INV-0004');
    expect(within(credit).getByText('received 3 days late')).toBeInTheDocument();
    expect(within(credit).getByText('Jul 20, 2025')).toBeInTheDocument();
    expect(screen.getByText(/A report counts as late 15 days after its due date/)).toBeVisible();
    expect(screen.getByTestId('monitoring-action-status')).toBeEmptyDOMElement();
    expect(boardRequests()).toEqual([BOARD]);
  });

  it('offers the quarters the positions span and reads the board for the one picked', async () => {
    mockApi(routes());
    renderWithQuery(<MonitoringPage />);
    await screen.findByTestId('monitoring-tiles');
    const picker = screen.getByRole('combobox', { name: 'Quarter' });
    expect(picker).toHaveTextContent('Q2 2025 (Jun 30, 2025)');
    await userEvent.click(picker);
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'Q2 2025 (Jun 30, 2025)',
      'Q1 2025 (Mar 31, 2025)',
      'Q4 2024 (Dec 31, 2024)',
    ]);
    await userEvent.click(screen.getByRole('option', { name: 'Q1 2025 (Mar 31, 2025)' }));
    await waitFor(() => expect(boardRequests()).toContain(`${BOARD}?periodEnd=2025-03-31`));
    expect(await screen.findByText(/Quarter ended Mar 31, 2025/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Quarter' })).toHaveTextContent(
      'Q1 2025 (Mar 31, 2025)',
    );
  });

  it('judges the board on the as-of day typed, and falls back to the API when it is cleared', async () => {
    mockApi(routes());
    renderWithQuery(<MonitoringPage />);
    await screen.findByTestId('monitoring-tiles');
    expect(dateInput()).toHaveValue('2025-06-30');
    fireEvent.change(dateInput(), { target: { value: '2025-08-30' } });
    await waitFor(() => expect(boardRequests()).toContain(`${BOARD}?asOf=2025-08-30`));
    expect(await screen.findByText(/judged as of Aug 30, 2025/)).toBeInTheDocument();
    // A quarter picked while the as-of day stands sends both, sorted.
    await userEvent.click(screen.getByRole('combobox', { name: 'Quarter' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Q2 2025 (Jun 30, 2025)' }));
    await waitFor(() =>
      expect(boardRequests()).toContain(`${BOARD}?asOf=2025-08-30&periodEnd=2025-06-30`),
    );
    fireEvent.change(dateInput(), { target: { value: '' } });
    await waitFor(() => expect(boardRequests()).toContain(`${BOARD}?periodEnd=2025-06-30`));
    expect(dateInput()).toHaveValue('');
  });

  it('exports the board as a CSV file fetched with the credential and says how many rows it holds', async () => {
    mockApi(routes());
    mockExport(BOARD_CSV);
    const created: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn((blob: Blob) => {
        created.push(blob);
        return 'blob:monitoring';
      }),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, download: this.download });
    });
    renderWithQuery(<MonitoringPage />);
    await screen.findByTestId('monitoring-tiles');
    fireEvent.change(dateInput(), { target: { value: '2025-08-30' } });
    await screen.findByText(/judged as of Aug 30, 2025/);
    const button = screen.getByTestId('monitoring-export');
    expect(button).toHaveTextContent('Export CSV');
    await userEvent.click(button);
    expect(await screen.findByTestId('monitoring-action-status')).toHaveTextContent(
      'Exported 2 rows to monitoring-board-2025-06-30.csv',
    );
    const exportCall = vi
      .mocked(globalThis.fetch)
      .mock.calls.find(([input]) => urlOf(input).startsWith(EXPORT));
    expect(exportCall).toBeDefined();
    expect(exportCall === undefined ? '' : urlOf(exportCall[0])).toBe(`${EXPORT}?asOf=2025-08-30`);
    const headers = new Headers(exportCall?.[1]?.headers);
    expect(headers.get('accept')).toBe('text/csv');
    expect(headers.get('authorization')).toBe('Bearer deal.three');
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe('text/csv');
    expect(await blobText(created[0])).toBe(BOARD_CSV);
    expect(clicked).toEqual([
      { href: 'blob:monitoring', download: 'monitoring-board-2025-06-30.csv' },
    ]);
  });

  it('words a refused export in the status region and keeps the board', async () => {
    mockApi(routes(['viewer']));
    mockExport('', 403);
    renderWithQuery(<MonitoringPage />);
    await screen.findByTestId('monitoring-tiles');
    await userEvent.click(screen.getByTestId('monitoring-export'));
    expect(await screen.findByTestId('monitoring-action-status')).toHaveTextContent(
      'Export CSV: Your role cannot do this.',
    );
    expect(table()).toBeInTheDocument();
  });

  it('reads the same for every signed-in role: no write button, the export for all', async () => {
    mockApi(routes(['viewer']));
    renderWithQuery(<MonitoringPage />);
    await screen.findByTestId('monitoring-tiles');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Export CSV']);
    expect(screen.getByTestId('monitoring-export')).toBeEnabled();
  });

  it('says when no position is on the board, and that walled positions are absent for non-members', async () => {
    mockApi(routes(['operations'], { [BOARD]: ok(boardFixture([])) }));
    renderWithQuery(<MonitoringPage />);
    expect(await screen.findByTestId('monitoring-empty')).toHaveTextContent(
      'No positions on the board',
    );
    expect(screen.getByTestId('monitoring-empty')).toHaveTextContent(
      'Positions behind a wall appear only to wall members.',
    );
    expect(screen.queryByRole('table', { name: 'Monitoring board' })).not.toBeInTheDocument();
    expect(screen.getByText('0 positions')).toBeInTheDocument();
  });

  it('reads every page of every position, exited ones included, so the earliest quarter can be picked', async () => {
    // A full first page of positions entered in 2025; the position that opened the book, entered
    // in 2023 and since exited, sits on the second page. The board answers for it on the quarter
    // ends it was held on, so the picker must reach back to Q2 2023.
    const fullPage = Array.from({ length: 200 }, (_, i) =>
      investmentFixture({
        id: `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`,
        investmentNumber: `INV-${String(i + 1).padStart(4, '0')}`,
        entryDate: '2025-02-01',
      }),
    );
    const exited = investmentFixture({
      id: ID.inv2,
      investmentNumber: 'INV-0201',
      entryDate: '2023-05-10',
      exitDate: '2024-09-30',
      isActive: false,
    });
    mockApi(
      routes(['deal_team'], {
        [POSITIONS]: ok(investmentPageFixture(fullPage, 'page-2')),
        [`${POSITIONS}&cursor=page-2`]: ok(investmentPageFixture([exited])),
      }),
    );
    renderWithQuery(<MonitoringPage />);
    await screen.findByTestId('monitoring-tiles');
    await userEvent.click(screen.getByRole('combobox', { name: 'Quarter' }));
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Q2 2023 (Jun 30, 2023)' })).toBeInTheDocument(),
    );
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toHaveLength(9);
    expect(options[0]).toBe('Q2 2025 (Jun 30, 2025)');
    expect(options[8]).toBe('Q2 2023 (Jun 30, 2023)');
    expect(
      sentRequests()
        .map(([url]) => url)
        .filter((url) => url.startsWith('/api/v1/investments')),
    ).toEqual([POSITIONS, `${POSITIONS}&cursor=page-2`]);
  });

  it('keeps the picker usable before the positions have loaded, or when they cannot', async () => {
    mockApi(routes(['deal_team'], { [POSITIONS]: failing(403, '/api/v1/investments') }));
    renderWithQuery(<MonitoringPage />);
    await screen.findByTestId('monitoring-tiles');
    await userEvent.click(screen.getByRole('combobox', { name: 'Quarter' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Q2 2025 (Jun 30, 2025)']);
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });

  it('degrades a refused or failed board read without an export to offer', async () => {
    mockApi(routes(['viewer'], { [BOARD]: failing(403, BOARD) }));
    renderWithQuery(<MonitoringPage />);
    expect(await screen.findByTestId('monitoring-unavailable')).toHaveTextContent(
      'The monitoring board: not visible to your role',
    );
    expect(screen.getByTestId('monitoring-export')).toBeDisabled();
    expect(screen.queryByTestId('monitoring-tiles')).not.toBeInTheDocument();

    cleanup();
    vi.restoreAllMocks();
    mockApi(routes(['viewer'], { [BOARD]: failing(501, BOARD) }));
    renderWithQuery(<MonitoringPage />);
    expect(await screen.findByText('The monitoring board: not available yet')).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();

    cleanup();
    vi.restoreAllMocks();
    mockApi(
      routes(['viewer'], {
        [BOARD]: { status: 500, body: { title: 'Server error', status: 500 } },
      }),
    );
    renderWithQuery(<MonitoringPage />);
    // A server failure is retried once before it is shown (retryUnlessUnavailable), so this waits past the retry delay.
    expect(await screen.findByTestId('error-state', {}, { timeout: 4000 })).toHaveTextContent(
      'Monitoring board unavailable',
    );
  });

  it('never shows an em dash', async () => {
    mockApi(
      routes(['deal_team'], {
        [BOARD]: ok(
          boardFixture([
            boardRowFixture({ documentStatus: 'missing', ageDays: 76, runState: 'Failed' }),
          ]),
        ),
      }),
    );
    const { container } = renderWithQuery(<MonitoringPage />);
    await screen.findByTestId('monitoring-tiles');
    expect(within(table()).getByText('Missing')).toHaveClass('pb-badge-bad');
    expect(within(table()).getByText('Failed')).toHaveClass('pb-badge-bad');
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});
