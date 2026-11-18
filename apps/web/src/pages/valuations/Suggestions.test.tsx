import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SUGGESTION_CHANGED_REFUSAL } from '@pb/workflows';
import { clearTaxonomyLabels, registerTaxonomyLabels } from '../../lib/format.js';
import { mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import { ID } from '../../test/fixtures.js';
import {
  notCalculableFixture,
  REPORT_FILE,
  reportSuggestionFixture,
  SOURCE,
  STATEMENT_FILE,
  SUGGESTION_ID,
  suggestionFixture,
  suggestionPageFixture,
  suggestionsFlagFixture,
} from '../../test/fixtures-suggestions.js';
import { PERSON, rolePrincipal, sentRequests, VAL_ID } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { statementDetailFixture } from '../extraction/test-fixtures.js';
import { SuggestionsPage } from './Suggestions.js';
import type { SuggestionsSearch } from './suggestions.js';

/** The address the page reads: tests set it before they render. */
const route: { search: SuggestionsSearch } = { search: {} };

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMockWithSearch(),
  useSearch: () => route.search,
}));

const ME = '/api/v1/auth/me';
const FLAGS = '/api/v1/flags';
const LIST = '/api/v1/valuation-suggestions';
const OPEN = `${LIST}?limit=200`;
const detailPath = (id: string): string => `${LIST}/${id}`;
const commandPath = (id: string): string => `${LIST}/${id}/commands`;
/** Dialog and dropdown journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

function routes(overrides: MockRoutes = {}): MockRoutes {
  return {
    [ME]: ok(rolePrincipal(['operations'])),
    [FLAGS]: ok(suggestionsFlagFixture(true)),
    [OPEN]: ok(suggestionPageFixture()),
    ...overrides,
  };
}

/** The requests the page sent to the suggestion routes, as [path and query, method]. */
const suggestionRequests = (): [string, string][] =>
  sentRequests()
    .filter(([url]) => url.includes('/valuation-suggestions'))
    .map(([url, method]) => [url, method]);

/** The If-Match header of the last request sent with the method given. */
function ifMatchOf(method: string): string | null {
  const call = vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([, init]) => (init?.method ?? 'GET') === method)
    .pop();
  return new Headers(call?.[1]?.headers).get('if-match');
}

const button = (name: string): HTMLElement => screen.getByRole('button', { name });

describe('valuation suggestions', () => {
  beforeEach(() => {
    route.search = {};
    registerTaxonomyLabels([
      { code: 'valuation_method.sponsor_mark', label: 'Sponsor mark' },
      { code: 'valuation_method.report_indication', label: 'Indication from sponsor report' },
      { code: 'valuation_method.market_multiple', label: 'Market multiple' },
    ]);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    clearTaxonomyLabels();
  });

  it('lists each open suggestion against the current mark, with its source and its badges', async () => {
    mockApi(routes());
    renderWithQuery(<SuggestionsPage />);
    const table = await screen.findByRole('table', { name: 'Valuation suggestions' });
    expect(screen.getByText('2 open')).toBeInTheDocument();
    expect(screen.getByTestId('suggestions-gate')).toHaveTextContent(
      'A suggestion is not a mark. Operations opens a draft valuation from it, and the draft is prepared and approved like any other before it is Locked.',
    );
    expect(screen.queryByTestId('suggestions-off')).not.toBeInTheDocument();

    const meridian = within(table).getByRole('link', { name: 'Meridian Data Partners' });
    expect(meridian).toHaveAttribute('href', `/portfolio/${ID.inv1}`);
    const row = meridian.closest('tr')!;
    expect(within(row).getByText('INV-0001')).toHaveClass('pb-key');
    expect(within(row).getByText('Jun 30, 2025')).toBeInTheDocument();
    expect(within(row).getByText('$20.9M')).toBeInTheDocument();
    expect(within(row).getByText('$18.4M')).toBeInTheDocument();
    expect(within(row).getByText('Mar 31, 2025, one quarter old')).toBeInTheDocument();
    expect(within(row).getByText('$2.5M')).toBeInTheDocument();
    expect(within(row).getByText('13.7%')).toBeInTheDocument();
    expect(within(row).getByText('$0.9M')).toBeInTheDocument();
    expect(within(row).getByText('4.7%')).toBeInTheDocument();
    expect(within(row).getByText('Capital account statement')).toBeInTheDocument();
    expect(within(row).getByText('Variance')).toBeInTheDocument();
    expect(within(row).queryByText('Does not tie')).not.toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /^Workings, Meridian/ })).toHaveAttribute(
      'href',
      `/valuations/suggestions?id=${SUGGESTION_ID.statement}`,
    );

    const juniper = within(table).getByText('Juniper Financial Group').closest('tr')!;
    expect(within(juniper).getByText('Sponsor report')).toBeInTheDocument();
    expect(within(juniper).getByText('$7.8M')).toBeInTheDocument();
    expect(within(juniper).getByText('Mar 28, 2025, one quarter old')).toBeInTheDocument();
    expect(within(juniper).getByText('Typed by reviewer')).toBeInTheDocument();
    expect(within(juniper).queryByText('Variance')).not.toBeInTheDocument();
    // No net of flows for a report: the placeholder, never a zero.
    expect(within(juniper).getAllByText('-').length).toBeGreaterThan(0);

    const tabs = screen.getByRole('navigation', { name: 'Valuations' });
    expect(within(tabs).getByRole('link', { name: 'Suggestions' })).toHaveAttribute(
      'href',
      '/valuations/suggestions',
    );
    expect(suggestionRequests()).toEqual([[OPEN, 'GET']]);
    // Every row of this list is Open, so the state is not repeated on each.
    expect(within(table).queryByRole('columnheader', { name: 'State' })).not.toBeInTheDocument();
  });

  it.each(['viewer', 'investor_relations', 'platform_admin'] as const)(
    'sends no request for a %s, shows no tab and says who reads suggestions',
    async (role) => {
      mockApi(routes({ [ME]: ok(rolePrincipal([role])) }));
      route.search = { id: SUGGESTION_ID.statement };
      renderWithQuery(<SuggestionsPage />);
      expect(await screen.findByTestId('suggestions-not-shown')).toHaveTextContent(
        'Operations, the deal team, approvers and auditors read valuation suggestions.',
      );
      const tabs = screen.getByRole('navigation', { name: 'Valuations' });
      expect(within(tabs).queryByRole('link', { name: 'Suggestions' })).not.toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(suggestionRequests()).toEqual([]);
      expect(sentRequests().some(([url]) => url.includes('/flags'))).toBe(false);
    },
  );

  it('says what makes a suggestion appear when none is open, and when they are switched off', async () => {
    mockApi(
      routes({
        [OPEN]: ok(suggestionPageFixture([])),
        [FLAGS]: ok(suggestionsFlagFixture(false)),
      }),
    );
    renderWithQuery(<SuggestionsPage />);
    const empty = await screen.findByTestId('suggestions-empty');
    expect(empty).toHaveTextContent('No suggestions are open');
    expect(empty).toHaveTextContent(
      'One appears when a statement or quarterly report is approved for a position with no mark for that quarter.',
    );
    expect(await screen.findByTestId('suggestions-off')).toHaveTextContent(
      'Suggestions are switched off. Open ones can be read and dismissed.',
    );
    expect(screen.getByText('0 open')).toBeInTheDocument();
  });

  it('shows the workings of the suggestion in the address: the rule, each input with its source and both checks', async () => {
    mockApi(routes());
    route.search = { id: SUGGESTION_ID.statement };
    renderWithQuery(<SuggestionsPage />);
    const card = await screen.findByTestId('suggestion-detail');
    expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Meridian Data Partners, Jun 30, 2025',
    );
    const tiles = within(card).getByTestId('suggestion-tiles');
    const tile = (name: string): HTMLElement => within(tiles).getByRole('group', { name });
    expect(within(tile('Suggested mark')).getByText('$20.9M')).toBeInTheDocument();
    expect(within(tile('Suggested mark')).getByText('Sponsor mark')).toBeInTheDocument();
    expect(within(tile('Current mark')).getByText('$18.4M')).toBeInTheDocument();
    expect(within(tile('Change')).getByText('13.7%')).toBeInTheDocument();
    expect(tile('Change')).toHaveAttribute('data-tone', 'watch');
    expect(within(tile('Net of flows')).getByText('4.7%')).toBeInTheDocument();

    expect(within(card).getByTestId('suggestion-rule')).toHaveTextContent(
      'The ending capital balance on the capital account statement.',
    );
    expect(within(card).getByText('Read as our own account.')).toBeInTheDocument();
    const inputs = within(card).getByRole('table', { name: 'Inputs' });
    const balance = within(inputs).getByText('Ending capital balance').closest('tr')!;
    expect(within(balance).getByText('$20,940,000.00')).toBeInTheDocument();
    expect(
      within(balance).getByRole('button', { name: new RegExp(`^From ${STATEMENT_FILE}, page 1`) }),
    ).toHaveAttribute('aria-expanded', 'false');

    const checks = within(card).getByRole('list', { name: 'Checks on the statement' });
    expect(within(checks).getByText('The lines add up.')).toBeInTheDocument();
    expect(
      within(checks).getByText('Contributions to date: statement $12.40M, record $12.40M.'),
    ).toBeInTheDocument();
    expect(
      within(card).getByText('No other source is on hand for this quarter.'),
    ).toBeInTheDocument();
    // The row is in the list, so it is not read a second time.
    expect(suggestionRequests()).toEqual([[OPEN, 'GET']]);
    expect(screen.getByText('Shown above')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Close' })).toHaveAttribute(
      'href',
      '/valuations/suggestions',
    );
  });

  it('flags a statement that does not tie and whose contributions differ, without holding the value back', async () => {
    const flagged = suggestionFixture({
      checks: {
        ties: false,
        tieDifference: '-50000',
        tieToleranceUsd: '25000',
        ownAccount: true,
        contributionsCheck: {
          statement: '30000000',
          record: '12400000',
          difference: '17600000',
          differencePct: '1.4193548387',
          differs: true,
          notChecked: null,
        },
      },
      comparison: {
        change: '2520000',
        changePct: '0.1368078176',
        variance: true,
        netOfFlows: null,
        netOfFlowsPct: null,
        beginningBalance: '18400000',
      },
      flags: {
        variance: true,
        ties: false,
        contributionsDiffer: true,
        sourcesDiffer: false,
        editedByReviewer: false,
      },
    });
    mockApi(routes({ [OPEN]: ok(suggestionPageFixture([flagged])) }));
    route.search = { id: SUGGESTION_ID.statement };
    renderWithQuery(<SuggestionsPage />);
    const card = await screen.findByTestId('suggestion-detail');
    const checks = within(card).getByRole('list', { name: 'Checks on the statement' });
    expect(within(checks).getByText(/The lines are \$50,000 apart\./)).toBeInTheDocument();
    expect(
      within(checks).getByText(/Contributions to date: statement \$30\.00M, record \$12\.40M\./),
    ).toBeInTheDocument();
    expect(
      within(checks).getByText(
        /The statement opens the quarter at \$18\.40M; the mark on record is \$18\.42M/,
      ),
    ).toBeInTheDocument();
    expect(
      within(card).getByText('A check never changes the suggested value.'),
    ).toBeInTheDocument();
    expect(within(card).getAllByText('Does not tie').length).toBeGreaterThan(0);
    expect(within(card).getAllByText('Contributions differ').length).toBeGreaterThan(0);
    // The value stands and can be acted on.
    expect(within(card).getByText('$20.9M')).toBeInTheDocument();
    expect(button('Open a draft valuation')).toBeEnabled();
  });

  it('sets a report-based suggestion beside the statement, and names where each figure came from', async () => {
    mockApi(routes());
    route.search = { id: SUGGESTION_ID.report };
    renderWithQuery(<SuggestionsPage />);
    const card = await screen.findByTestId('suggestion-detail');
    expect(within(card).getByTestId('suggestion-rule')).toHaveTextContent(
      'The last Locked mark, scaled by the change in equity value (enterprise value less net debt).',
    );
    const inputs = within(card).getByRole('table', { name: 'Inputs' });
    expect(within(inputs).getByRole('link', { name: 'Locked mark, Mar 28, 2025' })).toHaveAttribute(
      'href',
      `/valuations/${VAL_ID.priorOther}`,
    );
    expect(within(inputs).getAllByText('From the record')).toHaveLength(2);
    expect(within(inputs).getByText('Typed by the reviewer')).toBeInTheDocument();
    expect(within(inputs).getByText('$428,050,000.00')).toBeInTheDocument();
    expect(
      within(inputs).getByRole('button', { name: new RegExp(`^From ${REPORT_FILE}, page 3`) }),
    ).toBeInTheDocument();
    // A report has no lines to add up.
    expect(within(card).queryByText('Checks on the statement')).not.toBeInTheDocument();
    const others = within(card).getByRole('list', { name: 'Other sources for this quarter' });
    expect(
      within(others).getByText(
        "Capital account statement: $7.81M, $21,633 (0.3%) below the report's indication.",
      ),
    ).toBeInTheDocument();
    expect(within(others).queryByText('Sources differ')).not.toBeInTheDocument();
  });

  it('shows the placeholder and the reason for a suggestion that is not calculable, and offers only its dismissal', async () => {
    mockApi(routes({ [OPEN]: ok(suggestionPageFixture([notCalculableFixture()])) }));
    route.search = { id: SUGGESTION_ID.notCalculable };
    renderWithQuery(<SuggestionsPage />);
    const card = await screen.findByTestId('suggestion-detail');
    const tiles = within(card).getByTestId('suggestion-tiles');
    const suggested = within(tiles).getByRole('group', { name: 'Suggested mark' });
    expect(within(suggested).getByText('-')).toHaveClass('is-missing');
    expect(within(suggested).getByText('Not calculable this quarter')).toBeInTheDocument();
    expect(within(card).getByTestId('suggestion-not-calculable')).toHaveTextContent(
      'Not calculable this quarter. No ending balance for our account in US dollars was accepted from the statement.',
    );
    expect(within(card).getByText('No input was read for this rule.')).toBeInTheDocument();
    // With no value nothing was read as our own account, so the page does not say it was.
    expect(within(card).queryByText('Read as our own account.')).not.toBeInTheDocument();
    expect(
      within(card).getByText(
        'Contributions not checked: no contributions to date were accepted from the statement.',
      ),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(
        'Sponsor report: no value. Cash has moved since the last Locked mark.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open a draft valuation' }),
    ).not.toBeInTheDocument();
    expect(button('Dismiss')).toBeEnabled();
    const row = within(screen.getByTestId('suggestions-table'))
      .getByText('Ashby Industrial Holdings')
      .closest('tr')!;
    expect(within(row).getByText('Not calculable')).toBeInTheDocument();
    expect(within(row).queryByText('$0.0M')).not.toBeInTheDocument();
  });

  it(
    'draws the page an input was read from, with its quote highlighted, once asked',
    TIMEOUT,
    async () => {
      const run = statementDetailFixture({ stage: 'approved' });
      mockApi(routes({ [`/api/v1/extraction/runs/${SOURCE.statementRun}`]: ok(run) }));
      route.search = { id: SUGGESTION_ID.statement };
      renderWithQuery(<SuggestionsPage />);
      await screen.findByTestId('suggestion-detail');
      expect(sentRequests().some(([url]) => url.includes('/extraction/runs/'))).toBe(false);
      const source = screen.getByRole('button', {
        name: new RegExp(`^From ${STATEMENT_FILE}, page 1`),
      });
      await userEvent.click(source);
      expect(await screen.findByTestId('suggestion-page-note')).toHaveTextContent(
        `Highlighting Ending capital balance on page 1 of ${STATEMENT_FILE}.`,
      );
      expect(screen.getByRole('img', { name: /^Page 1 of / })).toBeInTheDocument();
      expect(screen.getAllByTestId('run-page-highlight').length).toBeGreaterThan(0);
      expect(source).toHaveAttribute('aria-expanded', 'true');
      await userEvent.click(source);
      expect(screen.queryByTestId('suggestion-page-note')).not.toBeInTheDocument();
    },
  );

  it(
    'opens a draft valuation after the confirmation, with the flags in words and the row version',
    TIMEOUT,
    async () => {
      const accepted = suggestionFixture({
        state: 'Accepted',
        decidedBy: PERSON.ops,
        decidedAt: '2025-08-02T09:00:00.000Z',
        valuationId: VAL_ID.draft,
        rowVersion: 2,
      });
      mockApi(routes({ [commandPath(SUGGESTION_ID.statement)]: ok(accepted) }));
      route.search = { id: SUGGESTION_ID.statement };
      renderWithQuery(<SuggestionsPage />);
      await screen.findByTestId('suggestion-detail');
      await userEvent.click(button('Open a draft valuation'));
      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByText(
          'This opens a draft valuation at $20.9M for Jun 30, 2025. It still has to be prepared and approved before it is locked.',
        ),
      ).toBeInTheDocument();
      const flags = within(dialog).getByRole('list', { name: 'Flags on this suggestion' });
      expect(within(flags).getAllByRole('listitem')).toHaveLength(1);
      expect(
        within(flags).getByText(
          "The change against the previous quarter's mark is at or above 10.0%.",
        ),
      ).toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Open a draft valuation' }));
      await waitFor(() =>
        expect(screen.getByTestId('suggestion-action-status')).toHaveTextContent(
          'Draft valuation opened at $20.9M for Meridian Data Partners, Jun 30, 2025 (audited)',
        ),
      );
      const posts = sentRequests().filter(([, method]) => method === 'POST');
      expect(posts).toEqual([
        [commandPath(SUGGESTION_ID.statement), 'POST', { command: 'accept' }],
      ]);
      expect(ifMatchOf('POST')).toBe('"1"');
      // The lists are read again after the decision.
      await waitFor(() =>
        expect(suggestionRequests().filter(([url]) => url === OPEN).length).toBeGreaterThan(1),
      );
    },
  );

  it(
    'puts the value on the Draft already open for the quarter, and says the draft keeps its date',
    TIMEOUT,
    async () => {
      const withDraft = suggestionFixture({
        inProgress: {
          valuationId: VAL_ID.draft,
          periodEnd: '2025-06-27',
          version: 1,
          state: 'Draft',
          method: 'valuation_method.market_multiple',
          fairValue: '19000000.00',
          rowVersion: 4,
        },
        rowVersion: 3,
      });
      mockApi(
        routes({
          [OPEN]: ok(suggestionPageFixture([withDraft])),
          [commandPath(SUGGESTION_ID.statement)]: ok({ ...withDraft, state: 'Accepted' }),
        }),
      );
      route.search = { id: SUGGESTION_ID.statement };
      renderWithQuery(<SuggestionsPage />);
      const card = await screen.findByTestId('suggestion-detail');
      expect(
        screen.queryByRole('button', { name: 'Open a draft valuation' }),
      ).not.toBeInTheDocument();
      expect(
        within(card).getByRole('link', { name: '$19.0M, Market multiple, dated Jun 27, 2025' }),
      ).toHaveAttribute('href', `/valuations/${VAL_ID.draft}`);
      await userEvent.click(button('Use this value on the draft'));
      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByText(
          'This puts $20.9M and the method Sponsor mark on the draft dated Jun 27, 2025. The draft keeps its date.',
        ),
      ).toBeInTheDocument();
      await userEvent.click(
        within(dialog).getByRole('button', { name: 'Use this value on the draft' }),
      );
      await waitFor(() =>
        expect(screen.getByTestId('suggestion-action-status')).toHaveTextContent(
          '$20.9M and the method Sponsor mark put on the draft for Meridian Data Partners, Jun 30, 2025 (audited)',
        ),
      );
      expect(sentRequests().filter(([, method]) => method === 'POST')).toEqual([
        [commandPath(SUGGESTION_ID.statement), 'POST', { command: 'applyToDraft' }],
      ]);
      expect(ifMatchOf('POST')).toBe('"3"');
    },
  );

  it('offers neither while a version for the quarter is being approved, and says to send it back', async () => {
    const blocked = suggestionFixture({
      inProgress: {
        valuationId: VAL_ID.prepared,
        periodEnd: '2025-06-30',
        version: 1,
        state: 'OpsPrepared',
        method: 'valuation_method.sponsor_mark',
        fairValue: '19000000.00',
        rowVersion: 2,
      },
    });
    mockApi(routes({ [OPEN]: ok(suggestionPageFixture([blocked])) }));
    route.search = { id: SUGGESTION_ID.statement };
    renderWithQuery(<SuggestionsPage />);
    await screen.findByTestId('suggestion-detail');
    const note = screen.getByTestId('suggestion-blocked');
    expect(note).toHaveTextContent(
      'A valuation for this quarter is being approved. Send it back to change it.',
    );
    expect(within(note).getByRole('link', { name: 'Open the valuation' })).toHaveAttribute(
      'href',
      `/valuations/${VAL_ID.prepared}`,
    );
    expect(
      screen.queryByRole('button', { name: 'Open a draft valuation' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Use this value on the draft' }),
    ).not.toBeInTheDocument();
    expect(button('Dismiss')).toBeEnabled();
  });

  it('dismisses with a reason of at least three characters', TIMEOUT, async () => {
    const dismissed = suggestionFixture({
      state: 'Dismissed',
      decidedBy: PERSON.ops,
      decidedAt: '2025-08-02T09:00:00.000Z',
      decisionReason: 'Statement is for the wrong vehicle',
      rowVersion: 2,
    });
    mockApi(routes({ [commandPath(SUGGESTION_ID.statement)]: ok(dismissed) }));
    route.search = { id: SUGGESTION_ID.statement };
    renderWithQuery(<SuggestionsPage />);
    await screen.findByTestId('suggestion-detail');
    await userEvent.click(button('Dismiss'));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Dismiss' });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'no');
    expect(submit).toBeDisabled();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      't ours: wrong vehicle',
    );
    await userEvent.click(submit);
    await waitFor(() =>
      expect(screen.getByTestId('suggestion-action-status')).toHaveTextContent(
        'Suggestion dismissed for Meridian Data Partners, Jun 30, 2025 (audited)',
      ),
    );
    expect(sentRequests().filter(([, method]) => method === 'POST')).toEqual([
      [
        commandPath(SUGGESTION_ID.statement),
        'POST',
        { command: 'dismiss', reason: 'not ours: wrong vehicle' },
      ],
    ]);
  });

  it(
    'says so and reads the list again when the figures behind a suggestion changed',
    TIMEOUT,
    async () => {
      mockApi(
        routes({
          [commandPath(SUGGESTION_ID.statement)]: {
            status: 409,
            body: {
              type: 'https://portfolio-beach.example/problems/conflict',
              title: 'Conflict',
              status: 409,
              detail: SUGGESTION_CHANGED_REFUSAL,
              request_id: 'test',
            },
          },
        }),
      );
      route.search = { id: SUGGESTION_ID.statement };
      renderWithQuery(<SuggestionsPage />);
      await screen.findByTestId('suggestion-detail');
      await userEvent.click(button('Open a draft valuation'));
      const dialog = await screen.findByRole('dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Open a draft valuation' }));
      await waitFor(() =>
        expect(screen.getByTestId('suggestion-action-status')).toHaveTextContent(
          'Meridian Data Partners, Jun 30, 2025: The figures behind this suggestion changed. It has been replaced or closed. The list is refreshed.',
        ),
      );
      await waitFor(() =>
        expect(suggestionRequests().filter(([url]) => url === OPEN).length).toBeGreaterThan(1),
      );
      expect(within(screen.getByTestId('action-log')).getByText('Refused')).toBeInTheDocument();
    },
  );

  it('keeps the two draft actions off while suggestions are switched off, and still lets one be dismissed', async () => {
    mockApi(routes({ [FLAGS]: ok(suggestionsFlagFixture(false)) }));
    route.search = { id: SUGGESTION_ID.statement };
    renderWithQuery(<SuggestionsPage />);
    await screen.findByTestId('suggestions-off');
    const open = button('Open a draft valuation');
    expect(open).toHaveAttribute('aria-disabled', 'true');
    expect(open).toHaveAttribute('title', 'Suggestions are switched off');
    await userEvent.click(open);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button('Dismiss')).not.toHaveAttribute('aria-disabled', 'true');
  });

  it.each(['deal_team', 'approver', 'auditor'] as const)(
    'lets a %s read the workings and offers no action',
    async (role) => {
      mockApi(routes({ [ME]: ok(rolePrincipal([role])) }));
      route.search = { id: SUGGESTION_ID.statement };
      renderWithQuery(<SuggestionsPage />);
      const card = await screen.findByTestId('suggestion-detail');
      expect(within(card).getByTestId('suggestion-workings')).toBeInTheDocument();
      expect(within(card).getByTestId('suggestion-read-only')).toHaveTextContent(
        'Operations decides a suggestion; your role reads it.',
      );
      expect(
        screen.queryByRole('button', { name: 'Open a draft valuation' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    },
  );

  it('reads a suggestion that is not in the list on its own, and says what became of it', async () => {
    const replaced = suggestionFixture({
      id: SUGGESTION_ID.report,
      state: 'Superseded',
      supersededReason: 'better_source',
      supersededById: SUGGESTION_ID.statement,
      decidedAt: '2025-08-02T09:00:00.000Z',
      rowVersion: 2,
    });
    mockApi(
      routes({
        [OPEN]: ok(suggestionPageFixture([suggestionFixture()])),
        [detailPath(SUGGESTION_ID.report)]: ok(replaced),
      }),
    );
    route.search = { id: SUGGESTION_ID.report };
    renderWithQuery(<SuggestionsPage />);
    const note = await screen.findByTestId('suggestion-decision');
    expect(note).toHaveTextContent('Replaced by a newer suggestion on Aug 2, 2025 09:00:00 UTC.');
    expect(within(note).getByRole('link', { name: 'Open the replacement' })).toHaveAttribute(
      'href',
      `/valuations/suggestions?id=${SUGGESTION_ID.statement}`,
    );
    // Nothing is left to decide on it.
    expect(screen.queryByTestId('suggestion-actions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('suggestion-read-only')).not.toBeInTheDocument();
    expect(suggestionRequests()).toEqual([
      [OPEN, 'GET'],
      [detailPath(SUGGESTION_ID.report), 'GET'],
    ]);
  });

  it('says a suggestion is not found when its position is outside the reader’s view', async () => {
    mockApi(routes());
    route.search = { id: SUGGESTION_ID.replacement };
    renderWithQuery(<SuggestionsPage />);
    expect(
      await screen.findByText('Suggestion not found or not visible to you'),
    ).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Valuation suggestions' })).toBeInTheDocument();
  });

  it('lists another state on request, with what became of each suggestion', TIMEOUT, async () => {
    const accepted = suggestionFixture({
      state: 'Accepted',
      decidedBy: PERSON.ops,
      decidedAt: '2025-08-02T09:00:00.000Z',
      valuationId: VAL_ID.draft,
    });
    const closed = reportSuggestionFixture({
      state: 'Superseded',
      supersededReason: 'mark_locked',
      decidedAt: '2025-08-03T09:00:00.000Z',
    });
    const replaced = notCalculableFixture({
      state: 'Superseded',
      supersededReason: 'better_source',
      supersededById: SUGGESTION_ID.replacement,
    });
    mockApi(
      routes({
        [`${OPEN}&state=all`]: ok(
          suggestionPageFixture([accepted, closed, replaced], { openCount: 2 }),
        ),
      }),
    );
    renderWithQuery(<SuggestionsPage />);
    await screen.findByRole('table', { name: 'Valuation suggestions' });
    await userEvent.click(screen.getByRole('combobox', { name: 'State' }));
    await userEvent.click(await screen.findByRole('option', { name: 'All states' }));
    const table = await screen.findByTestId('suggestions-table');
    await within(table).findByText('Accepted');
    expect(within(table).getByRole('columnheader', { name: 'State' })).toBeInTheDocument();
    const first = within(table).getByText('Meridian Data Partners').closest('tr')!;
    expect(within(first).getByRole('link', { name: 'Open the valuation' })).toHaveAttribute(
      'href',
      `/valuations/${VAL_ID.draft}`,
    );
    const second = within(table).getByText('Juniper Financial Group').closest('tr')!;
    expect(within(second).getByText('Replaced or closed')).toBeInTheDocument();
    expect(
      within(second).getByText('Closed: a mark for this quarter is Locked.'),
    ).toBeInTheDocument();
    const third = within(table).getByText('Ashby Industrial Holdings').closest('tr')!;
    expect(within(third).getByText('Replaced')).toBeInTheDocument();
    expect(within(third).getByRole('link', { name: 'Open the replacement' })).toHaveAttribute(
      'href',
      `/valuations/suggestions?id=${SUGGESTION_ID.replacement}&state=all`,
    );
    // The count of open suggestions is the caller's, whatever the filter.
    expect(screen.getByText('2 open')).toBeInTheDocument();
  });
});
