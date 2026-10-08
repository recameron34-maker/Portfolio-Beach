import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import { DEAL_PATHS, dealDetailFixture, valuationPageFixture } from '../../test/fixtures-deal.js';
import { renderWithQuery } from '../../test/render.js';
import { ValuationsTab } from './ValuationsTab.js';

vi.mock('@tanstack/react-router', async () => {
  const { routerMock } = await import('../../test/router-mock.js');
  const { DEAL_ID: id } = await import('../../test/fixtures-deal.js');
  return { ...routerMock(), useParams: () => ({ id }) };
});

const EM_DASH = String.fromCharCode(0x2014);

describe('valuations tab', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('charts the Locked versions and lists every version newest first with its reopen reason', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.valuations]: ok(valuationPageFixture()),
    });
    renderWithQuery(<ValuationsTab />);

    const card = await screen.findByTestId('deal-valuations');
    expect(card).toHaveTextContent('4 versions, newest first');
    expect(within(card).getByRole('group', { name: 'Locked fair value by period' })).toBeVisible();
    // Only the two Locked versions are plotted, and the summary says so.
    expect(
      within(card).getByText(
        /Locked fair value over 2 periods, from \$25\.1M at December 2024 to \$26\.0M at March 2025\. Only Locked versions are plotted/,
      ),
    ).toBeInTheDocument();
    expect(within(card).queryByRole('list', { name: 'Legend' })).not.toBeInTheDocument();

    const table = within(card).getByRole('table', { name: 'Valuation versions' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      'Jun 30, 20251Ops preparedSponsor mark$26.0M$27.4M5.4%-',
      'Mar 31, 20252LockedSponsor mark$25.1M$26.0M3.6%Apr 20, 2025',
      'Mar 31, 20251ReopenedSponsor mark$25.1M$26.8M6.8%Apr 10, 2025',
      'Reopen reason: Sponsor restated the quarter.',
      'Dec 31, 20241LockedSponsor mark-$25.1M-Jan 25, 2025',
    ]);
    // The first version has no prior Locked value: the placeholder, never zero.
    expect(within(rows[4]!).getAllByRole('cell')[4]).toHaveClass('is-missing');
    expect(within(rows[3]!).getByText('Reopen reason: Sponsor restated the quarter.')).toHaveClass(
      'pb-meta',
    );

    expect(within(card).getByRole('link', { name: 'Open the valuation board' })).toHaveAttribute(
      'href',
      '/valuations',
    );
    expect(card).toHaveTextContent(
      'Prepare, approve, lock and reopen live on the valuation board.',
    );
    // Read only: the workflow buttons live on the board.
    expect(screen.queryByRole('button', { name: /lock|approve|prepare|reopen/i })).toBeNull();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(EM_DASH);
  });

  it('says so when the position has no valuation versions', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.valuations]: ok(valuationPageFixture([])),
    });
    renderWithQuery(<ValuationsTab />);
    expect(await screen.findByText('No valuation versions')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the valuation board' })).toBeInTheDocument();
  });

  it('falls back to the versions on the position record while the list answers 501', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.valuations]: failing(501, '/api/v1/valuations'),
    });
    renderWithQuery(<ValuationsTab />);
    expect(
      await screen.findByText('Approvals and prior values are not available yet'),
    ).toBeInTheDocument();
    const recorded = await screen.findByTestId('deal-valuations-recorded');
    expect(recorded).toHaveTextContent('As recorded on the position, newest first');
    const rows = within(within(recorded).getByRole('table', { name: 'Valuation versions' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      'Jun 30, 20251Ops preparedSponsor mark$27.4M',
      'Mar 31, 20252LockedSponsor mark$26.0M',
      'Mar 31, 20251ReopenedSponsor mark$26.8M',
      'Dec 31, 20241LockedSponsor mark$25.1M',
    ]);
    expect(
      within(recorded).getByRole('group', { name: 'Locked fair value by period' }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });

  it('falls back the same way when the role may not read the list', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.valuations]: failing(403, '/api/v1/valuations'),
    });
    renderWithQuery(<ValuationsTab />);
    expect(
      await screen.findByText('Valuation versions: not visible to your role'),
    ).toBeInTheDocument();
    expect(await screen.findByTestId('deal-valuations-recorded')).toBeInTheDocument();
  });
});
