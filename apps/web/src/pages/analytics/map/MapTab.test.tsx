import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InvestmentSummary } from '@pb/contracts';
import { clearTaxonomyLabels, registerTaxonomyLabels } from '../../../lib/format.js';
import { failing, mockApi, ok } from '../../../test/api-mock.js';
import { investmentFixture, investmentPageFixture } from '../../../test/fixtures.js';
import { renderWithQuery } from '../../../test/render.js';
import { MapTab } from './MapTab.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../../test/router-mock.js')).routerMock(),
);

const LIST = '/api/v1/investments?limit=200';
const AUSTIN = { city: 'Austin', country: 'US', latitude: 30.2672, longitude: -97.7431 };
const LONDON = { city: 'London', country: 'GB', latitude: 51.5074, longitude: -0.1278 };
const TOKYO = { city: 'Tokyo', country: 'JP', latitude: 35.6762, longitude: 139.6503 };
const CV = 'deal_type.cv_single_asset';

let n = 0;
const position = (overrides: Partial<InvestmentSummary>): InvestmentSummary => {
  n += 1;
  return investmentFixture({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    investmentNumber: `INV-${String(n).padStart(4, '0')}`,
    ...overrides,
  });
};

const alder = position({ companyName: 'Alder Analytics', hq: AUSTIN, nav: '15200000.00' });
const birch = position({ companyName: 'Birch Brands', hq: AUSTIN, grossMoic: null });
const cedar = position({ companyName: 'Cedar Care', hq: LONDON, dealType: CV });
const dune = position({ companyName: 'Dune Data', hq: null });
const elm = position({
  companyName: 'Elm Energy',
  hq: TOKYO,
  isActive: false,
  exitDate: '2024-03-31',
});
const credit = position({
  companyName: 'Fir Finance',
  hq: LONDON,
  dealType: 'deal_type.private_credit',
});
const BOOK = [alder, birch, cedar, dune, elm, credit];

const open = (items: InvestmentSummary[] = BOOK, nextCursor: string | null = null): void => {
  mockApi({ [LIST]: ok(investmentPageFixture(items, nextCursor)) });
  renderWithQuery(<MapTab />);
};
const markers = (): HTMLElement[] => screen.queryAllByTestId('map-marker');
const marker = (name: string | RegExp): HTMLElement => screen.getByRole('button', { name });
const tile = (label: string): HTMLElement =>
  within(screen.getByTestId('map-tiles')).getByRole('group', { name: label });

describe('co-investment map', () => {
  beforeEach(() => {
    registerTaxonomyLabels([
      { code: 'deal_type.co_invest_equity', label: 'Co-investment (equity)' },
      { code: CV, label: 'Continuation vehicle (single asset)' },
    ]);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    clearTaxonomyLabels();
  });

  it('places held co-investments and single-asset CVs at their head offices and counts them', async () => {
    open();
    await screen.findByTestId('world-map');
    expect(markers().map((m) => m.getAttribute('aria-label'))).toEqual([
      'Austin, United States: 2 positions',
      'London, United Kingdom: 1 position',
    ]);
    expect(tile('Positions on the map')).toHaveTextContent('3');
    expect(tile('Cities')).toHaveTextContent('2');
    expect(tile('Countries')).toHaveTextContent('2');
    expect(tile('No head office recorded')).toHaveTextContent('1');

    // The same positions as a table, for a reader who cannot use the map.
    const rows = within(screen.getByRole('table', { name: 'Positions on the map' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Alder AnalyticsINV-0001Austin, United States'),
      expect.stringContaining('Birch Brands'),
      expect.stringContaining('Cedar CareINV-0003London, United Kingdom'),
    ]);
    expect(within(rows[0]!).getByRole('link', { name: 'Alder Analytics' })).toHaveAttribute(
      'href',
      `/portfolio/${alder.id}`,
    );
    // Private credit is not what this map is for; a realized position waits behind its filter.
    expect(document.body).not.toHaveTextContent('Fir Finance');
    expect(document.body).not.toHaveTextContent('Elm Energy');
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x2014));
  });

  it('lists a position with no head office apart and never places it', async () => {
    open();
    const card = await screen.findByTestId('map-unplaced');
    expect(card).toHaveTextContent('a place is never guessed');
    const rows = within(
      within(card).getByRole('table', { name: 'Positions with no head office recorded' }),
    )
      .getAllByRole('row')
      .slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Dune Data');
    expect(
      within(screen.getByRole('table', { name: 'Positions on the map' })).queryByText('Dune Data'),
    ).toBeNull();
    // With every company placed the card is not there at all.
    cleanup();
    open([alder, cedar]);
    await screen.findByTestId('world-map');
    expect(screen.queryByTestId('map-unplaced')).toBeNull();
  });

  it('shows the positions at a marker, with the figures as the API gave them', async () => {
    open();
    await screen.findByTestId('world-map');
    expect(screen.getByTestId('map-panel-empty')).toBeInTheDocument();
    await userEvent.click(marker('Austin, United States: 2 positions'));
    const panel = screen.getByTestId('map-panel');
    expect(within(panel).getByRole('heading', { level: 3 })).toHaveTextContent(
      'Austin, United States2 positions',
    );
    const lines = within(panel).getAllByRole('listitem');
    expect(lines[0]).toHaveTextContent('Alder Analytics');
    expect(lines[0]).toHaveTextContent('NAV $15.2M');
    expect(lines[0]).toHaveTextContent('MOIC 4.29x');
    // A figure the API could not give is the missing placeholder, never a number.
    expect(lines[1]).toHaveTextContent('Birch Brands');
    expect(lines[1]).toHaveTextContent('MOIC -');
    expect(within(lines[0]!).getByRole('link', { name: 'Alder Analytics' })).toHaveAttribute(
      'href',
      `/portfolio/${alder.id}`,
    );
    expect(marker('Austin, United States: 2 positions')).toHaveAttribute('aria-pressed', 'true');
    expect(marker('London, United Kingdom: 1 position')).toHaveAttribute('aria-pressed', 'false');
  });

  it('works from the keyboard: Enter chooses a marker, Escape lets go', async () => {
    open();
    const map = await screen.findByTestId('world-map');
    const london = marker('London, United Kingdom: 1 position');
    london.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('map-panel')).toHaveTextContent('Cedar Care');
    map.focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('map-panel-empty')).toBeInTheDocument();
    // The zoom buttons and the keys move the view without losing the markers.
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await userEvent.keyboard('{ArrowRight}+0');
    await userEvent.click(screen.getByRole('button', { name: 'Show the whole world' }));
    expect(markers()).toHaveLength(2);
  });

  it('narrows by deal type and status, and says so when nothing is left', async () => {
    open();
    await screen.findByTestId('world-map');
    const cv = screen.getByRole('button', { name: 'Continuation vehicle (single asset)' });
    expect(cv).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(cv);
    expect(cv).toHaveAttribute('aria-pressed', 'false');
    expect(markers().map((m) => m.getAttribute('aria-label'))).toEqual([
      'Austin, United States: 2 positions',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Realized' }));
    expect(markers().map((m) => m.getAttribute('aria-label'))).toEqual([
      'Tokyo, Japan: 1 position',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(markers()).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Co-investment (equity)' }));
    expect(markers()).toHaveLength(0);
    expect(screen.getByTestId('map-empty')).toHaveTextContent(
      'No co-investment or single-asset CV matches these filters.',
    );
    expect(screen.getByRole('button', { name: 'Play tour' })).toBeDisabled();
  });

  it('shows a row of the table on the map', async () => {
    open();
    await screen.findByTestId('world-map');
    await userEvent.click(screen.getByRole('button', { name: 'Show Cedar Care on the map' }));
    expect(screen.getByTestId('map-panel')).toHaveTextContent('London, United Kingdom');
    // Closer in, the marker is still London's and is the one picked out.
    expect(marker('London, United Kingdom: 1 position')).toHaveAttribute('aria-pressed', 'true');
    // A region button moves the view and keeps what was chosen.
    await userEvent.click(screen.getByRole('button', { name: 'Europe' }));
    expect(screen.getByTestId('map-panel')).toHaveTextContent('Cedar Care');
  });

  it('tours the cities from west to east and comes back to the world', async () => {
    vi.useFakeTimers();
    mockApi({ [LIST]: ok(investmentPageFixture(BOOK)) });
    renderWithQuery(<MapTab />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    const tour = screen.getByRole('button', { name: 'Play tour' });
    fireEvent.click(tour);
    expect(screen.getByRole('button', { name: 'Stop tour' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('map-panel')).toHaveTextContent('Austin, United States');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId('map-panel')).toHaveTextContent('London, United Kingdom');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // The last city seen, the tour ends where it began: the whole world, nothing chosen.
    expect(screen.getByRole('button', { name: 'Play tour' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByTestId('map-panel-empty')).toBeInTheDocument();

    // Taking hold of the map stops a tour where it is.
    fireEvent.click(screen.getByRole('button', { name: 'Play tour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByRole('button', { name: 'Play tour' })).toBeInTheDocument();
    expect(screen.getByTestId('map-panel')).toHaveTextContent('Austin, United States');
  });

  it('does not count what one page cannot hold, and says the list is cut', async () => {
    open(BOOK, 'next');
    await screen.findByTestId('world-map');
    expect(screen.getByTestId('map-truncated')).toHaveTextContent(
      'Showing the first 200 positions; more exist.',
    );
    expect(tile('Positions on the map')).toHaveTextContent('-');
    expect(tile('No head office recorded')).toHaveTextContent('-');
  });

  it('says who may see the map when the read is refused, and reports a failure as one', async () => {
    mockApi({ [LIST]: failing(403, LIST) });
    renderWithQuery(<MapTab />);
    expect(await screen.findByText(/co-investment map/i)).toBeInTheDocument();
    expect(screen.queryByTestId('world-map')).toBeNull();
    expect(screen.queryByTestId('error-state')).toBeNull();
  });
});
