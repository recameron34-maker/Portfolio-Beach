import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import {
  FILE_ID,
  intakeExportListFixture,
  intakeFilePageFixture,
  intakeImportResultFixture,
} from '../../test/fixtures-intake.js';
import { rolePrincipal, sentPosts, sentRequests } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { navigate } from '../../test/router-mock.js';
import { IntakePage } from './Intake.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const ME = '/api/v1/auth/me';
const FILES = '/api/v1/intake/files?limit=200';
const EXPORTS = '/api/v1/intake/accounting/exports';
const IMPORT = '/api/v1/intake/accounting';
const CSV = 'InvestmentNumber,CompanyName,PeriodEnd\nINV-0001,Meridian Data Partners,2025-06-30\n';

function routes(
  roles: Parameters<typeof rolePrincipal>[0] = ['operations'],
  overrides: MockRoutes = {},
): MockRoutes {
  return {
    [ME]: ok(rolePrincipal(roles)),
    [FILES]: ok(intakeFilePageFixture()),
    [EXPORTS]: ok(intakeExportListFixture()),
    ...overrides,
  };
}

const fileInput = (): HTMLInputElement =>
  screen.getByLabelText<HTMLInputElement>('Accounting export (CSV)');

describe('intake list', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    navigate.mockReset();
  });

  it('lists every file with its status, counts and exceptions, newest first', async () => {
    mockApi(routes());
    renderWithQuery(<IntakePage />);
    const table = await screen.findByRole('table', { name: 'Intake files' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Intake');
    expect(
      screen.getByText('Staging, validation, approval, then production (SEC-9.1)'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('intake-files')).toBe(table);
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);

    const update = within(table).getByRole('link', {
      name: 'accounting-export-2025-06-30-update.csv',
    });
    expect(update).toHaveAttribute('href', `/data/intake/${FILE_ID.update}`);
    const updateRow = update.closest('tr')!;
    expect(within(updateRow).getByText('Jul 1, 2025')).toBeInTheDocument();
    expect(within(updateRow).getByText('Avery Castellanos')).toBeInTheDocument();
    expect(within(updateRow).getByText('7')).toBeInTheDocument();
    expect(within(updateRow).getByText('Flagged')).toHaveClass('pb-badge-watch');
    expect(within(updateRow).getByText('3 validated, 2 flagged, 1 promoted')).toBeInTheDocument();
    expect(within(updateRow).getByText('3')).toBeInTheDocument();

    const clean = within(table).getByText('accounting-export-2025-06-30-clean.csv').closest('tr')!;
    expect(within(clean).getByText('Promoted')).toHaveClass('pb-badge-good');
    expect(within(clean).getByText('0 validated, 0 flagged, 9 promoted')).toBeInTheDocument();

    const refused = within(table).getByText('accounting-export-bad-header.csv').closest('tr')!;
    expect(within(refused).getByText('New')).toHaveClass('pb-badge-neutral');
    expect(within(refused).getAllByText('-')).toHaveLength(2);
    expect(screen.queryByTestId('intake-files-truncated')).not.toBeInTheDocument();
  });

  it('offers the upload card and the drop folder to operations only', async () => {
    mockApi(routes(['operations']));
    renderWithQuery(<IntakePage />);
    const card = await screen.findByTestId('intake-upload');
    expect(fileInput()).toHaveAttribute('accept', '.csv,text/csv');
    expect(screen.getByRole('button', { name: 'Stage export' })).toBeDisabled();
    const drop = await within(card).findByRole('list', { name: 'Exports in the drop folder' });
    expect(drop).toHaveTextContent('accounting-export-2025-06-30-update.csv');
    expect(screen.queryByTestId('intake-sample-clean')).not.toBeInTheDocument();
    const urls = sentRequests().map(([url]) => url);
    expect([...new Set(urls)].sort()).toEqual([ME, FILES, EXPORTS].sort());

    cleanup();
    vi.restoreAllMocks();
    mockApi(routes(['deal_team']));
    renderWithQuery(<IntakePage />);
    await screen.findByRole('table', { name: 'Intake files' });
    expect(screen.queryByTestId('intake-upload')).not.toBeInTheDocument();
    expect(sentRequests().map(([url]) => url)).not.toContain(EXPORTS);
  });

  it('stages an export from the drop folder by id', async () => {
    mockApi(routes(['operations'], { [IMPORT]: ok(intakeImportResultFixture()) }));
    renderWithQuery(<IntakePage />);
    await screen.findByTestId('intake-upload');
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Stage, accounting-export-2025-06-30-update.csv',
      }),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(sentPosts()).toEqual([
      [IMPORT, { exportId: 'accounting-export-2025-06-30-update.csv' }],
    ]);
    expect(navigate).toHaveBeenCalledWith({
      to: '/data/intake/$id',
      params: { id: FILE_ID.update },
      search: {},
    });
  });

  it('reads a chosen CSV in the browser, posts it as text and opens the staged file', async () => {
    mockApi(routes(['operations'], { [IMPORT]: ok(intakeImportResultFixture(true)) }));
    renderWithQuery(<IntakePage />);
    await screen.findByTestId('intake-upload');
    await userEvent.upload(fileInput(), new File([CSV], 'export.csv', { type: 'text/csv' }));
    const stage = screen.getByRole('button', { name: 'Stage export' });
    await waitFor(() => expect(stage).toBeEnabled());
    await userEvent.click(stage);
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(sentPosts()).toEqual([[IMPORT, { fileName: 'export.csv', csv: CSV }]]);
    // A duplicate import opens the file staged before and says so through the search.
    expect(navigate).toHaveBeenCalledWith({
      to: '/data/intake/$id',
      params: { id: FILE_ID.update },
      search: { duplicate: true },
    });
  });

  it('refuses a file over the configured limit before sending anything', async () => {
    mockApi(routes(['operations'], { [IMPORT]: ok(intakeImportResultFixture()) }));
    renderWithQuery(<IntakePage />);
    await screen.findByTestId('intake-upload');
    const big = new File([new Uint8Array(2_000_001)], 'big.csv', { type: 'text/csv' });
    await userEvent.upload(fileInput(), big);
    expect(await screen.findByTestId('intake-upload-status')).toHaveTextContent(
      'This file is 2.0 MB; the limit is 2 MB.',
    );
    expect(screen.getByRole('button', { name: 'Stage export' })).toBeDisabled();
    expect(sentPosts()).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('words a refused import in the upload card instead of leaving the page', async () => {
    mockApi(routes(['operations'], { [IMPORT]: failing(403, IMPORT) }));
    renderWithQuery(<IntakePage />);
    await screen.findByTestId('intake-upload');
    await userEvent.upload(fileInput(), new File([CSV], 'export.csv', { type: 'text/csv' }));
    const stage = screen.getByRole('button', { name: 'Stage export' });
    await waitFor(() => expect(stage).toBeEnabled());
    await userEvent.click(stage);
    expect(
      await screen.findByText(/Stage export.csv: Your role cannot do this/),
    ).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('tells a viewer who intake is for, and degrades while the endpoint answers 501', async () => {
    mockApi(routes(['viewer'], { [FILES]: failing(403, '/api/v1/intake/files') }));
    renderWithQuery(<IntakePage />);
    expect(await screen.findByText('Intake is for operations and reviewers')).toBeInTheDocument();
    expect(screen.getByTestId('intake-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('intake-upload')).not.toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();

    cleanup();
    vi.restoreAllMocks();
    mockApi(routes(['operations'], { [FILES]: failing(501, '/api/v1/intake/files') }));
    renderWithQuery(<IntakePage />);
    expect(await screen.findByText('Intake: not available yet')).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });

  it('says when nothing is staged yet, and when only the first page is shown', async () => {
    mockApi(routes(['approver'], { [FILES]: ok(intakeFilePageFixture([])) }));
    renderWithQuery(<IntakePage />);
    expect(await screen.findByText('No intake files yet')).toBeInTheDocument();
    expect(screen.getByText(/Operations stages accounting exports/)).toBeInTheDocument();

    cleanup();
    vi.restoreAllMocks();
    mockApi(routes(['approver'], { [FILES]: ok(intakeFilePageFixture(undefined, 'next')) }));
    renderWithQuery(<IntakePage />);
    expect(await screen.findByTestId('intake-files-truncated')).toHaveTextContent(
      'Showing the first 200 files; more exist.',
    );
  });

  it('never shows an em dash', async () => {
    mockApi(routes());
    const { container } = renderWithQuery(<IntakePage />);
    await screen.findByRole('table', { name: 'Intake files' });
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});
