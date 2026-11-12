import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { clearTaxonomyLabels, registerTaxonomyLabels } from '../../lib/format.js';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import {
  lookthroughRunDetailFixture,
  lookthroughRuns,
  RUN_ID,
} from '../../test/fixtures-lookthrough.js';
import { POSITION_ID } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { LookthroughRunPage } from './LookthroughRun.js';

const route = vi.hoisted(() => ({ id: '', duplicate: undefined as boolean | undefined }));

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: route.id }),
  useSearch: () => ({ duplicate: route.duplicate }),
}));

const runPath = (id: string): string => `/api/v1/intake/lookthrough/runs/${id}`;

function routes(overrides: MockRoutes = {}): MockRoutes {
  route.id = RUN_ID.defects;
  route.duplicate = undefined;
  return { [runPath(RUN_ID.defects)]: ok(lookthroughRunDetailFixture()), ...overrides };
}

const tile = (name: string): HTMLElement =>
  within(screen.getByTestId('lookthrough-tiles')).getByRole('group', { name });

/** The n-th data row of the positions table (the alias row shows the record's name, so two rows share it). */
const rowAt = (n: number): HTMLElement => {
  const table = screen.getByRole('table', { name: 'Reconciled positions' });
  const row = within(table).getAllByRole('row')[n];
  if (row === undefined) throw new Error(`no row ${n}`);
  return row;
};

const rowOf = (text: string): HTMLElement => {
  const table = screen.getByRole('table', { name: 'Reconciled positions' });
  const row = within(table).getByText(text).closest('tr');
  if (row === null) throw new Error(`no row holds ${text}`);
  return row;
};

describe('a reconcile run', () => {
  beforeAll(() =>
    registerTaxonomyLabels([
      { code: 'sector.software', label: 'Software' },
      { code: 'sector.healthcare', label: 'Healthcare' },
      { code: 'sector.business_services', label: 'Business services' },
      { code: 'geography.north_america', label: 'North America' },
      { code: 'geography.europe', label: 'Europe' },
    ]),
  );
  afterAll(() => clearTaxonomyLabels());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the run, its tiles and every row with its mapping, exposures, differences and findings', async () => {
    mockApi(routes());
    renderWithQuery(<LookthroughRunPage />);
    const banner = await screen.findByTestId('lookthrough-banner');
    expect(within(banner).getByRole('heading', { level: 1 })).toHaveTextContent(
      'lookthrough-2025-06-30.json',
    );
    expect(banner).toHaveTextContent('As of Jun 30, 2025');
    expect(banner).toHaveTextContent('Reconciled Jul 2, 2025');
    expect(banner).toHaveTextContent('By Avery Castellanos');
    expect(banner).toHaveTextContent('7 rows');
    expect(within(banner).getByText('Differences')).toHaveClass('pb-badge-watch');
    expect(screen.getByRole('link', { name: 'All reconcile runs' })).toHaveAttribute(
      'href',
      '/data/lookthrough',
    );
    expect(screen.queryByTestId('lookthrough-duplicate')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lookthrough-file-findings')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lookthrough-hidden-rows')).not.toBeInTheDocument();

    expect(within(tile('Rows')).getByText('7')).toBeInTheDocument();
    expect(within(tile('Matched')).getByText('6')).toBeInTheDocument();
    expect(within(tile('Differences')).getByText('2')).toBeInTheDocument();
    expect(tile('Differences')).toHaveAttribute('data-tone', 'watch');
    expect(within(tile('Exceptions')).getByText('4')).toBeInTheDocument();
    expect(tile('Exceptions')).toHaveAttribute('data-tone', 'watch');
    expect(screen.getByRole('link', { name: '4 exceptions on the queue' })).toHaveAttribute(
      'href',
      '/data/exceptions',
    );

    const table = screen.getByRole('table', { name: 'Reconciled positions' });
    expect(screen.getByTestId('lookthrough-rows')).toBe(table);
    expect(within(table).getAllByRole('row')).toHaveLength(8);

    const agrees = rowAt(1);
    expect(within(agrees).getByRole('link', { name: 'Meridian Data Partners' })).toHaveAttribute(
      'href',
      `/portfolio/${POSITION_ID.meridian}`,
    );
    expect(within(agrees).getByText('INV-0001')).toHaveClass('pb-key');
    expect(within(agrees).getByText('Technology (Software)')).toBeInTheDocument();
    expect(within(agrees).getByText('North America (North America)')).toBeInTheDocument();
    expect(within(agrees).getAllByText('$27,400,000.00')).toHaveLength(1);
    expect(within(agrees).getByText('record $27,400,000.00')).toBeInTheDocument();
    expect(within(agrees).getAllByText('None')).toHaveLength(2);
    expect(within(agrees).getByText('Validated')).toHaveClass('pb-badge-neutral');

    const nav = rowOf('Silverline Staffing Holdings');
    expect(within(nav).getByText('$21,500,000.00')).toBeInTheDocument();
    expect(within(nav).getByText('record $20,000,000.00')).toBeInTheDocument();
    const navBadge = within(nav).getByText('NAV', { selector: '.pb-badge' });
    expect(navBadge).toHaveClass('pb-badge-watch');
    expect(navBadge.closest('[title]')).toHaveAttribute(
      'title',
      'NAV $20,000,000.00 on record, provider $21,500,000.00',
    );
    expect(
      within(nav).getByText('NAV $20,000,000.00 on record, provider $21,500,000.00'),
    ).toBeInTheDocument();
    expect(within(nav).getByText('LT-TIE-01', { selector: '.pb-badge' })).toHaveClass(
      'pb-badge-bad',
    );
    expect(within(nav).getByText('Flagged')).toHaveClass('pb-badge-watch');
    expect(within(nav).getByText('1 exception')).toBeInTheDocument();

    const sector = rowOf('Cobalt Energy Group');
    expect(within(sector).getByText('Healthcare (Healthcare)')).toBeInTheDocument();
    expect(within(sector).getByText('Sector', { selector: '.pb-badge' })).toHaveClass(
      'pb-badge-watch',
    );
    expect(
      within(sector).getByText(
        'Sector sector.energy_transition on record, provider Healthcare (sector.healthcare)',
      ),
    ).toBeInTheDocument();

    const unmapped = rowOf('Ashby Renewables Group');
    expect(within(unmapped).getByText('Other (unmapped)')).toBeInTheDocument();
    expect(within(unmapped).getByText('LT-MAP-01', { selector: '.pb-badge' })).toHaveClass(
      'pb-badge-bad',
    );
    expect(within(unmapped).getByText('1 finding')).toBeInTheDocument();
    expect(
      within(unmapped).getByText(
        'LT-MAP-01: The sector label is not in config/lookthrough_mapping.json; the taxonomy is never guessed from a label (Expected a sector label the mapping lists, actual Other)',
      ),
    ).toBeInTheDocument();

    const unmatched = rowOf('Meridian Data Partner');
    expect(within(unmatched).queryByRole('link')).not.toBeInTheDocument();
    expect(within(unmatched).getByText('no match')).toHaveClass('pb-badge-plain');
    expect(
      within(unmatched).getByText('Candidates: INV-0001 Meridian Data Partners (near miss)'),
    ).toBeInTheDocument();
    expect(within(unmatched).getAllByText('record -')).toHaveLength(2);

    const stale = rowOf('Summit Care Holdings');
    expect(within(stale).getByText('LT-STALE-01', { selector: '.pb-badge' })).toHaveClass(
      'pb-badge-bad',
    );
    expect(within(stale).queryByText(/exception/)).not.toBeInTheDocument();

    const alias = rowAt(7);
    expect(within(alias).getByRole('link', { name: 'Meridian Data Partners' })).toBeInTheDocument();
    expect(within(alias).getByText('LT-DUP-01', { selector: '.pb-badge' })).toBeInTheDocument();
  });

  it('counts the rows behind a wall and notes a duplicate reconcile', async () => {
    mockApi(
      routes({ [runPath(RUN_ID.defects)]: ok(lookthroughRunDetailFixture({ hiddenRows: 2 })) }),
    );
    route.duplicate = true;
    renderWithQuery(<LookthroughRunPage />);
    expect(await screen.findByTestId('lookthrough-hidden-rows')).toHaveTextContent(
      '2 rows are linked to positions you cannot see',
    );
    expect(screen.getByTestId('lookthrough-duplicate')).toHaveTextContent(
      'This extract was reconciled before. The run is shown as it stands; nothing new was staged.',
    );
    expect(screen.queryByTestId('lookthrough-no-rows')).not.toBeInTheDocument();
  });

  it('says every row sits behind a wall when the run has rows and the reader sees none', async () => {
    mockApi(
      routes({
        [runPath(RUN_ID.defects)]: ok(lookthroughRunDetailFixture({ rows: [], hiddenRows: 7 })),
      }),
    );
    renderWithQuery(<LookthroughRunPage />);
    const empty = await screen.findByTestId('lookthrough-no-rows');
    expect(empty).toHaveTextContent('Every row in this run is linked to positions you cannot see');
    expect(screen.getByTestId('lookthrough-hidden-rows')).toHaveTextContent('7 rows');
    expect(within(tile('Rows')).getByText('7')).toBeInTheDocument();
    expect(within(tile('Matched')).getByText('0')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Reconciled positions' })).not.toBeInTheDocument();
  });

  it('shows the run findings of a date with no extract and says no rows were reconciled', async () => {
    const empty = lookthroughRuns()[2]!;
    route.id = RUN_ID.empty;
    mockApi({
      [runPath(RUN_ID.empty)]: ok(
        lookthroughRunDetailFixture({ ...empty, asOf: '2025-05-30', rows: [], hiddenRows: 0 }),
      ),
    });
    renderWithQuery(<LookthroughRunPage />);
    const findings = await screen.findByRole('list', { name: 'Run findings' });
    expect(within(findings).getByText('LT-FILE-01')).toHaveClass('pb-badge-bad');
    expect(findings).toHaveTextContent('No extract for 2025-05-30');
    expect(screen.getByTestId('lookthrough-no-rows')).toHaveTextContent('No rows were reconciled');
    expect(within(screen.getByTestId('lookthrough-banner')).getByText('No extract')).toHaveClass(
      'pb-badge-neutral',
    );
    expect(screen.queryByRole('link', { name: /on the queue/ })).not.toBeInTheDocument();
  });

  it('says not found on a 404, who look-through is for on a 403, and degrades on a 501', async () => {
    const cases: [403 | 404 | 501, string][] = [
      [404, 'Reconcile run not found or not visible to you'],
      [403, 'Look-through is for operations and reviewers'],
      [501, 'This reconcile run: not available yet'],
    ];
    for (const [status, text] of cases) {
      cleanup();
      vi.restoreAllMocks();
      mockApi(routes({ [runPath(RUN_ID.defects)]: failing(status, runPath(RUN_ID.defects)) }));
      renderWithQuery(<LookthroughRunPage />);
      expect(await screen.findByText(text), String(status)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'All reconcile runs' })).toBeInTheDocument();
    }
  });

  it('never shows an em dash', async () => {
    mockApi(routes());
    const { container } = renderWithQuery(<LookthroughRunPage />);
    await screen.findByRole('table', { name: 'Reconciled positions' });
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});
