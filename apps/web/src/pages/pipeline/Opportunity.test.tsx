import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OpportunityDetail } from '@pb/contracts';
import { failing, mockApi, ok, problemFixture } from '../../test/api-mock.js';
import type { MockResponse, MockRoutes } from '../../test/api-mock.js';
import { ID } from '../../test/fixtures.js';
import {
  clientListFixture,
  closingOpportunityFixture,
  OPP_ID,
  opportunityDetailFixture,
  PIPE_ID,
  PIPE_PATHS,
  taxonomyFixture,
} from '../../test/fixtures-pipeline.js';
import {
  refusalFixture,
  rolePrincipal,
  sentPosts,
  sentRequests,
  vehicleListFixture,
} from '../../test/fixtures-valuations.js';
import { VS_ID } from '../../test/fixtures-vehicles-sponsors.js';
import { renderWithQuery } from '../../test/render.js';
import { OpportunityPage } from './Opportunity.js';

const params = vi.hoisted(() => ({ id: '' }));

vi.mock('../../app/env.js', () => ({ previewMode: true }));
vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: params.id }),
}));

const TIMEOUT = { timeout: 15_000 };
const SUFFIX = '(simulated in this preview, not audited)';

/**
 * The record the GET answers; a command replaces it, so the page shows the API's answer after the
 * write and the refetch every write triggers agrees with it.
 */
function stateful<T>(initial: T): { get: () => MockResponse; set: (next: T) => MockResponse } {
  let current = initial;
  return {
    get: () => ok(current),
    set: (next) => {
      current = next;
      return ok(next);
    },
  };
}

function open(
  roles: Parameters<typeof rolePrincipal>[0],
  detail: OpportunityDetail,
  extra: MockRoutes = {},
): void {
  params.id = detail.id;
  mockApi({
    [PIPE_PATHS.me]: ok(rolePrincipal(roles)),
    [PIPE_PATHS.opportunity(detail.id)]: ok(detail),
    [PIPE_PATHS.taxonomy]: ok(taxonomyFixture()),
    [PIPE_PATHS.vehicles]: ok(vehicleListFixture()),
    [PIPE_PATHS.clients]: ok(clientListFixture()),
    ...extra,
  });
  renderWithQuery(<OpportunityPage />);
}

const button = (name: string): HTMLElement => screen.getByRole('button', { name });

async function dialogClosed(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

describe('opportunity page', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the deal at Diligence: strip, gates, tasks, history and the closing it does not have yet', async () => {
    open(['deal_team'], opportunityDetailFixture());
    const page = await screen.findByTestId('opportunity-detail');
    const banner = within(page).getByTestId('opportunity-banner');
    expect(
      within(banner).getByRole('heading', {
        level: 1,
        name: 'Project Dune: Dune Logistics Holdings',
      }),
    ).toBeInTheDocument();
    expect(banner).toHaveTextContent('Kelpwood Capital Partners, Kelpwood Fund I');
    expect(banner).toHaveTextContent('Received Mar 10, 2025');
    expect(banner).toHaveTextContent('Deal lead Blake Mbeki');
    expect(within(banner).getByText('Diligence')).toHaveClass('pb-badge');

    const strip = within(page).getByRole('list', { name: 'Deal stages' });
    const steps = within(strip).getAllByRole('listitem');
    expect(steps).toHaveLength(8);
    expect(steps[3]).toHaveAttribute('aria-current', 'step');
    expect(steps[2]).toHaveTextContent('Done');
    expect(steps[4]).toHaveTextContent('Upcoming');

    const tiles = within(page).getByTestId('opportunity-tiles');
    expect(within(tiles).getByRole('group', { name: 'Target commitment' })).toHaveTextContent(
      '$15.0M',
    );
    expect(within(tiles).getByRole('group', { name: 'Days in stage' })).toHaveTextContent('40');
    expect(within(tiles).getByRole('group', { name: 'Required tasks open' })).toHaveTextContent(
      '1',
    );
    expect(within(tiles).getByRole('group', { name: 'Allocation tie-out' })).toHaveTextContent(
      'No closing record yet',
    );

    const gates = within(page).getByTestId('opportunity-gates');
    const lines = within(gates).getAllByRole('listitem');
    expect(lines.map((l) => l.textContent)).toEqual([
      'Waiting1 diligence task required for IC is still open; the advance to IC waits for them (an approver may override with a reason).',
      'WaitingNo IC decision is recorded; the advance from IC waits for one.',
      'WaitingNo closing record yet: it opens when the deal advances from Approved with a close date and a commitment.',
      'WaitingThe allocation tie-out starts once the closing record exists.',
    ]);

    // The open required task disables the advance and names the rule; pass stays live.
    const actions = within(page).getByTestId('opportunity-stage-actions');
    const advance = within(actions).getByRole('button', { name: 'Advance, Project Dune' });
    expect(advance).toBeDisabled();
    expect(advance).toHaveAttribute(
      'title',
      '1 diligence task required for IC still open; an approver may override with a reason',
    );
    expect(within(actions).getByRole('button', { name: 'Pass, Project Dune' })).toBeEnabled();
    expect(actions).toHaveTextContent('Advance moves the deal to IC.');

    const tasks = within(page).getByTestId('diligence-tasks');
    expect(tasks).toHaveTextContent('4 tasks, 1 required task open');
    const rows = within(within(tasks).getByRole('table', { name: 'Diligence tasks' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText('Done')).toHaveClass('pb-badge-good');
    expect(rows[1]).toHaveTextContent('Waived: Audited accounts received from the sponsor');
    expect(within(rows[2]!).getByText('Open')).toHaveClass('pb-badge-watch');
    expect(within(rows[3]!).getByText('Open')).toHaveClass('pb-badge-neutral');
    expect(rows[2]).toHaveTextContent('Required');
    expect(rows[3]).toHaveTextContent('Optional');
    expect(within(rows[0]!).getByRole('link', { name: 'Document' })).toHaveAttribute(
      'href',
      `/documents/${PIPE_ID.document}`,
    );
    expect(within(rows[0]!).getByRole('button', { name: /Reopen/ })).toBeEnabled();
    expect(within(rows[2]!).getByRole('button', { name: /Complete/ })).toBeEnabled();
    expect(within(rows[2]!).getByRole('button', { name: /Waive/ })).toBeEnabled();
    expect(within(tasks).getByTestId('diligence-task-form')).toBeInTheDocument();

    // The IC form is for approvers, and only while the deal is at IC.
    const ic = within(page).getByTestId('ic-decision-form');
    const record = within(ic).getByRole('button', { name: 'Record decision' });
    expect(record).toBeDisabled();
    expect(record).toHaveAttribute('title', 'Needs approver');
    expect(within(page).getByTestId('ic-decisions-empty')).toBeInTheDocument();

    const history = within(page).getByTestId('opportunity-history');
    const changes = within(within(history).getByRole('table', { name: 'Stage history' }))
      .getAllByRole('row')
      .slice(1);
    expect(changes).toHaveLength(4);
    expect(changes[0]).toHaveTextContent(
      'May 21, 2025 09:00:00 UTCPrescreenDiligenceAdvanceBlake Mbeki-',
    );
    expect(within(page).getByTestId('opportunity-closing-empty')).toBeInTheDocument();
    expect(within(page).getByTestId('allocations-editor')).toHaveTextContent('No allocation lines');
    expect(within(page).getByTestId('action-log')).toHaveTextContent('No actions yet');
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x2014));
  });

  it('lets an approver override the diligence gate with a reason and reports the new stage', async () => {
    const state = stateful(opportunityDetailFixture());
    open(['approver'], opportunityDetailFixture(), {
      [PIPE_PATHS.opportunity(OPP_ID.diligence)]: state.get,
      [PIPE_PATHS.commands(OPP_ID.diligence)]: () =>
        state.set(opportunityDetailFixture({ stage: 'IC', daysInStage: 0 })),
    });
    await screen.findByTestId('opportunity-detail');
    const advance = button('Advance, Project Dune');
    expect(advance).toBeEnabled();
    await userEvent.click(advance);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('your reason is recorded with the override');
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Legal summary due tomorrow');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Advance' }));
    await dialogClosed();
    expect(await screen.findByTestId('opportunity-action-status')).toHaveTextContent(
      `Project Dune is now IC ${SUFFIX}`,
    );
    expect(sentPosts()).toEqual([
      [
        PIPE_PATHS.commands(OPP_ID.diligence),
        { command: 'advance', reason: 'Legal summary due tomorrow' },
      ],
    ]);
    // The answer is the new detail: the strip moves without a second read.
    const strip = await screen.findByRole('list', { name: 'Deal stages' }, TIMEOUT);
    expect(strip.children[4]).toHaveAttribute('aria-current', 'step');
  }, 30_000);

  it('passes with a reason code from the taxonomy and a note', async () => {
    const state = stateful(opportunityDetailFixture());
    open(['deal_team'], opportunityDetailFixture(), {
      [PIPE_PATHS.opportunity(OPP_ID.diligence)]: state.get,
      [PIPE_PATHS.commands(OPP_ID.diligence)]: () =>
        state.set(
          opportunityDetailFixture({
            stage: 'Passed',
            passReasonCode: 'pass_reason.valuation',
            passNote: 'Price above our range',
          }),
        ),
    });
    await screen.findByTestId('opportunity-detail');
    await userEvent.click(button('Pass, Project Dune'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Pass' })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('combobox', { name: /Reason code/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Valuation' }, TIMEOUT));
    await userEvent.type(within(dialog).getByLabelText(/Note/), 'Price above our range');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pass' }));
    await dialogClosed();
    expect(await screen.findByTestId('opportunity-action-status')).toHaveTextContent(
      'Project Dune is now Passed',
    );
    expect(sentPosts()).toEqual([
      [
        PIPE_PATHS.commands(OPP_ID.diligence),
        { command: 'pass', passReasonCode: 'pass_reason.valuation', note: 'Price above our range' },
      ],
    ]);
    expect(screen.getByTestId('opportunity-workflow')).toHaveTextContent('Price above our range');
  }, 30_000);

  it('opens the closing with a close date and commitment when advancing from Approved', async () => {
    const approved = opportunityDetailFixture({
      id: OPP_ID.approved,
      stage: 'Approved',
      icDecisions: [
        {
          id: PIPE_ID.decision,
          decisionDate: '2025-06-20',
          decision: 'approved',
          amount: '20000000.00',
          conditions: [],
          recordedBy: { id: ID.user, name: 'Harper Lindqvist' },
        },
      ],
      gates: {
        diligence: { requiredOpen: 0, ok: true },
        icDecision: { ok: true },
        closing: { checklistComplete: false, allocationTiedOut: false, ok: false },
      },
    });
    const state = stateful(approved);
    open(['deal_team'], approved, {
      [PIPE_PATHS.opportunity(OPP_ID.approved)]: state.get,
      [PIPE_PATHS.commands(OPP_ID.approved)]: () => state.set(closingOpportunityFixture()),
    });
    await screen.findByTestId('opportunity-detail');
    await userEvent.click(button('Advance, Project Dune'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Open closing');
    // The commitment starts from the approved IC amount.
    expect(within(dialog).getByLabelText(/Commitment/)).toHaveValue('20000000.00');
    expect(within(dialog).getByRole('button', { name: 'Open closing' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Close date/), {
      target: { value: '2025-08-15' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open closing' }));
    await dialogClosed();
    expect(sentPosts()).toEqual([
      [
        PIPE_PATHS.commands(OPP_ID.approved),
        { command: 'advance', closeDate: '2025-08-15', commitmentAmount: '20000000.00' },
      ],
    ]);
    expect(await screen.findByTestId('opportunity-action-status')).toHaveTextContent(
      'Project Cove is now Closing',
    );
    const closing = screen.getByTestId('opportunity-closing');
    expect(closing).toHaveTextContent('Aug 15, 2025');
    expect(closing).toHaveTextContent('Tied out');
    expect(
      await within(closing).findByRole('link', { name: 'Open the closing page' }, TIMEOUT),
    ).toHaveAttribute('href', `/pipeline/${OPP_ID.closing}/closing`);
  }, 30_000);

  it('completes, waives and reopens diligence tasks and adds one', async () => {
    const after = (status: 'done' | 'open' | 'waived', waivedReason: string | null = null) =>
      opportunityDetailFixture({
        diligenceTasks: opportunityDetailFixture().diligenceTasks.map((t) =>
          t.id === PIPE_ID.taskLegal ? { ...t, status, waivedReason } : t,
        ),
      });
    const reopened = opportunityDetailFixture({
      diligenceTasks: opportunityDetailFixture().diligenceTasks.map((t) =>
        t.id === PIPE_ID.taskCommercial ? { ...t, status: 'open', evidenceDocumentId: null } : t,
      ),
    });
    open(['deal_team'], opportunityDetailFixture(), {
      [PIPE_PATHS.taskCommands(OPP_ID.diligence, PIPE_ID.taskLegal)]: ok(after('done')),
      [PIPE_PATHS.taskCommands(OPP_ID.diligence, PIPE_ID.taskCommercial)]: ok(reopened),
      [PIPE_PATHS.tasks(OPP_ID.diligence)]: ok(opportunityDetailFixture()),
    });
    await screen.findByTestId('opportunity-detail');
    await userEvent.click(button('Complete, Legal due diligence summary'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Evidence document id/), 'not-a-uuid');
    expect(within(dialog).getByRole('button', { name: 'Complete' })).toBeDisabled();
    await userEvent.clear(within(dialog).getByLabelText(/Evidence document id/));
    await userEvent.type(within(dialog).getByLabelText(/Evidence document id/), PIPE_ID.document);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Complete' }));
    await dialogClosed();
    expect(await screen.findByTestId('opportunity-action-status')).toHaveTextContent(
      'Legal due diligence summary is now Done',
    );

    await userEvent.click(
      await screen.findByRole('button', { name: 'Reopen, Market and competitive review' }, TIMEOUT),
    );
    await waitFor(() =>
      expect(screen.getByTestId('opportunity-action-status')).toHaveTextContent(
        'Market and competitive review is now Open',
      ),
    );

    const form = screen.getByTestId('diligence-task-form');
    expect(await screen.findByRole('button', { name: 'Add task' }, TIMEOUT)).toBeDisabled();
    await userEvent.click(within(form).getByRole('combobox', { name: /Workstream/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'References' }, TIMEOUT));
    await userEvent.type(within(form).getByLabelText(/Title/), 'Customer reference calls');
    await userEvent.click(within(form).getByLabelText('Required for IC'));
    await userEvent.click(within(form).getByRole('button', { name: 'Add task' }));
    await waitFor(() =>
      expect(screen.getByTestId('opportunity-action-status')).toHaveTextContent(
        'Task added: Customer reference calls',
      ),
    );
    expect(sentPosts()).toEqual([
      [
        PIPE_PATHS.taskCommands(OPP_ID.diligence, PIPE_ID.taskLegal),
        { command: 'complete', evidenceDocumentId: PIPE_ID.document },
      ],
      [PIPE_PATHS.taskCommands(OPP_ID.diligence, PIPE_ID.taskCommercial), { command: 'reopen' }],
      [
        PIPE_PATHS.tasks(OPP_ID.diligence),
        {
          workstream: 'diligence_workstream.references',
          title: 'Customer reference calls',
          requiredForIc: true,
        },
      ],
    ]);
  }, 30_000);

  it('waives a task with a reason and reports a refusal in words', async () => {
    open(['approver'], opportunityDetailFixture(), {
      [PIPE_PATHS.taskCommands(OPP_ID.diligence, PIPE_ID.taskLegal)]: {
        status: 422,
        body: refusalFixture(422, 'a waived task needs a reason'),
      },
    });
    await screen.findByTestId('opportunity-detail');
    await userEvent.click(button('Waive, Legal due diligence summary'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Covered by the sponsor memo');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Waive' }));
    await dialogClosed();
    expect(await screen.findByTestId('opportunity-action-status')).toHaveTextContent(
      'Waive Legal due diligence summary: Blocked by a rule. A waived task needs a reason',
    );
    expect(sentPosts()).toEqual([
      [
        PIPE_PATHS.taskCommands(OPP_ID.diligence, PIPE_ID.taskLegal),
        { command: 'waive', reason: 'Covered by the sponsor memo' },
      ],
    ]);
    // The deal team does not add tasks here: the form names the role.
    expect(await screen.findByRole('button', { name: 'Add task' }, TIMEOUT)).toHaveAttribute(
      'title',
      'Needs deal team',
    );
  }, 30_000);

  it('records an IC decision for an approver while the deal is at IC', async () => {
    const atIc = opportunityDetailFixture({
      id: OPP_ID.ic,
      stage: 'IC',
      gates: {
        diligence: { requiredOpen: 0, ok: true },
        icDecision: { ok: false },
        closing: { checklistComplete: false, allocationTiedOut: false, ok: false },
      },
    });
    const state = stateful(atIc);
    open(['approver'], atIc, {
      [PIPE_PATHS.opportunity(OPP_ID.ic)]: state.get,
      [PIPE_PATHS.decisions(OPP_ID.ic)]: () =>
        state.set(
          opportunityDetailFixture({
            ...atIc,
            icDecisions: [
              {
                id: PIPE_ID.decision,
                decisionDate: '2025-06-20',
                decision: 'approved',
                amount: '12000000.00',
                conditions: ['Key person clause confirmed'],
                recordedBy: { id: ID.user, name: 'Harper Lindqvist' },
              },
            ],
            gates: { ...atIc.gates, icDecision: { ok: true } },
          }),
        ),
    });
    await screen.findByTestId('opportunity-detail');
    // Without a decision the advance from IC is blocked and says so.
    const advance = button('Advance, Project Dune');
    expect(advance).toBeDisabled();
    expect(advance).toHaveAttribute('title', 'An IC decision record is required');
    const form = screen.getByTestId('ic-decision-form');
    fireEvent.change(within(form).getByLabelText(/Decision date/), {
      target: { value: '2025-06-20' },
    });
    await userEvent.click(within(form).getByRole('combobox', { name: /Decision$/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Approved' }, TIMEOUT));
    await userEvent.type(within(form).getByLabelText(/Amount/), '12000000.00');
    await userEvent.type(
      within(form).getByLabelText(/Conditions/),
      'Key person clause confirmed{enter}{enter}',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Record decision' }));
    expect(await screen.findByTestId('opportunity-action-status')).toHaveTextContent(
      'IC decision recorded: Approved on Jun 20, 2025',
    );
    expect(sentPosts()).toEqual([
      [
        PIPE_PATHS.decisions(OPP_ID.ic),
        {
          decisionDate: '2025-06-20',
          decision: 'approved',
          amount: '12000000.00',
          conditions: ['Key person clause confirmed'],
        },
      ],
    ]);
    const table = screen.getByRole('table', { name: 'IC decisions' });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent(
      'Jun 20, 2025Approved$12.0MKey person clause confirmedHarper Lindqvist',
    );
    expect(button('Advance, Project Dune')).toBeEnabled();
  }, 30_000);

  it('edits the allocations, shows the running total against the commitment and saves the whole list', async () => {
    const saved = closingOpportunityFixture({
      rowVersion: 8,
      allocations: closingOpportunityFixture().allocations.map((a) =>
        a.id === PIPE_ID.allocationB ? { ...a, requested: '7500000.00' } : a,
      ),
    });
    const state = stateful(closingOpportunityFixture());
    open(['deal_team'], closingOpportunityFixture(), {
      [PIPE_PATHS.opportunity(OPP_ID.closing)]: state.get,
      [PIPE_PATHS.allocations(OPP_ID.closing)]: () => state.set(saved),
    });
    await screen.findByTestId('opportunity-detail');
    const editor = screen.getByTestId('allocations-editor');
    expect(editor).toHaveTextContent('2 lines');
    expect(editor).toHaveTextContent('Allocated $20.0M against a commitment of $20.0M.');
    expect(within(editor).getByText('Tied out')).toHaveClass('pb-badge-good');
    const second = within(editor).getByTestId('allocation-row-1');
    // The vehicle and client names arrive with their own reads.
    await waitFor(() =>
      expect(within(second).getByRole('combobox', { name: 'Vehicle, line 2' })).toHaveTextContent(
        'Beach Credit Partners I',
      ),
    );
    expect(within(second).getByRole('combobox', { name: 'Client, line 2' })).toHaveTextContent(
      'Alpha Pension Trust',
    );
    const requested = within(second).getByRole('textbox', { name: 'Requested, line 2' });
    await userEvent.clear(requested);
    expect(within(editor).getByRole('button', { name: 'Save allocations' })).toHaveAttribute(
      'title',
      'Every line needs a vehicle and a requested amount (received is optional)',
    );
    expect(editor).toHaveTextContent('Allocated -');
    await userEvent.type(requested, '7500000.00');
    expect(editor).toHaveTextContent('Allocated $19.5M against a commitment of $20.0M.');
    await userEvent.click(within(editor).getByRole('button', { name: 'Add line' }));
    expect(within(editor).getByTestId('allocation-row-2')).toBeInTheDocument();
    await userEvent.click(within(editor).getByRole('button', { name: 'Remove line 3' }));
    expect(within(editor).queryByTestId('allocation-row-2')).toBeNull();
    await userEvent.click(within(editor).getByRole('button', { name: 'Save allocations' }));
    expect(await screen.findByTestId('opportunity-action-status')).toHaveTextContent(
      'Allocations saved for Project Cove: 2 lines, tied out',
    );
    expect(sentRequests().filter(([, method]) => method === 'PUT')).toEqual([
      [
        PIPE_PATHS.allocations(OPP_ID.closing),
        'PUT',
        {
          allocations: [
            { vehicleId: ID.vehicle1, requested: '12000000.00', received: '12000000.00' },
            { vehicleId: ID.vehicle2, clientId: VS_ID.clientAlpha, requested: '7500000.00' },
          ],
        },
      ],
    ]);
  }, 30_000);

  it('shows a viewer the closing deal read only with every action naming its role', async () => {
    open(['viewer'], closingOpportunityFixture());
    await screen.findByTestId('opportunity-detail');
    const advance = button('Advance, Project Cove');
    expect(advance).toBeDisabled();
    expect(advance).toHaveAttribute('title', 'Needs operations');
    expect(button('Pass, Project Cove')).toHaveAttribute('title', 'Needs deal team or approver');
    const editor = screen.getByTestId('allocations-editor');
    expect(within(editor).getByRole('table', { name: 'Allocations' })).toBeInTheDocument();
    expect(within(editor).queryByRole('button', { name: 'Save allocations' })).toBeNull();
    expect(editor).toHaveTextContent('Alpha Pension Trust');
    expect(button('Reopen, Market and competitive review')).toHaveAttribute(
      'title',
      'Needs deal team or approver',
    );
    const gates = screen.getByTestId('opportunity-gates');
    expect(gates).toHaveTextContent('A required closing item is still open (M8).');
    expect(gates).toHaveTextContent('Allocations tie to the closing commitment.');
    expect(screen.getByTestId('opportunity-tiles')).toHaveTextContent('Tied out');
  });

  it('shows the operations advance from Closing blocked by the checklist until the closing is confirmed', async () => {
    open(['operations'], closingOpportunityFixture());
    await screen.findByTestId('opportunity-detail');
    const advance = button('Advance, Project Cove');
    expect(advance).toBeDisabled();
    expect(advance).toHaveAttribute('title', 'The closing checklist is incomplete');
  });

  it('tells the reader when the opportunity is not visible, and when the read failed', async () => {
    params.id = OPP_ID.diligence;
    mockApi({
      [PIPE_PATHS.me]: ok(rolePrincipal(['viewer'])),
      [PIPE_PATHS.opportunity(OPP_ID.diligence)]: failing(404, '/api/v1/opportunities'),
    });
    renderWithQuery(<OpportunityPage />);
    expect(
      await screen.findByText('Opportunity not found or not visible to you'),
    ).toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();

    mockApi({
      [PIPE_PATHS.me]: ok(rolePrincipal(['viewer'])),
      [PIPE_PATHS.opportunity(OPP_ID.diligence)]: {
        status: 500,
        body: {
          ...problemFixture(404, '/api/v1/opportunities'),
          status: 500,
          title: 'Server error',
        },
      },
    });
    renderWithQuery(<OpportunityPage />);
    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(await screen.findByText('Opportunity unavailable', {}, TIMEOUT)).toBeInTheDocument();
  });
});
