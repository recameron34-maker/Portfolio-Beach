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
    expect(within(table).getByRole('link', { name: 'Cobalt Energy Group' })).toHaveAttribute(
      'href',
      `/portfolio/${ID.inv2}`,
    );
    expect(within(table).getByText('INV-0004')).toHaveClass('pb-key');
    expect(within(table).getByText('Negative EBITDA')).toBeInTheDocument();
    expect(
      within(table).getByText('EBITDA LTM of -3484738.35 for 2025-06-30 is at or below zero'),
    ).toBeInTheDocument();

    const thresholds = screen.getByRole('table', { name: 'Thresholds (config/definitions.json)' });
    expect(within(thresholds).getByText('netDebtToEbitdaMax')).toHaveClass('pb-key');
    expect(within(thresholds).getByText('Net debt / EBITDA, maximum')).toBeInTheDocument();
    expect(thresholds).toHaveTextContent('0.15');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
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
