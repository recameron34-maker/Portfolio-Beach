import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { valuationLockText } from '@pb/contracts';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import {
  changeTypeTaxonomyFixture,
  POSITION_ID,
  refusalFixture,
  rolePrincipal,
  sentPosts,
  sentRequests,
  VAL_ID,
  valuationDetailFixture,
  valuationMethodTaxonomyFixture,
  valuationRowFixture,
} from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { clearTaxonomyLabels, registerTaxonomyLabels } from '../../lib/format.js';
import { ValuationDetailPage } from './ValuationDetail.js';

const params = vi.hoisted(() => ({ id: '00000000-0000-4000-8000-000000000104' }));

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: params.id }),
}));

/** The shell registers the taxonomy labels for labelOf; the tests register the change types and the methods the same way. */
beforeAll(() =>
  registerTaxonomyLabels(
    [...changeTypeTaxonomyFixture().domains, ...valuationMethodTaxonomyFixture().domains].flatMap(
      (d) => d.terms,
    ),
  ),
);
afterAll(() => clearTaxonomyLabels());

const ME = '/api/v1/auth/me';
const TAXONOMY = '/api/v1/taxonomy';
const detailPath = (id: string): string => `/api/v1/valuations/${id}`;
const commandsPath = (id: string): string => `/api/v1/valuations/${id}/commands`;
const NEW_DRAFT_ID = '00000000-0000-4000-8000-000000000199';
/** Dialog journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

function routes(
  roles: Parameters<typeof rolePrincipal>[0],
  overrides: MockRoutes = {},
): MockRoutes {
  params.id = VAL_ID.locked;
  return {
    [ME]: ok(rolePrincipal(roles)),
    [detailPath(VAL_ID.locked)]: ok(valuationDetailFixture()),
    ...overrides,
  };
}

const tile = (name: string): HTMLElement =>
  within(screen.getByTestId('valuation-detail-tiles')).getByRole('group', { name });

/**
 * The page's one status region, by its test id: the modal hides the rest of the page from
 * assistive technology while it is open, and in jsdom Fluent's focus manager lifts that late, so
 * the region is read by id rather than by role once a dialog has been used.
 */
const status = (): HTMLElement => screen.getByTestId('valuation-action-status');

async function dialogClosed(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

/** A Draft the edit works on: version 2 after a reopen, with two method inputs and no decisions yet. */
function draftDetail(overrides: Parameters<typeof valuationDetailFixture>[0] = {}) {
  return valuationDetailFixture({
    id: VAL_ID.draft,
    version: 2,
    state: 'Draft',
    lockHash: null,
    preparedBy: null,
    dealTeamApprovedBy: null,
    approvedBy: null,
    approvedAt: null,
    rowVersion: 4,
    inputs: { multiple: 11.5, basis: 'LTM EBITDA' },
    approvals: [],
    openChangeRequests: [],
    lockText: null,
    ...overrides,
  });
}

function draftRoutes(
  roles: Parameters<typeof rolePrincipal>[0],
  overrides: MockRoutes = {},
): MockRoutes {
  params.id = VAL_ID.draft;
  return {
    [ME]: ok(rolePrincipal(roles)),
    [TAXONOMY]: ok(valuationMethodTaxonomyFixture()),
    [detailPath(VAL_ID.draft)]: ok(draftDetail()),
    ...overrides,
  };
}

/** The PATCH requests the page sent, as [path, parsed body, the If-Match header]. */
function sentEdits(): [string, unknown, string | null][] {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([, init]) => init?.method === 'PATCH')
    .map(([input, init]) => [
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      new Headers(init?.headers).get('if-match'),
    ]);
}

const MONEY_SHAPE =
  'An amount above zero: at most 18 digits before the decimal point and two after';

describe('valuation version screen', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the version, its progress, the figures, the approvals, the lock text and the open requests', async () => {
    mockApi(routes(['approver']));
    renderWithQuery(<ValuationDetailPage />);
    expect(await screen.findByTestId('valuation-detail')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Meridian Data Partners: Jun 30, 2025 v1',
    );
    const banner = screen.getByTestId('valuation-banner');
    expect(within(banner).getByRole('link', { name: 'INV-0001' })).toHaveAttribute(
      'href',
      `/portfolio/${POSITION_ID.meridian}`,
    );
    expect(within(banner).getByText('Locked')).toHaveClass('pb-badge-good');
    expect(screen.getByRole('link', { name: 'Valuation board' })).toHaveAttribute(
      'href',
      '/valuations',
    );

    const steps = within(screen.getByRole('list', { name: 'Valuation progress' })).getAllByRole(
      'listitem',
    );
    expect(steps).toHaveLength(4);
    expect(steps[0]).toHaveTextContent('DraftDone');
    expect(steps[3]).toHaveAttribute('aria-current', 'step');
    expect(steps[3]).toHaveTextContent('LockedCurrent');

    expect(within(tile('Fair value')).getByText('$27.4M')).toBeInTheDocument();
    expect(within(tile('Prior fair value')).getByText('$25.0M')).toBeInTheDocument();
    expect(within(tile('Change')).getByText('9.6%')).toBeInTheDocument();
    expect(tile('Change')).not.toHaveAttribute('data-tone');
    expect(within(tile('Locked')).getByText('Aug 9, 2025')).toBeInTheDocument();
    expect(within(tile('Locked')).getByText('By Morgan Lindqvist')).toBeInTheDocument();

    const approvals = within(screen.getByTestId('valuation-approvals')).getByRole('table', {
      name: 'Approvals',
    });
    const rows = within(approvals).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      'Ops preparedApprovedAvery MbekiJul 20, 2025 10:00:00 UTC-',
      'Deal teamApprovedBlake OkaforAug 1, 2025 10:00:00 UTC-',
      'Final approvalApprovedMorgan LindqvistAug 9, 2025 15:00:00 UTC-',
    ]);

    const lock = screen.getByTestId('valuation-lock');
    expect(screen.getByTestId('valuation-lock-text')).toHaveTextContent(
      valuationLockText({ ...valuationRowFixture(), inputs: {} }),
    );
    expect(within(lock).getByText('h-00000104')).toHaveClass('pb-val-hash');
    expect(lock).toHaveTextContent(
      'the version identity, the method, the method inputs and the fair value',
    );
    // This version holds no method inputs, and says so.
    expect(
      within(screen.getByTestId('valuation-inputs')).getByText('No method inputs'),
    ).toBeInTheDocument();
    // A Locked version is not edited in place: the correction is a reopen.
    expect(screen.queryByRole('button', { name: 'Edit draft' })).not.toBeInTheDocument();

    const open = screen.getByTestId('valuation-open-changes');
    expect(open).toHaveTextContent('1 open request');
    const openRow = within(open).getByText('Add-on acquisition').closest('tr')!;
    expect(within(openRow).getByText('Submitted')).toHaveClass('pb-badge-watch');
    expect(within(openRow).getByText('May 15, 2025')).toBeInTheDocument();
    expect(
      within(open).getByRole('link', { name: 'Open the change request queue' }),
    ).toHaveAttribute('href', '/valuations/changes');

    // An approver may reopen a Locked version; the note names what a reopen does.
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeEnabled();
    expect(
      screen.getByText(/Creates a new Draft version and alerts prior approvers/),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x2014));
  });

  it('names the roles a viewer would need and keeps the screen read only', async () => {
    mockApi(routes(['viewer']));
    renderWithQuery(<ValuationDetailPage />);
    const reopen = await screen.findByRole('button', { name: 'Reopen' });
    expect(reopen).toBeDisabled();
    expect(reopen).toHaveAttribute('title', 'Needs operations or approver');
  });

  it('reopens with a reason and links to the new Draft version', TIMEOUT, async () => {
    mockApi(
      routes(['approver'], {
        [commandsPath(VAL_ID.locked)]: ok(
          valuationRowFixture({
            id: NEW_DRAFT_ID,
            version: 2,
            state: 'Draft',
            lockHash: null,
            preparedBy: null,
            dealTeamApprovedBy: null,
            approvedBy: null,
            approvedAt: null,
            rowVersion: 1,
          }),
        ),
      }),
    );
    renderWithQuery(<ValuationDetailPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reopen' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Sponsor restated',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reopen' }));
    await dialogClosed();
    expect(
      await within(status()).findByText(
        'Meridian Data Partners, Jun 30, 2025 v1 is now Reopened; the new Draft version is Meridian Data Partners, Jun 30, 2025 v2 (audited)',
      ),
    ).toHaveClass('pb-notice-good');
    // By text, not by role: the closed modal may still mark the page hidden for a moment in jsdom.
    const reopened = screen.getByTestId('valuation-reopened');
    const link = within(reopened).getByText('Meridian Data Partners, Jun 30, 2025 v2');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', `/valuations/${NEW_DRAFT_ID}`);
    expect(sentPosts()).toEqual([
      [commandsPath(VAL_ID.locked), { command: 'reopen', reason: 'Sponsor restated' }],
    ]);
  });

  it('offers the deal team its approval on an Ops prepared version and words a refusal', async () => {
    params.id = VAL_ID.prepared;
    mockApi({
      [ME]: ok(rolePrincipal(['deal_team'])),
      [detailPath(VAL_ID.prepared)]: ok(
        valuationDetailFixture({
          id: VAL_ID.prepared,
          state: 'OpsPrepared',
          lockHash: null,
          dealTeamApprovedBy: null,
          approvedBy: null,
          approvedAt: null,
          approvals: [
            {
              id: '00000000-0000-4000-8000-000000000611',
              step: 'ops_prepared',
              decision: 'approve',
              actorId: '00000000-0000-4000-8000-000000000301',
              actorName: 'Avery Mbeki',
              at: '2025-07-20T10:00:00Z',
              reason: null,
            },
          ],
          openChangeRequests: [],
          lockText: null,
        }),
      ),
      [commandsPath(VAL_ID.prepared)]: {
        status: 422,
        body: refusalFixture(422, 'valuation: the preparer cannot approve their own valuation'),
      },
    });
    renderWithQuery(<ValuationDetailPage />);
    const approve = await screen.findByRole('button', { name: 'Deal team approve' });
    expect(approve).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send back' })).toBeEnabled();
    expect(
      within(screen.getByTestId('valuation-lock')).getByText('Not locked'),
    ).toBeInTheDocument();
    expect(screen.getByText('No open change requests')).toBeInTheDocument();
    expect(within(tile('Locked')).getByText('-')).toBeInTheDocument();
    expect(within(tile('Locked')).getByText('Not locked')).toBeInTheDocument();
    await userEvent.click(approve);
    expect(
      await within(screen.getByRole('status')).findByText(
        'Deal team approve for Meridian Data Partners, Jun 30, 2025 v1: Blocked by a rule. The preparer cannot approve their own valuation',
      ),
    ).toHaveClass('pb-notice-bad');
    expect(sentPosts()).toEqual([[commandsPath(VAL_ID.prepared), { command: 'dealTeamApprove' }]]);
  });

  it('says the work continues on the next version once reopened', async () => {
    mockApi(
      routes(['operations'], {
        [detailPath(VAL_ID.locked)]: ok(
          valuationDetailFixture({
            state: 'Reopened',
            reopenReason: 'Quarterly financials restated',
          }),
        ),
      }),
    );
    renderWithQuery(<ValuationDetailPage />);
    expect(
      await screen.findByText(/Reopened is the last step of this version; the work continues/),
    ).toBeInTheDocument();
    expect(screen.getByText('Reopen reason: Quarterly financials restated')).toBeInTheDocument();
    const steps = within(screen.getByRole('list', { name: 'Valuation progress' })).getAllByRole(
      'listitem',
    );
    expect(steps.every((s) => s.textContent?.endsWith('Done'))).toBe(true);
  });

  it('shows the method inputs the lock covers, by name, whatever they hold', async () => {
    mockApi(
      routes(['approver'], {
        [detailPath(VAL_ID.locked)]: ok(
          valuationDetailFixture({
            inputs: { multiple: 11.5, basis: 'LTM EBITDA', comps: { set: 'peers', count: 6 } },
          }),
        ),
      }),
    );
    renderWithQuery(<ValuationDetailPage />);
    const card = await screen.findByTestId('valuation-inputs');
    expect(card).toHaveTextContent('3 inputs');
    const rows = within(within(card).getByRole('table', { name: 'Method inputs' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      'basisLTM EBITDA',
      'comps{"count":6,"set":"peers"}',
      'multiple11.5',
    ]);
    expect(screen.getByTestId('valuation-lock-text')).toHaveTextContent(
      '"inputs":{"basis":"LTM EBITDA","comps":{"count":6,"set":"peers"},"multiple":11.5}',
    );
  });

  it('names who signed a Locked version that holds no decision rows, from the version itself (WEB-5)', async () => {
    // A seeded Locked version: the people and the lock time are on the row, the trail is empty.
    mockApi(
      routes(['viewer'], {
        [detailPath(VAL_ID.locked)]: ok(
          valuationDetailFixture({
            preparedBy: 'Avery Mbeki',
            dealTeamApprovedBy: 'Blake Okafor',
            approvedBy: 'Morgan Lindqvist',
            approvals: [],
            openChangeRequests: [],
          }),
        ),
      }),
    );
    renderWithQuery(<ValuationDetailPage />);
    await screen.findByTestId('valuation-detail');
    expect(within(tile('Locked')).getByText('Aug 9, 2025')).toBeInTheDocument();
    expect(within(tile('Locked')).getByText('By Morgan Lindqvist')).toBeInTheDocument();
    expect(within(tile('Locked')).queryByText('Not locked')).not.toBeInTheDocument();
    const card = screen.getByTestId('valuation-approvals');
    expect(card).toHaveTextContent('3 sign-offs');
    const rows = within(within(card).getByRole('table', { name: 'Approvals' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      'Ops preparedApprovedAvery Mbeki--',
      'Deal teamApprovedBlake Okafor--',
      'Final approvalApprovedMorgan LindqvistAug 9, 2025 15:00:00 UTC-',
    ]);
    expect(card).toHaveTextContent(
      'These names are on the version itself; it holds no step by step decisions.',
    );
    expect(within(card).queryByText('No decisions yet')).not.toBeInTheDocument();
    // The viewer is not a change request reader: the panel shows its empty state (CR-5).
    expect(screen.getByText('No open change requests')).toBeInTheDocument();
  });

  it('shows the hash a Reopened version was locked with, in place of "Not locked"', async () => {
    mockApi(
      routes(['viewer'], {
        [detailPath(VAL_ID.locked)]: ok(
          valuationDetailFixture({
            state: 'Reopened',
            reopenReason: 'Quarterly financials restated',
            lockText: null,
          }),
        ),
      }),
    );
    renderWithQuery(<ValuationDetailPage />);
    const lock = await screen.findByTestId('valuation-lock');
    expect(within(lock).getByText('Reopened after its lock')).toBeInTheDocument();
    expect(within(lock).getByText('h-00000104')).toHaveClass('pb-val-hash');
    expect(within(lock).queryByText('Not locked')).not.toBeInTheDocument();
  });

  it(
    'lets operations edit a Draft: the form starts from the stored method, value and inputs and sends only what changed, with If-Match (VAL-1)',
    TIMEOUT,
    async () => {
      mockApi(
        draftRoutes(['operations'], {
          [detailPath(VAL_ID.draft)]: (url) => {
            void url;
            return ok(draftDetail());
          },
        }),
      );
      renderWithQuery(<ValuationDetailPage />);
      const edit = await screen.findByRole('button', { name: 'Edit draft' });
      expect(edit).toBeEnabled();
      expect(screen.getByTestId('valuation-inputs')).toHaveTextContent('2 inputs');
      await userEvent.click(edit);
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('Edit draft');
      expect(dialog).toHaveTextContent('Meridian Data Partners, Jun 30, 2025 v2');
      const method = within(dialog).getByRole('combobox', { name: /Method/ });
      expect(method).toHaveTextContent('Sponsor mark');
      const value = within(dialog).getByRole('textbox', { name: /Fair value/ });
      expect(value).toHaveValue('27400000.00');
      // The stored inputs, by name; the number reads as it was stored.
      expect(within(dialog).getByRole('textbox', { name: 'Input 1 name' })).toHaveValue('basis');
      expect(within(dialog).getByRole('textbox', { name: 'Input 1 value' })).toHaveValue(
        'LTM EBITDA',
      );
      expect(within(dialog).getByRole('textbox', { name: 'Input 2 name' })).toHaveValue('multiple');
      const multiple = within(dialog).getByRole('textbox', { name: 'Input 2 value' });
      expect(multiple).toHaveValue('11.5');
      const save = within(dialog).getByRole('button', { name: 'Save changes' });
      // Nothing changed yet, so there is nothing to send.
      expect(save).toBeDisabled();

      // The fair value is checked with the contract (positiveMoney) and refused in its words.
      await userEvent.clear(value);
      await userEvent.type(value, '28000000.505');
      expect(within(dialog).getByText(MONEY_SHAPE)).toBeInTheDocument();
      expect(save).toBeDisabled();
      await userEvent.clear(value);
      await userEvent.type(value, '0');
      expect(within(dialog).getByText('Must be above zero')).toBeInTheDocument();
      expect(save).toBeDisabled();
      await userEvent.clear(value);
      await userEvent.type(value, '28000000.5');
      expect(within(dialog).getByText('Reads as $28.0M.')).toBeInTheDocument();
      expect(save).toBeEnabled();

      // An input retyped as a number is sent as a number; a new one is added by name.
      await userEvent.clear(multiple);
      await userEvent.type(multiple, '12');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add input' }));
      await userEvent.type(within(dialog).getByRole('textbox', { name: 'Input 3 name' }), 'source');
      await userEvent.type(
        within(dialog).getByRole('textbox', { name: 'Input 3 value' }),
        'sponsor letter',
      );
      vi.mocked(globalThis.fetch).mockClear();
      mockApi(
        draftRoutes(['operations'], {
          [detailPath(VAL_ID.draft)]: (url) => {
            void url;
            return ok(
              draftDetail({
                fairValue: '28000000.50',
                rowVersion: 5,
                inputs: { basis: 'LTM EBITDA', multiple: 12, source: 'sponsor letter' },
              }),
            );
          },
        }),
      );
      await userEvent.click(save);
      await dialogClosed();
      expect(sentEdits()).toEqual([
        [
          detailPath(VAL_ID.draft),
          {
            fairValue: '28000000.5',
            inputs: { basis: 'LTM EBITDA', multiple: 12, source: 'sponsor letter' },
          },
          '"4"',
        ],
      ]);
      expect(
        await within(status()).findByText(
          'Meridian Data Partners, Jun 30, 2025 v2 corrected: the fair value and the inputs (audited)',
        ),
      ).toHaveClass('pb-notice-good');
      // The screen reads the version again and shows what was saved.
      await waitFor(() =>
        expect(screen.getByTestId('valuation-inputs')).toHaveTextContent('3 inputs'),
      );
      // By test id, not by role: the closed modal may still mark the page hidden for a moment in jsdom.
      expect(
        within(screen.getByTestId('valuation-detail-tiles')).getByText('$28.0M'),
      ).toBeInTheDocument();
      expect(sentRequests().filter(([, m]) => m === 'POST')).toEqual([]);
    },
  );

  it(
    'keeps a refused edit open with the reason, and offers the edit to operations on a Draft only',
    TIMEOUT,
    async () => {
      mockApi(
        draftRoutes(['operations'], {
          [detailPath(VAL_ID.draft)]: (url) => {
            void url;
            return ok(draftDetail());
          },
        }),
      );
      const first = renderWithQuery(<ValuationDetailPage />);
      await userEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));
      const dialog = await screen.findByRole('dialog');
      const value = within(dialog).getByRole('textbox', { name: /Fair value/ });
      await userEvent.clear(value);
      await userEvent.type(value, '28000000.00');
      // The version was prepared by someone else in the meantime: the API answers 409.
      vi.restoreAllMocks();
      mockApi(
        draftRoutes(['operations'], {
          [detailPath(VAL_ID.draft)]: {
            status: 409,
            body: {
              ...refusalFixture(
                409,
                'valuation: edit is not allowed from OpsPrepared; only a Draft can be edited',
              ),
              type: 'https://portfolio-beach.example/problems/workflow-transition',
            },
          },
        }),
      );
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
      expect(
        await within(dialog).findByText(
          'Not allowed from the current state. Edit is not allowed from Ops prepared; only a Draft can be edited',
        ),
      ).toHaveClass('pb-notice-bad');
      // What was typed is still there, and the refusal is in the session list too.
      expect(value).toHaveValue('28000000.00');
      expect(sentEdits()).toEqual([
        [detailPath(VAL_ID.draft), { fairValue: '28000000.00' }, '"4"'],
      ]);
      first.unmount();
      vi.restoreAllMocks();

      // The deal team sees the action and the role it needs; nobody edits a prepared version.
      mockApi(draftRoutes(['deal_team']));
      const second = renderWithQuery(<ValuationDetailPage />);
      const blocked = await screen.findByRole('button', { name: 'Edit draft' });
      expect(blocked).toBeDisabled();
      expect(blocked).toHaveAttribute('title', 'Needs operations');
      second.unmount();
      vi.restoreAllMocks();
      mockApi(
        draftRoutes(['operations'], {
          [detailPath(VAL_ID.draft)]: ok(draftDetail({ state: 'OpsPrepared', preparedBy: 'x' })),
        }),
      );
      renderWithQuery(<ValuationDetailPage />);
      await screen.findByRole('button', { name: 'Send back' });
      expect(screen.queryByRole('button', { name: 'Edit draft' })).not.toBeInTheDocument();
    },
  );

  it(
    'leaves inputs it cannot carry as they are: the method and the value are still edited',
    TIMEOUT,
    async () => {
      mockApi(
        draftRoutes(['operations'], {
          [detailPath(VAL_ID.draft)]: ok(
            draftDetail({ inputs: { comps: { set: 'peers', count: 6 }, basis: 'LTM EBITDA' } }),
          ),
          // The PATCH answers the row; the page then reads the detail again.
        }),
      );
      renderWithQuery(<ValuationDetailPage />);
      await userEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));
      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByText(
          'These inputs hold a value that is not text or a number, so they cannot be edited here and stay as they are.',
        ),
      ).toBeInTheDocument();
      expect(within(dialog).queryByRole('button', { name: 'Add input' })).not.toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole('combobox', { name: /Method/ }));
      // The active methods of the taxonomy, by label; a retired one is not offered.
      expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
        'Sponsor mark',
        'Market multiple',
        'Discounted cash flow',
        'Par plus accrued',
      ]);
      await userEvent.click(screen.getByRole('option', { name: 'Market multiple' }));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
      await waitFor(() =>
        expect(sentEdits()).toEqual([
          [detailPath(VAL_ID.draft), { method: 'valuation_method.market_multiple' }, '"4"'],
        ]),
      );
    },
  );

  it(
    'words the 409 of a lost race for a version number so the person knows what to do',
    TIMEOUT,
    async () => {
      mockApi(
        routes(['approver'], {
          [commandsPath(VAL_ID.locked)]: {
            status: 409,
            body: {
              ...refusalFixture(
                409,
                'valuation: another version was created first; open the list again',
              ),
              type: 'https://portfolio-beach.example/problems/workflow-transition',
            },
          },
        }),
      );
      renderWithQuery(<ValuationDetailPage />);
      await userEvent.click(await screen.findByRole('button', { name: 'Reopen' }));
      const dialog = await screen.findByRole('dialog');
      await userEvent.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Restated');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Reopen' }));
      await dialogClosed();
      expect(
        await within(status()).findByText(
          'Reopen for Meridian Data Partners, Jun 30, 2025 v1: Another version was created for this position and period first, so nothing was saved. The list is refreshed: continue with the version it shows.',
        ),
      ).toHaveClass('pb-notice-bad');
    },
  );

  it.each([404, 403] as const)('says not found or not visible on a %s', async (status) => {
    mockApi(routes(['operations'], { [detailPath(VAL_ID.locked)]: failing(status, 'x') }));
    renderWithQuery(<ValuationDetailPage />);
    expect(
      await screen.findByText('Valuation not found or not visible to you'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Valuation board' })).toBeInTheDocument();
  });

  it('degrades to a not-available state on a 501', async () => {
    mockApi(routes(['operations'], { [detailPath(VAL_ID.locked)]: failing(501, 'x') }));
    renderWithQuery(<ValuationDetailPage />);
    expect(await screen.findByText('This valuation: not available yet')).toBeInTheDocument();
  });
});
