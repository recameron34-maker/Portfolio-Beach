import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import { dataHealthFixture } from '../../test/fixtures.js';
import {
  lookthroughReconcileResultFixture,
  lookthroughRunPageFixture,
  RUN_ID,
} from '../../test/fixtures-lookthrough.js';
import { rolePrincipal, sentPosts, sentRequests } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { navigate } from '../../test/router-mock.js';
import { LookthroughPage } from './Lookthrough.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const ME = '/api/v1/auth/me';
const HEALTH = '/api/v1/data-health';
const RUNS = '/api/v1/intake/files?limit=200&source=lookthrough';
const RECONCILE = '/api/v1/intake/lookthrough/reconcile';

function routes(
  roles: Parameters<typeof rolePrincipal>[0] = ['operations'],
  overrides: MockRoutes = {},
): MockRoutes {
  return {
    [ME]: ok(rolePrincipal(roles)),
    [HEALTH]: ok(dataHealthFixture()),
    [RUNS]: ok(lookthroughRunPageFixture()),
    ...overrides,
  };
}

const dateInput = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>('As of');

describe('look-through runs', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    navigate.mockReset();
  });

  it('lists every run with its as-of date, result and rows by outcome, newest first', async () => {
    mockApi(routes());
    renderWithQuery(<LookthroughPage />);
    const table = await screen.findByRole('table', { name: 'Reconcile runs' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Look-through');
    expect(screen.getByText(/differences open exceptions and change nothing/)).toBeInTheDocument();
    expect(screen.getByTestId('lookthrough-runs')).toBe(table);
    expect(within(table).getAllByRole('row')).toHaveLength(4);

    const defects = within(table).getByRole('link', { name: 'lookthrough-2025-06-30.json' });
    expect(defects).toHaveAttribute('href', `/data/lookthrough/${RUN_ID.defects}`);
    const defectsRow = defects.closest('tr')!;
    expect(within(defectsRow).getByText('Jun 30, 2025')).toBeInTheDocument();
    expect(within(defectsRow).getByText('Jul 2, 2025')).toBeInTheDocument();
    expect(within(defectsRow).getByText('Avery Castellanos')).toBeInTheDocument();
    expect(within(defectsRow).getByText('7')).toBeInTheDocument();
    expect(within(defectsRow).getByText('Differences')).toHaveClass('pb-badge-watch');
    expect(within(defectsRow).getByText('1 agree, 6 flagged')).toBeInTheDocument();

    const clean = within(table).getByText('lookthrough-2025-03-31.json').closest('tr')!;
    expect(within(clean).getByText('Agrees')).toHaveClass('pb-badge-good');
    expect(within(clean).getByText('16 agree, 0 flagged')).toBeInTheDocument();

    const empty = within(table).getByText('lookthrough-2025-05-30.json').closest('tr')!;
    expect(within(empty).getByText('No extract')).toHaveClass('pb-badge-neutral');
    expect(within(empty).getByText('-')).toBeInTheDocument();
    expect(screen.queryByTestId('lookthrough-runs-truncated')).not.toBeInTheDocument();
  });

  it('offers the run card to operations only, with the as-of date from Data Health', async () => {
    mockApi(routes(['operations']));
    renderWithQuery(<LookthroughPage />);
    await screen.findByTestId('lookthrough-run');
    expect(dateInput()).toHaveValue('2025-06-30');
    expect(screen.getByRole('button', { name: 'Reconcile' })).toBeEnabled();
    const urls = sentRequests().map(([url]) => url);
    expect([...new Set(urls)].sort()).toEqual([ME, HEALTH, RUNS].sort());

    cleanup();
    vi.restoreAllMocks();
    mockApi(routes(['deal_team']));
    renderWithQuery(<LookthroughPage />);
    await screen.findByRole('table', { name: 'Reconcile runs' });
    expect(screen.queryByTestId('lookthrough-run')).not.toBeInTheDocument();
  });

  it('reconciles the date in the card and opens the run; a duplicate says so through the search', async () => {
    mockApi(routes(['operations'], { [RECONCILE]: ok(lookthroughReconcileResultFixture()) }));
    renderWithQuery(<LookthroughPage />);
    await screen.findByTestId('lookthrough-run');
    fireEvent.change(dateInput(), { target: { value: '2025-06-27' } });
    expect(dateInput()).toHaveValue('2025-06-27');
    await userEvent.click(screen.getByRole('button', { name: 'Reconcile' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(sentPosts()).toEqual([[RECONCILE, { asOf: '2025-06-27' }]]);
    expect(navigate).toHaveBeenCalledWith({
      to: '/data/lookthrough/$id',
      params: { id: RUN_ID.defects },
      search: {},
    });

    cleanup();
    vi.restoreAllMocks();
    navigate.mockReset();
    mockApi(routes(['operations'], { [RECONCILE]: ok(lookthroughReconcileResultFixture(true)) }));
    renderWithQuery(<LookthroughPage />);
    await screen.findByTestId('lookthrough-run');
    await userEvent.click(screen.getByRole('button', { name: 'Reconcile' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(sentPosts()).toEqual([[RECONCILE, { asOf: '2025-06-30' }]]);
    expect(navigate).toHaveBeenCalledWith({
      to: '/data/lookthrough/$id',
      params: { id: RUN_ID.defects },
      search: { duplicate: true },
    });
  });

  it('keeps the button off without a real date, and words a refused reconcile in the card', async () => {
    mockApi(routes(['operations'], { [RECONCILE]: failing(403, RECONCILE) }));
    renderWithQuery(<LookthroughPage />);
    await screen.findByTestId('lookthrough-run');
    fireEvent.change(dateInput(), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Reconcile' })).toBeDisabled();
    fireEvent.change(dateInput(), { target: { value: '2025-06-30' } });
    await userEvent.click(screen.getByRole('button', { name: 'Reconcile' }));
    expect(
      await screen.findByText(
        'Reconcile 2025-06-30: Your role cannot do this. Your role may not read this',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('lookthrough-run-status')).toHaveTextContent('Reconcile 2025-06-30');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('tells a viewer who look-through is for, and degrades while the endpoint answers 501', async () => {
    mockApi(routes(['viewer'], { [RUNS]: failing(403, '/api/v1/intake/files') }));
    renderWithQuery(<LookthroughPage />);
    expect(
      await screen.findByText('Look-through is for operations and reviewers'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('lookthrough-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('lookthrough-run')).not.toBeInTheDocument();

    cleanup();
    vi.restoreAllMocks();
    mockApi(routes(['operations'], { [RUNS]: failing(501, '/api/v1/intake/files') }));
    renderWithQuery(<LookthroughPage />);
    expect(await screen.findByText('Look-through: not available yet')).toBeInTheDocument();
  });

  it('says when nothing was reconciled yet, and when only the first page is shown', async () => {
    mockApi(routes(['approver'], { [RUNS]: ok(lookthroughRunPageFixture([])) }));
    renderWithQuery(<LookthroughPage />);
    expect(await screen.findByText('No reconcile runs yet')).toBeInTheDocument();
    expect(screen.getByText(/Operations reconciles the provider extract/)).toBeInTheDocument();

    cleanup();
    vi.restoreAllMocks();
    mockApi(routes(['approver'], { [RUNS]: ok(lookthroughRunPageFixture(undefined, 'next')) }));
    renderWithQuery(<LookthroughPage />);
    expect(await screen.findByTestId('lookthrough-runs-truncated')).toHaveTextContent(
      'Showing the first 200 runs; more exist.',
    );
  });

  it('never shows an em dash', async () => {
    mockApi(routes());
    const { container } = renderWithQuery(<LookthroughPage />);
    await screen.findByRole('table', { name: 'Reconcile runs' });
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});
