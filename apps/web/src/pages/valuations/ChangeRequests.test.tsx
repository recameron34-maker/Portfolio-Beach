import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { latestQuarterEndOnOrBefore } from '@pb/calc';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import { AS_OF, dataHealthFixture } from '../../test/fixtures.js';
import {
  changeRequestPageFixture,
  changeRequestRowFixture,
  changeRequestRows,
  changeTypeTaxonomyFixture,
  CR_ID,
  mockUsersFixture,
  PERSON,
  POSITION_ID,
  quarterEndCheckFixture,
  refusalFixture,
  rolePrincipal,
  sentPosts,
  sentRequests,
  USER_ID,
} from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { clearTaxonomyLabels, registerTaxonomyLabels } from '../../lib/format.js';
import { ChangeRequestsPage } from './ChangeRequests.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

/** The shell registers the taxonomy labels for labelOf; the tests register the change types the same way. */
beforeAll(() =>
  registerTaxonomyLabels(changeTypeTaxonomyFixture().domains.flatMap((d) => d.terms)),
);
afterAll(() => clearTaxonomyLabels());

const ME = '/api/v1/auth/me';
const LIST = '/api/v1/change-requests?limit=200';
const USERS = '/api/v1/auth/mock-users';
const CHECK = '/api/v1/change-requests/quarter-end-check';
const HEALTH = '/api/v1/data-health';
const commandsPath = (id: string): string => `/api/v1/change-requests/${id}/commands`;
/** Dialog and dropdown journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

/**
 * The record's day is the API's day (data health carries it): 2025-06-30 here, whatever the
 * clock of the machine running the tests says, so the quarter ends offered are the same always.
 */
function routes(
  roles: Parameters<typeof rolePrincipal>[0],
  overrides: MockRoutes = {},
): MockRoutes {
  return {
    [ME]: ok(rolePrincipal(roles)),
    [LIST]: ok(changeRequestPageFixture()),
    [USERS]: ok(mockUsersFixture()),
    [HEALTH]: ok({ ...dataHealthFixture(), asOf: AS_OF }),
    ...overrides,
  };
}

/** A 422 the way the API words a refused precondition of a change request command. */
const refused = (detail: string) => ({ status: 422, body: refusalFixture(422, detail) });

const tile = (name: string): HTMLElement =>
  within(screen.getByTestId('change-request-tiles')).getByRole('group', { name });

const table = (): HTMLElement => screen.getByRole('table', { name: 'Change requests' });

const rowOf = (text: string): HTMLElement => {
  const row = within(table()).getByText(text).closest('tr');
  if (row === null) throw new Error(`no row holds ${text}`);
  return row;
};

const button = (name: string): HTMLElement => screen.getByRole('button', { name });

async function pick(combobox: HTMLElement, option: string): Promise<void> {
  await userEvent.click(combobox);
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

async function dialogClosed(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await screen.findByRole('status');
}

describe('change request queue', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists every request with its tiles, people and state, and offers operations its commands', async () => {
    mockApi(routes(['operations']));
    renderWithQuery(<ChangeRequestsPage />);
    expect(await screen.findByTestId('change-requests-table')).toBe(table());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Change requests');
    expect(within(table()).getAllByRole('row')).toHaveLength(6);
    expect(screen.getByText('5 of 5 requests')).toBeInTheDocument();
    expect(within(tile('Submitted')).getByText('1')).toBeInTheDocument();
    expect(tile('Submitted')).toHaveAttribute('data-tone', 'watch');
    expect(within(tile('Routed')).getByText('1')).toBeInTheDocument();
    expect(within(tile('In progress')).getByText('1')).toBeInTheDocument();
    expect(within(tile('Applied')).getByText('1')).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Valuations' });
    expect(within(tabs).getByRole('link', { name: 'Board' })).toHaveAttribute(
      'href',
      '/valuations',
    );

    const routed = rowOf('Dividend recapitalization with a new term loan');
    expect(
      within(routed).getByRole('link', { name: 'Silverline Staffing Holdings' }),
    ).toHaveAttribute('href', `/portfolio/${POSITION_ID.silverline}`);
    expect(within(routed).getByText('Recapitalization')).toBeInTheDocument();
    expect(within(routed).getByText('Effective Apr 30, 2025')).toBeInTheDocument();
    expect(within(routed).getByText('Avery Mbeki')).toBeInTheDocument();
    expect(within(routed).getByText('Blake Okafor')).toBeInTheDocument();
    expect(within(routed).getByText('Jun 10, 2025')).toBeInTheDocument();
    expect(within(routed).getByText('Routed')).toHaveClass('pb-badge-brand');
    expect(
      within(routed).getByRole('button', {
        name: 'Start, Recapitalization for Silverline Staffing Holdings',
      }),
    ).toBeEnabled();
    expect(
      within(routed).getByRole('button', {
        name: 'Reject, Recapitalization for Silverline Staffing Holdings',
      }),
    ).toBeEnabled();

    // Routing belongs to the deal team (docs/18 section 8); operations sees why.
    const submitted = rowOf('Add-on acquisition of a regional competitor closed');
    const route = within(submitted).getByRole('button', {
      name: 'Route, Add-on acquisition for Meridian Data Partners',
    });
    expect(route).toBeDisabled();
    expect(route).toHaveAttribute('title', 'Needs deal team or service');
    expect(within(submitted).getByText('-')).toBeInTheDocument();
    expect(within(submitted).getByText('Submitted')).toHaveClass('pb-badge-watch');

    const applied = rowOf('Partial exit of a fifth of the holding to a strategic buyer');
    expect(within(applied).getByText('Applied')).toHaveClass('pb-badge-good');
    expect(within(applied).getByText('Mar 31, 2025')).toBeInTheDocument();
    expect(within(applied).getByText('None')).toBeInTheDocument();
    const rejected = rowOf('Interest payment to be treated as a distribution');
    expect(within(rejected).getByText('Rejected')).toHaveClass('pb-badge-bad');
    expect(within(rejected).getByText('Already reflected in the record')).toBeInTheDocument();
    expect(screen.getAllByTestId('change-request-actions')).toHaveLength(5);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x2014));
  });

  it(
    'filters by state and position in the browser over the one unfiltered page',
    TIMEOUT,
    async () => {
      mockApi(routes(['operations']));
      renderWithQuery(<ChangeRequestsPage />);
      await screen.findByTestId('change-requests-table');
      await pick(screen.getByRole('combobox', { name: 'State' }), 'In progress');
      expect(within(table()).getAllByRole('row')).toHaveLength(2);
      expect(within(table()).getByText('Cobalt Energy Group')).toBeInTheDocument();
      expect(screen.getByText('1 of 5 requests')).toBeInTheDocument();
      await pick(screen.getByRole('combobox', { name: 'State' }), 'All states');
      await pick(screen.getByRole('combobox', { name: 'Position' }), 'Ashby Renewables Group');
      expect(within(table()).getAllByRole('row')).toHaveLength(2);
      await pick(screen.getByRole('combobox', { name: 'State' }), 'Submitted');
      expect(screen.getByTestId('change-requests-empty')).toHaveTextContent(
        'No requests match these filters',
      );
      const urls = sentRequests().map(([url]) => url);
      expect(urls.filter((u) => u.startsWith('/api/v1/change-requests'))).toEqual([LIST]);
    },
  );

  it('lets the deal team route a submitted request to an operations owner', TIMEOUT, async () => {
    mockApi(
      routes(['deal_team'], {
        [commandsPath(CR_ID.submitted)]: ok(
          changeRequestRowFixture({ state: 'Routed', owner: PERSON.opsTwo, rowVersion: 2 }),
        ),
      }),
    );
    renderWithQuery(<ChangeRequestsPage />);
    await screen.findByTestId('change-requests-table');
    const start = screen.getByRole('button', {
      name: 'Start, Recapitalization for Silverline Staffing Holdings',
    });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute('title', 'Needs operations');
    await userEvent.click(button('Route, Add-on acquisition for Meridian Data Partners'));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Route' });
    expect(submit).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('combobox', { name: /Owner/ }));
    // Operations users only, each once: the two from the mock list (the row owner is one of them).
    const offered = await screen.findAllByRole('option');
    expect(offered.map((o) => o.textContent)).toEqual(['Avery Mbeki', 'Rowan Castellanos']);
    await userEvent.click(screen.getByRole('option', { name: 'Rowan Castellanos' }));
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await dialogClosed();
    expect(
      await within(screen.getByRole('status')).findByText(
        'Add-on acquisition for Meridian Data Partners is now Routed (audited)',
      ),
    ).toHaveClass('pb-notice-good');
    expect(sentPosts()).toEqual([
      [commandsPath(CR_ID.submitted), { command: 'route', ownerId: USER_ID.opsTwo }],
    ]);
  });

  it(
    'lets operations start, apply in a quarter end on or after the effective date, and reject',
    TIMEOUT,
    async () => {
      const rows = changeRequestRows();
      const inProgress = rows.find((r) => r.id === CR_ID.inProgress)!;
      mockApi(
        routes(['operations'], {
          [commandsPath(CR_ID.routed)]: (url) => {
            void url;
            return ok(changeRequestRowFixture({ ...rows[1]!, state: 'InProgress', rowVersion: 3 }));
          },
          [commandsPath(CR_ID.inProgress)]: ok(
            changeRequestRowFixture({
              ...inProgress,
              state: 'Applied',
              appliedPeriod: '2025-03-31',
              appliedBy: PERSON.ops,
              rowVersion: 4,
            }),
          ),
        }),
      );
      renderWithQuery(<ChangeRequestsPage />);
      await screen.findByTestId('change-requests-table');

      await userEvent.click(button('Start, Recapitalization for Silverline Staffing Holdings'));
      expect(
        await within(screen.getByRole('status')).findByText(
          'Recapitalization for Silverline Staffing Holdings is now In progress (audited)',
        ),
      ).toBeInTheDocument();

      await userEvent.click(button('Apply, New security for Cobalt Energy Group'));
      const apply = await screen.findByRole('dialog');
      expect(
        within(apply).getByText(/on or after the effective date, Mar 31, 2025/),
      ).toBeInTheDocument();
      // The effective date's own quarter is the earliest offered (the API refuses an earlier
      // one) and the quarter of the record's day the latest (it refuses a later one, CR-6):
      // nothing after it, whatever the clock of this machine says.
      await userEvent.click(within(apply).getByRole('combobox', { name: /Quarter end/ }));
      const offered = await screen.findAllByRole('option');
      expect(offered.map((o) => o.textContent)).toEqual(['Jun 30, 2025', 'Mar 31, 2025']);
      await userEvent.click(screen.getByRole('option', { name: 'Mar 31, 2025' }));
      await userEvent.click(within(apply).getByRole('button', { name: 'Apply' }));
      await dialogClosed();
      expect(
        await within(screen.getByRole('status')).findByText(
          'New security for Cobalt Energy Group is now Applied (audited)',
        ),
      ).toBeInTheDocument();

      await userEvent.click(button('Reject, Recapitalization for Silverline Staffing Holdings'));
      const reject = await screen.findByRole('dialog');
      await userEvent.type(
        within(reject).getByRole('textbox', { name: /Reason/ }),
        'Already recorded',
      );
      await userEvent.click(within(reject).getByRole('button', { name: 'Reject' }));
      await dialogClosed();
      expect(sentPosts()).toEqual([
        [commandsPath(CR_ID.routed), { command: 'start' }],
        [commandsPath(CR_ID.inProgress), { command: 'apply', appliedPeriod: '2025-03-31' }],
        [commandsPath(CR_ID.routed), { command: 'reject', reason: 'Already recorded' }],
      ]);
    },
  );

  it('words a refusal through describeActionError', async () => {
    mockApi(
      routes(['operations'], {
        [commandsPath(CR_ID.routed)]: {
          status: 422,
          body: refusalFixture(422, 'deal_change_request: the owner is not a known active user'),
        },
      }),
    );
    renderWithQuery(<ChangeRequestsPage />);
    await screen.findByTestId('change-requests-table');
    await userEvent.click(button('Start, Recapitalization for Silverline Staffing Holdings'));
    expect(
      await within(screen.getByRole('status')).findByText(
        'Start for Recapitalization for Silverline Staffing Holdings: Blocked by a rule. The owner is not a known active user',
      ),
    ).toHaveClass('pb-notice-bad');
    expect(
      within(screen.getByRole('list', { name: 'Actions this session' })).getByText('Refused'),
    ).toBeInTheDocument();
  });

  it('runs the quarter-end check for operations and shows the unapplied requests and the exceptions opened', async () => {
    mockApi(routes(['operations'], { [CHECK]: ok(quarterEndCheckFixture()) }));
    renderWithQuery(<ChangeRequestsPage />);
    await screen.findByTestId('change-requests-table');
    const card = screen.getByTestId('quarter-end-check');
    const run = within(card).getByRole('button', { name: 'Run quarter-end check' });
    expect(run).toBeEnabled();
    await userEvent.click(run);
    const result = await screen.findByTestId('quarter-end-result');
    expect(result).toHaveTextContent(
      'Jun 30, 2025: 3 requests not applied, 2 data exceptions opened.',
    );
    expect(within(result).getByRole('link', { name: 'Open the exceptions queue' })).toHaveAttribute(
      'href',
      '/data/exceptions',
    );
    const unapplied = within(result).getByRole('table', { name: 'Unapplied change requests' });
    expect(within(unapplied).getAllByRole('row')).toHaveLength(4);
    expect(within(unapplied).getByText('In progress')).toHaveClass('pb-badge-brand');
    // The latest quarter end on or before the record's day is offered first and sent unless
    // another is picked.
    expect(sentPosts()).toEqual([[CHECK, { periodEnd: AS_OF }]]);
    expect(
      within(screen.getByRole('status')).getByText(
        'Quarter-end check for Jun 30, 2025: 3 requests not applied, 2 data exceptions opened (audited)',
      ),
    ).toBeInTheDocument();
    // Nothing is hidden from this caller, so nothing is said about hidden requests.
    expect(screen.queryByTestId('quarter-end-hidden')).not.toBeInTheDocument();
  });

  it('says how many unapplied requests the caller cannot see, without naming them (CR-2)', async () => {
    mockApi(routes(['operations'], { [CHECK]: ok(quarterEndCheckFixture(2)) }));
    renderWithQuery(<ChangeRequestsPage />);
    await screen.findByTestId('change-requests-table');
    await userEvent.click(button('Run quarter-end check'));
    const result = await screen.findByTestId('quarter-end-result');
    // Three listed, two hidden: the run opened an exception for each of the five still missing one.
    expect(result).toHaveTextContent(
      'Jun 30, 2025: 3 requests not applied, 4 data exceptions opened.',
    );
    expect(within(result).getByTestId('quarter-end-hidden')).toHaveTextContent(
      '2 more requests not applied are on positions you cannot see. They are not listed here; each has a data exception that people who can see the position work.',
    );
    expect(
      within(result).getByRole('table', { name: 'Unapplied change requests' }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('status')).getByText(
        'Quarter-end check for Jun 30, 2025: 3 requests not applied, 2 more not visible to you, 4 data exceptions opened (audited)',
      ),
    ).toBeInTheDocument();
  });

  it('says so when every unapplied request is on a position the caller cannot see', async () => {
    mockApi(
      routes(['operations'], {
        [CHECK]: ok({ periodEnd: AS_OF, unapplied: [], hidden: 1, exceptionsOpened: 1 }),
      }),
    );
    renderWithQuery(<ChangeRequestsPage />);
    await screen.findByTestId('change-requests-table');
    await userEvent.click(button('Run quarter-end check'));
    const result = await screen.findByTestId('quarter-end-result');
    expect(within(result).getByTestId('quarter-end-hidden')).toHaveTextContent(
      '1 more request not applied is on a position you cannot see.',
    );
    // Not "every request is applied": one is not, and the caller is told as much.
    expect(within(result).queryByText('Every request is applied')).not.toBeInTheDocument();
    expect(
      within(result).getByText('No unapplied request on the positions you can see'),
    ).toBeInTheDocument();
  });

  it('falls back to the day of this machine when the record day cannot be read', async () => {
    mockApi(
      routes(['operations'], {
        [HEALTH]: failing(404, HEALTH),
        [CHECK]: ok(quarterEndCheckFixture()),
      }),
    );
    renderWithQuery(<ChangeRequestsPage />);
    await screen.findByTestId('change-requests-table');
    await userEvent.click(button('Run quarter-end check'));
    await screen.findByTestId('quarter-end-result');
    const today = new Date().toISOString().slice(0, 10);
    expect(sentPosts()).toEqual([[CHECK, { periodEnd: latestQuarterEndOnOrBefore(today) }]]);
  });

  it('offers no quarter for a request that takes effect after the current quarter, and says why (CR-6)', async () => {
    const later = changeRequestRowFixture({
      id: CR_ID.inProgress,
      investmentId: POSITION_ID.cobalt,
      investmentName: 'Cobalt Energy Group',
      changeType: 'change_type.new_security',
      effectiveDate: '2025-08-15',
      owner: PERSON.ops,
      state: 'InProgress',
      rowVersion: 3,
    });
    mockApi(routes(['operations'], { [LIST]: ok(changeRequestPageFixture([later])) }));
    renderWithQuery(<ChangeRequestsPage />);
    await screen.findByTestId('change-requests-table');
    await userEvent.click(button('Apply, New security for Cobalt Energy Group'));
    const apply = await screen.findByRole('dialog');
    expect(
      within(apply).getByText(
        'This change takes effect on Aug 15, 2025, after the current quarter end, Jun 30, 2025, so it cannot be applied yet.',
      ),
    ).toBeInTheDocument();
    expect(within(apply).getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(within(apply).getByRole('combobox', { name: /Quarter end/ })).toBeDisabled();
    expect(sentPosts()).toEqual([]);
  });

  it(
    'keeps the route dialog open when the owner is outside the wall of the position, so another owner can be named (CR-3)',
    TIMEOUT,
    async () => {
      const answers = [
        refused(
          'deal_change_request: the owner is outside the wall of this position and could not open the request; name an owner inside the wall',
        ),
        ok(changeRequestRowFixture({ state: 'Routed', owner: PERSON.opsTwo, rowVersion: 2 })),
      ];
      mockApi(
        routes(['deal_team'], {
          [commandsPath(CR_ID.submitted)]: () => answers.shift() ?? failing(404, 'x'),
        }),
      );
      renderWithQuery(<ChangeRequestsPage />);
      await screen.findByTestId('change-requests-table');
      await userEvent.click(button('Route, Add-on acquisition for Meridian Data Partners'));
      const dialog = await screen.findByRole('dialog');
      await pick(within(dialog).getByRole('combobox', { name: /Owner/ }), 'Avery Mbeki');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Route' }));
      // The refusal is shown where the owner is chosen, in plain words; the dialog stays open.
      expect(
        await within(dialog).findByText(
          'Blocked by a rule. The owner is outside the wall of this position and could not open the request; name an owner inside the wall',
        ),
      ).toHaveClass('pb-notice-bad');
      expect(screen.getByRole('dialog')).toBe(dialog);
      await pick(within(dialog).getByRole('combobox', { name: /Owner/ }), 'Rowan Castellanos');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Route' }));
      await dialogClosed();
      expect(
        await within(screen.getByRole('status')).findByText(
          'Add-on acquisition for Meridian Data Partners is now Routed (audited)',
        ),
      ).toHaveClass('pb-notice-good');
      expect(sentPosts()).toEqual([
        [commandsPath(CR_ID.submitted), { command: 'route', ownerId: USER_ID.ops }],
        [commandsPath(CR_ID.submitted), { command: 'route', ownerId: USER_ID.opsTwo }],
      ]);
      // Both attempts are in the session list: the refusal and the routing.
      expect(
        within(screen.getByRole('list', { name: 'Actions this session' })).getByText('Refused'),
      ).toBeInTheDocument();
    },
  );

  it('blocks the quarter-end check for the deal team, naming the role it needs', async () => {
    mockApi(routes(['deal_team']));
    renderWithQuery(<ChangeRequestsPage />);
    await screen.findByTestId('change-requests-table');
    const run = within(screen.getByTestId('quarter-end-check')).getByRole('button', {
      name: 'Run quarter-end check',
    });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', 'Needs operations');
  });

  it('says who may read the queue when the role may not, and when the queue is empty', async () => {
    mockApi(routes(['viewer'], { [LIST]: failing(403, '/api/v1/change-requests') }));
    const first = renderWithQuery(<ChangeRequestsPage />);
    expect(
      await screen.findByText(
        'Change requests are for the deal team, operations, approvers and auditors',
      ),
    ).toBeInTheDocument();
    first.unmount();
    vi.restoreAllMocks();
    mockApi(routes(['operations'], { [LIST]: ok(changeRequestPageFixture([])) }));
    renderWithQuery(<ChangeRequestsPage />);
    expect(await screen.findByTestId('change-requests-empty')).toHaveTextContent(
      'No change requests',
    );
  });

  it('says only the first page is shown and gives the tiles the missing placeholder', async () => {
    mockApi(routes(['operations'], { [LIST]: ok(changeRequestPageFixture(undefined, 'next')) }));
    renderWithQuery(<ChangeRequestsPage />);
    expect(await screen.findByTestId('change-requests-truncated')).toHaveTextContent(
      'Showing the first 200 change requests; more exist.',
    );
    expect(within(tile('Submitted')).getByText('-')).toBeInTheDocument();
  });
});
