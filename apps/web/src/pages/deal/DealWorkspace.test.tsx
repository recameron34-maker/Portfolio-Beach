import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mockApi, ok, problemFixture } from '../../test/api-mock.js';
import type { MockResponse } from '../../test/api-mock.js';
import {
  creditDetailFixture,
  DEAL_ID,
  DEAL_PATHS,
  dealDetailFixture,
} from '../../test/fixtures-deal.js';
import { renderWithQuery } from '../../test/render.js';
import { InvestmentDetailPage } from '../InvestmentDetail.js';
import { DealWorkspace } from './DealWorkspace.js';

vi.mock('@tanstack/react-router', async () => {
  const { routerMock } = await import('../../test/router-mock.js');
  const { DEAL_ID: id } = await import('../../test/fixtures-deal.js');
  return { ...routerMock(), useParams: () => ({ id }) };
});

const EM_DASH = String.fromCharCode(0x2014);

const serverError = (): MockResponse => ({
  status: 500,
  body: { ...problemFixture(404, DEAL_PATHS.detail), status: 500, title: 'Server error' },
});

describe('deal workspace', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the banner, the shared tiles and every tab of the workspace', async () => {
    mockApi({ [DEAL_PATHS.detail]: ok(dealDetailFixture()) });
    renderWithQuery(<DealWorkspace />);
    const banner = await screen.findByTestId('detail-banner');
    expect(
      within(banner).getByRole('heading', { level: 1, name: 'Meridian Data Partners' }),
    ).toBeInTheDocument();
    expect(banner).toHaveTextContent('Beach Co-Invest Fund I');
    expect(banner).toHaveTextContent('Co invest equity');
    expect(banner).toHaveTextContent('Investment date November 2018');
    expect(banner).toHaveTextContent('As of Jun 30, 2025');
    expect(within(banner).getByText('Active')).toBeInTheDocument();

    const tiles = screen.getByTestId('deal-tiles');
    expect(within(tiles).getByRole('group', { name: 'Invested capital' })).toHaveTextContent(
      '$6.9M',
    );
    expect(within(tiles).getByRole('group', { name: 'Current NAV' })).toHaveTextContent(
      '$27.4MLocked Jun 30, 2025',
    );
    expect(within(tiles).getByRole('group', { name: 'Gross MOIC' })).toHaveTextContent('4.29x');
    expect(within(tiles).getByRole('group', { name: 'Gross IRR' })).toHaveTextContent('25.0%');
    expect(within(tiles).queryByRole('group', { name: 'Par' })).not.toBeInTheDocument();

    const nav = screen.getByRole('navigation', { name: 'Deal workspace' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'Overview',
      'Performance',
      'Sponsor and contacts',
      'Diligence',
      'Closing',
      'Valuations',
      'Capital activity',
      'Documents',
      'Tasks',
      'Activity',
    ]);
    expect(within(nav).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'href',
      `/portfolio/${DEAL_ID}`,
    );
    expect(within(nav).getByRole('link', { name: 'Performance' })).toHaveAttribute(
      'href',
      `/portfolio/${DEAL_ID}/performance`,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(EM_DASH);
  });

  it('shows the private credit tiles from docs/06: funded, par, fair value, current yield and IRR', async () => {
    mockApi({ [DEAL_PATHS.detail]: ok(creditDetailFixture()) });
    renderWithQuery(<DealWorkspace />);
    const tiles = await screen.findByTestId('deal-tiles');
    const names = within(tiles)
      .getAllByRole('group')
      .map((g) => g.getAttribute('aria-label'));
    expect(names).toEqual(['Funded', 'Par', 'Fair value', 'Current yield', 'Gross IRR']);
    expect(within(tiles).getByRole('group', { name: 'Par' })).toHaveTextContent(
      '$9.9MAs of Jun 30, 2025',
    );
    expect(within(tiles).getByRole('group', { name: 'Current yield' })).toHaveTextContent('11.23%');
  });

  it('says NM with the reason when the IRR is not meaningful, and when no valuation is Locked', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(
        dealDetailFixture({ irrFlag: 'short_period', grossIrr: '0.32', nav: null, navDate: null }),
      ),
    });
    renderWithQuery(<DealWorkspace />);
    const tiles = await screen.findByTestId('deal-tiles');
    const irr = within(tiles).getByRole('group', { name: 'Gross IRR' });
    expect(irr).toHaveTextContent('NM');
    expect(irr).toHaveTextContent('Not meaningful: held for less than the minimum period');
    expect(within(tiles).getByRole('group', { name: 'Current NAV' })).toHaveTextContent(
      '-No Locked valuation',
    );
  });

  it.each([404, 403] as const)(
    'answers %s with the not-found state the journeys look for, and no banner',
    async (status) => {
      mockApi({ [DEAL_PATHS.detail]: { status, body: problemFixture(status, DEAL_PATHS.detail) } });
      renderWithQuery(<DealWorkspace />);
      const error = await screen.findByTestId('error-state');
      expect(error).toHaveTextContent('Position not found or not visible to you');
      expect(error).toHaveTextContent('Investment not found');
      expect(screen.queryByTestId('detail-banner')).not.toBeInTheDocument();
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    },
  );

  it('hides a position whose refetch answers 404, even with its data still cached', async () => {
    // The role switch case: the cache holds the previous user's position, the new user may not see it.
    let visible = true;
    mockApi({
      [DEAL_PATHS.detail]: () =>
        visible
          ? { status: 200, body: dealDetailFixture() }
          : { status: 404, body: problemFixture(404, DEAL_PATHS.detail) },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <DealWorkspace />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('detail-banner')).toBeInTheDocument();
    visible = false;
    await act(() => client.invalidateQueries());
    const error = await screen.findByTestId('error-state');
    expect(error).toHaveTextContent('Position not found or not visible to you');
    expect(screen.queryByTestId('detail-banner')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('shows any other failure as an error with its message', async () => {
    mockApi({ [DEAL_PATHS.detail]: serverError() });
    renderWithQuery(<DealWorkspace />);
    const error = await screen.findByTestId('error-state');
    expect(error).toHaveTextContent('Could not load this position');
    expect(error).not.toHaveTextContent('Investment not found');
  });
});

describe('overview tab (the one-pager body)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps deal details, financial performance, the latest 8 valuations and cash flows, without its own banner', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      periodEnd: `20${String(16 + i).padStart(2, '0')}-12-31`,
      version: 1,
      state: 'Locked',
      fairValue: `${20 + i}000000.00`,
      method: 'valuation_method.sponsor_mark',
    }));
    mockApi({ [DEAL_PATHS.detail]: ok(dealDetailFixture({ valuations: many })) });
    renderWithQuery(<InvestmentDetailPage />);
    expect(await screen.findByRole('table', { name: 'Deal details' })).toHaveTextContent(
      'Kelpwood Capital Partners',
    );
    expect(screen.getByRole('table', { name: 'Financial performance' })).toHaveTextContent(
      '$13.9M',
    );
    const valuations = screen.getByRole('table', { name: 'Valuations' });
    // Header plus the latest 8 of 10 versions, newest first.
    expect(within(valuations).getAllByRole('row')).toHaveLength(9);
    expect(within(valuations).getAllByRole('row')[1]).toHaveTextContent('Dec 31, 2025');
    expect(screen.getByText('latest 8')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Cash flows' })).toHaveTextContent('-$6.9M');
    expect(screen.queryByTestId('detail-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deal-tiles')).not.toBeInTheDocument();
  });

  it('shows the credit terms in place of financial performance for a credit position', async () => {
    mockApi({ [DEAL_PATHS.detail]: ok(creditDetailFixture()) });
    renderWithQuery(<InvestmentDetailPage />);
    const terms = await screen.findByRole('table', { name: 'Credit terms' });
    expect(terms).toHaveTextContent('Unitranche');
    expect(within(terms).getByText('Waiver')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Financial performance' })).not.toBeInTheDocument();
  });
});
