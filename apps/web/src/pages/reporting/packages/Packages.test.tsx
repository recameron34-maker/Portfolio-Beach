import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MockResponse, MockRoutes } from '../../../test/api-mock.js';
import { failing, mockApi, ok } from '../../../test/api-mock.js';
import {
  CLIENT_ID,
  packageClientsFixture,
  packageDetailFixture,
  packageListFixture,
  packageRowFixture,
  packageRows,
  PKG_ID,
  PKG_PERIOD,
  PKG_PRIOR_PERIOD,
} from '../../../test/fixtures-packages.js';
import {
  refusalFixture,
  rolePrincipal,
  sentPosts,
  sentRequests,
} from '../../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../../test/render.js';
import { navigate } from '../../../test/router-mock.js';
import { PackagesPage } from './Packages.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../../test/router-mock.js')).routerMock(),
);

const PACKAGES = '/api/v1/report-packages';
const ME = '/api/v1/auth/me';
const CLIENTS = '/api/v1/clients';

/** An identifier a page must never show: a rule code, or a uuid. */
const IDENTIFIER = /QA-[A-Z]+-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The list for a read and `created` for the POST that starts a package at the same address. */
const listAnd =
  (list: MockResponse, created: MockResponse) =>
  (_url: URL, method: string): MockResponse =>
    method === 'POST' ? created : list;

function open(roles: Parameters<typeof rolePrincipal>[0], extra: MockRoutes = {}): void {
  mockApi({
    [ME]: ok(rolePrincipal(roles)),
    [PACKAGES]: ok(packageListFixture()),
    [CLIENTS]: ok(packageClientsFixture()),
    ...extra,
  });
  renderWithQuery(<PackagesPage />);
}

const rowsOf = (table: HTMLElement): HTMLElement[] => within(table).getAllByRole('row').slice(1);

async function pick(scope: HTMLElement, combobox: string, option: string): Promise<void> {
  await userEvent.click(within(scope).getByRole('combobox', { name: combobox }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

/** Opens the start form as investor relations and waits for the client list behind it. */
async function openStartForm(extra: MockRoutes = {}): Promise<HTMLElement> {
  open(['investor_relations'], extra);
  await userEvent.click(await screen.findByRole('button', { name: 'Start package' }, TIMEOUT));
  const form = screen.getByTestId('package-start-form');
  // The quarter is chosen for the reader once the client list has answered with its as-of date.
  await waitFor(() =>
    expect(within(form).getByRole('combobox', { name: 'Quarter' })).toHaveValue('Q2 2025'),
  );
  return form;
}

const startPosts = (): unknown[] =>
  sentPosts()
    .filter(([url]) => url === PACKAGES)
    .map(([, body]) => body);

/** Opening dropdowns through userEvent takes a while under a full-suite load. */
const TIMEOUT = { timeout: 20_000 };

describe('the client packages list', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    navigate.mockReset();
  });

  it('lists every package newest quarter first, with its state, its checks and who prepared it', async () => {
    open(['auditor']);
    const table = await screen.findByRole('table', { name: 'Client packages' });
    expect(screen.getByRole('heading', { level: 1, name: 'Client packages' })).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Reporting' });
    expect(within(tabs).getByRole('link', { name: 'Packages' })).toHaveAttribute(
      'href',
      '/reporting/packages',
    );
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Client', 'Quarter', 'State', 'Checks', 'Basis', 'Label', 'Version', 'Prepared by']);
    const rows = rowsOf(table);
    expect(rows).toHaveLength(5);
    const cells = (row: HTMLElement): (string | null)[] =>
      within(row)
        .getAllByRole('cell')
        .map((td) => td.textContent);
    // Where a package stands and what its checks said come first; the version is its number alone.
    expect(cells(rows[0]!)).toEqual([
      'Client Alpha Pension',
      'Q2 2025',
      'QA failed',
      '3 of 126 failed',
      'Gross',
      'Final',
      '1',
      'Imogen Tavares',
    ]);
    expect(cells(rows[1]!)).toEqual([
      'Client Alpha Pension',
      'Q2 2025',
      'Draft',
      'Not run',
      'Net',
      'Preliminary',
      '1',
      'Imogen Tavares',
    ]);
    expect(cells(rows[2]!).slice(2, 4)).toEqual(['In review', 'All 98 passed']);
    expect(cells(rows[3]!).slice(1, 7)).toEqual([
      'Q1 2025',
      'Approved',
      '2 failed, overridden',
      'Gross',
      'Final',
      '2',
    ]);
    expect(cells(rows[4]!).slice(2, 7)).toEqual([
      'Released',
      'All 120 passed',
      'Gross',
      'Final',
      '1',
    ]);
    // The version is a figure: right-aligned under its header.
    expect(within(table).getByRole('columnheader', { name: 'Version' })).toHaveClass('num');
    expect(within(rows[3]!).getByRole('cell', { name: '2' })).toHaveClass('num');
    // Each row opens its package.
    expect(within(rows[0]!).getByRole('link', { name: 'Client Alpha Pension' })).toHaveAttribute(
      'href',
      `/reporting/packages/${PKG_ID.failed}`,
    );
    expect(within(rows[2]!).getByRole('link', { name: 'Client Beta Endowment' })).toHaveAttribute(
      'href',
      `/reporting/packages/${PKG_ID.inReview}`,
    );
    // One tone per state: a refusal, a person's turn, ready to release, settled.
    expect(within(rows[0]!).getByText('QA failed')).toHaveClass('pb-badge-bad');
    expect(within(rows[1]!).getByText('Draft')).toHaveClass('pb-badge-neutral');
    expect(within(rows[2]!).getByText('In review')).toHaveClass('pb-badge-watch');
    expect(within(rows[3]!).getByText('Approved')).toHaveClass('pb-badge-brand');
    expect(within(rows[4]!).getByText('Released')).toHaveClass('pb-badge-good');
    expect(screen.getByTestId('package-count')).toHaveTextContent(
      '5 packages shown; 4 packages not yet released.',
    );
    // No identifier reaches the page.
    expect(document.body.textContent).not.toMatch(IDENTIFIER);
  });

  it('filters by client and by state in the browser over the one read', async () => {
    open(['operations']);
    await screen.findByRole('table', { name: 'Client packages' });
    const card = screen.getByTestId('packages-card');
    await pick(card, 'Client', 'Client Beta Endowment');
    expect(rowsOf(screen.getByRole('table', { name: 'Client packages' }))).toHaveLength(1);
    await pick(card, 'State', 'Released');
    expect(screen.getByText('No packages match')).toBeInTheDocument();
    expect(screen.getByTestId('package-count')).toHaveTextContent('0 packages shown');
    await pick(card, 'Client', 'All clients');
    const rows = rowsOf(screen.getByRole('table', { name: 'Client packages' }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Released');
    await pick(card, 'State', 'QA failed');
    expect(rowsOf(screen.getByRole('table', { name: 'Client packages' }))[0]).toHaveTextContent(
      '3 of 126 failed',
    );
    // Every state of the gate can be asked for, in the gate's order.
    await userEvent.click(within(card).getByRole('combobox', { name: 'State' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
      'All states',
      'Draft',
      'Generated',
      'QA failed',
      'QA passed',
      'In review',
      'Approved',
      'Released',
    ]);
    const gets = sentRequests()
      .filter(([, method]) => method === 'GET')
      .map(([url]) => url);
    expect(gets.filter((u) => u.startsWith(PACKAGES))).toEqual([PACKAGES]);
  }, 30_000);

  it('says when there is no package yet, and what makes one appear', async () => {
    open(['deal_team'], { [PACKAGES]: ok(packageListFixture([])) });
    expect(await screen.findByText('No packages yet')).toBeInTheDocument();
    expect(screen.getByTestId('packages-empty')).toHaveTextContent(
      'Investor relations start a package for a client, a quarter and a basis.',
    );
    expect(screen.getByTestId('package-count')).toHaveTextContent(
      '0 packages shown; 0 packages not yet released.',
    );
    expect(screen.queryByRole('table', { name: 'Client packages' })).not.toBeInTheDocument();
  });

  it.each([['viewer'], ['platform_admin']] as const)(
    'tells a %s the list is not visible to the role, and who reads it',
    async (role) => {
      open([role], { [PACKAGES]: failing(403, PACKAGES) });
      expect(
        await screen.findByText('Client packages: not visible to your role'),
      ).toBeInTheDocument();
      expect(screen.getByTestId('packages-unavailable')).toHaveTextContent(
        'Investor relations read the packages of the clients they are entitled to',
      );
      // The tabs stay, so the reader can leave for a page the role does read.
      expect(screen.getByRole('navigation', { name: 'Reporting' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Start package' })).not.toBeInTheDocument();
    },
  );

  it('shows an outage as an error, never as an empty list', async () => {
    open(['operations'], {
      [PACKAGES]: {
        status: 503,
        body: {
          type: 'https://portfolio-beach.example/problems/unavailable',
          title: 'Service unavailable',
          status: 503,
          detail: 'The database is not reachable',
          request_id: 'test',
        },
      },
    });
    // A failed read is tried once more before the page gives up, so the error takes a moment.
    expect(
      await screen.findByText('Client packages unavailable', undefined, TIMEOUT),
    ).toBeInTheDocument();
    expect(screen.queryByText('No packages yet')).not.toBeInTheDocument();
  });

  it.each([['operations'], ['deal_team'], ['approver'], ['auditor']] as const)(
    'shows a reader who is %s the Start button disabled, naming the role it needs',
    async (role) => {
      open([role]);
      const start = await screen.findByRole('button', { name: 'Start package' });
      expect(start).toBeDisabled();
      expect(start).toHaveAttribute('title', 'Needs investor relations');
      // The reason is in words beside the button too, and the button points to it.
      expect(
        within(screen.getByTestId('packages-card')).getByText('Needs investor relations'),
      ).toBeVisible();
      expect(start).toHaveAccessibleDescription('Needs investor relations');
      expect(screen.queryByTestId('package-start-form')).not.toBeInTheDocument();
      // A reader who cannot start never asks for the clients behind the form.
      expect(sentRequests().some(([url]) => url === CLIENTS)).toBe(false);
    },
  );
});

describe('starting a package', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    navigate.mockReset();
  });

  it('offers the quarters that have ended, the latest one chosen, and no as-of date', async () => {
    const form = await openStartForm();
    expect(within(form).getByText('Quarters that ended on or before Aug 15, 2025.')).toBeVisible();
    await userEvent.click(within(form).getByRole('combobox', { name: 'Quarter' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
      'Q2 2025',
      'Q1 2025',
      'Q4 2024',
      'Q3 2024',
      'Q2 2024',
      'Q1 2024',
      'Q4 2023',
      'Q3 2023',
    ]);
    expect(within(form).queryByLabelText(/as of/i)).not.toBeInTheDocument();
    // The button on the list waits while the form is open.
    expect(
      within(screen.getByTestId('packages-card')).getByRole('button', { name: 'Start package' }),
    ).toBeDisabled();
  }, 30_000);

  it('starts the first package of a client, quarter and basis and opens its page', async () => {
    const created = packageDetailFixture({
      id: '00000000-0000-4000-8000-000000000999',
      client: { id: CLIENT_ID.beta, name: 'Client Beta Endowment' },
      periodEnd: PKG_PRIOR_PERIOD,
    });
    const form = await openStartForm({
      [PACKAGES]: listAnd(ok(packageListFixture()), { status: 201, body: created }),
    });
    await pick(form, 'Client', 'Client Beta Endowment');
    await pick(form, 'Quarter', 'Q1 2025');
    await pick(form, 'Basis', 'Net');
    await pick(form, 'Label', 'Preliminary');
    expect(within(form).queryByText("Not on this client's record")).not.toBeInTheDocument();
    expect(within(form).queryByRole('textbox')).not.toBeInTheDocument();
    await userEvent.click(within(form).getByRole('button', { name: 'Start package' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1), TIMEOUT);
    expect(navigate).toHaveBeenCalledWith({
      to: '/reporting/packages/$id',
      params: { id: created.id },
    });
    expect(startPosts()).toEqual([
      {
        clientId: CLIENT_ID.beta,
        periodEnd: PKG_PRIOR_PERIOD,
        basis: 'net',
        label: 'preliminary',
      },
    ]);
    expect(screen.queryByTestId('package-start-form')).not.toBeInTheDocument();
  }, 30_000);

  it('asks for every choice in words before anything is sent', async () => {
    const form = await openStartForm();
    await userEvent.click(within(form).getByRole('button', { name: 'Start package' }));
    expect(within(form).getByText('Choose the client.')).toBeVisible();
    expect(within(form).getByText('Choose gross or net.')).toBeVisible();
    expect(within(form).getByText('Choose preliminary or final.')).toBeVisible();
    // The quarter was chosen for the reader, so it has nothing to say.
    expect(within(form).queryByText('Choose the quarter.')).not.toBeInTheDocument();
    expect(startPosts()).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
  }, 30_000);

  it('links to the package already in progress and sends nothing', async () => {
    const form = await openStartForm();
    await pick(form, 'Client', 'Client Alpha Pension');
    await pick(form, 'Basis', 'Net');
    await pick(form, 'Label', 'Final');
    const notice = within(form).getByTestId('package-in-progress');
    expect(notice).toHaveTextContent(
      'A package for this client, quarter and basis is already in progress: Client Alpha Pension, Q2 2025, net, version 1 (Draft). A new version can be started once it is released.',
    );
    expect(
      within(notice).getByRole('link', { name: 'Client Alpha Pension, Q2 2025, net, version 1' }),
    ).toHaveAttribute('href', `/reporting/packages/${PKG_ID.draft}`);
    const start = within(form).getByRole('button', { name: 'Start package' });
    expect(start).toBeDisabled();
    // Another basis of the same client and quarter is another package: gross is in progress too.
    await pick(form, 'Basis', 'Gross');
    expect(within(form).getByTestId('package-in-progress')).toHaveTextContent(
      'gross, version 1 (QA failed)',
    );
    // A quarter with nothing in progress frees the button again.
    await pick(form, 'Quarter', 'Q4 2024');
    expect(within(form).queryByTestId('package-in-progress')).not.toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Start package' })).toBeEnabled();
    expect(startPosts()).toEqual([]);
  }, 30_000);

  it('needs a reason for a new version of a released package, and sends it', async () => {
    const released = packageRowFixture({
      id: PKG_ID.released,
      basis: 'gross',
      label: 'final',
      state: 'Released',
      releasedAt: '2025-08-20T16:00:00.000Z',
      qa: { runNo: 1, findings: 126, failed: 0, overridden: 0 },
    });
    const created = packageDetailFixture({ id: PKG_ID.draft, basis: 'gross', version: 2 });
    const form = await openStartForm({
      [PACKAGES]: listAnd(ok(packageListFixture([released])), { status: 201, body: created }),
    });
    await pick(form, 'Client', 'Client Alpha Pension');
    await pick(form, 'Basis', 'Gross');
    await pick(form, 'Label', 'Final');
    const reason = within(form).getByRole('textbox', { name: 'Reason for the new version' });
    expect(reason).toBeRequired();
    expect(
      within(form).getByText(
        'Version 1 was released on Aug 20, 2025 and cannot be changed. This starts version 2.',
      ),
    ).toBeVisible();
    const start = within(form).getByRole('button', { name: 'Start new version' });
    await userEvent.click(start);
    expect(
      within(form).getByText(
        'Say why the released package is being corrected, in 3 to 500 characters.',
      ),
    ).toBeVisible();
    expect(startPosts()).toEqual([]);
    await userEvent.type(reason, '  The June mark of one position was restated. ');
    await userEvent.click(start);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1), TIMEOUT);
    expect(startPosts()).toEqual([
      {
        clientId: CLIENT_ID.alpha,
        periodEnd: PKG_PERIOD,
        basis: 'gross',
        label: 'final',
        correctionReason: 'The June mark of one position was restated.',
      },
    ]);
  }, 30_000);

  it("warns that a basis is not on the client's record and still lets it through", async () => {
    const created = packageDetailFixture({
      id: '00000000-0000-4000-8000-000000000998',
      client: { id: CLIENT_ID.beta, name: 'Client Beta Endowment' },
      basis: 'gross',
    });
    const form = await openStartForm({
      [PACKAGES]: listAnd(ok(packageListFixture()), { status: 201, body: created }),
    });
    await pick(form, 'Client', 'Client Beta Endowment');
    await pick(form, 'Basis', 'Gross');
    expect(within(form).getByText("Not on this client's record")).toBeVisible();
    await pick(form, 'Label', 'Preliminary');
    await userEvent.click(within(form).getByRole('button', { name: 'Start package' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1), TIMEOUT);
    expect(startPosts()).toEqual([
      { clientId: CLIENT_ID.beta, periodEnd: PKG_PERIOD, basis: 'gross', label: 'preliminary' },
    ]);
  }, 30_000);

  it('shows the refusal of the API in the page status, without its references, and keeps the form', async () => {
    const refusal =
      'A package for this client, period and basis was released; a new version needs a reason (docs/18 section 5)';
    const form = await openStartForm({
      [PACKAGES]: listAnd(ok(packageListFixture()), {
        status: 422,
        body: refusalFixture(422, refusal),
      }),
    });
    await pick(form, 'Client', 'Client Beta Endowment');
    await pick(form, 'Quarter', 'Q1 2025');
    await pick(form, 'Basis', 'Net');
    await pick(form, 'Label', 'Final');
    await userEvent.click(within(form).getByRole('button', { name: 'Start package' }));
    const status = await screen.findByTestId('package-action-status', undefined, TIMEOUT);
    await waitFor(() =>
      expect(status).toHaveTextContent(
        'Start package: Blocked by a rule. A package for this client, period and basis was released; a new version needs a reason',
      ),
    );
    expect(status.textContent).not.toMatch(/docs\/|section 5/);
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('package-start-form')).toBeInTheDocument();
  }, 30_000);

  it('says so when the reader is entitled to no client, and when the client list fails', async () => {
    const form = await openStartForm({
      [CLIENTS]: ok({ ...packageClientsFixture(), items: [] }),
    });
    expect(within(form).getByTestId('package-no-clients')).toHaveTextContent(
      'You are not entitled to any client yet',
    );
    cleanup();
    vi.restoreAllMocks();
    open(['investor_relations'], { [CLIENTS]: failing(403, CLIENTS) });
    await userEvent.click(await screen.findByRole('button', { name: 'Start package' }, TIMEOUT));
    expect(
      await screen.findByText('The client list: not visible to your role'),
    ).toBeInTheDocument();
    // With no as-of date there is no quarter to offer: none is invented.
    expect(
      within(screen.getByTestId('package-start-form')).getByRole('combobox', { name: 'Quarter' }),
    ).toHaveValue('');
  }, 30_000);
});

describe('the fixtures of the list', () => {
  it('are in the order the API lists them', () => {
    const rows = packageRows();
    const sorted = [...rows].sort(
      (a, b) =>
        b.periodEnd.localeCompare(a.periodEnd) ||
        a.client.name.localeCompare(b.client.name) ||
        a.basis.localeCompare(b.basis) ||
        b.version - a.version,
    );
    expect(rows.map((r) => r.id)).toEqual(sorted.map((r) => r.id));
  });
});
