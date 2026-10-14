import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import {
  FILE_ID,
  intakeExportListFixture,
  intakeFilePageFixture,
  intakeFiles,
  intakeImportResultFixture,
  opsDropDropListFixture,
  opsDropFileFixture,
  opsDropRefusedFileFixture,
} from '../../test/fixtures-intake.js';
import { rolePrincipal, sentPosts, sentRequests } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { navigate } from '../../test/router-mock.js';
import { IntakePage } from './Intake.js';
import { MAX_WORKBOOK_BYTES } from './intake.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const ME = '/api/v1/auth/me';
const FILES = '/api/v1/intake/files?limit=200';
const EXPORTS = '/api/v1/intake/accounting/exports';
const IMPORT = '/api/v1/intake/accounting';
const DROPS = '/api/v1/intake/ops-drop/drops';
const OPS_DROP = '/api/v1/intake/ops-drop';
const CSV = 'InvestmentNumber,CompanyName,PeriodEnd\nINV-0001,Meridian Data Partners,2025-06-30\n';
/** The first bytes of any .xlsx (a zip archive) followed by filler: enough to prove bytes travel as base64. */
const XLSX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);

function routes(
  roles: Parameters<typeof rolePrincipal>[0] = ['operations'],
  overrides: MockRoutes = {},
): MockRoutes {
  return {
    [ME]: ok(rolePrincipal(roles)),
    [FILES]: ok(intakeFilePageFixture()),
    [EXPORTS]: ok(intakeExportListFixture()),
    [DROPS]: ok(opsDropDropListFixture()),
    ...overrides,
  };
}

const fileInput = (): HTMLInputElement =>
  screen.getByLabelText<HTMLInputElement>('Accounting export (CSV)');
const workbookInput = (): HTMLInputElement =>
  screen.getByLabelText<HTMLInputElement>('Operations workbook (XLSX)');

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
    expect(within(updateRow).getByText('2 validated, 3 flagged, 1 promoted')).toBeInTheDocument();
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
    // The workbook upload sits in the same card with the ops drop folder beside it.
    expect(workbookInput()).toHaveAttribute(
      'accept',
      '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(screen.getByRole('button', { name: 'Stage workbook' })).toBeDisabled();
    const workbooks = await within(card).findByRole('list', {
      name: 'Workbooks in the ops drop folder',
    });
    expect(workbooks).toHaveTextContent('ops-drop-2025-06-30-update.xlsx');
    const urls = sentRequests().map(([url]) => url);
    expect([...new Set(urls)].sort()).toEqual([ME, FILES, EXPORTS, DROPS].sort());

    cleanup();
    vi.restoreAllMocks();
    mockApi(routes(['deal_team']));
    renderWithQuery(<IntakePage />);
    await screen.findByRole('table', { name: 'Intake files' });
    expect(screen.queryByTestId('intake-upload')).not.toBeInTheDocument();
    expect(sentRequests().map(([url]) => url)).not.toContain(EXPORTS);
    expect(sentRequests().map(([url]) => url)).not.toContain(DROPS);
  });

  it('shows where each file came from, with the template a workbook matched', async () => {
    mockApi(
      routes(['auditor'], {
        [FILES]: ok(
          intakeFilePageFixture([
            opsDropRefusedFileFixture(),
            opsDropFileFixture(),
            ...intakeFiles(),
          ]),
        ),
      }),
    );
    renderWithQuery(<IntakePage />);
    const table = await screen.findByRole('table', { name: 'Intake files' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'File',
      'Source',
      'Received',
      'Received by',
      'Rows',
      'Status',
      'Counts',
      'Exceptions',
    ]);
    const matched = within(table).getByText('ops-drop-2025-06-30-clean.xlsx').closest('tr')!;
    expect(within(matched).getByText('Ops drop')).toBeInTheDocument();
    expect(within(matched).getByText('Template: quarterly-figures')).toHaveClass('pb-cell-sub');
    expect(within(matched).getByText('Validated')).toBeInTheDocument();
    const refused = within(table)
      .getByText('ops-drop-2025-06-30-unknown-template.xlsx')
      .closest('tr')!;
    expect(within(refused).getByText('Ops drop')).toBeInTheDocument();
    expect(within(refused).getByText('Template: none matched')).toBeInTheDocument();
    expect(within(refused).getByText('New')).toBeInTheDocument();
    const accounting = within(table)
      .getByText('accounting-export-2025-06-30-update.csv')
      .closest('tr')!;
    expect(within(accounting).getByText('Accounting')).toBeInTheDocument();
    expect(within(accounting).queryByText(/Template:/)).not.toBeInTheDocument();
  });

  it('reads a chosen workbook as bytes, posts it as base64 and opens the staged file', async () => {
    mockApi(
      routes(['operations'], {
        [OPS_DROP]: ok(intakeImportResultFixture(false, { ...opsDropFileFixture() })),
      }),
    );
    renderWithQuery(<IntakePage />);
    await screen.findByTestId('intake-upload');
    await userEvent.upload(
      workbookInput(),
      new File([XLSX_BYTES], 'ops-drop-2025-06-30-clean.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    );
    const stage = screen.getByRole('button', { name: 'Stage workbook' });
    await waitFor(() => expect(stage).toBeEnabled());
    await userEvent.click(stage);
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(sentPosts()).toEqual([
      [
        OPS_DROP,
        {
          fileName: 'ops-drop-2025-06-30-clean.xlsx',
          workbookBase64: Buffer.from(XLSX_BYTES).toString('base64'),
        },
      ],
    ]);
    expect(navigate).toHaveBeenCalledWith({
      to: '/data/intake/$id',
      params: { id: FILE_ID.opsDrop },
      search: {},
    });
  });

  it('stages a workbook from the ops drop folder by id', async () => {
    mockApi(
      routes(['operations'], {
        [OPS_DROP]: ok(intakeImportResultFixture(true, { ...opsDropFileFixture() })),
      }),
    );
    renderWithQuery(<IntakePage />);
    await screen.findByTestId('intake-upload');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Stage, ops-drop-2025-06-30-update.xlsx' }),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(sentPosts()).toEqual([[OPS_DROP, { dropId: 'ops-drop-2025-06-30-update.xlsx' }]]);
    expect(navigate).toHaveBeenCalledWith({
      to: '/data/intake/$id',
      params: { id: FILE_ID.opsDrop },
      search: { duplicate: true },
    });
  });

  it('refuses a workbook over the configured limit, or empty, before sending anything', async () => {
    mockApi(routes(['operations'], { [OPS_DROP]: ok(intakeImportResultFixture()) }));
    renderWithQuery(<IntakePage />);
    await screen.findByTestId('intake-upload');
    const big = new File([new Uint8Array(MAX_WORKBOOK_BYTES + 1)], 'big.xlsx');
    await userEvent.upload(workbookInput(), big);
    expect(await screen.findByTestId('intake-workbook-status')).toHaveTextContent(
      'This file is 3.0 MB; the limit is 3 MB.',
    );
    expect(screen.getByRole('button', { name: 'Stage workbook' })).toBeDisabled();
    await userEvent.upload(workbookInput(), new File([], 'empty.xlsx'));
    expect(await screen.findByTestId('intake-workbook-status')).toHaveTextContent(
      'The file is empty.',
    );
    expect(screen.getByRole('button', { name: 'Stage workbook' })).toBeDisabled();
    // The export's own status stays clear: each upload reports in its own region.
    expect(screen.getByTestId('intake-upload-status')).toBeEmptyDOMElement();
    expect(sentPosts()).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('words a refused workbook in its own status region instead of leaving the page', async () => {
    mockApi(routes(['operations'], { [OPS_DROP]: failing(403, OPS_DROP) }));
    renderWithQuery(<IntakePage />);
    await screen.findByTestId('intake-upload');
    await userEvent.upload(workbookInput(), new File([XLSX_BYTES], 'book.xlsx'));
    const stage = screen.getByRole('button', { name: 'Stage workbook' });
    await waitFor(() => expect(stage).toBeEnabled());
    await userEvent.click(stage);
    expect(
      await screen.findByText(/Stage book.xlsx: Your role cannot do this/),
    ).toBeInTheDocument();
    expect(screen.getByTestId('intake-workbook-status')).toHaveTextContent('Stage book.xlsx');
    expect(navigate).not.toHaveBeenCalled();
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

  it('refuses an empty file in plain words before the button is enabled', async () => {
    mockApi(routes(['operations'], { [IMPORT]: ok(intakeImportResultFixture()) }));
    renderWithQuery(<IntakePage />);
    await screen.findByTestId('intake-upload');
    await userEvent.upload(fileInput(), new File([], 'export.csv', { type: 'text/csv' }));
    expect(await screen.findByTestId('intake-upload-status')).toHaveTextContent(
      'The file is empty.',
    );
    const stage = screen.getByRole('button', { name: 'Stage export' });
    expect(stage).toBeDisabled();
    await userEvent.click(stage);
    expect(sentPosts()).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();

    // A good file chosen next clears the message and enables the button.
    await userEvent.upload(fileInput(), new File([CSV], 'export.csv', { type: 'text/csv' }));
    await waitFor(() => expect(stage).toBeEnabled());
    expect(screen.getByTestId('intake-upload-status')).toBeEmptyDOMElement();
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
