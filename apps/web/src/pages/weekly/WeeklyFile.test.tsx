import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WeeklyFileDetail } from '@pb/contracts';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import {
  approvedWeeklyDetailFixture,
  rejectedWeeklyDetailFixture,
  WEEKLY_FILE_ID,
  weeklyFileDetailFixture,
  weeklyFiles,
} from '../../test/fixtures-weekly.js';
import { POSITION_ID, rolePrincipal, sentPosts } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { WeeklyFilePage } from './WeeklyFile.js';

const route = vi.hoisted(() => ({ id: '', duplicate: undefined as boolean | undefined }));

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: route.id }),
  useSearch: () => ({ duplicate: route.duplicate }),
}));

const ME = '/api/v1/auth/me';
const detailPath = (id: string): string => `/api/v1/intake/weekly/files/${id}`;
const commandsPath = (id: string): string => `${detailPath(id)}/commands`;
/** Dialog journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

function routes(
  roles: Parameters<typeof rolePrincipal>[0] = ['operations'],
  overrides: MockRoutes = {},
): MockRoutes {
  route.id = WEEKLY_FILE_ID.update;
  route.duplicate = undefined;
  return {
    [ME]: ok(rolePrincipal(roles)),
    [detailPath(WEEKLY_FILE_ID.update)]: ok(weeklyFileDetailFixture()),
    ...overrides,
  };
}

const tile = (name: string): HTMLElement =>
  within(screen.getByTestId('weekly-tiles')).getByRole('group', { name });

const rowOf = (text: string): HTMLElement => {
  const table = screen.getByRole('table', { name: 'Staged weekly values' });
  const row = within(table).getByText(text).closest('tr');
  if (row === null) throw new Error(`no row holds ${text}`);
  return row;
};

/** The detail as the API serves it after a command: the answer to the POST, and to the refetch that follows it. */
function afterCommand(after: WeeklyFileDetail): MockRoutes {
  return {
    [detailPath(WEEKLY_FILE_ID.update)]: () =>
      ok(sentPosts().length > 0 ? after : weeklyFileDetailFixture()),
    [commandsPath(WEEKLY_FILE_ID.update)]: ok(after),
  };
}

/** Fluent lifts the modal's aria-hidden a moment after the dialog unmounts; then the status region is reachable again. */
async function dialogClosed(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await screen.findByRole('status');
}

describe('weekly values file', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the file, its tiles and every value with its prior, variance, flag, findings and status', async () => {
    mockApi(routes());
    renderWithQuery(<WeeklyFilePage />);
    const banner = await screen.findByTestId('weekly-banner');
    expect(within(banner).getByRole('heading', { level: 1 })).toHaveTextContent(
      'weekly-values-2025-06-27-update.csv',
    );
    expect(banner).toHaveTextContent('Received Jul 1, 2025');
    expect(banner).toHaveTextContent('By Avery Castellanos');
    expect(banner).toHaveTextContent('7 rows');
    expect(within(banner).getByText('Flagged')).toHaveClass('pb-badge-watch');
    expect(screen.getByRole('link', { name: 'All weekly files' })).toHaveAttribute(
      'href',
      '/data/weekly',
    );
    expect(screen.queryByTestId('weekly-duplicate')).not.toBeInTheDocument();
    expect(screen.queryByTestId('intake-file-findings')).not.toBeInTheDocument();

    expect(within(tile('Rows')).getByText('7')).toBeInTheDocument();
    expect(within(tile('Validated')).getByText('2')).toBeInTheDocument();
    expect(within(tile('Flagged')).getByText('3')).toBeInTheDocument();
    expect(tile('Flagged')).toHaveAttribute('data-tone', 'watch');
    expect(within(tile('Promoted')).getByText('1')).toBeInTheDocument();
    expect(tile('Promoted')).toHaveAttribute('data-tone', 'good');
    expect(tile('Promoted')).toHaveTextContent('Draft valuations created, audited');
    expect(within(tile('Rejected')).getByText('1')).toBeInTheDocument();
    expect(within(tile('Exceptions')).getByText('1')).toBeInTheDocument();
    expect(tile('Exceptions')).toHaveAttribute('data-tone', 'watch');

    const table = screen.getByRole('table', { name: 'Staged weekly values' });
    expect(screen.getByTestId('weekly-rows')).toBe(table);
    expect(within(table).getAllByRole('row')).toHaveLength(8);
    expect(screen.getByText('7 of 7 rows')).toBeInTheDocument();

    // A value equal to its prior: the position links to the deal workspace, the prior is the
    // Locked mark with its date, the variance reads 0.0% and nothing is flagged.
    const unchanged = rowOf('Meridian Data Partners');
    expect(within(unchanged).getByRole('link', { name: 'Meridian Data Partners' })).toHaveAttribute(
      'href',
      `/portfolio/${POSITION_ID.meridian}`,
    );
    expect(within(unchanged).getByText('INV-0001')).toHaveClass('pb-key');
    expect(within(unchanged).getByText('Jun 27, 2025')).toBeInTheDocument();
    expect(within(unchanged).getAllByText('$27,400,000.00')).toHaveLength(2);
    expect(within(unchanged).getByText('Locked mark, Mar 31, 2025')).toBeInTheDocument();
    expect(within(unchanged).getByText('0.0%')).toBeInTheDocument();
    expect(within(unchanged).queryByText('Above threshold')).not.toBeInTheDocument();
    expect(within(unchanged).getByText('None')).toBeInTheDocument();
    expect(within(unchanged).getByText('Validated')).toHaveClass('pb-badge-neutral');
    expect(within(unchanged).getByText('-')).toBeInTheDocument();

    // A move inside the threshold: signed, to one decimal, and still validated.
    const moved = rowOf('Silverline Staffing Holdings');
    expect(within(moved).getByText('$21,630,000.00')).toBeInTheDocument();
    expect(within(moved).getByText('$21,000,000.00')).toBeInTheDocument();
    expect(within(moved).getByText('+3.0%')).toBeInTheDocument();
    expect(within(moved).getByText('Validated')).toBeInTheDocument();

    // A move at or beyond the threshold: the badge the API set, the rule behind it, flagged.
    const beyond = rowOf('Cobalt Energy Group');
    expect(within(beyond).getByText('+50.0%')).toBeInTheDocument();
    const badge = within(beyond).getByText('Above threshold');
    expect(badge.closest('.pb-badge')).toHaveClass('pb-badge-bad');
    expect(badge).toHaveAttribute('title', 'At or beyond the 10% threshold');
    expect(within(beyond).getByText('WK-BOUND-01', { selector: '.pb-badge' })).toHaveClass(
      'pb-badge-bad',
    );
    expect(within(beyond).getByText('1 finding')).toBeInTheDocument();
    expect(within(beyond).getByText('Flagged')).toHaveClass('pb-badge-watch');

    // An unmatched name: no link, no prior, the candidates for a person, the placeholder for the variance.
    const unmatched = rowOf('Meridian Data Partner');
    expect(within(unmatched).queryByRole('link')).not.toBeInTheDocument();
    expect(within(unmatched).getByText('no match')).toHaveClass('pb-badge-plain');
    expect(within(unmatched).getByText('No prior on record')).toBeInTheDocument();
    expect(
      within(unmatched).getByText('Candidates: INV-0001 Meridian Data Partners (near miss)'),
    ).toBeInTheDocument();
    expect(within(unmatched).getByText('WK-XREF-01', { selector: '.pb-badge' })).toHaveClass(
      'pb-badge-bad',
    );
    expect(within(unmatched).getAllByText('-').length).toBeGreaterThanOrEqual(2);

    // A promoted row: compared with the weekly value before it, with its Draft valuation.
    const promoted = rowOf('Ashby Renewables Group');
    expect(within(promoted).getByText('Weekly value, Jun 20, 2025')).toBeInTheDocument();
    expect(within(promoted).getByText('-1.0%')).toBeInTheDocument();
    expect(within(promoted).getByText('Promoted')).toHaveClass('pb-badge-good');
    expect(within(promoted).getByText('Approved')).toBeInTheDocument();
    expect(within(promoted).getByText('By Avery Castellanos')).toBeInTheDocument();
    expect(within(promoted).getByText('Decided Jul 1, 2025')).toBeInTheDocument();
    expect(within(promoted).getByRole('link', { name: 'Draft valuation' })).toHaveAttribute(
      'href',
      '/valuations',
    );

    // A rejected row: the value as the file wrote it, the reason.
    const rejected = rowOf('Summit Care Holdings');
    expect(within(rejected).getByText('45.1m')).toBeInTheDocument();
    expect(within(rejected).getByText('Rejected')).toHaveClass('pb-badge-bad');
    expect(
      within(rejected).getByText('Value sent back to the sponsor as a number'),
    ).toBeInTheDocument();

    // A report date that is not a day is shown as written, never guessed.
    const badDate = rowOf('Juniper Financial Group');
    expect(within(badDate).getByText('27/06/2025')).toBeInTheDocument();
    expect(within(badDate).getByText('WK-TYPE-01', { selector: '.pb-badge' })).toBeInTheDocument();

    // One Draft valuation from this file so far: the board link says so.
    expect(screen.getByTestId('weekly-board-link')).toHaveTextContent(
      '1 Draft valuation from this file is on the valuations board',
    );
    expect(screen.queryByTestId('weekly-hidden-rows')).not.toBeInTheDocument();
  });

  it('says when the import that led here staged nothing new, and shows a refused file with no rows', async () => {
    mockApi(routes());
    route.duplicate = true;
    renderWithQuery(<WeeklyFilePage />);
    expect(await screen.findByTestId('weekly-duplicate')).toHaveTextContent(
      'This file was staged before. Its rows are shown as they stand; nothing new was staged.',
    );

    cleanup();
    vi.restoreAllMocks();
    const refused = weeklyFiles()[2]!;
    mockApi(
      routes(['operations'], {
        [detailPath(WEEKLY_FILE_ID.update)]: ok(
          weeklyFileDetailFixture({ ...refused, rows: [], hiddenRows: 0 }),
        ),
      }),
    );
    renderWithQuery(<WeeklyFilePage />);
    const findings = await screen.findByTestId('intake-file-findings');
    expect(findings).toHaveTextContent('LAYOUT-02');
    expect(findings).toHaveTextContent('The file lacks the column ReportDate');
    expect(screen.getByTestId('weekly-no-rows')).toHaveTextContent('No rows were staged');
    expect(screen.queryByTestId('weekly-board-link')).not.toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Approve validated rows' });
    expect(approve).toHaveAttribute('aria-disabled', 'true');
  });

  it('counts rows linked to positions the reviewer cannot see, without naming them', async () => {
    const detail = weeklyFileDetailFixture({ hiddenRows: 1 });
    mockApi(
      routes(['deal_team'], {
        [detailPath(WEEKLY_FILE_ID.update)]: ok({
          ...detail,
          counts: { ...detail.counts, validated: detail.counts.validated + 1 },
        }),
      }),
    );
    renderWithQuery(<WeeklyFilePage />);
    await screen.findByRole('table', { name: 'Staged weekly values' });
    expect(within(tile('Validated')).getByText('3')).toBeInTheDocument();
    expect(screen.getByTestId('weekly-hidden-rows')).toHaveTextContent(
      '1 row is linked to positions you cannot see',
    );
    expect(screen.getByText('7 of 7 rows')).toBeInTheDocument();
  });

  it('approves every validated row, reports the promotion and the Draft valuations created', async () => {
    mockApi(routes(['operations'], afterCommand(approvedWeeklyDetailFixture())));
    renderWithQuery(<WeeklyFilePage />);
    await screen.findByRole('table', { name: 'Staged weekly values' });
    const approve = screen.getByRole('button', { name: 'Approve validated rows' });
    expect(approve).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject flagged rows' })).toBeEnabled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    await userEvent.click(approve);
    expect(
      await screen.findByText('2 rows promoted (audited); 2 Draft valuations created'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('weekly-action-status')).toHaveClass('pb-action-status');
    expect(sentPosts()).toEqual([[commandsPath(WEEKLY_FILE_ID.update), { command: 'approve' }]]);
    const promoted = rowOf('Meridian Data Partners');
    expect(within(promoted).getByText('Promoted')).toHaveClass('pb-badge-good');
    expect(within(promoted).getByRole('link', { name: 'Draft valuation' })).toHaveAttribute(
      'href',
      '/valuations',
    );
    expect(within(tile('Promoted')).getByText('3')).toBeInTheDocument();
    expect(within(tile('Validated')).getByText('0')).toBeInTheDocument();
    expect(screen.getByTestId('weekly-board-link')).toHaveTextContent(
      '3 Draft valuations from this file are on the valuations board',
    );
    // Nothing is left to approve: the button says so and keeps the focus of whoever pressed it.
    const again = screen.getByRole('button', { name: 'Approve validated rows' });
    expect(again).toBe(approve);
    expect(again).toHaveAttribute('aria-disabled', 'true');
    expect(again).toHaveAttribute('title', 'No validated rows you can see to approve');
    expect(again).toHaveFocus();
  });

  it('rejects flagged rows only with a reason', TIMEOUT, async () => {
    const reason = 'Values sent back to the sponsor';
    mockApi(routes(['operations'], afterCommand(rejectedWeeklyDetailFixture(reason))));
    renderWithQuery(<WeeklyFilePage />);
    await screen.findByRole('table', { name: 'Staged weekly values' });
    const reject = screen.getByRole('button', { name: 'Reject flagged rows' });
    await userEvent.click(reject);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('3 flagged rows in weekly-values-2025-06-27-update.csv');
    const submit = within(dialog).getByRole('button', { name: 'Reject flagged rows' });
    expect(submit).toBeDisabled();
    expect(sentPosts()).toEqual([]);
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Reason' }), reason);
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await dialogClosed();
    expect(await screen.findByText('3 rows rejected (audited)')).toBeInTheDocument();
    expect(sentPosts()).toEqual([
      [commandsPath(WEEKLY_FILE_ID.update), { command: 'reject', reason }],
    ]);
    expect(within(rowOf('Cobalt Energy Group')).getByText('Rejected')).toHaveClass('pb-badge-bad');
    expect(within(rowOf('Cobalt Energy Group')).getByText(reason)).toBeInTheDocument();
    expect(within(tile('Rejected')).getByText('4')).toBeInTheDocument();
    expect(reject).toHaveAttribute('aria-disabled', 'true');
    await waitFor(() => expect(reject).toHaveFocus());
  });

  it('words a refused command in the status region and keeps the rows as they were', async () => {
    mockApi(
      routes(['operations'], {
        [commandsPath(WEEKLY_FILE_ID.update)]: failing(403, commandsPath(WEEKLY_FILE_ID.update)),
      }),
    );
    renderWithQuery(<WeeklyFilePage />);
    await screen.findByRole('table', { name: 'Staged weekly values' });
    await userEvent.click(screen.getByRole('button', { name: 'Approve validated rows' }));
    expect(
      await screen.findByText(
        'Approve validated rows: Your role cannot do this. Your role may not read this',
      ),
    ).toBeInTheDocument();
    expect(within(rowOf('Meridian Data Partners')).getByText('Validated')).toBeInTheDocument();
    expect(within(tile('Promoted')).getByText('1')).toBeInTheDocument();
  });

  it('offers approve to the deal team but not reject, and nothing to auditors', async () => {
    mockApi(routes(['deal_team']));
    renderWithQuery(<WeeklyFilePage />);
    await screen.findByRole('table', { name: 'Staged weekly values' });
    expect(screen.getByRole('button', { name: 'Approve validated rows' })).toBeEnabled();
    const reject = screen.getByRole('button', { name: 'Reject flagged rows' });
    expect(reject).toHaveAttribute('aria-disabled', 'true');
    expect(reject).toHaveAttribute('title', 'Needs operations');

    cleanup();
    vi.restoreAllMocks();
    mockApi(routes(['auditor']));
    renderWithQuery(<WeeklyFilePage />);
    await screen.findByRole('table', { name: 'Staged weekly values' });
    expect(
      screen.queryByRole('button', { name: 'Approve validated rows' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject flagged rows' })).not.toBeInTheDocument();
  });

  it('filters by state and search in the browser', TIMEOUT, async () => {
    mockApi(routes());
    renderWithQuery(<WeeklyFilePage />);
    await screen.findByRole('table', { name: 'Staged weekly values' });
    const rows = (): HTMLElement[] =>
      within(screen.getByRole('table', { name: 'Staged weekly values' }))
        .getAllByRole('row')
        .slice(1);
    await userEvent.click(screen.getByRole('combobox', { name: 'State' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Flagged' }));
    expect(rows()).toHaveLength(3);
    expect(screen.getByText('3 of 7 rows')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: 'State' }));
    await userEvent.click(await screen.findByRole('option', { name: 'All states' }));
    await userEvent.click(screen.getByRole('textbox', { name: 'Search' }));
    await userEvent.paste('inv-0004');
    expect(rows()).toHaveLength(1);
    expect(rowOf('Silverline Staffing Holdings')).toBeInTheDocument();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Search' }));
    await userEvent.paste('nothing here');
    expect(screen.getByText('No rows match these filters')).toBeInTheDocument();
  });

  it('tells the reader when the file is not theirs to see, or the route is not for them', async () => {
    mockApi(
      routes(['operations'], {
        [detailPath(WEEKLY_FILE_ID.update)]: failing(404, detailPath(WEEKLY_FILE_ID.update)),
      }),
    );
    renderWithQuery(<WeeklyFilePage />);
    expect(
      await screen.findByText('Weekly file not found or not visible to you'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All weekly files' })).toBeInTheDocument();

    cleanup();
    vi.restoreAllMocks();
    mockApi(
      routes(['viewer'], {
        [detailPath(WEEKLY_FILE_ID.update)]: failing(403, detailPath(WEEKLY_FILE_ID.update)),
      }),
    );
    renderWithQuery(<WeeklyFilePage />);
    expect(
      await screen.findByText('Weekly values are for operations and reviewers'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('weekly-file-unavailable')).toBeInTheDocument();
  });

  it('never shows an em dash', async () => {
    mockApi(routes());
    const { container } = renderWithQuery(<WeeklyFilePage />);
    await screen.findByRole('table', { name: 'Staged weekly values' });
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});
