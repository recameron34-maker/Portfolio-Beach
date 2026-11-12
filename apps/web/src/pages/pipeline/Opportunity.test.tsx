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
  closingSummaryFixture,
  confirmedOpportunityFixture,
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
      'WaitingNo approved IC decision is recorded since the deal last entered IC; the advance from IC waits for one.',
      'WaitingNo closing record yet: it opens when the deal advances from Approved with a close date and a commitment.',
      'WaitingThe allocation tie-out starts once the closing record exists.',
      'WaitingOperations confirm the closing once the closing record exists.',
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
    await waitFor(() => expect(strip.children[4]).toHaveAttribute('aria-current', 'step'));
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
    // The message is the page's own; the record it reports lands a moment later.
    await waitFor(() =>
      expect(screen.getByTestId('opportunity-workflow')).toHaveTextContent('Price above our range'),
    );
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
        diligence: { requiredOpen: 0, ok: true, carriedOver: 0 },
        icDecision: { ok: true },
        closing: {
          checklistComplete: false,
          allocationTiedOut: false,
          confirmed: false,
          ok: false,
        },
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
    // A first closing: nothing to say about a record the deal already has.
    expect(within(dialog).queryByTestId('closing-reentry-note')).toBeNull();
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
    const closing = await screen.findByTestId('opportunity-closing');
    await waitFor(() => expect(closing).toHaveTextContent('Aug 15, 2025'));
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
        diligence: { requiredOpen: 0, ok: true, carriedOver: 0 },
        icDecision: { ok: false },
        closing: {
          checklistComplete: false,
          allocationTiedOut: false,
          confirmed: false,
          ok: false,
        },
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
    const table = await screen.findByRole('table', { name: 'IC decisions' });
    await waitFor(() =>
      expect(within(table).getAllByRole('row')[1]).toHaveTextContent(
        'Jun 20, 2025Approved$12.0MKey person clause confirmedHarper Lindqvist',
      ),
    );
    expect(button('Advance, Project Dune')).toBeEnabled();
  }, 30_000);

  it('edits the allocations, shows the received total against the commitment and saves the whole list', async () => {
    const saved = closingOpportunityFixture({
      rowVersion: 8,
      allocations: closingOpportunityFixture().allocations.map((a) =>
        a.id === PIPE_ID.allocationB
          ? { ...a, requested: '7500000.00', received: '7500000.00' }
          : a,
      ),
      closing: closingSummaryFixture({
        allocationTieOut: {
          commitment: '20000000.00',
          allocated: '19500000.00',
          difference: '-500000.00',
          tiedOut: false,
          hiddenLines: 0,
        },
      }),
    });
    const state = stateful(closingOpportunityFixture());
    open(['deal_team'], closingOpportunityFixture(), {
      [PIPE_PATHS.opportunity(OPP_ID.closing)]: state.get,
      [PIPE_PATHS.allocations(OPP_ID.closing)]: () => state.set(saved),
    });
    await screen.findByTestId('opportunity-detail');
    const editor = screen.getByTestId('allocations-editor');
    expect(editor).toHaveTextContent('2 lines');
    // The card leads with the commitment and the received total against it, tied or not.
    const lead = within(editor).getByTestId('allocations-lead');
    expect(within(lead).getByRole('group', { name: 'Commitment' })).toHaveTextContent('$20.0M');
    expect(within(lead).getByRole('group', { name: 'Received' })).toHaveTextContent(
      '$20.0MTied out',
    );
    // The foot keeps the running total of the lines as typed.
    expect(editor).toHaveTextContent('Received $20.0M against a commitment of $20.0M.');
    expect(within(editor).getByText('Tied out', { selector: '.pb-badge' })).toHaveClass(
      'pb-badge-good',
    );
    expect(within(editor).queryByTestId('allocations-missing-received')).toBeNull();
    // A writer is shown every line: nothing is said about lines not shown.
    expect(within(editor).queryByTestId('allocations-hidden-lines')).toBeNull();
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
      'Every line needs a vehicle and a requested amount',
    );
    expect(editor).toHaveTextContent('Received -');
    await userEvent.type(requested, '7500000.00');
    // What was asked for does not move the tie-out: only what was received counts (M22).
    expect(editor).toHaveTextContent('Received $20.0M against a commitment of $20.0M.');
    const received = within(second).getByRole('textbox', { name: 'Received, line 2' });
    await userEvent.clear(received);
    expect(editor).toHaveTextContent('Received $12.0M against a commitment of $20.0M.');
    expect(within(editor).getByTestId('allocations-missing-received')).toHaveTextContent(
      '1 line has no received amount yet. The tie-out counts received amounts only: a requested amount never stands in for one (M22).',
    );
    await userEvent.type(received, '7500000.00');
    expect(editor).toHaveTextContent('Received $19.5M against a commitment of $20.0M.');
    expect(within(editor).queryByTestId('allocations-missing-received')).toBeNull();
    await userEvent.click(within(editor).getByRole('button', { name: 'Add line' }));
    expect(within(editor).getByTestId('allocation-row-2')).toBeInTheDocument();
    await userEvent.click(within(editor).getByRole('button', { name: 'Remove line 3' }));
    expect(within(editor).queryByTestId('allocation-row-2')).toBeNull();
    await userEvent.click(within(editor).getByRole('button', { name: 'Save allocations' }));
    expect(await screen.findByTestId('opportunity-action-status')).toHaveTextContent(
      'Allocations saved for Project Cove: 2 lines, short by $0.5M',
    );
    expect(sentRequests().filter(([, method]) => method === 'PUT')).toEqual([
      [
        PIPE_PATHS.allocations(OPP_ID.closing),
        'PUT',
        {
          allocations: [
            { vehicleId: ID.vehicle1, requested: '12000000.00', received: '12000000.00' },
            {
              vehicleId: ID.vehicle2,
              clientId: VS_ID.clientAlpha,
              requested: '7500000.00',
              received: '7500000.00',
            },
          ],
        },
      ],
    ]);
  }, 30_000);

  it('shows a viewer the closing deal read only with every action naming its role', async () => {
    // As the API answers a viewer: the vehicle line, not the client line, and the deal's totals.
    const all = closingOpportunityFixture();
    open(
      ['viewer'],
      closingOpportunityFixture({
        allocations: all.allocations.filter((a) => a.client === null),
        allocationTotals: { ...all.allocationTotals, hiddenLines: 1 },
        closing: closingSummaryFixture({
          allocationTieOut: { ...all.closing!.allocationTieOut, hiddenLines: 1 },
        }),
      }),
    );
    await screen.findByTestId('opportunity-detail');
    const advance = button('Advance, Project Cove');
    expect(advance).toBeDisabled();
    expect(advance).toHaveAttribute('title', 'Needs operations');
    expect(button('Pass, Project Cove')).toHaveAttribute('title', 'Needs deal team or approver');
    const editor = screen.getByTestId('allocations-editor');
    expect(within(editor).getByRole('table', { name: 'Allocations' })).toBeInTheDocument();
    expect(within(editor).queryByRole('button', { name: 'Save allocations' })).toBeNull();
    // The commitment and the received total lead, and they are the deal's: the line the viewer
    // is shown holds 12.0 of the 20.0 received.
    const lead = within(editor).getByTestId('allocations-lead');
    expect(within(lead).getByRole('group', { name: 'Commitment' })).toHaveTextContent('$20.0M');
    expect(within(lead).getByRole('group', { name: 'Received' })).toHaveTextContent(
      '$20.0MTied out',
    );
    expect(editor).toHaveTextContent('2 lines');
    expect(editor).not.toHaveTextContent('Alpha Pension Trust');
    expect(within(editor).queryByRole('button', { name: /Client breakdown/ })).toBeNull();
    // No vehicle total is stated while a line is not shown; the line shown keeps its own amounts.
    const table = within(editor).getByRole('table', { name: 'Allocations' });
    const vehicle = within(table).getByRole('row', { name: /Beach Co-Invest Fund I/ });
    expect(vehicle).toHaveTextContent('Beach Co-Invest Fund I--');
    expect(within(vehicle).getAllByTitle(/some lines of this deal are not shown/)).toHaveLength(2);
    expect(within(table).getByRole('row', { name: /Vehicle line/ })).toHaveTextContent(
      'Vehicle line$12.0M$12.0M',
    );
    // A quiet line says how many lines are not shown; it is not an alert.
    const note = within(editor).getByTestId('allocations-hidden-lines');
    expect(note).toHaveTextContent(
      '1 client line is not shown. Client-level lines are for operations, the investment team (the deal team and approvers) and auditors, and for readers entitled to the client.',
    );
    expect(note).toHaveClass('pb-meta');
    expect(within(editor).queryByRole('alert')).toBeNull();
    expect(button('Reopen, Market and competitive review')).toHaveAttribute(
      'title',
      'Needs deal team or approver',
    );
    const gates = screen.getByTestId('opportunity-gates');
    expect(gates).toHaveTextContent('A required closing item is still open (M8).');
    expect(gates).toHaveTextContent('The received amounts tie to the closing commitment.');
    expect(gates).toHaveTextContent(
      'Operations have not confirmed the closing; the advance to Closed waits for the confirmation (M8).',
    );
    expect(screen.getByTestId('opportunity-tiles')).toHaveTextContent('Tied out');
  });

  it('leads with the commitment, lists the lines by vehicle and keeps the client breakdown closed until asked, by mouse or keyboard', async () => {
    open(['auditor'], closingOpportunityFixture());
    await screen.findByTestId('opportunity-detail');
    const editor = screen.getByTestId('allocations-editor');
    const table = within(editor).getByRole('table', { name: 'Allocations' });
    // The vehicle rows are the primary rows, each with the vehicle's totals.
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((h) => h.textContent),
    ).toEqual(['Beach Co-Invest Fund I', 'Beach Credit Partners I']);
    expect(within(table).getByRole('row', { name: /Beach Credit Partners I/ })).toHaveTextContent(
      'Beach Credit Partners I$8.0M$8.0M',
    );
    // The client line sits behind a disclosure that starts closed.
    const toggle = within(table).getByRole('button', {
      name: 'Client breakdown (1 line), Beach Credit Partners I',
    });
    expect(toggle).toHaveTextContent('Client breakdown (1 line)');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(table).queryByRole('row', { name: /Alpha Pension Trust/ })).toBeNull();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const client = within(table).getByRole('row', { name: /Alpha Pension Trust/ });
    expect(client).toHaveTextContent('Alpha Pension Trust$8.0M$8.0M');
    expect(client).toHaveClass('pb-pipe-client-row');
    expect(toggle.getAttribute('aria-controls')).toBe(client.id);
    // The keyboard opens and closes it too.
    toggle.focus();
    await userEvent.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(table).queryByRole('row', { name: /Alpha Pension Trust/ })).toBeNull();
    await userEvent.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Every line is shown to an auditor: nothing is said about lines not shown.
    expect(within(editor).queryByTestId('allocations-hidden-lines')).toBeNull();
  });

  it('gives a reader who is shown no line the totals of the deal and the count of lines not shown, not an empty state', async () => {
    const all = closingOpportunityFixture();
    open(
      ['viewer'],
      closingOpportunityFixture({
        allocations: [],
        allocationTotals: {
          lines: 3,
          hiddenLines: 3,
          requested: '20000000.00',
          received: '12000000.00',
          missingReceived: 1,
        },
        closing: closingSummaryFixture({
          allocationTieOut: {
            commitment: '20000000.00',
            allocated: '12000000.00',
            difference: '-8000000.00',
            tiedOut: false,
            hiddenLines: 3,
          },
        }),
        gates: {
          ...all.gates,
          closing: { ...all.gates.closing, allocationTiedOut: false },
        },
      }),
    );
    await screen.findByTestId('opportunity-detail');
    const editor = screen.getByTestId('allocations-editor');
    expect(editor).toHaveTextContent('3 lines');
    const lead = within(editor).getByTestId('allocations-lead');
    expect(within(lead).getByRole('group', { name: 'Commitment' })).toHaveTextContent('$20.0M');
    expect(within(lead).getByRole('group', { name: 'Received' })).toHaveTextContent(
      '$12.0MShort by $8.0M',
    );
    expect(within(editor).queryByRole('table', { name: 'Allocations' })).toBeNull();
    expect(within(editor).queryByTestId('allocations-empty')).toBeNull();
    expect(within(editor).getByTestId('allocations-hidden-lines')).toHaveTextContent(
      '3 client lines are not shown. Client-level lines are for operations, the investment team (the deal team and approvers) and auditors, and for readers entitled to the client.',
    );
    // The tile and the gate read the deal's tie-out, as every reader's do.
    expect(screen.getByTestId('opportunity-tiles')).toHaveTextContent('Short by $8.0M');
    expect(screen.getByTestId('opportunity-gates')).toHaveTextContent(
      'The received amounts do not tie to the closing commitment (M22).',
    );
  });

  it('leads with the requested total and the target before a closing record exists, and still counts the lines not shown', async () => {
    const vehicleLine = closingOpportunityFixture().allocations.filter((a) => a.client === null);
    open(
      ['viewer'],
      opportunityDetailFixture({
        id: OPP_ID.approved,
        stage: 'Approved',
        targetCommitment: '20000000.00',
        allocations: vehicleLine.map((a) => ({ ...a, received: null })),
        allocationTotals: {
          lines: 2,
          hiddenLines: 1,
          requested: '20000000.00',
          received: '0.00',
          missingReceived: 2,
        },
      }),
    );
    await screen.findByTestId('opportunity-detail');
    const editor = screen.getByTestId('allocations-editor');
    const lead = within(editor).getByTestId('allocations-lead');
    // The requested total is the deal's, across the line shown and the one that is not.
    expect(within(lead).getByRole('group', { name: 'Requested' })).toHaveTextContent(
      '$20.0MAcross all allocation lines',
    );
    expect(within(lead).getByRole('group', { name: 'Target' })).toHaveTextContent(
      '$20.0MTarget commitment; the tie-out starts once the closing record exists (M22)',
    );
    expect(within(lead).queryByRole('group', { name: 'Commitment' })).toBeNull();
    expect(within(editor).getByTestId('allocations-hidden-lines')).toHaveTextContent(
      '1 client line is not shown. Client-level lines are for operations, the investment team (the deal team and approvers) and auditors, and for readers entitled to the client.',
    );
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x2014));
  });

  it('offers the advance from Closing to operations only once the closing is confirmed, and names the missing confirmation until then', async () => {
    open(['operations'], closingOpportunityFixture());
    await screen.findByTestId('opportunity-detail');
    const advance = button('Advance, Project Cove');
    expect(advance).toBeDisabled();
    expect(advance).toHaveAttribute(
      'title',
      'The closing checklist is incomplete; the closing is not confirmed by operations (M8)',
    );
    cleanup();
    vi.restoreAllMocks();

    // The checklist is in and the lines tie: the confirmation alone still holds the advance.
    open(
      ['operations'],
      closingOpportunityFixture({
        closing: closingSummaryFixture({ itemsOpen: 2, itemsRequiredOpen: 0 }),
        gates: {
          diligence: { requiredOpen: 0, ok: true, carriedOver: 0 },
          icDecision: { ok: true },
          closing: {
            checklistComplete: true,
            allocationTiedOut: true,
            confirmed: false,
            ok: false,
          },
        },
      }),
    );
    await screen.findByTestId('opportunity-detail');
    expect(button('Advance, Project Cove')).toBeDisabled();
    expect(button('Advance, Project Cove')).toHaveAttribute(
      'title',
      'The closing is not confirmed by operations (M8)',
    );
    const waiting = within(screen.getByTestId('opportunity-gates')).getAllByRole('listitem');
    expect(waiting.map((l) => l.textContent)).toEqual([
      'ClearEvery diligence task required for IC is done or waived.',
      'ClearAn IC decision is recorded.',
      'ClearEvery required closing item is received or waived.',
      'ClearThe received amounts tie to the closing commitment.',
      'WaitingOperations have not confirmed the closing; the advance to Closed waits for the confirmation (M8).',
    ]);
    cleanup();
    vi.restoreAllMocks();

    // Confirmed: every gate reads clear and the advance is offered.
    const state = stateful(confirmedOpportunityFixture());
    open(['operations'], confirmedOpportunityFixture(), {
      [PIPE_PATHS.opportunity(OPP_ID.closing)]: state.get,
      [PIPE_PATHS.commands(OPP_ID.closing)]: () =>
        state.set(
          confirmedOpportunityFixture({ stage: 'Closed', investmentId: PIPE_ID.investment }),
        ),
    });
    await screen.findByTestId('opportunity-detail');
    const clear = within(screen.getByTestId('opportunity-gates')).getAllByRole('listitem');
    expect(clear.map((l) => l.textContent?.startsWith('Clear'))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(clear[4]).toHaveTextContent('Operations confirmed the closing.');
    const live = button('Advance, Project Cove');
    expect(live).toBeEnabled();
    expect(live).not.toHaveAttribute('title');
    await userEvent.click(live);
    expect(await screen.findByTestId('opportunity-action-status')).toHaveTextContent(
      'Project Cove is now Closed and converted into a position',
    );
    expect(sentPosts()).toEqual([[PIPE_PATHS.commands(OPP_ID.closing), { command: 'advance' }]]);
  }, 30_000);

  it('holds the allocation lines as confirmed once operations confirmed the closing, and for good once the deal is closed', async () => {
    open(['deal_team'], confirmedOpportunityFixture());
    await screen.findByTestId('opportunity-detail');
    const editor = screen.getByTestId('allocations-editor');
    expect(within(editor).getByRole('table', { name: 'Allocations' })).toBeInTheDocument();
    expect(within(editor).queryByRole('button', { name: 'Save allocations' })).toBeNull();
    expect(within(editor).queryByRole('button', { name: 'Add line' })).toBeNull();
    expect(within(editor).queryByRole('textbox')).toBeNull();
    expect(within(editor).getByTestId('allocations-lock')).toHaveTextContent(
      'The closing is confirmed; change the close date or ask operations to reopen it.',
    );
    const lead = within(editor).getByTestId('allocations-lead');
    expect(within(lead).getByRole('group', { name: 'Commitment' })).toHaveTextContent('$20.0M');
    expect(within(lead).getByRole('group', { name: 'Received' })).toHaveTextContent(
      '$20.0MTied out',
    );
    expect(within(editor).queryByTestId('allocations-hidden-lines')).toBeNull();
    cleanup();
    vi.restoreAllMocks();

    open(
      ['operations'],
      confirmedOpportunityFixture({ stage: 'Closed', investmentId: PIPE_ID.investment }),
    );
    await screen.findByTestId('opportunity-detail');
    const closed = screen.getByTestId('allocations-editor');
    expect(within(closed).queryByRole('button', { name: 'Save allocations' })).toBeNull();
    expect(within(closed).getByTestId('allocations-lock')).toHaveTextContent(
      'Allocations are fixed once the deal is closed (M22); raise a change request instead.',
    );
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x2014));
  });

  it('says how many tasks were done before a reopen, and that the closing a reopened deal already has is rewritten', async () => {
    const reopened = opportunityDetailFixture({
      id: OPP_ID.approved,
      stage: 'Approved',
      closing: closingSummaryFixture({
        state: 'OpsConfirmed',
        opsConfirmedBy: { id: ID.user, name: 'Rowan Castellanos' },
        opsConfirmedAt: '2025-08-16T10:00:00Z',
        itemsOpen: 2,
        itemsRequiredOpen: 0,
      }),
      gates: {
        diligence: { requiredOpen: 1, ok: false, carriedOver: 2 },
        icDecision: { ok: true },
        closing: { checklistComplete: true, allocationTiedOut: false, confirmed: true, ok: false },
      },
    });
    open(['deal_team'], reopened);
    await screen.findByTestId('opportunity-detail');
    const lines = within(screen.getByTestId('opportunity-gates')).getAllByRole('listitem');
    expect(lines[0]).toHaveTextContent(
      '1 diligence task required for IC is still open; the advance to IC waits for them (an approver may override with a reason). 2 were done or waived before the deal was reopened.',
    );
    expect(screen.getByTestId('diligence-tasks')).toHaveTextContent(
      '4 tasks, 1 required task open; 2 were done or waived before the deal was reopened',
    );
    // Approved again with the closing it had: the dialog says what the advance does to it.
    await userEvent.click(button('Advance, Project Dune'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('closing-reentry-note')).toHaveTextContent(
      'This deal already has a closing record. It takes the new close date and commitment, its checklist items stay as they are, and the confirmation given before does not carry over: operations confirm again.',
    );
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x2014));
  }, 30_000);

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
