import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import {
  OPP_ID,
  opportunityPageFixture,
  opportunityRows,
  PIPE_PATHS,
} from '../../test/fixtures-pipeline.js';
import { rolePrincipal } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { navigate } from '../../test/router-mock.js';
import { PipelinePage } from './Pipeline.js';

// Actions are live in the preview today and in every build once W1's workflow.ts lands.
vi.mock('../../app/env.js', () => ({ previewMode: true }));
vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const EM_DASH = String.fromCharCode(0x2014);
const TIMEOUT = { timeout: 15_000 };

function routes(roles: Parameters<typeof rolePrincipal>[0], extra: MockRoutes = {}): MockRoutes {
  return {
    [PIPE_PATHS.me]: ok(rolePrincipal(roles)),
    [PIPE_PATHS.board]: ok(opportunityPageFixture()),
    ...extra,
  };
}

describe('pipeline board', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    navigate.mockClear();
  });

  it('shows one column per live stage in docs/18 order, a card per deal, and Closed and Passed as a table', async () => {
    mockApi(routes(['viewer']));
    renderWithQuery(<PipelinePage />);
    const board = await screen.findByTestId('pipeline-board');
    const columns = within(board)
      .getAllByRole('listitem')
      .filter((li) => li.className.includes('pb-pipe-column'));
    expect(columns.map((c) => c.querySelector('h3 span')?.textContent)).toEqual([
      'Sourced',
      'Screening',
      'Prescreen',
      'Diligence',
      'IC',
      'Approved',
      'Closing',
    ]);
    // Each column's heading carries its count; the columns arrive left to right.
    expect(columns.map((c) => c.querySelector('h3')?.textContent)).toEqual([
      'Sourced1',
      'Screening1',
      'Prescreen1',
      'Diligence1',
      'IC1',
      'Approved1',
      'Closing1',
    ]);
    expect(columns.map((c) => c.style.getPropertyValue('--i'))).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
    expect(within(board).queryByTestId('pipeline-column-Closed')).toBeNull();
    expect(within(board).queryByTestId('pipeline-column-Passed')).toBeNull();

    const diligence = within(board).getByTestId('pipeline-column-Diligence');
    const card = within(diligence).getByTestId(`opportunity-card-${OPP_ID.diligence}`);
    expect(within(card).getByRole('link', { name: 'Project Dune' })).toHaveAttribute(
      'href',
      `/pipeline/${OPP_ID.diligence}`,
    );
    // One fact a line, in the same order on every card: company, sponsor and fund, deal type,
    // deal lead, then the target and the days in stage.
    expect(
      [...card.querySelectorAll('.pb-pipe-card-line')].map((line) => line.textContent),
    ).toEqual([
      'Dune Logistics Holdings',
      'Kelpwood Capital Partners, Kelpwood Fund I',
      'Co invest equity',
      'Blake Mbeki',
    ]);
    expect(card).toHaveTextContent('Target $15.0M');
    expect(card).toHaveTextContent('Blake Mbeki');
    // 40 days at Diligence sits within the 90-day guide: plain text, no dot.
    expect(card).toHaveTextContent('40 days in stage');
    expect(card).toHaveAttribute('data-tone', 'neutral');
    expect(card.querySelector('.pb-badge')).toBeNull();
    // Lines wrap rather than being cut short, so no line hides its words in a title.
    expect(card.querySelector('[title]')).toBeNull();
    // 45 days at Sourced is past the 30-day guide: a watch dot and the days, naming the guide.
    const sourced = within(board).getByTestId(`opportunity-card-${OPP_ID.sourced}`);
    expect(sourced).toHaveAttribute('data-tone', 'watch');
    const aging = within(sourced).getByText('45 days');
    expect(aging.closest('.pb-badge')).toHaveClass('pb-badge-watch');
    expect(aging.closest('[title]')).toHaveAttribute('title', 'Over the 30-day guide for Sourced');
    expect(sourced).toHaveTextContent('45 days in stage');
    // A missing target commitment and a missing deal lead read as such, never as zero.
    expect(sourced).toHaveTextContent('No deal lead');
    expect(sourced).toHaveTextContent('-Target not recorded');

    // Closed and Passed: one open table with the card's fields, after the board.
    const settled = screen.getByRole('table', { name: 'Closed and passed' });
    expect(
      within(settled)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Deal',
      'Company',
      'Sponsor and fund',
      'Deal type',
      'Target',
      'Deal lead',
      'Days in stage',
      'Stage',
    ]);
    const passed = within(settled).getByTestId(`opportunity-row-${OPP_ID.passed}`);
    expect(passed).toHaveTextContent('Project Dusk');
    expect(passed).toHaveTextContent('Passed');
    expect(within(passed).getByRole('link', { name: 'Project Dusk' })).toHaveAttribute(
      'href',
      `/pipeline/${OPP_ID.passed}`,
    );

    const tiles = screen.getByTestId('pipeline-tiles');
    expect(within(tiles).getByRole('group', { name: 'In pipeline' })).toHaveTextContent('7');
    expect(within(tiles).getByRole('group', { name: 'Aging' })).toHaveTextContent('1');
    expect(within(tiles).getByRole('group', { name: 'At closing' })).toHaveTextContent('1');
    expect(within(tiles).getByRole('group', { name: 'Passed' })).toHaveTextContent('1');
    // How a deal moves between stages, folded under its summary.
    const spec = screen.getByTestId('workflow-deal_stage');
    expect(spec.querySelector('details:not([open]) > summary')).toHaveTextContent(
      'How a deal moves between stages',
    );
    expect(document.body.textContent).not.toContain(EM_DASH);
  });

  it('lets the deal team start a new opportunity and names the role others need', async () => {
    mockApi(routes(['deal_team']));
    renderWithQuery(<PipelinePage />);
    const button = await screen.findByRole('button', { name: 'New opportunity' });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(navigate).toHaveBeenCalledWith({ to: '/pipeline/new' });
    cleanup();
    vi.restoreAllMocks();

    mockApi(routes(['viewer']));
    renderWithQuery(<PipelinePage />);
    const blocked = await screen.findByRole('button', { name: 'New opportunity' });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute('title', 'Needs deal team');
  });

  it('filters the board by deal type and deal lead over the loaded page', async () => {
    mockApi(routes(['viewer']));
    renderWithQuery(<PipelinePage />);
    await screen.findByTestId('pipeline-board');
    expect(screen.getByText('9 of 9 deals')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: 'Deal type' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Private credit' }, TIMEOUT));
    expect(await screen.findByText('1 of 9 deals')).toBeInTheDocument();
    expect(screen.getByTestId(`opportunity-card-${OPP_ID.screening}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`opportunity-card-${OPP_ID.diligence}`)).toBeNull();
    expect(screen.getByTestId('pipeline-column-Diligence')).toHaveTextContent('Diligence0None');
    await userEvent.click(screen.getByRole('combobox', { name: 'Deal lead' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Blake Mbeki' }, TIMEOUT));
    // The Screening deal is led by Blake Mbeki too, so it stays; the lead-less Sourced deal never shows.
    expect(await screen.findByText('1 of 9 deals')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: 'Deal type' }));
    await userEvent.click(await screen.findByRole('option', { name: 'All deal types' }, TIMEOUT));
    expect(await screen.findByText('8 of 9 deals')).toBeInTheDocument();
    expect(screen.queryByTestId(`opportunity-card-${OPP_ID.sourced}`)).toBeNull();
  });

  it('says so when nothing matches, when the board is empty, and when more deals exist', async () => {
    mockApi(routes(['viewer'], { [PIPE_PATHS.board]: ok(opportunityPageFixture([])) }));
    renderWithQuery(<PipelinePage />);
    expect(await screen.findByText('No opportunities yet')).toBeInTheDocument();
    expect(screen.queryByTestId('pipeline-board')).toBeNull();
    cleanup();
    vi.restoreAllMocks();

    mockApi(
      routes(['viewer'], {
        [PIPE_PATHS.board]: ok(opportunityPageFixture(opportunityRows(), 'next')),
      }),
    );
    renderWithQuery(<PipelinePage />);
    expect(await screen.findByTestId('pipeline-truncated')).toHaveTextContent(
      'Showing the first 9 deals; more exist',
    );
    // Counts of a partial page would be of the page, not the pipeline: the placeholder instead.
    expect(
      within(screen.getByTestId('pipeline-tiles')).getByRole('group', { name: 'In pipeline' }),
    ).toHaveTextContent('Not calculable: more rows than one page holds');
  });

  it('shows the loading skeleton, then who may see the board when the read is refused', async () => {
    mockApi(routes(['viewer'], { [PIPE_PATHS.board]: failing(403, '/api/v1/opportunities') }));
    renderWithQuery(<PipelinePage />);
    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(
      await screen.findByText('The pipeline board: not visible to your role'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Pipeline' })).toBeInTheDocument();
  });
});
