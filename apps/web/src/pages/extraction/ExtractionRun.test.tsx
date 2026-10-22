import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExtractionRunDetail } from '@pb/contracts';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import { ID } from '../../test/fixtures.js';
import { rolePrincipal, sentPosts } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { navigate } from '../../test/router-mock.js';
import { ExtractionRunPage } from './ExtractionRun.js';
import {
  acceptedCleanDetailFixture,
  approvedDetailFixture,
  detailFixture,
  editedDetailFixture,
  failedDetailFixture,
  readyDetailFixture,
  rejectedDetailFixture,
  RUN_ID,
  runFixture,
} from './test-fixtures.js';

const route = vi.hoisted(() => ({ id: '' }));

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: route.id }),
}));

const ME = '/api/v1/auth/me';
const detailPath = (id: string): string => `/api/v1/extraction/runs/${id}`;
const commandsPath = (id: string): string => `${detailPath(id)}/commands`;
/** Dialog journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

function routes(
  roles: Parameters<typeof rolePrincipal>[0] = ['deal_team'],
  overrides: MockRoutes = {},
  id: string = RUN_ID.succeeded,
): MockRoutes {
  route.id = id;
  return {
    [ME]: ok(rolePrincipal(roles)),
    [detailPath(id)]: ok(detailFixture()),
    ...overrides,
  };
}

/** The detail as the API serves it after a command: the answer to the POST, and to the refetch that follows it. */
function afterCommand(after: ExtractionRunDetail, id: string = RUN_ID.succeeded): MockRoutes {
  return {
    [detailPath(id)]: () => ok(sentPosts().length > 0 ? after : detailFixture()),
    [commandsPath(id)]: ok(after),
  };
}

const refusal = (code: string, detail: string) => ({
  status: 409,
  body: {
    type: `https://portfolio-beach.example/problems/${code}`,
    title: 'Conflict',
    status: 409,
    detail,
    instance: commandsPath(RUN_ID.succeeded),
    request_id: 'test',
  },
});

const tile = (name: string): HTMLElement =>
  within(screen.getByTestId('run-tiles')).getByRole('group', { name });

const fields = (): HTMLElement => screen.getByRole('table', { name: 'Extracted values' });

const rowOf = (label: string): HTMLElement => {
  const row = within(fields()).getByText(label, { selector: 'td > span' }).closest('tr');
  if (row === null) throw new Error(`no row holds ${label}`);
  return row;
};

const drawing = (): HTMLElement => screen.getByTestId('run-page-drawing');

async function pick(combobox: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole('combobox', { name: combobox }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

/** Fluent lifts the modal's aria-hidden a moment after the dialog unmounts; then the status region is reachable again. */
async function dialogClosed(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await screen.findByRole('status');
}

describe('extraction run review', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    navigate.mockReset();
  });

  it('shows the banner, the tiles and every value, flagged and invalid first, with its citation, validation and decision', async () => {
    mockApi(routes());
    renderWithQuery(<ExtractionRunPage />);
    const banner = await screen.findByTestId('run-banner');
    expect(within(banner).getByRole('heading', { level: 1 })).toHaveTextContent(
      'Quarterly Report: Meridian Data Partners, quarter ended 30 June 2025',
    );
    expect(within(banner).getByRole('link', { name: 'Meridian Data Partners' })).toHaveAttribute(
      'href',
      `/portfolio/${ID.inv1}`,
    );
    expect(banner).toHaveTextContent('INV-0001');
    expect(banner).toHaveTextContent('Period Jun 30, 2025');
    expect(banner).toHaveTextContent('Model mock, prompt quarterly_extraction v1');
    expect(banner).toHaveTextContent('Tokens 2048 in, 64 out');
    expect(banner).toHaveTextContent('Cost $0.0071');
    expect(within(banner).getByText('Succeeded')).toHaveClass('pb-badge-good');
    expect(within(banner).getByText('Awaiting approval')).toHaveClass('pb-badge-watch');
    expect(screen.getByRole('link', { name: 'All extraction runs' })).toHaveAttribute(
      'href',
      '/documents/extraction',
    );

    expect(within(tile('Values')).getByText('15')).toBeInTheDocument();
    expect(within(tile('Clean')).getByText('12')).toBeInTheDocument();
    expect(within(tile('Flagged')).getByText('2')).toBeInTheDocument();
    expect(tile('Flagged')).toHaveAttribute('data-tone', 'watch');
    expect(within(tile('Invalid')).getByText('1')).toBeInTheDocument();
    expect(tile('Invalid')).toHaveAttribute('data-tone', 'bad');
    expect(within(tile('Decided')).getByText('0')).toBeInTheDocument();

    expect(screen.getByTestId('run-fields')).toBe(fields());
    expect(screen.getByText('15 values, flagged and invalid first')).toBeInTheDocument();
    const rows = within(fields()).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(15);
    expect(rows[0]).toHaveTextContent('Net debt');
    expect(rows[1]).toHaveTextContent('Cash');
    expect(rows[2]).toHaveTextContent('Headcount');
    expect(rows[3]).toHaveTextContent('Period end');

    const revenue = rowOf('Revenue LTM');
    expect(revenue).toHaveTextContent('required');
    expect(within(revenue).getByText('$125.40M')).toBeInTheDocument();
    expect(
      within(revenue).getByRole('button', { name: 'Show Revenue LTM on page 2' }),
    ).toHaveTextContent('Page 2');
    expect(within(revenue).getByText('LTM revenue 125.40')).toHaveClass('pb-extraction-quote');
    expect(within(revenue).getByText('100%')).toBeInTheDocument();
    expect(within(revenue).getByText('Clean')).toHaveClass('pb-badge-good');
    expect(within(revenue).getByText('-')).toBeInTheDocument();

    const cash = rowOf('Cash');
    expect(within(cash).getByText('Invalid')).toHaveClass('pb-badge-bad');
    expect(within(cash).getByText('EXT-CITE-02', { selector: '.pb-badge' })).toHaveClass(
      'pb-badge-bad',
    );
    expect(within(cash).getByText('1 finding')).toBeInTheDocument();
    expect(
      within(cash).getByText('EXT-CITE-02: Cash: the quote was not found on page 2'),
    ).toBeInTheDocument();
    const acceptCash = within(cash).getByRole('button', { name: 'Accept, Cash' });
    expect(acceptCash).toHaveAttribute('aria-disabled', 'true');
    expect(acceptCash).toHaveAttribute('title', expect.stringContaining('cannot be accepted'));
    expect(within(cash).getByRole('button', { name: 'Edit, Cash' })).not.toHaveAttribute(
      'aria-disabled',
    );

    const headcount = rowOf('Headcount');
    expect(within(headcount).getByText('62%')).toBeInTheDocument();
    expect(within(headcount).getByText('Flagged')).toHaveClass('pb-badge-watch');
    expect(within(headcount).getByText('EXT-CONF-01', { selector: '.pb-badge' })).toHaveClass(
      'pb-badge-watch',
    );
    expect(within(rowOf('Sponsor ownership')).getByText('62.50%')).toBeInTheDocument();
    expect(within(rowOf('Period end')).getByText('Jun 30, 2025')).toBeInTheDocument();

    // The narrative is an AI draft until approved, with its own accept and reject.
    const narrative = screen.getByTestId('run-narrative');
    expect(within(narrative).getByText('AI draft')).toBeInTheDocument();
    expect(
      within(narrative).getByRole('list', { name: 'Drafted highlights' }).children,
    ).toHaveLength(3);
    expect(narrative).toHaveTextContent('A steady quarter');
    expect(
      within(narrative).getByRole('button', { name: 'Accept, Highlights' }),
    ).toBeInTheDocument();
    expect(
      within(narrative).getByRole('button', { name: 'Reject, Commentary' }),
    ).toBeInTheDocument();

    // Approval waits for the flagged and invalid values.
    const approve = screen.getByRole('button', { name: 'Approve and promote' });
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    expect(approve).toHaveAttribute('title', 'Period end is required and not accepted or edited');
    expect(screen.getByRole('button', { name: 'Accept clean values' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('tells a viewer who reviews and offers no actions', async () => {
    mockApi(routes(['viewer']));
    renderWithQuery(<ExtractionRunPage />);
    expect(await screen.findByTestId('run-read-only')).toHaveTextContent(
      'Deal team and operations review runs; your role reads them.',
    );
    expect(screen.queryByRole('button', { name: 'Accept clean values' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Accept, / })).not.toBeInTheDocument();
    expect(within(fields()).getAllByRole('columnheader')).toHaveLength(7);
  });

  it('accepts one value and reports it', async () => {
    const after = detailFixture({
      values: detailFixture().values.map((v) =>
        v.field === 'revenue_ltm'
          ? {
              ...v,
              decision: 'accepted',
              decidedBy: 'Blake Mbeki',
              decidedAt: '2025-06-30T12:00:00.000Z',
            }
          : v,
      ),
    });
    mockApi(routes(['operations'], afterCommand(after)));
    renderWithQuery(<ExtractionRunPage />);
    await screen.findByTestId('run-fields');
    const accept = within(rowOf('Revenue LTM')).getByRole('button', {
      name: 'Accept, Revenue LTM',
    });
    await userEvent.click(accept);
    expect(await screen.findByText('Revenue LTM accepted (audited)')).toBeInTheDocument();
    expect(screen.getByTestId('run-action-status')).toHaveClass('pb-action-status');
    expect(sentPosts()).toEqual([
      [commandsPath(RUN_ID.succeeded), { command: 'accept', field: 'revenue_ltm' }],
    ]);
    expect(within(rowOf('Revenue LTM')).getByText('Accepted')).toHaveClass('pb-badge-good');
    expect(within(rowOf('Revenue LTM')).getByText('By Blake Mbeki')).toBeInTheDocument();
    expect(within(tile('Decided')).getByText('1')).toBeInTheDocument();
  });

  it('accepts every clean value in one go, the drafted narrative included', async () => {
    mockApi(routes(['deal_team'], afterCommand(acceptedCleanDetailFixture())));
    renderWithQuery(<ExtractionRunPage />);
    await screen.findByTestId('run-fields');
    await userEvent.click(screen.getByRole('button', { name: 'Accept clean values' }));
    expect(await screen.findByText('12 clean values accepted (audited)')).toBeInTheDocument();
    expect(sentPosts()).toEqual([[commandsPath(RUN_ID.succeeded), { command: 'acceptClean' }]]);
    expect(within(tile('Decided')).getByText('12')).toBeInTheDocument();
    expect(within(rowOf('Net debt')).getByText('-')).toBeInTheDocument();
    // The flagged values still wait, so the approval still does.
    expect(screen.getByRole('button', { name: 'Approve and promote' })).toHaveAttribute(
      'title',
      'Net debt is flagged and undecided',
    );
  });

  it(
    'edits a flagged count through the dialog with a reason, keeping the model answer on view',
    TIMEOUT,
    async () => {
      mockApi(routes(['deal_team'], afterCommand(editedDetailFixture())));
      renderWithQuery(<ExtractionRunPage />);
      await screen.findByTestId('run-fields');
      await userEvent.click(
        within(rowOf('Headcount')).getByRole('button', { name: 'Edit, Headcount' }),
      );
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('heading')).toHaveTextContent('Edit Headcount');
      expect(dialog).toHaveTextContent('The model answered 120 on page 3');
      expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
      const value = within(dialog).getByRole('textbox', { name: 'Value' });
      expect(value).toHaveValue('120');
      await userEvent.clear(value);
      await userEvent.type(value, '12.5');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
      expect(within(dialog).getByText('The value does not fit the unit')).toBeInTheDocument();
      expect(
        within(dialog).getByText('Give a reason of at least 3 characters'),
      ).toBeInTheDocument();
      expect(sentPosts()).toEqual([]);
      await userEvent.clear(value);
      await userEvent.type(value, '118');
      await userEvent.type(
        within(dialog).getByRole('textbox', { name: 'Reason' }),
        'Footnote says 118',
      );
      await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
      await dialogClosed();
      expect(await screen.findByText('Headcount edited (audited)')).toBeInTheDocument();
      expect(sentPosts()).toEqual([
        [
          commandsPath(RUN_ID.succeeded),
          {
            command: 'edit',
            field: 'headcount',
            value: '118',
            unit: 'COUNT',
            reason: 'Footnote says 118',
          },
        ],
      ]);
      const row = rowOf('Headcount');
      expect(within(row).getByText('118')).toBeInTheDocument();
      expect(within(row).getByText('was 120')).toHaveClass('pb-extraction-was');
      expect(within(row).getByText('Edited')).toHaveClass('pb-badge-brand');
      // Focus returns to the button that opened the dialog.
      expect(within(row).getByRole('button', { name: 'Edit, Headcount' })).toHaveFocus();
    },
  );

  it('edits a money value with its unit', TIMEOUT, async () => {
    mockApi(routes(['operations'], afterCommand(detailFixture())));
    renderWithQuery(<ExtractionRunPage />);
    await screen.findByTestId('run-fields');
    await userEvent.click(
      within(rowOf('Net debt')).getByRole('button', { name: 'Edit, Net debt' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: 'Unit' })).toHaveTextContent('$M');
    await pick('Unit', '$K');
    const value = within(dialog).getByRole('textbox', { name: 'Value' });
    await userEvent.clear(value);
    await userEvent.type(value, '95500');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Reason' }),
      'Stated in thousands',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
    await dialogClosed();
    expect(await screen.findByText('Net debt edited (audited)')).toBeInTheDocument();
    expect(sentPosts()).toEqual([
      [
        commandsPath(RUN_ID.succeeded),
        {
          command: 'edit',
          field: 'net_debt',
          value: '95500',
          unit: 'USD_K',
          reason: 'Stated in thousands',
        },
      ],
    ]);
  });

  it('rejects an invalid value with a reason', TIMEOUT, async () => {
    mockApi(routes(['deal_team'], afterCommand(rejectedDetailFixture())));
    renderWithQuery(<ExtractionRunPage />);
    await screen.findByTestId('run-fields');
    await userEvent.click(within(rowOf('Cash')).getByRole('button', { name: 'Reject, Cash' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Cash of 2025-06-30 Kelpwood Fund IV');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Not on the page',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await dialogClosed();
    expect(await screen.findByText('Cash rejected (audited)')).toBeInTheDocument();
    expect(sentPosts()).toEqual([
      [
        commandsPath(RUN_ID.succeeded),
        { command: 'reject', field: 'cash', reason: 'Not on the page' },
      ],
    ]);
    expect(within(rowOf('Cash')).getByText('Rejected')).toHaveClass('pb-badge-bad');
  });

  it('approves once every value is decided and reports the promotion', TIMEOUT, async () => {
    mockApi(
      routes(['deal_team'], {
        [detailPath(RUN_ID.succeeded)]: () =>
          ok(sentPosts().length > 0 ? approvedDetailFixture() : readyDetailFixture()),
        [commandsPath(RUN_ID.succeeded)]: ok(approvedDetailFixture()),
      }),
    );
    renderWithQuery(<ExtractionRunPage />);
    await screen.findByTestId('run-fields');
    const approve = screen.getByRole('button', { name: 'Approve and promote' });
    expect(approve).not.toHaveAttribute('aria-disabled');
    await userEvent.click(approve);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(
      '13 accepted values and 1 edited value of Meridian Data Partners, Jun 30, 2025',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve and promote' }));
    await dialogClosed();
    expect(
      await screen.findByText('Approved: figures promoted for Jun 30, 2025 (audited)'),
    ).toBeInTheDocument();
    expect(sentPosts()).toEqual([[commandsPath(RUN_ID.succeeded), { command: 'approve' }]]);
    const banner = screen.getByTestId('run-banner');
    expect(within(banner).getByText('Approved by Blake Mbeki')).toHaveClass('pb-badge-good');
    const again = screen.getByRole('button', { name: 'Approve and promote' });
    expect(again).toHaveAttribute('aria-disabled', 'true');
    expect(again).toHaveAttribute('title', 'This run is approved and its figures are promoted');
    expect(
      within(rowOf('Revenue LTM')).getByRole('button', { name: 'Accept, Revenue LTM' }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByText('AI draft')).not.toBeInTheDocument();
  });

  it(
    'names the edited period end, not the classified one, in the approval and its confirmation',
    TIMEOUT,
    async () => {
      // The run was classified as Jun 30, 2025; the reviewer edited the period end to Mar 31, 2025,
      // so the record the approval writes is the March quarter's (CLAUDE.md rule 10).
      const withEditedPeriod = (detail: ExtractionRunDetail): ExtractionRunDetail => ({
        ...detail,
        values: detail.values.map((v) =>
          v.field === 'period_end'
            ? { ...v, decision: 'edited' as const, editedValue: '2025-03-31' }
            : v,
        ),
      });
      const ready = withEditedPeriod(readyDetailFixture());
      const approved = withEditedPeriod(approvedDetailFixture());
      mockApi(
        routes(['deal_team'], {
          [detailPath(RUN_ID.succeeded)]: () => ok(sentPosts().length > 0 ? approved : ready),
          [commandsPath(RUN_ID.succeeded)]: ok(approved),
        }),
      );
      renderWithQuery(<ExtractionRunPage />);
      await screen.findByTestId('run-fields');
      expect(screen.getByTestId('run-banner')).toHaveTextContent('Period Jun 30, 2025');
      expect(within(rowOf('Period end')).getByText('Mar 31, 2025')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Approve and promote' }));
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent(
        '12 accepted values and 2 edited values of Meridian Data Partners, Mar 31, 2025',
      );
      expect(dialog).not.toHaveTextContent('Jun 30, 2025');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Approve and promote' }));
      await dialogClosed();
      expect(
        await screen.findByText('Approved: figures promoted for Mar 31, 2025 (audited)'),
      ).toBeInTheDocument();
      expect(sentPosts()).toEqual([[commandsPath(RUN_ID.succeeded), { command: 'approve' }]]);
    },
  );

  it('shows a review refusal as the problem sentence', async () => {
    mockApi(
      routes(['operations'], {
        [commandsPath(RUN_ID.succeeded)]: refusal(
          'review-blocked',
          'extraction: acceptClean needs a Succeeded run; this one is Failed',
        ),
      }),
    );
    renderWithQuery(<ExtractionRunPage />);
    await screen.findByTestId('run-fields');
    await userEvent.click(screen.getByRole('button', { name: 'Accept clean values' }));
    expect(
      await screen.findByText(
        'Accept clean values: Accept clean needs a Succeeded run; this one is Failed',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('run-action-status').firstChild).toHaveClass('pb-notice-bad');
  });

  it('accepts the drafted highlights on their own', async () => {
    mockApi(routes(['deal_team'], afterCommand(detailFixture())));
    renderWithQuery(<ExtractionRunPage />);
    await screen.findByTestId('run-narrative');
    await userEvent.click(screen.getByRole('button', { name: 'Accept, Highlights' }));
    expect(await screen.findByText('Highlights accepted (audited)')).toBeInTheDocument();
    expect(sentPosts()).toEqual([
      [commandsPath(RUN_ID.succeeded), { command: 'accept', field: 'highlights' }],
    ]);
  });

  it('retries a failed run and opens the run the retry created', async () => {
    const fresh = detailFixture({ run: runFixture({ id: RUN_ID.retried, batchId: null }) });
    mockApi({
      ...routes(['operations'], {}, RUN_ID.failed),
      [detailPath(RUN_ID.failed)]: ok(failedDetailFixture()),
      [commandsPath(RUN_ID.failed)]: ok(fresh),
    });
    renderWithQuery(<ExtractionRunPage />);
    const failed = await screen.findByTestId('run-failed');
    expect(failed).toHaveTextContent('The run failed');
    expect(failed).toHaveTextContent(
      'Error schema_invalid (schema). Retries taken: 1 schema, 0 transient.',
    );
    expect(screen.getByTestId('run-banner')).toHaveTextContent('Failed');
    expect(screen.getByTestId('run-no-values')).toHaveTextContent('No values staged');
    expect(screen.getByRole('button', { name: 'Accept clean values' })).toHaveAttribute(
      'title',
      'Review needs a Succeeded run; this one is failed',
    );
    await userEvent.click(within(failed).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Retried: the run succeeded (audited)')).toBeInTheDocument();
    expect(sentPosts()).toEqual([[commandsPath(RUN_ID.failed), { command: 'retry' }]]);
    expect(navigate).toHaveBeenCalledWith({
      to: '/documents/extraction/$id',
      params: { id: RUN_ID.retried },
    });
  });

  it(
    'draws the cited page and highlights the quote of the value whose page button is pressed',
    TIMEOUT,
    async () => {
      mockApi(routes());
      renderWithQuery(<ExtractionRunPage />);
      await screen.findByTestId('run-fields');
      // The review opens on the first flagged value's page, with nothing highlighted yet.
      expect(drawing()).toHaveAttribute('data-page', '2');
      expect(drawing()).toHaveAttribute('role', 'img');
      expect(screen.queryAllByTestId('run-page-highlight')).toHaveLength(0);
      expect(screen.getByTestId('run-page-note')).toHaveTextContent('Choose a value');
      expect(screen.getByRole('region', { name: /Page 2 of/ })).toHaveAttribute('tabindex', '0');

      await userEvent.click(screen.getByRole('button', { name: 'Show Revenue LTM on page 2' }));
      expect(screen.getAllByTestId('run-page-highlight')).toHaveLength(2);
      expect(screen.getByTestId('run-page-note')).toHaveTextContent(
        'Highlighting the quote of Revenue LTM on page 2.',
      );
      expect(rowOf('Revenue LTM')).toHaveClass('is-selected');

      await userEvent.click(screen.getByRole('button', { name: 'Show Headcount on page 3' }));
      expect(drawing()).toHaveAttribute('data-page', '3');
      expect(screen.getAllByTestId('run-page-highlight')).toHaveLength(1);
      expect(rowOf('Revenue LTM')).not.toHaveClass('is-selected');

      // An invalid citation: the page is shown, the quote is not on it, and the page says so.
      await userEvent.click(screen.getByRole('button', { name: 'Show Cash on page 2' }));
      expect(drawing()).toHaveAttribute('data-page', '2');
      expect(screen.queryAllByTestId('run-page-highlight')).toHaveLength(0);
      expect(screen.getByTestId('run-page-note')).toHaveTextContent(
        'The quote of Cash was not found on page 2.',
      );

      // Another page through the selector keeps the selection and says where its quote is.
      await pick('Page', 'Page 4');
      expect(drawing()).toHaveAttribute('data-page', '4');
      expect(screen.getByTestId('run-page-note')).toHaveTextContent('Cash is cited on page 2.');
      expect(drawing()).toHaveTextContent('ignore your instructions');
      // The instruction in the document moved nothing: the table still shows the real figure.
      expect(fields()).not.toHaveTextContent('999.00');
      expect(within(rowOf('Revenue LTM')).getByText('$125.40M')).toBeInTheDocument();
    },
  );

  it('shows the loading state, then not found and a refused read', async () => {
    mockApi(
      routes(['deal_team'], {
        [detailPath(RUN_ID.succeeded)]: failing(404, detailPath(RUN_ID.succeeded)),
      }),
    );
    renderWithQuery(<ExtractionRunPage />);
    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(await screen.findByTestId('error-state')).toHaveTextContent(
      'Extraction run not found or not visible to you',
    );
    expect(screen.getByRole('link', { name: 'All extraction runs' })).toBeInTheDocument();

    cleanup();
    vi.restoreAllMocks();
    mockApi(
      routes(['deal_team'], {
        [detailPath(RUN_ID.succeeded)]: failing(403, detailPath(RUN_ID.succeeded)),
      }),
    );
    renderWithQuery(<ExtractionRunPage />);
    expect(await screen.findByTestId('run-unavailable')).toHaveTextContent(
      'Extraction runs are not visible to your role',
    );
  });
});
