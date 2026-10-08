import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { capitalNoticePageFixture, ID } from '../../test/fixtures.js';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import {
  creditDetailFixture,
  DEAL_IDS,
  DEAL_PATHS,
  dealDetailFixture,
  dealNoticePageFixture,
} from '../../test/fixtures-deal.js';
import { renderWithQuery } from '../../test/render.js';
import { CapitalTab } from './CapitalTab.js';

vi.mock('@tanstack/react-router', async () => {
  const { routerMock } = await import('../../test/router-mock.js');
  const { DEAL_ID: id } = await import('../../test/fixtures-deal.js');
  return { ...routerMock(), useParams: () => ({ id }) };
});

const EM_DASH = String.fromCharCode(0x2014);

describe('capital activity tab', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows invested and distributions, then the notices with due-date urgency and a link to each', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.notices]: ok(dealNoticePageFixture()),
    });
    renderWithQuery(<CapitalTab />);
    const tiles = await screen.findByTestId('deal-capital-tiles');
    expect(within(tiles).getByRole('group', { name: 'Invested' })).toHaveTextContent('$6.9M');
    expect(within(tiles).getByRole('group', { name: 'Distributions' })).toHaveTextContent('$2.2M');

    const table = await screen.findByRole('table', { name: 'Capital notices' });
    const rows = within(table).getAllByRole('row').slice(1);
    // Latest due date first.
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual([
      'Jul 2, 2025Due in 2 days',
      'Jun 28, 2025Overdue by 2 days',
      'Jul 30, 2024',
    ]);
    expect(rows[0]).toHaveTextContent('Capital call$1.3M-Ticket approved');
    expect(rows[1]).toHaveTextContent('Reviewed');
    // Settled notices carry no due badge; the settled amount comes from the API.
    expect(rows[2]).toHaveTextContent('Distribution$2.2M$2.2MReconciled');
    expect(within(rows[1]!).getByText('Overdue by 2 days').closest('.pb-badge')).toHaveClass(
      'pb-badge-bad',
    );
    expect(within(rows[0]!).getByText('Due in 2 days').closest('.pb-badge')).toHaveClass(
      'pb-badge-watch',
    );
    const open = within(rows[1]!).getByRole('link', { name: 'Open Capital call due Jun 28, 2025' });
    expect(open).toHaveAttribute('href', `/capital-activity/${ID.notice1}`);
    expect(within(rows[2]!).getByRole('link', { name: /^Open Distribution/ })).toHaveAttribute(
      'href',
      `/capital-activity/${DEAL_IDS.notice2}`,
    );
    expect(screen.getByRole('link', { name: 'Open capital activity' })).toHaveAttribute(
      'href',
      '/capital-activity',
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(EM_DASH);
  });

  it('labels the first tile Funded for a credit position', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(creditDetailFixture()),
      [DEAL_PATHS.notices]: ok(capitalNoticePageFixture([])),
    });
    renderWithQuery(<CapitalTab />);
    expect(await screen.findByRole('group', { name: 'Funded' })).toHaveTextContent('$9.9M');
    expect(await screen.findByText('No capital notices for this position')).toBeInTheDocument();
  });

  it('falls back to the cash flows on record, newest first, while the notices list answers 501', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.notices]: failing(501, '/api/v1/capital-notices'),
    });
    renderWithQuery(<CapitalTab />);
    expect(await screen.findByText('Capital notices are not available yet')).toBeInTheDocument();
    const flows = screen.getByRole('table', { name: 'Cash flows' });
    const rows = within(flows).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      'Jul 30, 2024Distribution$2.2M',
      'Nov 15, 2018Contribution-$6.9M',
    ]);
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Capital notices' })).not.toBeInTheDocument();
  });

  it('falls back the same way when the role may not read notices', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.notices]: failing(403, '/api/v1/capital-notices'),
    });
    renderWithQuery(<CapitalTab />);
    expect(
      await screen.findByText('Capital notices: not visible to your role'),
    ).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Cash flows' })).toBeInTheDocument();
  });
});
