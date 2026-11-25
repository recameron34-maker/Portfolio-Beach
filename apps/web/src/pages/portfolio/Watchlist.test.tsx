import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import { ID, watchlistFixture } from '../../test/fixtures.js';
import { renderWithQuery } from '../../test/render.js';
import { WatchlistPage } from './Watchlist.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const WATCHLIST = '/api/v1/monitoring/watchlist';

describe('watchlist page', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('counts the flags, lists every flagged position with its messages and shows the thresholds', async () => {
    mockApi({ [WATCHLIST]: ok(watchlistFixture()) });
    renderWithQuery(<WatchlistPage />);
    const tiles = await screen.findByTestId('watchlist-tiles');
    const needsAction = within(tiles).getByRole('group', { name: 'Needs action' });
    expect(within(needsAction).getByText('1', { selector: '.pb-stat-value' })).toBeInTheDocument();
    expect(
      within(within(tiles).getByRole('group', { name: 'Clear' })).getByText('3', {
        selector: '.pb-stat-value',
      }),
    ).toBeInTheDocument();
    expect(within(tiles).getByRole('group', { name: 'Flagged positions' })).toHaveTextContent(
      'of 5 active positions',
    );
    expect(screen.getByRole('navigation', { name: 'Portfolio' })).toHaveTextContent('Watchlist');

    const table = screen.getByRole('table', { name: 'Flagged positions' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    // Two columns: the position (its number, vehicle and deal type under the company) and its flags.
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Position', 'Flags']);
    expect(within(table).getByRole('link', { name: 'Cobalt Energy Group' })).toHaveAttribute(
      'href',
      `/portfolio/${ID.inv2}`,
    );
    const sub = within(table).getByText(/^INV-0004 · /);
    expect(sub).toHaveClass('pb-cell-sub');
    expect(sub.closest('td')).toHaveTextContent('Silverline Staffing Holdings');
    expect(within(table).getByText('Negative EBITDA')).toBeInTheDocument();
    expect(
      within(table).getByText('EBITDA LTM of -3484738.35 for 2025-06-30 is at or below zero'),
    ).toHaveClass('pb-flag-message');

    // The thresholds in the reader's units, named in words; no key and no file.
    expect(screen.getByRole('heading', { name: 'Monitoring thresholds' })).toBeInTheDocument();
    const thresholds = screen.getByRole('table', { name: 'Monitoring thresholds' });
    const valueOf = (label: string): string | null | undefined =>
      within(thresholds).getByText(label).nextElementSibling?.textContent;
    expect(valueOf('Net debt / EBITDA, maximum')).toBe('6.0x');
    expect(valueOf('EBITDA decline year on year')).toBe('15.0%');
    expect(valueOf('Markdown against the prior Locked mark')).toBe('20.0%');
    expect(valueOf('Without approved financials for')).toBe('75 days');
    expect(valueOf('Maturity within')).toBe('12 months');
    expect(thresholds).not.toHaveTextContent('netDebtToEbitdaMax');
    expect(thresholds).not.toHaveTextContent('0.15');
    expect(thresholds.querySelector('.pb-key')).toBeNull();
    expect(
      screen.getByText('Each flag above names the limit it was tested against.'),
    ).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('config/');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows a limit with the decimals it was configured with, never a rounded one', async () => {
    // A flag is tested against the limit as configured: 6.25 shown as "6.3x", or 12.75% as
    // "12.8%", would be a different number from the one the flags above were tested against.
    mockApi({
      [WATCHLIST]: ok({
        ...watchlistFixture(),
        thresholds: {
          netDebtToEbitdaMax: 6.25,
          ebitdaYoYDeclinePct: 0.1275,
          markdownPct: 0.125,
          missingFinancialsDays: 75,
          maturityWithinMonths: 12,
        },
      }),
    });
    renderWithQuery(<WatchlistPage />);
    const thresholds = await screen.findByRole('table', { name: 'Monitoring thresholds' });
    const valueOf = (label: string): string | null | undefined =>
      within(thresholds).getByText(label).nextElementSibling?.textContent;
    expect(valueOf('Net debt / EBITDA, maximum')).toBe('6.25x');
    expect(valueOf('EBITDA decline year on year')).toBe('12.75%');
    expect(valueOf('Markdown against the prior Locked mark')).toBe('12.5%');
    expect(valueOf('Without approved financials for')).toBe('75 days');
  });

  it('puts the flags under the position on a phone, in the same table', async () => {
    const original = globalThis.matchMedia;
    globalThis.matchMedia = ((query: string) => ({
      matches: query === '(max-width: 760px)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof globalThis.matchMedia;
    try {
      mockApi({ [WATCHLIST]: ok(watchlistFixture()) });
      renderWithQuery(<WatchlistPage />);
      const table = await screen.findByRole('table', { name: 'Flagged positions' });
      expect(
        within(table)
          .getAllByRole('columnheader')
          .map((h) => h.textContent),
      ).toEqual(['Position and flags']);
      const row = within(table).getByRole('link', { name: 'Cobalt Energy Group' }).closest('tr');
      expect(row?.querySelectorAll('td')).toHaveLength(1);
      expect(row).toHaveTextContent('Stale valuation');
    } finally {
      globalThis.matchMedia = original;
    }
  });

  it('filters to the positions that need action', async () => {
    mockApi({ [WATCHLIST]: ok(watchlistFixture()) });
    renderWithQuery(<WatchlistPage />);
    await screen.findByRole('table', { name: 'Flagged positions' });
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'Needs action' }));
    const table = screen.getByRole('table', { name: 'Flagged positions' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).queryByText('Cobalt Energy Group')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 2 flagged')).toBeInTheDocument();
  });

  it('says nothing is flagged when every position is clear', async () => {
    mockApi({
      [WATCHLIST]: ok(watchlistFixture({ items: [], counts: { watch: 0, bad: 0, clear: 5 } })),
    });
    renderWithQuery(<WatchlistPage />);
    expect(await screen.findByText('Nothing flagged')).toBeInTheDocument();
  });

  it('degrades to an empty state when the watchlist is not available', async () => {
    mockApi({ [WATCHLIST]: failing(501, WATCHLIST) });
    renderWithQuery(<WatchlistPage />);
    expect(await screen.findByText('The watchlist: not available yet')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Watchlist' })).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });
});
