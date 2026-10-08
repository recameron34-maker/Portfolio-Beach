import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { clientList, weeklyReport } from '@pb/contracts';
import { ClientLookThrough } from '../../components/ClientLookThrough.js';
import {
  clientListFixture,
  mockApi,
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
    const header = await screen.findByTestId('weekly-header');
    expect(header).toHaveTextContent('Weekly portfolio report');
    expect(header).toHaveTextContent(
      'Period Jun 30, 2025, as of Jun 30, 2025, prepared for Viewer One',
    );
    expect(screen.getByRole('button', { name: 'Print' })).toBeVisible();
    expect(header).toHaveTextContent('PowerPoint, Word and Excel output arrives in Phase 4');

    const tiles = screen.getByTestId('weekly-tiles');
    expect(within(tiles).getByRole('group', { name: 'NAV' })).toHaveTextContent('$40.0M');
    expect(within(tiles).getByRole('group', { name: 'Gross IRR' })).toHaveTextContent('14.2%');
    expect(within(tiles).getByRole('group', { name: 'DPI' })).toHaveTextContent('0.17x');

    const byVehicle = screen.getByRole('table', { name: 'By vehicle' });
    expect(byVehicle).toHaveTextContent('Beach Credit Partners');
    expect(within(byVehicle).getAllByText('-').length).toBeGreaterThan(0);

    const movers = screen.getByRole('table', { name: 'Movers' });
    expect(movers).toHaveTextContent('12.0%');
    expect(within(movers).getByText('Up')).toBeVisible();
    expect(within(movers).getByText('Down')).toBeVisible();

    expect(screen.getByTestId('stale-list')).toHaveTextContent('PB-0015');
    const capital = screen.getByRole('table', { name: 'Capital activity' });
    expect(capital).toHaveTextContent('Capital call');
    expect(within(capital).getByText('Reviewed')).toBeVisible();

    expect(screen.getByTestId('commentary')).toHaveTextContent('3 active positions');
    expect(screen.getByTestId('commentary-source')).toHaveTextContent(
      'Assembled from the figures above by a template; no model was called',
    );
    expect(screen.queryByText('AI draft')).toBeNull();
    expect(screen.getByTestId('footnotes').querySelectorAll('li')).toHaveLength(2);

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

  it('degrades to an empty state on 403', async () => {
    mockApi({ '/api/v1/reports/weekly': { status: 403, title: 'Forbidden' } });
    render(withQueries(<WeeklyReportPage />));
    expect(
      await screen.findByText('The weekly report is not available to your role'),
    ).toBeVisible();
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
    expect(
      await screen.findByText(
        "Shares are the vehicle's pooled figures times the client's ownership percentage (docs/03 section 4).",
      ),
    ).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Reporting' })).toHaveTextContent('Clients');
    expect(await screen.findByTestId('clients-asof')).toHaveTextContent(
      'As of Jun 30, 2025. 1 entitled client',
    );
    const card = screen.getByTestId('client-10000000-0000-4000-8000-000000000051');
    expect(card).toHaveTextContent('Client Alpha Pension');
    expect(within(card).getByText('Gross')).toBeVisible();
    expect(within(card).getByText('Net')).toBeVisible();
    expect(card).toHaveTextContent('Quarterly reporting');
    expect(within(card).getByRole('group', { name: 'Commitment' })).toHaveTextContent('$35.0M');
    const table = within(card).getByRole('table', { name: 'Client Alpha Pension vehicles' });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('25.0%');
    expect(rows[1]).toHaveTextContent('$7.5M');
    // The credit vehicle has no ownership yet: every share shows the placeholder, never a zero.
    expect(within(rows[2]!).getAllByText('-')).toHaveLength(5);
  });

  it('says who can see client data when the list is empty', async () => {
    mockApi({ '/api/v1/clients': { body: clientListFixture({ items: [] }) } });
    render(withQueries(<ClientLookThrough />));
    const empty = await screen.findByTestId('clients-empty');
    expect(empty).toHaveTextContent('No entitled clients');
    expect(empty).toHaveTextContent(
      'Client data is visible to operations, approvers, auditors and the investor relations users entitled to each client (SEC-5.4)',
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

  it('keeps the phase placeholder and says what M19 will hold', () => {
    render(withQueries(<DisclosuresPage />));
    expect(screen.getByText('Disclosures and statistics arrives in Phase 4')).toBeVisible();
    expect(screen.getByText(/M19 will hold the versioned disclosure library/)).toBeVisible();
    expect(screen.getByText(/distribution log of every issued report/)).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Reporting' })).toBeVisible();
  });
});
