import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { mockApi, ok } from '../../test/api-mock.js';
import { DEAL_IDS, DEAL_PATHS, dealDetailFixture } from '../../test/fixtures-deal.js';
import { closingDetailFixture, PIPE_PATHS, taxonomyFixture } from '../../test/fixtures-pipeline.js';
import { rolePrincipal } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { ClosingTab } from './ClosingTab.js';

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
});
