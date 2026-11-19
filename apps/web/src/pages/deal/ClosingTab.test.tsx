import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { mockApi, ok } from '../../test/api-mock.js';
import { DEAL_ID, DEAL_IDS, DEAL_PATHS, dealDetailFixture } from '../../test/fixtures-deal.js';
import {
  closingDetailFixture,
  confirmedClosingFixture,
  PIPE_PATHS,
  taxonomyFixture,
} from '../../test/fixtures-pipeline.js';
import { rolePrincipal } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { ClosingTab } from './ClosingTab.js';

/** A row of the tie-out ledger (Commitment, Allocated, Difference) inside the tie-out section. */
const ledgerRow = (section: HTMLElement, label: string): HTMLElement =>
  within(within(section).getByRole('table', { name: 'Allocation tie-out' })).getByRole('row', {
    name: new RegExp(`^${label}`),
  });

vi.mock('../../app/env.js', () => ({ previewMode: true }));
vi.mock('@tanstack/react-router', async () => {
  const { routerMock } = await import('../../test/router-mock.js');
  const { DEAL_ID: id } = await import('../../test/fixtures-deal.js');
  return { ...routerMock(), useParams: () => ({ id }) };
});

describe('closing tab', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('says a position with no closing record predates the pipeline', async () => {
    mockApi({
      [DEAL_PATHS.me]: ok(rolePrincipal(['viewer'])),
      [DEAL_PATHS.detail]: ok(dealDetailFixture({ closingId: null })),
    });
    renderWithQuery(<ClosingTab />);
    expect(await screen.findByTestId('deal-closing-empty')).toHaveTextContent(
      'No closing record: this position predates the pipeline',
    );
  });

  it('shows the closing panel over the record the position names', async () => {
    mockApi({
      [DEAL_PATHS.me]: ok(rolePrincipal(['viewer'])),
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [PIPE_PATHS.closing(DEAL_IDS.closing)]: ok(
        closingDetailFixture({ id: DEAL_IDS.closing, closeDate: '2018-11-15' }),
      ),
      [PIPE_PATHS.taxonomy]: ok(taxonomyFixture()),
    });
    renderWithQuery(<ClosingTab />);
    const panel = await screen.findByTestId('closing-panel');
    expect(within(panel).getByTestId('closing-close-date')).toHaveTextContent('Nov 15, 2018');
    expect(within(panel).getByTestId('closing-items')).toBeInTheDocument();
    expect(within(panel).getByTestId('legal-terms')).toBeInTheDocument();
    // Read only for a viewer: the confirmation names the role it needs.
    expect(within(panel).getByTestId('closing-confirm')).toHaveAttribute(
      'title',
      'Needs operations',
    );
  });

  it('tells a reader with lines not shown how many, and says nothing of it to operations', async () => {
    const closing = closingDetailFixture({ id: DEAL_IDS.closing, closeDate: '2018-11-15' });
    mockApi({
      [DEAL_PATHS.me]: ok(rolePrincipal(['viewer'])),
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [PIPE_PATHS.closing(DEAL_IDS.closing)]: ok({
        ...closing,
        allocations: closing.allocations.filter((a) => a.client === null),
        allocationTieOut: { ...closing.allocationTieOut, hiddenLines: 1 },
      }),
      [PIPE_PATHS.taxonomy]: ok(taxonomyFixture()),
    });
    renderWithQuery(<ClosingTab />);
    const tieOut = within(await screen.findByTestId('closing-panel')).getByTestId(
      'closing-tie-out',
    );
    // The commitment and the received total lead; the client breakdown is not offered.
    expect(ledgerRow(tieOut, 'Commitment')).toHaveTextContent('$20.0M');
    expect(ledgerRow(tieOut, 'Allocated')).toHaveTextContent('$20.0M');
    expect(within(tieOut).getByTestId('allocations-hidden-lines')).toHaveTextContent(
      '1 client line is not shown. Client-level lines are for operations, the investment team (the deal team and approvers) and auditors, and for readers entitled to the client.',
    );
    expect(within(tieOut).queryByRole('button', { name: /Client breakdown/ })).toBeNull();
    cleanup();
    vi.restoreAllMocks();

    mockApi({
      [DEAL_PATHS.me]: ok(rolePrincipal(['operations'])),
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [PIPE_PATHS.closing(DEAL_IDS.closing)]: ok(closing),
      [PIPE_PATHS.taxonomy]: ok(taxonomyFixture()),
    });
    renderWithQuery(<ClosingTab />);
    const full = within(await screen.findByTestId('closing-panel')).getByTestId('closing-tie-out');
    expect(within(full).queryByTestId('allocations-hidden-lines')).toBeNull();
    expect(
      within(full).getByRole('button', {
        name: 'Client breakdown (1 line), Beach Credit Partners I',
      }),
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not offer a close date change or a reopen on the closing of a position: the change is a deal change request', async () => {
    mockApi({
      [DEAL_PATHS.me]: ok(rolePrincipal(['operations'])),
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [PIPE_PATHS.closing(DEAL_IDS.closing)]: ok({
        ...confirmedClosingFixture(),
        id: DEAL_IDS.closing,
        closeDate: '2018-11-15',
        investmentId: DEAL_ID,
      }),
      [PIPE_PATHS.taxonomy]: ok(taxonomyFixture()),
    });
    renderWithQuery(<ClosingTab />);
    const panel = await screen.findByTestId('closing-panel');
    const POSITION = 'The position exists; record the change through a deal change request';
    const change = within(panel).getByRole('button', { name: 'Change close date' });
    expect(change).toBeDisabled();
    expect(change).toHaveAttribute('title', POSITION);
    expect(within(panel).getByTestId('closing-reopen')).toBeDisabled();
    expect(within(panel).getByTestId('closing-reopen')).toHaveAttribute('title', POSITION);
    expect(within(panel).getByTestId('closing-record')).toHaveTextContent(
      'Confirmed by operations.',
    );
    expect(within(panel).getByTestId('closing-position-note')).toHaveTextContent(`${POSITION}.`);
    expect(within(panel).queryByTestId('closing-confirm')).toBeNull();
  });
});
