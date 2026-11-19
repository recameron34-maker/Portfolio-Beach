import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { KeyValueTable, PageHeader, SectionHeader, StatTile, Subhead, TableWrap } from './ui.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../test/router-mock.js')).routerMock(),
);

describe('table frame', () => {
  afterEach(cleanup);

  it('is a focusable region named after its table, so keyboard users can scroll it', () => {
    render(
      <TableWrap label="Cash flows">
        <table aria-label="Cash flows">
          <tbody>
            <tr>
              <td>Jun 30, 2025</td>
            </tr>
          </tbody>
        </table>
      </TableWrap>,
    );
    const region = screen.getByRole('region', { name: 'Cash flows' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveClass('pb-table-wrap');
    expect(region).not.toHaveClass('is-tall');
    expect(region).not.toHaveAttribute('aria-busy');
    expect(within(region).getByRole('table', { name: 'Cash flows' })).toBeInTheDocument();
  });

  it('says when its rows are being replaced, and holds a long table in a tall region', () => {
    render(
      <TableWrap label="Trade tickets" tall busy>
        <table aria-label="Trade tickets">
          <tbody>
            <tr>
              <td>Jun 30, 2025</td>
            </tr>
          </tbody>
        </table>
      </TableWrap>,
    );
    const region = screen.getByRole('region', { name: 'Trade tickets' });
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveClass('pb-table-wrap', 'is-tall');
  });

  it('frames the key and value table the same way', () => {
    render(
      <KeyValueTable
        label="Credit terms"
        rows={[
          { label: 'Facility', value: 'Unitranche' },
          { label: 'Seniority', value: 'Senior secured' },
        ]}
      />,
    );
    const region = screen.getByRole('region', { name: 'Credit terms' });
    expect(within(region).getByRole('rowheader', { name: 'Facility' })).toBeInTheDocument();
    // Two pairs a row on a wider screen.
    expect(within(region).getAllByRole('row')).toHaveLength(1);
  });
});

describe('key and value table on a phone', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('holds one pair a row, and stays a table', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 760px)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    render(
      <KeyValueTable
        label="Credit terms"
        rows={[
          { label: 'Facility', value: 'Unitranche' },
          { label: 'Seniority', value: 'Senior secured' },
          { label: 'Coupon', value: 'SOFR + 5.75%' },
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: 'Credit terms' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByRole('rowheader', { name: 'Seniority' })).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('cell', { name: 'Senior secured' })).toBeInTheDocument();
  });
});

describe('page header', () => {
  afterEach(cleanup);

  it('shows the trail of a record page as a breadcrumb of links above the title', () => {
    render(
      <PageHeader
        title="Cobalt Energy Group"
        meta="As of Jun 30, 2025"
        crumbs={[
          { label: 'Valuations', to: '/valuations' },
          { label: 'Board', to: '/valuations/board' },
        ]}
      />,
    );
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const links = within(trail).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Valuations', 'Board']);
    expect(links[1]).toHaveAttribute('href', '/valuations/board');
    expect(screen.getByRole('heading', { level: 1, name: 'Cobalt Energy Group' })).toBeVisible();
  });

  it('has no trail on an area page', () => {
    render(<PageHeader title="Valuations" meta="As of Jun 30, 2025" />);
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
  });
});

describe('section titles', () => {
  afterEach(cleanup);

  it('keeps commands beside the heading, not inside it', () => {
    render(
      <SectionHeader aside="As of Jun 30, 2025" actions={<button type="button">Export CSV</button>}>
        Positions
      </SectionHeader>,
    );
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('PositionsAs of Jun 30, 2025');
    expect(within(heading).queryByRole('button')).toBeNull();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeVisible();
  });

  it('renders a sub-title one level down', () => {
    render(<Subhead>Fees</Subhead>);
    expect(screen.getByRole('heading', { level: 3, name: 'Fees' })).toHaveClass('pb-subhead');
  });
});

describe('figures strip cell', () => {
  afterEach(cleanup);

  it('keeps its tone and marks a zero, which carries no dot', () => {
    render(
      <>
        <StatTile label="Overdue" value="3" tone="bad" />
        <StatTile label="Flagged" value="0" tone="watch" />
      </>,
    );
    const overdue = screen.getByRole('group', { name: 'Overdue' });
    expect(overdue).toHaveAttribute('data-tone', 'bad');
    expect(overdue).not.toHaveAttribute('data-zero');
    const flagged = screen.getByRole('group', { name: 'Flagged' });
    expect(flagged).toHaveAttribute('data-tone', 'watch');
    expect(flagged).toHaveAttribute('data-zero');
  });
});
