import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { taxonomy } from '@pb/contracts';
import { mockApi, taxonomyFixture, withQueries } from '../assistants/test-support.js';
import { TaxonomyPage } from './Taxonomy.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => (
    <a href={to}>{children as never}</a>
  ),
}));

describe('taxonomy page', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('parses its fixture with the contract', () => {
    expect(() => taxonomy.parse(taxonomyFixture())).not.toThrow();
  });

  it('renders a card per domain with codes, labels, parents and inactive badges', async () => {
    mockApi({ '/api/v1/taxonomy': { body: taxonomyFixture() } });
    render(withQueries(<TaxonomyPage />));
    const dealType = await screen.findByTestId('taxonomy-deal_type');
    expect(within(dealType).getByRole('heading')).toHaveTextContent('Deal type');
    expect(within(dealType).getByRole('heading')).toHaveTextContent('2 terms, 1 inactive');
    const rows = within(within(dealType).getByRole('table')).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('deal_type.co_invest_equity');
    expect(rows[1]).toHaveTextContent('Co-investment (equity)');
    expect(rows[1]).toHaveTextContent('none');
    expect(rows[2]).toHaveTextContent('deal_type.co_invest_equity');
    expect(within(rows[2]!).getByText('Inactive')).toBeVisible();
    expect(screen.getByTestId('taxonomy-sector')).toHaveTextContent('Healthcare');
    expect(screen.getByTestId('taxonomy-count')).toHaveTextContent('3 terms across 2 domains');
    expect(screen.getByRole('navigation', { name: 'Admin' })).toHaveTextContent('Taxonomy');
  });

  it('filters by code or label and shows an empty state when nothing matches', async () => {
    mockApi({ '/api/v1/taxonomy': { body: taxonomyFixture() } });
    render(withQueries(<TaxonomyPage />));
    await screen.findByTestId('taxonomy-deal_type');
    const filter = screen.getByLabelText('Filter by code or label');
    await userEvent.type(filter, 'health');
    expect(screen.queryByTestId('taxonomy-deal_type')).toBeNull();
    expect(screen.getByTestId('taxonomy-sector')).toBeVisible();
    expect(screen.getByTestId('taxonomy-count')).toHaveTextContent(
      '1 of 3 terms match in 1 domain',
    );
    await userEvent.clear(filter);
    await userEvent.type(filter, 'cv_single');
    expect(within(screen.getByTestId('taxonomy-deal_type')).getByRole('heading')).toHaveTextContent(
      '1 of 2 terms',
    );
    await userEvent.clear(filter);
    await userEvent.type(filter, 'nothing here');
    expect(screen.getByTestId('taxonomy-empty')).toHaveTextContent('No terms match');
  });
});
