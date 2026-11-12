import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import {
  OPP_ID,
  opportunityDetailFixture,
  PIPE_PATHS,
  taxonomyFixture,
} from '../../test/fixtures-pipeline.js';
import { refusalFixture, rolePrincipal, sentPosts } from '../../test/fixtures-valuations.js';
import {
  sponsorDetailFixture,
  sponsorPageFixture,
  VS_ID,
} from '../../test/fixtures-vehicles-sponsors.js';
import { renderWithQuery } from '../../test/render.js';
import { navigate } from '../../test/router-mock.js';
import { NewOpportunityPage } from './NewOpportunity.js';

vi.mock('../../app/env.js', () => ({ previewMode: true }));
vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const TIMEOUT = { timeout: 15_000 };
const SPONSOR = `/api/v1/sponsors/${VS_ID.sponsorKelpwood}`;

function routes(roles: Parameters<typeof rolePrincipal>[0], extra: MockRoutes = {}): MockRoutes {
  return {
    [PIPE_PATHS.me]: ok(rolePrincipal(roles)),
    [PIPE_PATHS.taxonomy]: ok(taxonomyFixture()),
    [PIPE_PATHS.sponsors]: ok(sponsorPageFixture()),
    [SPONSOR]: ok(sponsorDetailFixture()),
    [PIPE_PATHS.create]: ok(opportunityDetailFixture({ id: OPP_ID.sourced, stage: 'Sourced' })),
    ...extra,
  };
}

async function pick(name: string | RegExp, option: string): Promise<void> {
  await userEvent.click(screen.getByRole('combobox', { name }));
  await userEvent.click(await screen.findByRole('option', { name: option }, TIMEOUT));
}

describe('new opportunity form', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    navigate.mockClear();
  });

  it('logs an opportunity for the deal team and opens its page', async () => {
    mockApi(routes(['deal_team']));
    renderWithQuery(<NewOpportunityPage />);
    const form = await screen.findByTestId('new-opportunity-form');
    expect(screen.getByRole('heading', { level: 1, name: 'New opportunity' })).toBeInTheDocument();
    await userEvent.type(within(form).getByLabelText(/Deal name/), 'Project Dune');
    await userEvent.type(within(form).getByLabelText(/Company name/), 'Dune Logistics Holdings');
    await pick(/Sponsor$/, 'Kelpwood Capital Partners');
    // The fund picker fills from the chosen sponsor's funds.
    await pick(/Sponsor fund/, 'Kelpwood Fund I');
    await pick(/Deal type/, 'Co-investment (equity)');
    await pick(/Sector/, 'Industrials');
    fireEvent.change(within(form).getByLabelText(/Received date/), {
      target: { value: '2025-03-10' },
    });
    await userEvent.type(within(form).getByLabelText(/Target commitment/), '15000000.00');
    expect(form).toHaveTextContent('Reads as $15.0M.');
    await userEvent.type(within(form).getByLabelText(/Source/), 'Sponsor introduction');
    await userEvent.click(within(form).getByRole('button', { name: 'Log opportunity' }));
    expect(await screen.findByText(/Project Dune logged at Sourced/)).toBeInTheDocument();
    expect(sentPosts()).toEqual([
      [
        PIPE_PATHS.create,
        {
          name: 'Project Dune',
          companyName: 'Dune Logistics Holdings',
          sponsorId: VS_ID.sponsorKelpwood,
          sponsorFundId: VS_ID.fundOne,
          dealType: 'deal_type.co_invest_equity',
          sector: 'sector.industrials',
          receivedDate: '2025-03-10',
          targetCommitment: '15000000.00',
          source: 'Sponsor introduction',
        },
      ],
    ]);
    expect(navigate).toHaveBeenCalledWith({ to: '/pipeline/$id', params: { id: OPP_ID.sourced } });
  }, 30_000);

  it('refuses to send an incomplete or malformed form and says what is missing', async () => {
    mockApi(routes(['deal_team']));
    renderWithQuery(<NewOpportunityPage />);
    const form = await screen.findByTestId('new-opportunity-form');
    await userEvent.type(within(form).getByLabelText(/Target commitment/), '1,5');
    await userEvent.click(within(form).getByRole('button', { name: 'Log opportunity' }));
    expect(await screen.findByText('Give the deal a name.')).toBeInTheDocument();
    expect(form).toHaveTextContent('Name the company.');
    expect(form).toHaveTextContent('Choose the sponsor.');
    expect(form).toHaveTextContent('Give the date the deal reached us.');
    expect(form).toHaveTextContent('Use digits with an optional decimal point, above zero');
    expect(sentPosts()).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows the form read only to other roles and names the role it needs', async () => {
    mockApi(routes(['operations']));
    renderWithQuery(<NewOpportunityPage />);
    const button = await screen.findByRole('button', { name: 'Log opportunity' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Needs deal team');
    expect(screen.getByTestId('new-opportunity-blocked')).toHaveTextContent('Needs deal team.');
  });

  it('reports a refusal from the API in the status region and stays on the page', async () => {
    mockApi(
      routes(['deal_team'], {
        [PIPE_PATHS.create]: {
          status: 403,
          body: refusalFixture(403, 'opportunity: create requires one of: deal_team'),
        },
      }),
    );
    renderWithQuery(<NewOpportunityPage />);
    const form = await screen.findByTestId('new-opportunity-form');
    await userEvent.type(within(form).getByLabelText(/Deal name/), 'Project Dune');
    await userEvent.type(within(form).getByLabelText(/Company name/), 'Dune Logistics');
    await pick(/Sponsor$/, 'Kelpwood Capital Partners');
    await pick(/Deal type/, 'Private credit');
    fireEvent.change(within(form).getByLabelText(/Received date/), {
      target: { value: '2025-03-10' },
    });
    await userEvent.click(within(form).getByRole('button', { name: 'Log opportunity' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'New opportunity: Your role cannot do this. Create requires one of: deal_team',
    );
    expect(navigate).not.toHaveBeenCalled();
  }, 30_000);
});
