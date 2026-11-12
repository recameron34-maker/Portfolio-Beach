import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { ID } from '../../test/fixtures.js';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import { DEAL_PATHS, dealDetailFixture, sponsorDetailFixture } from '../../test/fixtures-deal.js';
import { renderWithQuery } from '../../test/render.js';
import { SponsorTab } from './SponsorTab.js';

vi.mock('@tanstack/react-router', async () => {
  const { routerMock } = await import('../../test/router-mock.js');
  const { DEAL_ID: id } = await import('../../test/fixtures-deal.js');
  return { ...routerMock(), useParams: () => ({ id }) };
});

const EM_DASH = String.fromCharCode(0x2014);

describe('sponsor and contacts tab', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the sponsor, our pooled figures, its funds and the other positions with it', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.sponsor]: ok(sponsorDetailFixture()),
    });
    renderWithQuery(<SponsorTab />);

    const card = await screen.findByTestId('deal-sponsor');
    expect(within(card).getByRole('link', { name: 'Kelpwood Capital Partners' })).toHaveAttribute(
      'href',
      `/sponsors/${ID.sponsor1}`,
    );
    expect(within(card).getByText('Active tier')).toHaveClass('pb-badge-plain');
    expect(card).toHaveTextContent('Headquarters North america');
    expect(card).toHaveTextContent('2 funds on record');
    expect(card).toHaveTextContent('Control buyouts and growth investments in the middle market.');

    const metrics = screen.getByTestId('deal-sponsor-metrics');
    expect(metrics).toHaveTextContent('Across our positions with this sponsor');
    expect(within(metrics).getByRole('group', { name: 'Positions' })).toHaveTextContent('3');
    expect(within(metrics).getByRole('group', { name: 'Invested' })).toHaveTextContent('$156.4M');
    expect(within(metrics).getByRole('group', { name: 'NAV' })).toHaveTextContent('$189.7M');
    expect(within(metrics).getByRole('group', { name: 'Gross MOIC' })).toHaveTextContent('1.25x');

    const funds = screen.getByRole('table', { name: 'Sponsor funds' });
    const rows = within(funds).getAllByRole('row').slice(1);
    // Only a target size exists for Fund IV, so it says so; Fund I shows its final size.
    expect(rows[0]).toHaveTextContent(
      'Kelpwood Fund IVThis position2018Buyout$500.0M target2$22.0M',
    );
    expect(within(rows[0]!).getByText('target')).toHaveClass('pb-meta');
    expect(rows[1]).toHaveTextContent('Kelpwood Fund I2015Growth$3,916.7M1-');
    expect(within(rows[1]!).queryByText('This position')).not.toBeInTheDocument();

    const others = screen.getByRole('list', { name: 'Other positions with this sponsor' });
    const items = within(others).getAllByRole('listitem');
    // The open position is left out of its own list.
    expect(items).toHaveLength(2);
    expect(within(others).queryByText('Meridian Data Partners')).not.toBeInTheDocument();
    expect(
      within(items[0]!).getByRole('link', { name: 'Juniper Financial Group' }),
    ).toHaveAttribute('href', `/portfolio/${ID.inv2}`);
    expect(items[0]).toHaveTextContent('Client Gamma Separate Account, Co invest equity');
    expect(within(items[1]!).getByText('Realized')).toBeInTheDocument();
    expect(items[1]).toHaveTextContent('Beach CV Opportunities I, Cv single asset');

    expect(screen.getByTestId('deal-contacts')).toHaveTextContent(
      'Contacts and interactions arrive with M6 in Phase 5',
    );
    expect(screen.getByTestId('deal-contacts')).toHaveTextContent(
      'Relationship score, warm paths and coverage',
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(EM_DASH);
  });

  it('says so when this is the only position with the sponsor', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.sponsor]: ok(
        sponsorDetailFixture({ positions: [sponsorDetailFixture().positions[0]!] }),
      ),
    });
    renderWithQuery(<SponsorTab />);
    expect(await screen.findByText('No other positions with this sponsor')).toBeInTheDocument();
  });

  it('degrades a 501 to the not-built wording and keeps the contacts note', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.sponsor]: failing(501, DEAL_PATHS.sponsor),
    });
    renderWithQuery(<SponsorTab />);
    expect(await screen.findByText('The sponsor: not available yet')).toBeInTheDocument();
    expect(screen.getByTestId('deal-contacts')).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });

  it('degrades a 403 to the role wording', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.sponsor]: failing(403, DEAL_PATHS.sponsor),
    });
    renderWithQuery(<SponsorTab />);
    expect(await screen.findByText('The sponsor: not visible to your role')).toBeInTheDocument();
  });

  it('shows a sponsor that is not found as an error', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.sponsor]: failing(404, DEAL_PATHS.sponsor),
    });
    renderWithQuery(<SponsorTab />);
    expect(await screen.findByTestId('error-state')).toHaveTextContent(
      'The sponsor could not load',
    );
  });
});
