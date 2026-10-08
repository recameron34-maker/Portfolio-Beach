import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { sponsorDetail, sponsorPage } from '@pb/contracts';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import { ID } from '../../test/fixtures.js';
import {
  fundCommitmentFixture,
  NOT_CALCULABLE,
  sponsorDetailFixture,
  sponsorPageFixture,
  VS_ID,
} from '../../test/fixtures-vehicles-sponsors.js';
import { renderWithQuery } from '../../test/render.js';
import { SponsorDetailPage, SponsorsPage } from './Sponsors.js';

const params = vi.hoisted(() => ({ id: '' }));

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: params.id }),
}));

const SPONSORS = '/api/v1/sponsors?limit=200';
const sponsorPath = (id: string): string => `/api/v1/sponsors/${id}`;
const EM_DASH = String.fromCharCode(0x2014);

function rowWith(table: HTMLElement, text: string): HTMLElement {
  const row = within(table).getByText(text).closest('tr');
  if (row === null) throw new Error(`no row holds ${text}`);
  return row;
}

describe('sponsor fixtures', () => {
  it('parse through the contract schemas', () => {
    expect(() => sponsorPage.parse(sponsorPageFixture())).not.toThrow();
    expect(() => sponsorDetail.parse(sponsorDetailFixture())).not.toThrow();
  });
});

describe('sponsors directory', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists each sponsor with a link, a tier chip, HQ, funds and active positions', async () => {
    mockApi({ [SPONSORS]: ok(sponsorPageFixture()) });
    renderWithQuery(<SponsorsPage />);
    const table = await screen.findByRole('table', { name: 'Sponsors' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByRole('link', { name: 'Kelpwood Capital Partners' })).toHaveAttribute(
      'href',
      `/sponsors/${VS_ID.sponsorKelpwood}`,
    );
    const kelpwood = rowWith(table, 'Kelpwood Capital Partners');
    expect(within(kelpwood).getByText('Active')).toHaveClass('pb-badge-plain');
    expect(within(kelpwood).getByText('North america')).toBeInTheDocument();
    expect(within(kelpwood).getByText('2')).toHaveClass('num');
    expect(within(kelpwood).getByText('7')).toHaveClass('num');
    expect(within(rowWith(table, 'Marram Equity Partners')).getByText('Core')).toHaveClass(
      'pb-badge-brand',
    );
    // A missing HQ shows the placeholder, muted; a sponsor on watch gets the watch tone and the word.
    const cliffside = rowWith(table, 'Cliffside Equity Partners');
    expect(within(cliffside).getByText('-')).toHaveClass('is-missing');
    expect(within(cliffside).getByText('Watch')).toHaveClass('pb-badge-watch');
    expect(screen.getByTestId('sponsors-count')).toHaveTextContent('3 sponsors');
    expect(screen.getByRole('heading', { name: 'Sponsors' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(EM_DASH);
  });

  it('filters by name as the user types and says when nothing matches', async () => {
    mockApi({ [SPONSORS]: ok(sponsorPageFixture()) });
    renderWithQuery(<SponsorsPage />);
    const search = await screen.findByRole('textbox', { name: 'Search' });
    await userEvent.type(search, 'KELP');
    const table = screen.getByRole('table', { name: 'Sponsors' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByTestId('sponsors-count')).toHaveTextContent('1 of 3 sponsors');
    await userEvent.clear(search);
    await userEvent.type(search, 'harbour');
    expect(screen.getByTestId('sponsors-no-match')).toHaveTextContent(
      'No sponsor matches "harbour"',
    );
    expect(screen.queryByRole('table', { name: 'Sponsors' })).not.toBeInTheDocument();
    expect(screen.getByTestId('sponsors-count')).toHaveTextContent('0 of 3 sponsors');
    await userEvent.clear(search);
    expect(
      within(screen.getByRole('table', { name: 'Sponsors' })).getAllByRole('row'),
    ).toHaveLength(4);
  });

  it('says when more sponsors exist than one page holds', async () => {
    mockApi({ [SPONSORS]: ok(sponsorPageFixture(undefined, 'next-page')) });
    renderWithQuery(<SponsorsPage />);
    expect(await screen.findByTestId('sponsors-count')).toHaveTextContent(
      '3 sponsors. Only the first 3 are listed; more sponsors exist.',
    );
  });

  it('says no sponsor is visible when the directory is empty', async () => {
    mockApi({ [SPONSORS]: ok(sponsorPageFixture([])) });
    renderWithQuery(<SponsorsPage />);
    expect(await screen.findByTestId('sponsors-empty')).toHaveTextContent('No sponsors visible');
    expect(screen.queryByRole('textbox', { name: 'Search' })).not.toBeInTheDocument();
  });

  it('degrades a 403 or a 501 to an empty state that names the reason', async () => {
    mockApi({ [SPONSORS]: failing(403, '/api/v1/sponsors') });
    renderWithQuery(<SponsorsPage />);
    expect(await screen.findByTestId('sponsors-unavailable')).toHaveTextContent(
      'Sponsors: not visible to your role',
    );
    cleanup();
    vi.restoreAllMocks();

    mockApi({ [SPONSORS]: failing(501, '/api/v1/sponsors') });
    renderWithQuery(<SponsorsPage />);
    expect(await screen.findByTestId('sponsors-unavailable')).toHaveTextContent(
      'Sponsors: not available yet',
    );
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });
});

describe('sponsor 360', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the banner, description, tiles, NAV by position, funds, positions and commitments', async () => {
    params.id = VS_ID.sponsorKelpwood;
    mockApi({ [sponsorPath(VS_ID.sponsorKelpwood)]: ok(sponsorDetailFixture()) });
    renderWithQuery(<SponsorDetailPage />);
    const banner = await screen.findByTestId('sponsor-banner');
    expect(
      within(banner).getByRole('heading', { name: 'Kelpwood Capital Partners' }),
    ).toBeInTheDocument();
    for (const item of ['Active tier', 'HQ North america', '2 funds']) {
      expect(within(banner).getByText(item)).toBeInTheDocument();
    }
    expect(screen.getByTestId('sponsor-description')).toHaveTextContent(
      'Control buyouts and growth investments in the middle market.',
    );
    expect(screen.getByRole('link', { name: 'All sponsors' })).toHaveAttribute('href', '/sponsors');

    const tiles = screen.getByTestId('sponsor-tiles');
    const tile = (label: string): HTMLElement => within(tiles).getByRole('group', { name: label });
    expect(tile('Positions')).toHaveTextContent('21 active');
    expect(tile('Invested')).toHaveTextContent('$35.5M');
    expect(tile('NAV')).toHaveTextContent('$8.7M');
    expect(tile('Gross MOIC')).toHaveTextContent('1.15x');
    expect(tile('Gross IRR')).toHaveTextContent('2.3%Pooled cash flows, XIRR');
    expect(tile('Committed')).toHaveTextContent('$33.0M2 commitments');

    // Only the active position with a NAV is charted; the realized one carries no NAV.
    const chart = screen.getByRole('group', { name: 'NAV by position' });
    expect(
      within(chart)
        .getAllByRole('img')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Meridian Data Partners: $8.7M']);

    const funds = screen.getByRole('table', { name: 'Funds' });
    const fundOne = rowWith(funds, 'Kelpwood Fund I');
    expect(within(fundOne).getByText('KF I')).toHaveClass('pb-badge-plain');
    expect(within(fundOne).getByText('Kelpwood I')).toBeInTheDocument();
    expect(within(fundOne).getByText('$4,000.0M')).toHaveClass('num');
    expect(within(fundOne).getByText('$3,916.7M')).toBeInTheDocument();
    expect(within(fundOne).getByText('$25.0M')).toBeInTheDocument();
    // A fund in another currency shows its code, never a dollar sign; no final size yet is missing.
    const fundThree = rowWith(funds, 'Kelpwood Fund III');
    expect(within(fundThree).getByText('EUR 500.0M')).toBeInTheDocument();
    expect(within(fundThree).getByText('-')).toHaveClass('is-missing');
    expect(within(fundThree).getByText('None')).toBeInTheDocument();
    expect(within(fundThree).getByText('Growth')).toBeInTheDocument();

    const positions = screen.getByRole('table', { name: 'Our positions' });
    expect(within(positions).getByRole('link', { name: 'Meridian Data Partners' })).toHaveAttribute(
      'href',
      `/portfolio/${ID.inv1}`,
    );
    const meridian = rowWith(positions, 'Meridian Data Partners');
    expect(within(meridian).getByText('Beach Co-Invest Fund I')).toBeInTheDocument();
    expect(within(meridian).getByText('Co invest equity')).toBeInTheDocument();
    expect(within(meridian).getByText('1.57x')).toBeInTheDocument();
    expect(within(meridian).getByText('Active')).toBeInTheDocument();
    expect(
      within(rowWith(positions, 'Cobalt Components Corp')).getByText('Realized'),
    ).toBeVisible();
    expect(
      within(positions).getByRole('rowheader', { name: 'Total' }).closest('tr'),
    ).toHaveTextContent('$35.5M$8.7M1.15x2.3%');

    const commitments = screen.getByRole('table', { name: 'Commitments' });
    expect(within(commitments).getByRole('columnheader', { name: 'Client' })).toBeInTheDocument();
    expect(
      within(commitments).getByRole('link', { name: 'Client Gamma Separate Account' }),
    ).toHaveAttribute('href', `/portfolio/vehicles/${VS_ID.vehicleSma}`);
    const smaRow = rowWith(commitments, 'Client Gamma Insurance');
    expect(within(smaRow).getByText('$8.0M')).toBeInTheDocument();
    expect(within(smaRow).getAllByText('-')).toHaveLength(2);
    const primaryRow = rowWith(commitments, 'Kelpwood Fund I');
    expect(within(primaryRow).getByText('-')).toHaveClass('is-missing');
    expect(
      within(commitments).getByRole('rowheader', { name: 'Total' }).closest('tr'),
    ).toHaveTextContent('$33.0M');
    expect(
      screen.getByText(/no recorded cash flow yet shows the missing placeholder/),
    ).toBeInTheDocument();

    expect(screen.getByTestId('sponsor-relationship')).toHaveTextContent(
      'Contacts and interactions arrive with M6 in Phase 5',
    );
    expect(screen.getByTestId('sponsor-calc-version')).toHaveTextContent('Calc version 0.1.0.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(EM_DASH);
  });

  it('shows a sponsor with no positions as counts and commitments, without blank figures', async () => {
    params.id = VS_ID.sponsorCliffside;
    mockApi({
      [sponsorPath(VS_ID.sponsorCliffside)]: ok(
        sponsorDetailFixture({
          id: VS_ID.sponsorCliffside,
          name: 'Cliffside Equity Partners',
          hqGeography: null,
          description: null,
          fundCount: 0,
          activeInvestments: 0,
          funds: [],
          positions: [],
          commitments: [fundCommitmentFixture()],
          metrics: { ...NOT_CALCULABLE, nav: '0' },
          totalCommitted: '25000000.00',
        }),
      ),
    });
    renderWithQuery(<SponsorDetailPage />);
    const banner = await screen.findByTestId('sponsor-banner');
    expect(within(banner).getByText('HQ not recorded')).toBeInTheDocument();
    expect(within(banner).getByText('0 funds')).toBeInTheDocument();
    expect(screen.queryByTestId('sponsor-description')).not.toBeInTheDocument();
    const tiles = screen.getByTestId('sponsor-tiles');
    expect(
      within(tiles)
        .getAllByRole('group')
        .map((g) => g.getAttribute('aria-label')),
    ).toEqual(['Positions', 'Committed']);
    expect(within(tiles).getByRole('group', { name: 'Committed' })).toHaveTextContent(
      '$25.0M1 commitment',
    );
    // No zero NAV is shown for a sponsor with nothing to pool.
    expect(within(tiles).queryByText('$0.0M')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'NAV by position' })).not.toBeInTheDocument();
    expect(screen.getByTestId('sponsor-funds-empty')).toHaveTextContent('No funds recorded');
    expect(screen.getByTestId('sponsor-positions-empty')).toHaveTextContent(
      'No positions with this sponsor',
    );
    const commitments = screen.getByRole('table', { name: 'Commitments' });
    expect(
      within(commitments).queryByRole('columnheader', { name: 'Client' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/no recorded cash flow yet shows the missing placeholder/),
    ).not.toBeInTheDocument();
  });

  it('says when no active position has a NAV yet', async () => {
    params.id = VS_ID.sponsorKelpwood;
    const fixture = sponsorDetailFixture();
    mockApi({
      [sponsorPath(VS_ID.sponsorKelpwood)]: ok({
        ...fixture,
        positions: fixture.positions.map((p) => (p.isActive ? { ...p, nav: null } : p)),
        commitments: [],
        totalCommitted: null,
      }),
    });
    renderWithQuery(<SponsorDetailPage />);
    expect(await screen.findByTestId('sponsor-nav-empty')).toHaveTextContent(
      'No active position with a NAV',
    );
    expect(
      screen.getByText('1 active position has no Locked valuation and is not shown.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('sponsor-commitments-empty')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('sponsor-tiles')).getByRole('group', { name: 'Committed' }),
    ).toHaveTextContent('-No commitments to its funds');
  });

  it('says not found or not visible for a 404 and for a 403', async () => {
    for (const status of [404, 403] as const) {
      params.id = VS_ID.sponsorKelpwood;
      mockApi({
        [sponsorPath(VS_ID.sponsorKelpwood)]: failing(status, sponsorPath(VS_ID.sponsorKelpwood)),
      });
      renderWithQuery(<SponsorDetailPage />);
      expect(await screen.findByTestId('error-state')).toHaveTextContent(
        'Sponsor not found or not visible to you',
      );
      expect(screen.getByRole('link', { name: 'All sponsors' })).toHaveAttribute(
        'href',
        '/sponsors',
      );
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('degrades a 501 to an empty state rather than an error', async () => {
    params.id = VS_ID.sponsorKelpwood;
    mockApi({
      [sponsorPath(VS_ID.sponsorKelpwood)]: failing(501, sponsorPath(VS_ID.sponsorKelpwood)),
    });
    renderWithQuery(<SponsorDetailPage />);
    expect(await screen.findByText('This sponsor: not available yet')).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });
});
