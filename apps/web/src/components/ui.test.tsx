import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  CheckList,
  EmptyState,
  KeyValueTable,
  Notice,
  PageHeader,
  PageSkeleton,
  RowsSkeleton,
  SectionHeader,
  StatTile,
  Subhead,
  TableWrap,
  TabNav,
} from './ui.js';

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

describe('figures strip cell, how a figure is worked out', () => {
  afterEach(cleanup);

  it('keeps the formula under the pointer and the basis as the hint', () => {
    render(<StatTile label="DPI" value="0.10x" hint="Pooled" title="Distributions / invested" />);
    const cell = screen.getByRole('group', { name: 'DPI' });
    expect(cell).toHaveAttribute('title', 'Distributions / invested');
    expect(cell).toHaveTextContent('Pooled');
    expect(cell).not.toHaveTextContent('Distributions / invested');
  });
});

describe('check list', () => {
  afterEach(cleanup);

  it('is one compact table named for its checks, with the test id on its frame', () => {
    render(
      <CheckList
        label="Readiness checks"
        testId="checks"
        rows={[
          { check: 'Database', tone: 'good', result: 'OK' },
          { check: 'Mail', tone: 'bad', result: 'Degraded', detail: 'Switched off' },
        ]}
      />,
    );
    const frame = screen.getByTestId('checks');
    expect(frame).toHaveAttribute('role', 'region');
    const table = within(frame).getByRole('table', { name: 'Readiness checks' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Check', 'Result', 'Detail']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(['DatabaseOK', 'MailDegradedSwitched off']);
    // An empty detail stays blank: no filler words.
    expect(within(rows[0]!).getAllByRole('cell')[1]).toBeEmptyDOMElement();
  });

  it('draws the tone as a dot before the result and adds no word of its own', () => {
    const { container } = render(
      <CheckList
        label="Data checks"
        rows={[
          { check: 'Orphan investments', result: '0' },
          { check: 'Open exceptions', tone: 'watch', result: '3' },
        ]}
      />,
    );
    const results = [...container.querySelectorAll('.pb-check-result')];
    expect(results.map((r) => r.getAttribute('data-tone'))).toEqual([null, 'watch']);
    expect(results.map((r) => r.textContent)).toEqual(['0', '3']);
    // Every result keeps the dot's room, hidden from a screen reader, so the results line up.
    for (const r of results)
      expect(r.querySelector('.pb-check-dot')).toHaveAttribute('aria-hidden', 'true');
  });

  it('adds a command column only when a row has a command, and lets a sentence run across', () => {
    render(
      <CheckList
        label="Data checks"
        rows={[
          { check: 'Open exceptions', result: '3', action: <a href="/q">Open the queue</a> },
          { check: 'Client ownership', wide: true, result: 'Every vehicle sums to 100%.' },
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: 'Data checks' });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(4);
    expect(within(table).getByRole('columnheader', { name: 'Command' })).toBeInTheDocument();
    const [, open, ownership] = within(table).getAllByRole('row');
    expect(within(open!).getByRole('link', { name: 'Open the queue' })).toBeVisible();
    const sentence = within(ownership!).getAllByRole('cell')[0];
    expect(sentence).toHaveAttribute('colspan', '2');
    expect(sentence).toHaveTextContent('Every vehicle sums to 100%.');
  });
});

describe('check list on a phone', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("puts the command at the end of its row's detail instead of a column of its own", () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 760px)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    render(
      <CheckList
        label="Data checks"
        rows={[
          { check: 'Open exceptions', result: '3', action: <a href="/q">Open the queue</a> },
          { check: 'Stale positions', result: '1', detail: 'No approved financials in 75 days' },
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: 'Data checks' });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(3);
    const open = within(table).getAllByRole('row')[1]!;
    expect(within(within(open).getAllByRole('cell')[1]!).getByRole('link')).toHaveTextContent(
      'Open the queue',
    );
  });
});

describe('states', () => {
  afterEach(cleanup);

  it('says an empty list plainly, with no mark', () => {
    render(<EmptyState title="No requests" detail="Nothing is waiting." testId="empty" />);
    const empty = screen.getByTestId('empty');
    expect(empty).toHaveTextContent('No requestsNothing is waiting.');
    expect(empty.querySelector('svg')).toBeNull();
  });

  it('sets a notice in its tone, info by default', () => {
    render(
      <>
        <Notice testId="info">Values are as of the quarter end.</Notice>
        <Notice tone="good" testId="good">
          Saved.
        </Notice>
        <Notice tone="watch" testId="watch">
          One file is late.
        </Notice>
        <Notice tone="bad" testId="bad">
          The read failed.
        </Notice>
      </>,
    );
    expect(screen.getByTestId('info').className).toBe('pb-notice');
    expect(screen.getByTestId('good')).toHaveClass('pb-notice', 'pb-notice-good');
    expect(screen.getByTestId('watch')).toHaveClass('pb-notice', 'pb-notice-watch');
    expect(screen.getByTestId('bad')).toHaveClass('pb-notice', 'pb-notice-bad');
    expect(screen.getByTestId('watch').tagName).toBe('P');
  });

  it('loads in the shape of the page and of a list, busy and never a status', () => {
    const { container } = render(
      <>
        <PageSkeleton tiles={4} rows={3} />
        <RowsSkeleton rows={5} />
        <RowsSkeleton rows={2} label="Loading sign-in options" />
      </>,
    );
    const [page, list, named] = Array.from(
      container.querySelectorAll(':scope > [aria-busy="true"]'),
    );
    expect(page?.querySelectorAll('.pb-skeleton-tile')).toHaveLength(4);
    expect(page?.querySelectorAll('.pb-skeleton-row')).toHaveLength(3);
    expect(list?.querySelectorAll('.pb-skeleton-row')).toHaveLength(5);
    expect(list).toHaveTextContent('Loading');
    // A list can say what is loading, so a screen reader hears more than "Loading".
    expect(named).toHaveTextContent('Loading sign-in options');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('tab row on a phone', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('marks each end of the row that hides tabs, so that end fades and no tab is cut off unseen', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 760px)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    // The row is 600px of tabs in a 358px window.
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(600);
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(358);
    render(
      <TabNav
        label="Analytics"
        items={[
          { to: '/analytics/exposure', label: 'Exposure' },
          { to: '/analytics/performance', label: 'Performance' },
          { to: '/analytics/map', label: 'Map' },
        ]}
      />,
    );
    const row = screen.getByRole('navigation', { name: 'Analytics' });
    const at = (left: number): void => {
      Object.defineProperty(row, 'scrollLeft', { value: left, configurable: true });
      fireEvent.scroll(row);
    };
    at(0);
    expect(row).not.toHaveAttribute('data-more-before');
    expect(row).toHaveAttribute('data-more-after');
    at(120);
    expect(row).toHaveAttribute('data-more-before');
    expect(row).toHaveAttribute('data-more-after');
    at(242);
    expect(row).toHaveAttribute('data-more-before');
    expect(row).not.toHaveAttribute('data-more-after');
  });

  it('marks nothing on a wide screen, where the tabs wrap', () => {
    render(<TabNav label="Admin" items={[{ to: '/admin/flags', label: 'Flags' }]} />);
    const row = screen.getByRole('navigation', { name: 'Admin' });
    expect(row).not.toHaveAttribute('data-more-before');
    expect(row).not.toHaveAttribute('data-more-after');
  });
});
