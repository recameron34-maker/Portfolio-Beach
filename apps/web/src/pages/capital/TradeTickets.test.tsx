import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import {
  NOTICE_ID,
  noticePageFixture,
  ticketPageFixture,
  ticketRows,
} from '../../test/fixtures-capital.js';
import { renderWithQuery } from '../../test/render.js';
import { TradeTicketsPage } from './TradeTickets.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const TICKETS = '/api/v1/trade-tickets?limit=200';
const NOTICES = '/api/v1/capital-notices?limit=200';

function open(extra: MockRoutes = {}): void {
  mockApi({
    [TICKETS]: ok(ticketPageFixture()),
    [NOTICES]: ok(noticePageFixture()),
    ...extra,
  });
  renderWithQuery(<TradeTicketsPage />);
}

const rowsOf = (table: HTMLElement): HTMLElement[] => within(table).getAllByRole('row').slice(1);

describe('trade tickets', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists every ticket with its notice, the people, the instruction version and the release check', async () => {
    open();
    const table = await screen.findByRole('table', { name: 'Trade tickets' });
    expect(screen.getByRole('navigation', { name: 'Capital activity' })).toHaveTextContent(
      'Trade tickets',
    );
    const rows = rowsOf(table);
    expect(rows).toHaveLength(3);
    const drafted = rows[0]!;
    expect(
      within(drafted).getByRole('link', { name: 'Capital call: Silverline Staffing Holdings' }),
    ).toHaveAttribute('href', `/capital-activity/${NOTICE_ID.extracted}`);
    expect(within(drafted).getByText('$2.5M')).toBeInTheDocument();
    expect(within(drafted).getByText('Jul 12, 2025')).toBeInTheDocument();
    expect(within(drafted).getByText('Priya Lindqvist')).toBeInTheDocument();
    expect(within(drafted).getAllByText('-')).toHaveLength(2);
    expect(within(drafted).getByText('Drafted')).toHaveClass('pb-badge-watch');
    const blockers = within(drafted).getAllByText(/Changed within hold|Same person/);
    expect(blockers.map((b) => b.textContent)).toEqual(['Changed within hold', 'Same person']);
    expect(blockers[0]!.closest('span[title]')).toHaveAttribute(
      'title',
      "The wire instructions changed within the hold window and wait for a second person's callback (SEC-12.3).",
    );

    const approved = rows[1]!;
    expect(
      within(approved).getByRole('link', { name: 'Capital call: Summit Services Co' }),
    ).toBeInTheDocument();
    expect(within(approved).getByText('Mina Halvorsen')).toBeInTheDocument();
    expect(within(approved).getByText('Version 1: Meridian Clearing ****2204')).toBeInTheDocument();
    expect(within(approved).getByText('Approved')).toHaveClass('pb-badge-brand');
    expect(within(approved).getByText('Allowed')).toHaveClass('pb-badge-good');

    const funded = rows[2]!;
    expect(
      within(funded).getByRole('link', { name: 'Interest payment: Summit Services Co' }),
    ).toBeInTheDocument();
    expect(within(funded).getByText('Funded')).toHaveClass('pb-badge-good');
    expect(within(funded).getByText('Nothing to release')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-count')).toHaveTextContent('3 tickets shown.');
  });

  it('falls back to the notice id when the notice list is not at hand', async () => {
    open({ [NOTICES]: failing(403, '/api/v1/capital-notices') });
    const table = await screen.findByRole('table', { name: 'Trade tickets' });
    expect(within(table).getAllByRole('link', { name: 'Notice 00000000' })).toHaveLength(3);
  });

  it('filters by state in the browser', async () => {
    open();
    await screen.findByRole('table', { name: 'Trade tickets' });
    await userEvent.click(screen.getByRole('combobox', { name: 'State' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Funded' }));
    expect(rowsOf(screen.getByRole('table', { name: 'Trade tickets' }))).toHaveLength(1);
    expect(screen.getByTestId('ticket-count')).toHaveTextContent('1 ticket shown.');
    await userEvent.click(screen.getByRole('combobox', { name: 'State' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Withdrawn' }));
    expect(screen.getByText('No tickets in this state')).toBeInTheDocument();
  });

  it('says when there are no tickets and when more than one page exists', async () => {
    open({ [TICKETS]: ok(ticketPageFixture([])) });
    expect(await screen.findByText('No trade tickets yet')).toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();
    open({ [TICKETS]: ok(ticketPageFixture(ticketRows(), 'next')) });
    expect(await screen.findByTestId('ticket-count')).toHaveTextContent(
      'Showing the first 200; more exist.',
    );
  });

  it('shows the unavailable state to a role outside the ticket readers, and degrades on a 501', async () => {
    open({ [TICKETS]: failing(403, '/api/v1/trade-tickets') });
    expect(await screen.findByText('Trade tickets: not visible to your role')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Capital activity' })).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();
    open({ [TICKETS]: failing(501, '/api/v1/trade-tickets') });
    expect(await screen.findByText('Trade tickets: not available yet')).toBeInTheDocument();
  });
});
