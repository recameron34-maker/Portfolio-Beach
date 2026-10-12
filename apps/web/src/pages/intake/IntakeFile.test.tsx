import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IntakeFileDetail } from '@pb/contracts';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import {
  approvedDetailFixture,
  FILE_ID,
  fileFindingsFixture,
  intakeFileDetailFixture,
  rejectedDetailFixture,
} from '../../test/fixtures-intake.js';
import { POSITION_ID, rolePrincipal, sentPosts } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { IntakeFilePage } from './IntakeFile.js';

const route = vi.hoisted(() => ({ id: '', duplicate: undefined as boolean | undefined }));

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: route.id }),
  useSearch: () => ({ duplicate: route.duplicate }),
}));

const ME = '/api/v1/auth/me';
const detailPath = (id: string): string => `/api/v1/intake/files/${id}`;
const commandsPath = (id: string): string => `${detailPath(id)}/commands`;
/** Dialog journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

function routes(
  roles: Parameters<typeof rolePrincipal>[0] = ['operations'],
  overrides: MockRoutes = {},
): MockRoutes {
  route.id = FILE_ID.update;
  route.duplicate = undefined;
  return {
    [ME]: ok(rolePrincipal(roles)),
    [detailPath(FILE_ID.update)]: ok(intakeFileDetailFixture()),
    ...overrides,
  };
}

const tile = (name: string): HTMLElement =>
  within(screen.getByTestId('intake-tiles')).getByRole('group', { name });

const rowOf = (text: string): HTMLElement => {
  const table = screen.getByRole('table', { name: 'Staged rows' });
  const row = within(table).getByText(text).closest('tr');
  if (row === null) throw new Error(`no row holds ${text}`);
  return row;
};

async function pick(combobox: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole('combobox', { name: combobox }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

/** The detail as the API serves it after a command: the answer to the POST, and to the refetch that follows it. */
function afterCommand(after: IntakeFileDetail): MockRoutes {
  return {
    [detailPath(FILE_ID.update)]: () =>
      ok(sentPosts().length > 0 ? after : intakeFileDetailFixture()),
    [commandsPath(FILE_ID.update)]: ok(after),
  };
}

/** Fluent lifts the modal's aria-hidden a moment after the dialog unmounts; then the status region is reachable again. */
async function dialogClosed(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await screen.findByRole('status');
}

describe('intake file', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the file, its tiles and every row with its link, diff, findings and status', async () => {
    mockApi(routes());
    renderWithQuery(<IntakeFilePage />);
    const banner = await screen.findByTestId('intake-banner');
    expect(within(banner).getByRole('heading', { level: 1 })).toHaveTextContent(
      'accounting-export-2025-06-30-update.csv',
    );
    expect(banner).toHaveTextContent('Received Jul 1, 2025');
    expect(banner).toHaveTextContent('By Avery Castellanos');
    expect(banner).toHaveTextContent('7 rows');
    expect(within(banner).getByText('Flagged')).toHaveClass('pb-badge-watch');
    expect(screen.getByRole('link', { name: 'All intake files' })).toHaveAttribute(
      'href',
      '/data/intake',
    );
    expect(screen.queryByTestId('intake-duplicate')).not.toBeInTheDocument();
    expect(screen.queryByTestId('intake-file-findings')).not.toBeInTheDocument();

    expect(within(tile('Rows')).getByText('7')).toBeInTheDocument();
    expect(within(tile('Validated')).getByText('3')).toBeInTheDocument();
    expect(within(tile('Flagged')).getByText('2')).toBeInTheDocument();
    expect(tile('Flagged')).toHaveAttribute('data-tone', 'watch');
    expect(within(tile('Promoted')).getByText('1')).toBeInTheDocument();
    expect(tile('Promoted')).toHaveAttribute('data-tone', 'good');
    expect(within(tile('Rejected')).getByText('1')).toBeInTheDocument();
    expect(within(tile('Exceptions')).getByText('3')).toBeInTheDocument();
    expect(tile('Exceptions')).toHaveAttribute('data-tone', 'watch');

    const table = screen.getByRole('table', { name: 'Staged rows' });
    expect(screen.getByTestId('intake-rows')).toBe(table);
    expect(within(table).getAllByRole('row')).toHaveLength(8);
    expect(screen.getByText('7 of 7 rows')).toBeInTheDocument();

    const unchanged = rowOf('Meridian Data Partners');
    expect(within(unchanged).getByRole('link', { name: 'Meridian Data Partners' })).toHaveAttribute(
      'href',
      `/portfolio/${POSITION_ID.meridian}`,
    );
    expect(within(unchanged).getByText('INV-0001')).toHaveClass('pb-key');
    expect(within(unchanged).getByText('Jun 30, 2025')).toBeInTheDocument();
    expect(within(unchanged).getByText('Unchanged')).toHaveClass('pb-badge-neutral');
    expect(within(unchanged).getByText('None')).toBeInTheDocument();
    expect(within(unchanged).getByText('Validated')).toHaveClass('pb-badge-neutral');
    expect(within(unchanged).getByText('-')).toBeInTheDocument();

    const changed = rowOf('Silverline Staffing Holdings');
    expect(within(changed).getByText('Changed')).toHaveClass('pb-badge-watch');
    expect(within(changed).getByText('Revenue $20.1M to $20.5M')).toBeInTheDocument();
    expect(within(changed).getByText('EBITDA $4.1M to $4.0M')).toBeInTheDocument();

    const added = rowOf('Cobalt Energy Group');
    expect(within(added).getByText('New')).toHaveClass('pb-badge-brand');
    expect(within(added).getByText('Jun 16, 2024')).toBeInTheDocument();
    const warning = within(added).getByText('PERIOD-02', { selector: '.pb-badge' });
    expect(warning).toHaveClass('pb-badge-watch');
    expect(warning.closest('[title]')).toHaveAttribute('title', 'Period end is not a quarter end');
    expect(within(added).getByText('1 finding')).toBeInTheDocument();
    expect(
      within(added).getByText(
        'PERIOD-02: Period end is not a quarter end (Expected 2024-06-30, actual 2024-06-16)',
      ),
    ).toBeInTheDocument();

    const unmatched = rowOf('Meridian Data Partner');
    expect(within(unmatched).queryByRole('link')).not.toBeInTheDocument();
    expect(within(unmatched).getByText('no match')).toHaveClass('pb-badge-plain');
    expect(
      within(unmatched).getByText('Candidates: INV-0001 Meridian Data Partners (near miss)'),
    ).toBeInTheDocument();
    expect(within(unmatched).getByText('XREF-01', { selector: '.pb-badge' })).toHaveClass(
      'pb-badge-bad',
    );
    expect(within(unmatched).getByText('Flagged')).toHaveClass('pb-badge-watch');

    const guarded = rowOf('Summit Services Company');
    expect(within(guarded).getByText('match guard')).toBeInTheDocument();
    expect(
      within(guarded).getByText('Candidates: INV-0013 Summit Services Co (match guard)'),
    ).toBeInTheDocument();

    const promoted = rowOf('Ashby Renewables Group');
    expect(within(promoted).getByText('Promoted')).toHaveClass('pb-badge-good');
    expect(within(promoted).getByText('EV $95.0M to $97.5M')).toBeInTheDocument();
    expect(within(promoted).getByText('Approved')).toBeInTheDocument();
    expect(within(promoted).getByText('By Avery Castellanos')).toBeInTheDocument();
    expect(within(promoted).getByText('Promoted Jul 1, 2025')).toBeInTheDocument();

    const rejected = rowOf('Summit Care Holdings');
    expect(within(rejected).getByText('Rejected')).toHaveClass('pb-badge-bad');
    expect(
      within(rejected).getByText('Fair value restated by the sponsor; waiting for a new mark'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('intake-hidden-rows')).not.toBeInTheDocument();
  });

  it('filters by state and search in the browser', TIMEOUT, async () => {
    mockApi(routes());
    renderWithQuery(<IntakeFilePage />);
    await screen.findByRole('table', { name: 'Staged rows' });
    const rows = (): HTMLElement[] =>
      within(screen.getByRole('table', { name: 'Staged rows' }))
        .getAllByRole('row')
        .slice(1);

    await pick('State', 'Flagged');
    expect(rows()).toHaveLength(2);
    expect(screen.getByText('2 of 7 rows')).toBeInTheDocument();
    await pick('State', 'Promoted');
    expect(rows()).toHaveLength(1);
    await pick('State', 'All states');
    expect(rows()).toHaveLength(7);

    await userEvent.click(screen.getByRole('textbox', { name: 'Search' }));
    await userEvent.paste('inv-0004');
    expect(rows()).toHaveLength(1);
    expect(rowOf('Silverline Staffing Holdings')).toBeInTheDocument();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Search' }));
    await userEvent.paste('nothing here');
    expect(screen.getByText('No rows match these filters')).toBeInTheDocument();
  });

  it('approves every validated row, reports the promotion and shows the rows promoted', async () => {
    mockApi(routes(['operations'], afterCommand(approvedDetailFixture())));
    renderWithQuery(<IntakeFilePage />);
    await screen.findByRole('table', { name: 'Staged rows' });
    const approve = screen.getByRole('button', { name: 'Approve validated rows' });
    expect(approve).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject flagged rows' })).toBeEnabled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    await userEvent.click(approve);
    expect(await screen.findByText('3 rows promoted (audited)')).toBeInTheDocument();
    expect(screen.getByTestId('intake-action-status')).toHaveClass('pb-action-status');
    expect(sentPosts()).toEqual([[commandsPath(FILE_ID.update), { command: 'approve' }]]);
    expect(within(rowOf('Meridian Data Partners')).getByText('Promoted')).toHaveClass(
      'pb-badge-good',
    );
    expect(within(tile('Promoted')).getByText('4')).toBeInTheDocument();
    expect(within(tile('Validated')).getByText('0')).toBeInTheDocument();
    const again = screen.getByRole('button', { name: 'Approve validated rows' });
    expect(again).toBeDisabled();
    expect(again).toHaveAttribute('title', 'No validated rows you can see to approve');
  });

  it('rejects flagged rows only with a reason', TIMEOUT, async () => {
    const reason = 'Names must be fixed in the accounting system first';
    mockApi(routes(['operations'], afterCommand(rejectedDetailFixture(reason))));
    renderWithQuery(<IntakeFilePage />);
    await screen.findByRole('table', { name: 'Staged rows' });
    await userEvent.click(screen.getByRole('button', { name: 'Reject flagged rows' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('2 flagged rows in accounting-export-2025-06-30-update.csv');
    const submit = within(dialog).getByRole('button', { name: 'Reject flagged rows' });
    expect(submit).toBeDisabled();
    expect(sentPosts()).toEqual([]);
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Reason' }), reason);
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await dialogClosed();
    expect(await screen.findByText('2 rows rejected (audited)')).toBeInTheDocument();
    expect(sentPosts()).toEqual([[commandsPath(FILE_ID.update), { command: 'reject', reason }]]);
    expect(within(rowOf('Meridian Data Partner')).getByText('Rejected')).toHaveClass(
      'pb-badge-bad',
    );
    expect(within(rowOf('Meridian Data Partner')).getByText(reason)).toBeInTheDocument();
    expect(within(tile('Rejected')).getByText('3')).toBeInTheDocument();
  });

  it('words a refused command in the status region and keeps the rows as they were', async () => {
    mockApi(
      routes(['operations'], {
        [commandsPath(FILE_ID.update)]: failing(403, commandsPath(FILE_ID.update)),
      }),
    );
    renderWithQuery(<IntakeFilePage />);
    await screen.findByRole('table', { name: 'Staged rows' });
    await userEvent.click(screen.getByRole('button', { name: 'Approve validated rows' }));
    expect(
      await screen.findByText(
        'Approve validated rows: Your role cannot do this. Your role may not read this',
      ),
    ).toBeInTheDocument();
    expect(within(rowOf('Meridian Data Partners')).getByText('Validated')).toBeInTheDocument();
    expect(within(tile('Promoted')).getByText('1')).toBeInTheDocument();
  });

  it('offers approve to the deal team but not reject, and nothing to reviewers', async () => {
    mockApi(routes(['deal_team']));
    renderWithQuery(<IntakeFilePage />);
    await screen.findByRole('table', { name: 'Staged rows' });
    expect(screen.getByRole('button', { name: 'Approve validated rows' })).toBeEnabled();
    const reject = screen.getByRole('button', { name: 'Reject flagged rows' });
    expect(reject).toBeDisabled();
    expect(reject).toHaveAttribute('title', 'Needs operations');

    for (const role of ['approver', 'auditor'] as const) {
      cleanup();
      vi.restoreAllMocks();
      mockApi(routes([role]));
      renderWithQuery(<IntakeFilePage />);
      await screen.findByRole('table', { name: 'Staged rows' });
      expect(screen.queryByRole('button', { name: 'Approve validated rows' }), role).toBeNull();
      expect(screen.queryByRole('button', { name: 'Reject flagged rows' }), role).toBeNull();
    }
  });

  it('says how many rows sit behind a wall, and notes a duplicate import', async () => {
    mockApi(
      routes(['deal_team'], {
        [detailPath(FILE_ID.update)]: ok(intakeFileDetailFixture({ hiddenRows: 2 })),
      }),
    );
    route.duplicate = true;
    renderWithQuery(<IntakeFilePage />);
    expect(await screen.findByTestId('intake-hidden-rows')).toHaveTextContent(
      '2 rows are linked to positions you cannot see',
    );
    expect(screen.getByTestId('intake-duplicate')).toHaveTextContent(
      'This export was staged before. Its rows are shown as they stand; nothing new was staged.',
    );
  });

  it('shows the file findings of a refused file and says no rows were staged', async () => {
    route.id = FILE_ID.refused;
    mockApi({
      [ME]: ok(rolePrincipal(['operations'])),
      [detailPath(FILE_ID.refused)]: ok(
        intakeFileDetailFixture({
          id: FILE_ID.refused,
          fileName: 'accounting-export-bad-header.csv',
          rowCount: 0,
          status: 'new',
          counts: { new: 0, validated: 0, flagged: 0, approved: 0, rejected: 0, promoted: 0 },
          fileFindings: fileFindingsFixture(),
          exceptions: 0,
          rows: [],
        }),
      ),
    });
    renderWithQuery(<IntakeFilePage />);
    const findings = await screen.findByRole('list', { name: 'File findings' });
    expect(within(findings).getByText('LAYOUT-01')).toHaveClass('pb-badge-bad');
    expect(findings).toHaveTextContent('The header is missing a required column');
    expect(findings).toHaveTextContent('Expected PeriodEnd');
    expect(screen.getByText('No rows were staged')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Staged rows' })).not.toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Approve validated rows' });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('title', 'No validated rows you can see to approve');
  });

  it('says not found on a 404, who intake is for on a 403, and degrades on a 501', async () => {
    const cases: [403 | 404 | 501, string][] = [
      [404, 'Intake file not found or not visible to you'],
      [403, 'Intake is for operations and reviewers'],
      [501, 'This intake file: not available yet'],
    ];
    for (const [status, text] of cases) {
      cleanup();
      vi.restoreAllMocks();
      mockApi(
        routes(['viewer'], {
          [detailPath(FILE_ID.update)]: failing(status, detailPath(FILE_ID.update)),
        }),
      );
      renderWithQuery(<IntakeFilePage />);
      expect(await screen.findByText(text), String(status)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'All intake files' })).toBeInTheDocument();
    }
  });

  it('never shows an em dash', async () => {
    mockApi(routes());
    const { container } = renderWithQuery(<IntakeFilePage />);
    await screen.findByRole('table', { name: 'Staged rows' });
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});
