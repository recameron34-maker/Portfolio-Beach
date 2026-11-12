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
import { homeRows, ROLE_FOCUS } from '../lib/role-focus.js';
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
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('leads with the work of the signed-in role: what it does, and a link to each place it does it', async () => {
    mockApi(routes());
    renderWithQuery(<HomePage />);
    const work = await screen.findByTestId('home-work');
    const focus = ROLE_FOCUS.roles.deal_team;
    if (focus === undefined) throw new Error('the deal team has a focus');
    expect(within(work).getByText('Your work')).toBeInTheDocument();
    expect(within(work).getByText('Deal team')).toBeInTheDocument();
    expect(screen.getByTestId('home-work-does')).toHaveTextContent(focus.does);
    const links = within(within(work).getByRole('list', { name: 'Your work' })).getAllByRole(
      'link',
    );
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual(
      focus.work.map((link) => [link.label, link.to]),
    );
    expect(links[0]).toHaveTextContent('Pipeline');
    for (const link of focus.work) expect(within(work).getByText(link.what)).toBeInTheDocument();
    // The work comes before the figures on the page.
    const tiles = screen.getByTestId('home-tiles');
    expect(work.compareDocumentPosition(tiles) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    ['operations', ['home-work', 'home-capital', 'home-tiles', 'home-attention', 'home-exposure']],
    ['approver', ['home-work', 'home-tiles', 'home-attention', 'home-capital', 'home-exposure']],
  ] as const)('orders the page for %s as its focus says', async (role, order) => {
    mockApi({
      ...routes(),
      '/api/v1/auth/me': ok({ ...principalFixture(), roles: [role] }),
      '/api/v1/capital-notices?limit=200': ok(capitalNoticePageFixture([])),
    });
    renderWithQuery(<HomePage />);
    await screen.findByTestId('home-tiles');
    await screen.findByTestId('home-exposure');
    const found = order.map((id) => screen.getByTestId(id));
    for (let i = 1; i < found.length; i += 1) {
      const before = found[i - 1];
      const after = found[i];
      if (before === undefined || after === undefined) throw new Error('a section is missing');
      expect(
        before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${order[i - 1]} before ${order[i]}`,
      ).toBeTruthy();
    }
    expect(screen.getByTestId('home-work-does')).toHaveTextContent(
      ROLE_FOCUS.roles[role]?.does ?? 'no focus',
    );
  });

  it('shows a role only the sections it uses: investor relations has no capital activity or data health card', async () => {
    mockApi({
      ...routes(),
      '/api/v1/auth/me': ok({ ...principalFixture(), roles: ['investor_relations'] }),
    });
    renderWithQuery(<HomePage />);
    await screen.findByTestId('home-tiles');
    expect(screen.getByTestId('home-work')).toHaveTextContent('Investor relations');
    expect(screen.getByTestId('home-attention')).toBeInTheDocument();
    expect(screen.queryByTestId('home-capital')).not.toBeInTheDocument();
    expect(screen.queryByText(/stale positions/)).not.toBeInTheDocument();
  });

  it('pairs half-width cards that follow each other, and gives every other section its own row', () => {
    expect(homeRows(['work', 'tiles', 'attention', 'capital', 'charts', 'dataHealth'])).toEqual([
      ['work'],
      ['tiles'],
      ['attention', 'capital'],
      ['charts'],
      ['dataHealth'],
    ]);
    expect(homeRows(['work', 'capital', 'dataHealth', 'tiles', 'attention', 'charts'])).toEqual([
      ['work'],
      ['capital', 'dataHealth'],
      ['tiles'],
      ['attention'],
      ['charts'],
    ]);
    expect(homeRows(['attention', 'capital', 'dataHealth'])).toEqual([
      ['attention', 'capital'],
      ['dataHealth'],
    ]);
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
