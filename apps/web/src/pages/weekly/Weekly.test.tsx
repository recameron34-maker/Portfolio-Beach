import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import {
  WEEKLY_FILE_ID,
  weeklyDropListFixture,
  weeklyFileFixture,
  weeklyFilePageFixture,
  weeklyImportResultFixture,
} from '../../test/fixtures-weekly.js';
import { rolePrincipal, sentPosts, sentRequests } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { navigate } from '../../test/router-mock.js';
import { WeeklyPage } from './Weekly.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const ME = '/api/v1/auth/me';
const FILES = '/api/v1/intake/files?limit=200&source=weekly';
const DROPS = '/api/v1/intake/weekly/drops';
const IMPORT = '/api/v1/intake/weekly';
const CSV =
  'InvestmentNumber,CompanyName,ReportDate,ReportedValue\nINV-0001,Meridian Data Partners,2025-06-27,27400000.00\n';
/** Dialog and dropdown journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

function routes(
  roles: Parameters<typeof rolePrincipal>[0] = ['operations'],
  overrides: MockRoutes = {},
): MockRoutes {
  return {
    [ME]: ok(rolePrincipal(roles)),
    [FILES]: ok(weeklyFilePageFixture()),
    [DROPS]: ok(weeklyDropListFixture()),
    ...overrides,
  };
}

const fileInput = (): HTMLInputElement =>
  screen.getByLabelText<HTMLInputElement>('Weekly values (CSV)');

describe('weekly values list', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    navigate.mockReset();
  });

  it('lists every weekly file with its status, newest first, under the Data group', async () => {
    mockApi(routes());
    renderWithQuery(<WeeklyPage />);
    const table = await screen.findByRole('table', { name: 'Weekly files' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Weekly values');
    expect(
      screen.getByText(
        'Weekly report values to valuation staging: prior, variance, threshold flag, then a Draft valuation (SEC-9.1)',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('weekly-files')).toBe(table);
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(screen.getByText('3 files')).toBeInTheDocument();

    const update = within(table).getByRole('link', {
      name: 'weekly-values-2025-06-27-update.csv',
    });
    expect(update).toHaveAttribute('href', `/data/weekly/${WEEKLY_FILE_ID.update}`);
    const updateRow = update.closest('tr')!;
    expect(within(updateRow).getByText('Jul 1, 2025')).toBeInTheDocument();
    expect(within(updateRow).getByText('Avery Castellanos')).toBeInTheDocument();
    expect(within(updateRow).getByText('7')).toBeInTheDocument();
    expect(within(updateRow).getByText('Flagged')).toHaveClass('pb-badge-watch');

    const clean = within(table).getByText('weekly-values-2025-06-20-clean.csv').closest('tr')!;
    expect(within(clean).getByText('Promoted')).toHaveClass('pb-badge-good');
    const refused = within(table).getByText('weekly-values-bad-header.csv').closest('tr')!;
    expect(within(refused).getByText('New')).toHaveClass('pb-badge-neutral');
    expect(within(refused).getByText('-')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more files' })).not.toBeInTheDocument();
  });

  it('offers the upload card and the drop folder to operations only', async () => {
    mockApi(routes(['operations']));
    renderWithQuery(<WeeklyPage />);
    const card = await screen.findByTestId('weekly-upload');
    expect(fileInput()).toHaveAttribute('accept', '.csv,text/csv');
    expect(screen.getByRole('button', { name: 'Stage weekly values' })).toBeDisabled();
    const drop = await within(card).findByRole('list', { name: 'Files in the weekly drop folder' });
    expect(screen.getByTestId('weekly-drops')).toBe(drop);
    expect(drop).toHaveTextContent('weekly-values-2025-06-27-update.csv');
    expect(drop).toHaveTextContent('Received Jun 30, 2025');
    await screen.findByRole('table', { name: 'Weekly files' });
    const urls = sentRequests().map(([url]) => url);
    expect([...new Set(urls)].sort()).toEqual([ME, FILES, DROPS].sort());

    cleanup();
    vi.restoreAllMocks();
    mockApi(routes(['deal_team']));
    renderWithQuery(<WeeklyPage />);
    await screen.findByRole('table', { name: 'Weekly files' });
    expect(screen.queryByTestId('weekly-upload')).not.toBeInTheDocument();
    expect(sentRequests().map(([url]) => url)).not.toContain(DROPS);
  });

  it('stages a chosen file as text and opens the staged file', async () => {
    const result = weeklyImportResultFixture();
    mockApi(routes(['operations'], { [IMPORT]: { status: 201, body: result } }));
    renderWithQuery(<WeeklyPage />);
    await screen.findByTestId('weekly-upload');
    await userEvent.upload(fileInput(), new File([CSV], 'weekly.csv', { type: 'text/csv' }));
    const stage = screen.getByRole('button', { name: 'Stage weekly values' });
    await waitFor(() => expect(stage).toBeEnabled());
    await userEvent.click(stage);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(sentPosts()).toEqual([[IMPORT, { fileName: 'weekly.csv', csv: CSV }]]);
    expect(navigate).toHaveBeenCalledWith({
      to: '/data/weekly/$id',
      params: { id: WEEKLY_FILE_ID.update },
      search: {},
    });
  });

  it('stages a file from the drop folder by its id and says when it was staged before', async () => {
    mockApi(
      routes(['operations'], { [IMPORT]: { status: 201, body: weeklyImportResultFixture(true) } }),
    );
    renderWithQuery(<WeeklyPage />);
    const card = await screen.findByTestId('weekly-upload');
    await userEvent.click(
      await within(card).findByRole('button', {
        name: 'Stage, weekly-values-2025-06-27-update.csv',
      }),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(sentPosts()).toEqual([[IMPORT, { dropId: 'weekly-values-2025-06-27-update.csv' }]]);
    expect(navigate).toHaveBeenCalledWith({
      to: '/data/weekly/$id',
      params: { id: WEEKLY_FILE_ID.update },
      search: { duplicate: true },
    });
  });

  it('refuses an empty file in plain words before anything is sent', async () => {
    mockApi(routes(['operations']));
    renderWithQuery(<WeeklyPage />);
    await screen.findByTestId('weekly-upload');
    await userEvent.upload(fileInput(), new File([], 'empty.csv', { type: 'text/csv' }));
    expect(await screen.findByText('The file is empty.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stage weekly values' })).toBeDisabled();
    expect(sentPosts()).toEqual([]);
  });

  it('words a refused import in the upload card instead of leaving the page', async () => {
    mockApi(routes(['operations'], { [IMPORT]: failing(403, IMPORT) }));
    renderWithQuery(<WeeklyPage />);
    await screen.findByTestId('weekly-upload');
    await userEvent.upload(fileInput(), new File([CSV], 'weekly.csv', { type: 'text/csv' }));
    const stage = screen.getByRole('button', { name: 'Stage weekly values' });
    await waitFor(() => expect(stage).toBeEnabled());
    await userEvent.click(stage);
    expect(
      await screen.findByText(/Stage weekly.csv: Your role cannot do this/),
    ).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it(
    'filters by status through the API and reads the next page on its cursor',
    TIMEOUT,
    async () => {
      const flaggedOnly = `${FILES}&status=flagged`;
      const nextPage = `${FILES}&cursor=next-page`;
      const older = weeklyFileFixture({
        id: '00000000-0000-4000-8000-000000000704',
        fileName: 'weekly-values-2025-06-13-clean.csv',
        receivedAt: '2025-06-16T09:00:00.000Z',
        status: 'promoted',
      });
      mockApi(
        routes(['auditor'], {
          [FILES]: ok(weeklyFilePageFixture(undefined, 'next-page')),
          [nextPage]: ok(weeklyFilePageFixture([older])),
          [flaggedOnly]: ok(weeklyFilePageFixture([weeklyFileFixture()])),
        }),
      );
      renderWithQuery(<WeeklyPage />);
      await screen.findByRole('table', { name: 'Weekly files' });
      const rows = (): HTMLElement[] =>
        within(screen.getByRole('table', { name: 'Weekly files' }))
          .getAllByRole('row')
          .slice(1);
      expect(rows()).toHaveLength(3);
      await userEvent.click(screen.getByRole('button', { name: 'Load more files' }));
      await waitFor(() => expect(rows()).toHaveLength(4));
      expect(screen.getByText('weekly-values-2025-06-13-clean.csv')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Load more files' })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('combobox', { name: 'Status' }));
      await userEvent.click(await screen.findByRole('option', { name: 'Flagged' }));
      await waitFor(() => expect(rows()).toHaveLength(1));
      expect(sentRequests().map(([url]) => url)).toContain(flaggedOnly);
    },
  );

  it('tells a viewer who weekly values are for, and says when nothing is staged yet', async () => {
    mockApi(routes(['viewer'], { [FILES]: failing(403, '/api/v1/intake/files') }));
    renderWithQuery(<WeeklyPage />);
    expect(
      await screen.findByText('Weekly values are for operations and reviewers'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('weekly-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('weekly-upload')).not.toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();

    cleanup();
    vi.restoreAllMocks();
    mockApi(routes(['approver'], { [FILES]: ok(weeklyFilePageFixture([])) }));
    renderWithQuery(<WeeklyPage />);
    expect(await screen.findByText('No weekly files yet')).toBeInTheDocument();
    expect(screen.getByText(/Operations stages the weekly report values/)).toBeInTheDocument();
  });

  it('never shows an em dash', async () => {
    mockApi(routes());
    const { container } = renderWithQuery(<WeeklyPage />);
    await screen.findByRole('table', { name: 'Weekly files' });
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});
