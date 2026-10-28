import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import { DEAL_PATHS, dealDetailFixture } from '../../test/fixtures-deal.js';
import { closingOpportunityFixture, OPP_ID, PIPE_PATHS } from '../../test/fixtures-pipeline.js';
import { renderWithQuery } from '../../test/render.js';
import { DiligenceTab } from './DiligenceTab.js';

vi.mock('@tanstack/react-router', async () => {
  const { routerMock } = await import('../../test/router-mock.js');
  const { DEAL_ID: id } = await import('../../test/fixtures-deal.js');
  return { ...routerMock(), useParams: () => ({ id }) };
});

const EM_DASH = String.fromCharCode(0x2014);

describe('diligence tab', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('says a position with no opportunity predates the pipeline', async () => {
    mockApi({ [DEAL_PATHS.detail]: ok(dealDetailFixture()) });
    renderWithQuery(<DiligenceTab />);
    expect(await screen.findByTestId('deal-diligence-empty')).toHaveTextContent(
      'No diligence record: this position predates the pipeline',
    );
    expect(screen.queryByTestId('diligence-tasks')).toBeNull();
  });

  it('shows the tasks and decisions of the opportunity the position came from, read only', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture({ opportunityId: OPP_ID.closing })),
      [PIPE_PATHS.opportunity(OPP_ID.closing)]: ok(closingOpportunityFixture()),
    });
    renderWithQuery(<DiligenceTab />);
    const tasks = await screen.findByTestId('diligence-tasks');
    const rows = within(within(tasks).getByRole('table', { name: 'Diligence tasks' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent(
      'CommercialMarket and competitive reviewBlake MbekiMay 15, 2025DoneRequiredDocument',
    );
    expect(within(tasks).queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('diligence-task-form')).toBeNull();
    const decisions = screen.getByTestId('ic-decisions');
    expect(within(decisions).getByRole('table', { name: 'IC decisions' })).toBeInTheDocument();
    expect(decisions).toHaveTextContent('Jun 20, 2025Approved$20.0M');
    expect(screen.queryByTestId('ic-decision-form')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open the opportunity' })).toHaveAttribute(
      'href',
      `/pipeline/${OPP_ID.closing}`,
    );
    expect(document.body.textContent).not.toContain(EM_DASH);
  });

  it('says so when the opportunity sits behind a wall the reader is not on', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture({ opportunityId: OPP_ID.closing })),
      [PIPE_PATHS.opportunity(OPP_ID.closing)]: failing(404, '/api/v1/opportunities'),
    });
    renderWithQuery(<DiligenceTab />);
    expect(await screen.findByText('Diligence record not visible to you')).toBeInTheDocument();
  });
});
