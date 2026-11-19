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

  it('lists every domain in one table, a group of rows each, with codes, labels, parents and states', async () => {
    mockApi({ '/api/v1/taxonomy': { body: taxonomyFixture() } });
    render(withQueries(<TaxonomyPage />));
    const dealType = await screen.findByTestId('taxonomy-deal_type');
    // One table holds every domain; each domain is a group of rows that opens with its name.
    expect(screen.getAllByRole('table')).toHaveLength(1);
    const table = screen.getByRole('table', { name: 'Taxonomy terms' });
    expect(table).toContainElement(dealType);
    const rows = within(dealType).getAllByRole('row');
    expect(rows[0]).toHaveTextContent('Deal type');
    expect(rows[0]).toHaveTextContent('2 terms, 1 inactive');
    expect(rows[1]).toHaveTextContent('deal_type.co_invest_equity');
    expect(rows[1]).toHaveTextContent('Co-investment (equity)');
    // No parent is a fact, not a missing figure: the cell is empty.
    expect(within(rows[1]!).getAllByRole('cell')[2]).toBeEmptyDOMElement();
    expect(rows[2]).toHaveTextContent('deal_type.co_invest_equity');
    expect(within(rows[2]!).getByText('Inactive')).toBeVisible();
    // The index lists each domain with its count, to jump to.
    const index = screen.getByRole('navigation', { name: 'Domains' });
    expect(within(index).getByRole('button', { name: 'Deal type 2 terms' })).toBeVisible();
    expect(within(index).getByRole('button', { name: 'Sector 1 term' })).toBeVisible();
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
    expect(
      within(screen.getByTestId('taxonomy-deal_type')).getAllByRole('row')[0],
    ).toHaveTextContent('1 of 2 terms');
    await userEvent.clear(filter);
    await userEvent.type(filter, 'nothing here');
    expect(screen.getByTestId('taxonomy-empty')).toHaveTextContent('No terms match');
  });
});
