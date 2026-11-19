import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { clientList, weeklyReport } from '@pb/contracts';
import { ClientLookThrough } from '../../components/ClientLookThrough.js';
import {
  clientListFixture,
  mockApi,
  notice,
  uuid,
  weeklyReportFixture,
  withQueries,
} from '../assistants/test-support.js';
import { ClientsPage, DisclosuresPage, WeeklyReportPage } from './Reporting.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => (
    <a href={to}>{children as never}</a>
  ),
}));

describe('weekly report page', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('parses its fixture with the contract', () => {
    expect(() => weeklyReport.parse(weeklyReportFixture())).not.toThrow();
  });

  it('lays out the report sections in order from the recorded figures', async () => {
    mockApi({ '/api/v1/reports/weekly': { body: weeklyReportFixture() } });
    render(withQueries(<WeeklyReportPage />));
    // The tiles arrive with the report; the header is there from the start.
    await screen.findByTestId('weekly-tiles');
    const header = screen.getByTestId('weekly-header');
    expect(header).toHaveTextContent('Weekly portfolio report');
    // The meta line is three items with a dot between each, not one sentence.
    expect(
      [...header.querySelectorAll('.pb-meta-list > span')].map((item) => item.textContent),
    ).toEqual(['Period Jun 30, 2025', 'As of Jun 30, 2025', 'Prepared for Viewer One']);
    expect(within(header).getByRole('button', { name: 'Print' })).toBeVisible();
    // What output is not built yet is said once, with the footnotes, and never printed.
    expect(header).not.toHaveTextContent('PowerPoint');

    const tiles = screen.getByTestId('weekly-tiles');
    expect(within(tiles).getByRole('group', { name: 'NAV' })).toHaveTextContent('$40.0M');
    expect(within(tiles).getByRole('group', { name: 'Gross IRR' })).toHaveTextContent('14.2%');
    expect(within(tiles).getByRole('group', { name: 'DPI' })).toHaveTextContent('0.17x');

    const byVehicle = screen.getByRole('table', { name: 'By vehicle' });
    expect(byVehicle).toHaveTextContent('Beach Credit Partners');
    expect(within(byVehicle).getAllByText('-').length).toBeGreaterThan(0);
    // The vehicle's type is the second line of its name, not a column of its own.
    expect(
      within(byVehicle)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Vehicle', 'Positions', 'Invested', 'Distributions', 'NAV', 'Gross MOIC']);
    expect(within(byVehicle).getByText('Co invest fund')).toHaveClass('pb-cell-sub');
    // The total is the API's own row, in the table's foot under its row header.
    const foot = byVehicle.querySelector('tfoot')!;
    expect(within(foot).getByRole('rowheader', { name: 'Total' })).toBeInTheDocument();
    expect(foot).toHaveTextContent('$40.0M');
    expect(byVehicle.querySelector('tbody')).not.toHaveTextContent('Total');

    const movers = screen.getByRole('table', { name: 'Movers' });
    expect(movers).toHaveTextContent('12.0%');
    // Up and Down in neutral words after a drawn mark: a fall is reported, not alarmed.
    for (const word of ['Up', 'Down']) {
      const direction = within(movers).getByText(word);
      expect(direction).toBeVisible();
      expect(direction).toHaveClass('pb-direction');
      expect(direction.className).not.toMatch(/pb-badge/);
      expect(direction.querySelector('.pb-direction-mark')).toHaveAttribute('aria-hidden', 'true');
    }

    expect(screen.getByTestId('stale-list')).toHaveTextContent('PB-0015');
    const capital = screen.getByRole('table', { name: 'Capital activity' });
    expect(capital).toHaveTextContent('Capital call');
    expect(within(capital).getByText('Reviewed')).toBeVisible();

    expect(screen.getByTestId('commentary')).toHaveTextContent('3 active positions');
    expect(screen.getByTestId('commentary-source')).toHaveTextContent(
      'Written by a fixed template from the figures above.',
    );
    expect(screen.queryByText('AI draft')).toBeNull();
    expect(screen.getByTestId('footnotes').querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText(/PowerPoint, Word and Excel output is not built yet/)).toHaveClass(
      'pb-no-print',
    );

    const order = [
      'By vehicle',
      'Movers',
      'Stale valuations',
      'Capital activity',
      'Commentary',
      'Footnotes',
    ].map((name) => screen.getByRole('heading', { name: new RegExp(`^${name}`) }));
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('shows empty states for no movers and no capital activity, and the AI draft badge when flagged', async () => {
    mockApi({
      '/api/v1/reports/weekly': {
        body: weeklyReportFixture({
          movers: [],
          capitalActivity: [],
          staleValuations: [],
          commentary: { paragraphs: ['Drafted.'], source: 'mock_assistant', aiDraft: true },
        }),
      },
    });
    render(withQueries(<WeeklyReportPage />));
    expect(await screen.findByTestId('movers-empty')).toHaveTextContent('No movers');
    expect(screen.getByTestId('capital-empty')).toHaveTextContent('No capital activity');
    expect(screen.getByText('All current')).toBeVisible();
    expect(screen.getByText('AI draft')).toBeVisible();
    expect(screen.queryByTestId('commentary-source')).toBeNull();
  });

  it('says how far past due an open notice is, under its date, until the money moves', async () => {
    mockApi({
      '/api/v1/reports/weekly': {
        body: weeklyReportFixture({
          capitalActivity: [
            notice({ dueDate: '2025-06-20', daysToDue: -10 }),
            notice({ id: uuid(702), state: 'Reconciled', dueDate: '2025-05-31', daysToDue: -30 }),
          ],
        }),
      },
    });
    render(withQueries(<WeeklyReportPage />));
    const capital = await screen.findByRole('table', { name: 'Capital activity' });
    const overdue = within(capital).getByText('Overdue by 10 days');
    expect(overdue).toHaveClass('pb-badge-bad');
    expect(overdue.closest('td')).toHaveTextContent('Jun 20, 2025Overdue by 10 days');
    // A settled notice keeps its date and raises no alert.
    expect(within(capital).queryByText('Overdue by 30 days')).toBeNull();
    expect(within(capital).getByText('May 31, 2025')).toBeVisible();
  });

  it('keeps its title and tabs while the report loads and when it cannot be shown', async () => {
    mockApi({ '/api/v1/reports/weekly': { status: 403, title: 'Forbidden' } });
    render(withQueries(<WeeklyReportPage />));
    expect(
      screen.getByRole('heading', { level: 1, name: 'Weekly portfolio report' }),
    ).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Reporting' })).toBeVisible();
    expect(
      await screen.findByText('The weekly report is not available to your role'),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Weekly portfolio report' }),
    ).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Reporting' })).toBeVisible();
  });
});

describe('clients page and client look-through', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('parses its fixture with the contract', () => {
    expect(() => clientList.parse(clientListFixture())).not.toThrow();
  });

  it('renders a card per client with tiles and the vehicle table', async () => {
    mockApi({ '/api/v1/clients': { body: clientListFixture() } });
    render(withQueries(<ClientsPage />));
    expect(screen.getByRole('navigation', { name: 'Reporting' })).toHaveTextContent('Clients');
    expect(await screen.findByTestId('clients-asof')).toHaveTextContent(
      'As of Jun 30, 2025. 1 entitled client',
    );
    const card = screen.getByTestId('client-10000000-0000-4000-8000-000000000051');
    expect(card).toHaveTextContent('Client Alpha Pension');
    expect(within(card).getByText('Quarterly reporting \u00B7 Gross, Net')).toBeVisible();
    expect(within(card).getByRole('group', { name: 'Commitment' })).toHaveTextContent('$35.0M');
    // Why the totals are missing is said once under the strip; each missing total points to it.
    const why = 'Totals not calculable: no share for Beach Credit Partners.';
    expect(within(card).getAllByText(why)).toHaveLength(1);
    for (const name of ['Invested share', 'Distributions share', 'NAV share', 'Gross MOIC']) {
      const tile = within(card).getByRole('group', { name });
      expect(tile).toHaveTextContent(/^[^]*-$/);
      expect(tile).toHaveAccessibleDescription(why);
    }
    expect(within(card).getByRole('group', { name: 'Commitment' })).not.toHaveAttribute(
      'aria-describedby',
    );
    // No tile repeats the reason under its own figure.
    expect(card.querySelectorAll('.pb-stat-hint')).toHaveLength(0);
    expect(screen.getByTestId('clients-asof')).toHaveTextContent(
      'cover the positions visible to you',
    );
    const table = within(card).getByRole('table', { name: 'Client Alpha Pension vehicles' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual([
      'Vehicle',
      'Commitment',
      'Closing no.',
      'Ownership',
      'Invested share',
      'Distributions share',
      'NAV share',
      'Gross MOIC',
    ]);
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('25.0%');
    expect(rows[1]).toHaveTextContent('$7.5M');
    expect(within(rows[1]!).getByText('Co invest fund')).toHaveClass('pb-cell-sub');
    // The credit vehicle has no ownership yet: every share shows the placeholder, never a zero,
    // and the row that leaves the totals out says why on each placeholder.
    const dashes = within(rows[2]!).getAllByText('-');
    expect(dashes).toHaveLength(5);
    for (const dash of dashes) {
      expect(dash).toHaveAttribute('title', 'Not calculable: no share for Beach Credit Partners');
      expect(dash).toHaveTextContent('- Not calculable: no share for Beach Credit Partners');
    }
    // How a share is worked out is said once, after the last client.
    const note = screen.getByText(
      "Shares are the vehicle's pooled figures times the client's ownership percentage.",
    );
    expect(card.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says who can see client data when the list is empty', async () => {
    mockApi({ '/api/v1/clients': { body: clientListFixture({ items: [] }) } });
    render(withQueries(<ClientLookThrough />));
    const empty = await screen.findByTestId('clients-empty');
    expect(empty).toHaveTextContent('No entitled clients');
    expect(empty).toHaveTextContent(
      'Client data is visible to operations, the investment team (the deal team and approvers) and auditors, and to the investor relations users entitled to each client',
    );
  });

  it('degrades to a not-available state on 501 and to the entitlement state on 403', async () => {
    mockApi({ '/api/v1/clients': { status: 501, title: 'Not implemented' } });
    const first = render(withQueries(<ClientLookThrough />));
    expect(await screen.findByText('Client look-through is not available yet')).toBeVisible();
    first.unmount();
    vi.restoreAllMocks();
    mockApi({ '/api/v1/clients': { status: 403, title: 'Forbidden' } });
    render(withQueries(<ClientLookThrough />));
    expect(await screen.findByText('No entitled clients')).toBeVisible();
  });
});

describe('disclosures page', () => {
  afterEach(cleanup);

  it('says the page is not built yet and what it will hold', () => {
    render(withQueries(<DisclosuresPage />));
    // A state: a neutral dot and its word, then the plan as a short list.
    expect(screen.getByText('Not built yet')).toHaveClass('pb-badge', 'pb-badge-neutral');
    expect(screen.getByText('This page will hold:')).toBeVisible();
    expect(
      screen
        .getAllByRole('listitem')
        .map((li) => li.textContent)
        .join(' '),
    ).toMatch(
      /^The disclosure library.*register of approved statistics.*A log of every report sent\.$/,
    );
    expect(screen.getByRole('navigation', { name: 'Reporting' })).toBeVisible();
  });
});
