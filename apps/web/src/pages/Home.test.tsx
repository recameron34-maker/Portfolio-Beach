import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { failing, mockApi, ok } from '../test/api-mock.js';
import type { MockRoutes } from '../test/api-mock.js';
import {
  analyticsFixture,
  capitalNoticePageFixture,
  dataHealthFixture,
  ID,
  noticeFixture,
  pooledFixture,
  principalFixture,
  watchlistFixture,
} from '../test/fixtures.js';
import { renderWithQuery } from '../test/render.js';
import { HomePage } from './Home.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../test/router-mock.js')).routerMock(),
);

const routes = (): MockRoutes => ({
  '/api/v1/auth/me': ok(principalFixture()),
  '/api/v1/analytics/summary': ok(analyticsFixture()),
  '/api/v1/monitoring/watchlist': ok(watchlistFixture()),
  '/api/v1/data-health': ok(dataHealthFixture()),
  '/api/v1/capital-notices?limit=200': failing(501, '/api/v1/capital-notices'),
});

describe('home dashboard', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the pooled tiles with a sparkline, the attention list, the charts and the links', async () => {
    mockApi(routes());
    renderWithQuery(<HomePage />);
    const tiles = await screen.findByTestId('home-tiles');
    expect(screen.getByRole('heading', { name: 'Welcome, Emerson Marchetti' })).toBeInTheDocument();
    expect(within(tiles).getByRole('group', { name: 'Active positions' })).toHaveTextContent('2');
    expect(within(tiles).getByRole('group', { name: 'Invested capital' })).toHaveTextContent(
      '$390.7M',
    );
    expect(within(tiles).getByRole('group', { name: 'Current NAV' })).toHaveTextContent('$464.3M');
    expect(within(tiles).getByRole('group', { name: 'Gross MOIC' })).toHaveTextContent('1.29x');
    expect(within(tiles).getByRole('group', { name: 'DPI' })).toHaveTextContent('0.10x');
    expect(within(tiles).getByRole('group', { name: 'TVPI' })).toHaveTextContent('1.29x');
    expect(within(tiles).getByRole('group', { name: 'Gross IRR' })).toHaveTextContent('5.3%');
    expect(
      within(tiles).getByRole('img', { name: 'NAV trend over the last 3 quarters' }),
    ).toBeInTheDocument();

    const attention = await screen.findByRole('list', { name: 'Flagged positions' });
    expect(
      within(attention).getByRole('link', { name: 'Silverline Staffing Holdings' }),
    ).toHaveAttribute('href', `/portfolio/${ID.inv1}`);
    expect(within(attention).getByTitle(/at or below zero/)).toHaveTextContent('Negative EBITDA');
    expect(screen.getByText('Needs action: 1')).toBeInTheDocument();
    expect(screen.getByText('Watch: 1')).toBeInTheDocument();
    expect(screen.getByText('Clear: 3')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the watchlist' })).toHaveAttribute(
      'href',
      '/portfolio/watchlist',
    );

    expect(screen.getByRole('group', { name: 'Exposure by vehicle' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'NAV by quarter' })).toBeInTheDocument();
    expect(screen.getAllByText('Locked marks only').length).toBeGreaterThan(0);

    expect(await screen.findByText('1 stale positions')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Analytics' })).toHaveAttribute('href', '/analytics');
    expect(screen.getByRole('link', { name: 'Capital Activity' })).toHaveAttribute(
      'href',
      '/capital-activity',
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('degrades the capital activity card to an empty state when the endpoint is not implemented', async () => {
    mockApi(routes());
    renderWithQuery(<HomePage />);
    expect(await screen.findByTestId('home-capital-unavailable')).toHaveTextContent(
      'Capital activity: not available yet',
    );
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });

  it('says nothing is due when no notice needs attention, and lists overdue notices otherwise', async () => {
    mockApi({
      ...routes(),
      '/api/v1/capital-notices?limit=200': ok(capitalNoticePageFixture([])),
    });
    const first = renderWithQuery(<HomePage />);
    expect(await screen.findByText('Nothing due')).toBeInTheDocument();
    first.unmount();
    vi.restoreAllMocks();

    mockApi({
      ...routes(),
      '/api/v1/capital-notices?limit=200': ok(capitalNoticePageFixture([noticeFixture()])),
    });
    renderWithQuery(<HomePage />);
    const table = await screen.findByRole('table', { name: 'Capital activity needing attention' });
    expect(within(table).getByRole('link', { name: 'Capital call' })).toHaveAttribute(
      'href',
      `/capital-activity/${ID.notice1}`,
    );
    expect(within(table).getByText('Overdue')).toBeInTheDocument();
    expect(within(table).getByText('Reviewed')).toBeInTheDocument();
    expect(within(table).getByText('$2.5M')).toBeInTheDocument();
    expect(within(table).getByText('Jun 28, 2025')).toBeInTheDocument();
  });

  it('shows NM with the reason when the pooled IRR is flagged', async () => {
    mockApi({
      ...routes(),
      '/api/v1/analytics/summary': ok(
        analyticsFixture({ active: pooledFixture({ irrFlag: 'short_period', grossIrr: '0.5' }) }),
      ),
    });
    renderWithQuery(<HomePage />);
    const tiles = await screen.findByTestId('home-tiles');
    const irr = within(tiles).getByRole('group', { name: 'Gross IRR' });
    expect(irr).toHaveTextContent('NM');
    expect(irr).toHaveTextContent('Not meaningful: held for less than the minimum period');
  });

  it('keeps the rest of the dashboard when analytics is not visible to the role', async () => {
    mockApi({
      ...routes(),
      '/api/v1/analytics/summary': failing(403, '/api/v1/analytics/summary'),
    });
    renderWithQuery(<HomePage />);
    expect(
      await screen.findByText('Portfolio analytics: not visible to your role'),
    ).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Flagged positions' })).toBeInTheDocument();
    expect(screen.queryByTestId('home-tiles')).not.toBeInTheDocument();
  });
});
