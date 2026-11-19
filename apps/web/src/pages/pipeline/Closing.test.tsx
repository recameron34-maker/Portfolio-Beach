import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ClosingDetail } from '@pb/contracts';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockResponse, MockRoutes } from '../../test/api-mock.js';
import { dealDocumentPageFixture, DEAL_DOCUMENT_ID } from '../../test/fixtures-deal.js';
import {
  closingDetailFixture,
  closingOpportunityFixture,
  confirmedClosingFixture,
  OPP_ID,
  opportunityDetailFixture,
  partlyReceivedAllocations,
  PIPE_ID,
  PIPE_PATHS,
  SHORT_TIE_OUT,
  taxonomyFixture,
} from '../../test/fixtures-pipeline.js';
import { refusalFixture, rolePrincipal, sentPosts } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { ClosingPage } from './Closing.js';

/** A row of the tie-out ledger (Commitment, Allocated, Difference) inside the tie-out section. */
const ledgerRow = (section: HTMLElement, label: string): HTMLElement =>
  within(within(section).getByRole('table', { name: 'Allocation tie-out' })).getByRole('row', {
    name: new RegExp(`^${label}`),
  });

const params = vi.hoisted(() => ({ id: '' }));

vi.mock('../../app/env.js', () => ({ previewMode: true }));
vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: params.id }),
}));

const TIMEOUT = { timeout: 15_000 };
const HUB = '/api/v1/documents?limit=200';

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
  closing: ClosingDetail = closingDetailFixture(),
  extra: MockRoutes = {},
): void {
  params.id = OPP_ID.closing;
  mockApi({
    [PIPE_PATHS.me]: ok(rolePrincipal(roles)),
    [PIPE_PATHS.opportunity(OPP_ID.closing)]: ok(closingOpportunityFixture()),
    [PIPE_PATHS.closing(PIPE_ID.closing)]: ok(closing),
    [PIPE_PATHS.taxonomy]: ok(taxonomyFixture()),
    [HUB]: ok(dealDocumentPageFixture()),
    ...extra,
  });
  renderWithQuery(<ClosingPage />);
}

const button = (name: string): HTMLElement => screen.getByRole('button', { name });
/**
 * After a dialog closes Fluent lifts aria-hidden from the page a moment later, and the actions stay
 * disabled until the command before has settled: wait for the button to be offered.
 */
async function find(name: string): Promise<HTMLElement> {
  const found = await screen.findByRole('button', { name }, TIMEOUT);
  await waitFor(() => expect(found).toBeEnabled(), TIMEOUT);
  return found;
}

async function dialogClosed(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

describe('closing page', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the record, the checklist in config order, the tie-out and the terms, with the confirmation blocked in words', async () => {
    open(['operations']);
    const panel = await screen.findByTestId('closing-panel');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Closing: Project Cove' }),
    ).toBeInTheDocument();
    // The trail: the board, then the opportunity this closing belongs to, by its name.
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByRole('link', { name: 'Pipeline' })).toHaveAttribute(
      'href',
      '/pipeline',
    );
    expect(within(trail).getByRole('link', { name: 'Project Cove' })).toHaveAttribute(
      'href',
      `/pipeline/${OPP_ID.closing}`,
    );
    expect(screen.getByTestId('closing-banner')).toHaveTextContent('Closing, ');
    const record = within(panel).getByTestId('closing-record');
    expect(within(record).getByTestId('closing-close-date')).toHaveTextContent('Aug 15, 2025');
    expect(record).toHaveTextContent('$20.0M');
    expect(within(record).getByText('Open')).toHaveClass('pb-badge-watch');
    const confirm = within(record).getByTestId('closing-confirm');
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute(
      'title',
      '1 required closing item still open: a required closing document is missing',
    );
    expect(within(record).getByTestId('closing-blockers')).toHaveTextContent(
      'a required closing document is missing',
    );

    const items = within(panel).getByTestId('closing-items');
    expect(items).toHaveTextContent('3 items open, 1 required');
    const rows = within(within(items).getByRole('table', { name: 'Closing checklist' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'closing-item-signed_documents',
      'closing-item-cap_table',
      'closing-item-funds_flow',
      'closing-item-wire_confirmation',
      'closing-item-consents',
      'closing-item-side_letter',
      'closing-item-closing_memo',
    ]);
    const wire = within(items).getByTestId('closing-item-wire_confirmation');
    expect(within(wire).getByText('Open')).toHaveClass('pb-badge-watch');
    expect(within(wire).getByRole('button', { name: 'Receive, Wire confirmation' })).toBeEnabled();
    expect(within(wire).getByRole('button', { name: 'Waive, Wire confirmation' })).toBeEnabled();
    const signed = within(items).getByTestId('closing-item-signed_documents');
    expect(within(signed).getByText('Received')).toHaveClass('pb-badge-good');
    expect(within(signed).getByRole('link', { name: 'Document' })).toHaveAttribute(
      'href',
      `/documents/${PIPE_ID.document}`,
    );
    expect(within(signed).getByRole('button', { name: /Reopen/ })).toBeEnabled();
    expect(within(items).getByTestId('closing-item-funds_flow')).toHaveTextContent(
      'Waived: Funds flow agreed in the signed documents',
    );
    expect(
      within(within(items).getByTestId('closing-item-side_letter')).getByText('Open'),
    ).toHaveClass('pb-badge-neutral');

    const tieOut = within(panel).getByTestId('closing-tie-out');
    expect(ledgerRow(tieOut, 'Commitment')).toHaveTextContent('$20.0M');
    expect(ledgerRow(tieOut, 'Allocated')).toHaveTextContent('$20.0M');
    expect(ledgerRow(tieOut, 'Allocated')).toHaveTextContent('Sum of the received amounts');
    expect(ledgerRow(tieOut, 'Difference')).toHaveTextContent('$0.0M');
    expect(within(tieOut).getByText('Tied out')).toHaveClass('pb-badge-good');
    expect(
      within(tieOut).getByRole('link', { name: 'Edit the allocations on the opportunity page' }),
    ).toHaveAttribute('href', `/pipeline/${OPP_ID.closing}`);

    const terms = within(panel).getByTestId('legal-terms');
    const termRows = within(within(terms).getByRole('table', { name: 'Legal terms' }))
      .getAllByRole('row')
      .slice(1);
    // Each field on its own line in words, true and false as Yes and No; a term with nothing
    // left to do leaves its actions cell blank to the eye.
    expect(termRows[0]).toHaveTextContent(
      'Management feeRate: 2%Basis: committed capitalDocumentConfirmedRowan CastellanosNo actions',
    );
    expect(
      within(termRows[0]!)
        .getAllByRole('listitem')
        .map((l) => l.textContent),
    ).toEqual(['Rate: 2%', 'Basis: committed capital']);
    expect(termRows[1]).toHaveTextContent('MfnElected: YesDeadline: 2025-09-30-Draft-Confirm');
    expect(within(termRows[1]!).getByRole('button', { name: 'Confirm, Mfn' })).toBeEnabled();
    expect(within(terms).getByTestId('legal-term-form')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x2014));
  });

  it('receives an item against a document from the hub list, then waives and reopens', async () => {
    const received = closingDetailFixture({
      itemsOpen: 2,
      itemsRequiredOpen: 0,
      items: closingDetailFixture().items.map((i) =>
        i.itemCode === 'wire_confirmation'
          ? { ...i, status: 'received', documentId: DEAL_DOCUMENT_ID.report }
          : i,
      ),
    });
    const waived = closingDetailFixture({
      ...received,
      items: received.items.map((i) =>
        i.itemCode === 'side_letter'
          ? { ...i, status: 'waived', waivedReason: 'No side letter for this deal' }
          : i,
      ),
    });
    const state = stateful(closingDetailFixture());
    open(['operations'], closingDetailFixture(), {
      [PIPE_PATHS.closing(PIPE_ID.closing)]: state.get,
      [PIPE_PATHS.itemCommands(PIPE_ID.closing, 'wire_confirmation')]: () => state.set(received),
      [PIPE_PATHS.itemCommands(PIPE_ID.closing, 'side_letter')]: () => state.set(waived),
      [PIPE_PATHS.itemCommands(PIPE_ID.closing, 'cap_table')]: () => state.set(waived),
    });
    await screen.findByTestId('closing-panel');
    await userEvent.click(button('Receive, Wire confirmation'));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Receive' })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('combobox', { name: /Document$/ }));
    await userEvent.click(
      await screen.findByRole(
        'option',
        { name: 'Meridian Data Partners quarterly report Q2 2025' },
        TIMEOUT,
      ),
    );
    expect(within(dialog).getByLabelText(/Document id/)).toHaveValue(DEAL_DOCUMENT_ID.report);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Receive' }));
    await dialogClosed();
    expect(await screen.findByTestId('closing-action-status')).toHaveTextContent(
      'Wire confirmation is now Received',
    );
    // Every required item is in: the confirmation is live.
    await waitFor(() => expect(screen.getByTestId('closing-confirm')).toBeEnabled());

    await userEvent.click(await find('Waive, Side letter'));
    dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'No side letter for this deal');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Waive' }));
    await dialogClosed();
    await userEvent.click(await find('Reopen, Closing capitalization table'));
    await waitFor(() => expect(sentPosts()).toHaveLength(3));
    expect(sentPosts()).toEqual([
      [
        PIPE_PATHS.itemCommands(PIPE_ID.closing, 'wire_confirmation'),
        { command: 'receive', documentId: DEAL_DOCUMENT_ID.report },
      ],
      [
        PIPE_PATHS.itemCommands(PIPE_ID.closing, 'side_letter'),
        { command: 'waive', reason: 'No side letter for this deal' },
      ],
      [PIPE_PATHS.itemCommands(PIPE_ID.closing, 'cap_table'), { command: 'reopen' }],
    ]);
  }, 30_000);

  it('lets operations confirm once nothing blocks, and reports a refusal in words', async () => {
    const ready = closingDetailFixture({
      itemsOpen: 2,
      itemsRequiredOpen: 0,
      items: closingDetailFixture().items.map((i) =>
        i.itemCode === 'wire_confirmation'
          ? { ...i, status: 'received', documentId: PIPE_ID.document }
          : i,
      ),
    });
    const state = stateful(ready);
    open(['operations'], ready, {
      [PIPE_PATHS.closing(PIPE_ID.closing)]: state.get,
      [PIPE_PATHS.closingCommands(PIPE_ID.closing)]: () => state.set(confirmedClosingFixture()),
    });
    await screen.findByTestId('closing-panel');
    expect(screen.getByTestId('closing-record')).toHaveTextContent(
      'Every required item is in and the received amounts tie out; operations may confirm.',
    );
    // While the closing is Open there is nothing to reopen.
    expect(screen.queryByTestId('closing-reopen')).toBeNull();
    const confirm = screen.getByTestId('closing-confirm');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(await screen.findByTestId('closing-action-status')).toHaveTextContent(
      'Closing confirmed for Aug 15, 2025; the record is Ops confirmed',
    );
    expect(sentPosts()).toEqual([
      [PIPE_PATHS.closingCommands(PIPE_ID.closing), { command: 'confirm' }],
    ]);
    const record = screen.getByTestId('closing-record');
    // The message is the page's own; the record it reports lands a moment later.
    expect(await within(record).findByText('Ops confirmed')).toHaveClass('pb-badge-good');
    expect(record).toHaveTextContent('Rowan Castellanos');
    expect(record).toHaveTextContent('Aug 16, 2025 10:00:00 UTC');
    expect(screen.queryByTestId('closing-confirm')).toBeNull();
    expect(record).toHaveTextContent(
      'Confirmed by operations: the checklist and the allocations stay as confirmed. A close date change or a reopen returns the record to Open and needs confirmation again.',
    );
    cleanup();
    vi.restoreAllMocks();

    open(['operations'], ready, {
      [PIPE_PATHS.closingCommands(PIPE_ID.closing)]: {
        status: 422,
        body: refusalFixture(422, 'closing: confirm from Open blocked: allocations do not tie'),
      },
    });
    await screen.findByTestId('closing-panel');
    await userEvent.click(screen.getByTestId('closing-confirm'));
    expect(await screen.findByTestId('closing-action-status')).toHaveTextContent(
      'Confirm: Blocked by a rule. Confirm from Open blocked: allocations do not tie',
    );
  }, 30_000);

  it('names the lines with no received amount as what blocks the confirmation (M22)', async () => {
    open(
      ['operations'],
      closingDetailFixture({
        itemsOpen: 2,
        itemsRequiredOpen: 0,
        items: closingDetailFixture().items.map((i) =>
          i.itemCode === 'wire_confirmation'
            ? { ...i, status: 'received', documentId: PIPE_ID.document }
            : i,
        ),
        allocations: partlyReceivedAllocations(),
        allocationTieOut: SHORT_TIE_OUT,
      }),
    );
    const panel = await screen.findByTestId('closing-panel');
    const confirm = within(panel).getByTestId('closing-confirm');
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute('title', 'Received amounts are missing on 1 line');
    const blockers = within(within(panel).getByTestId('closing-blockers')).getAllByRole('listitem');
    expect(blockers.map((b) => b.textContent)).toEqual(['Received amounts are missing on 1 line']);
    const tieOut = within(panel).getByTestId('closing-tie-out');
    expect(ledgerRow(tieOut, 'Allocated')).toHaveTextContent('$12.0M');
    expect(within(tieOut).getByText('Short by $8.0M')).toHaveClass('pb-badge-bad');
    // The vehicle rows lead with the vehicle's totals; a vehicle with nothing received shows the
    // placeholder, never its requested amount. The client line sits under it, behind a disclosure.
    const table = within(tieOut).getByRole('table', { name: 'Allocations' });
    expect(within(table).getByRole('row', { name: /Beach Credit Partners I/ })).toHaveTextContent(
      'Beach Credit Partners I$8.0M-',
    );
    expect(within(table).queryByRole('row', { name: /Alpha Pension Trust/ })).toBeNull();
    await userEvent.click(
      within(table).getByRole('button', {
        name: 'Client breakdown (1 line), Beach Credit Partners I',
      }),
    );
    expect(within(table).getByRole('row', { name: /Alpha Pension Trust/ })).toHaveTextContent(
      'Alpha Pension Trust$8.0M-',
    );
    expect(within(tieOut).queryByTestId('allocations-hidden-lines')).toBeNull();
    expect(tieOut).toHaveTextContent(
      'The closing cannot complete until the received amounts equal the commitment.',
    );
  });

  it("tells a reader with lines not shown how many, under the deal's own tie-out, and counts no line in the blockers", async () => {
    // As the API answers a viewer: the vehicle line alone, the tie-out of every line.
    open(
      ['viewer'],
      closingDetailFixture({
        itemsOpen: 2,
        itemsRequiredOpen: 0,
        allocations: partlyReceivedAllocations().filter((a) => a.client === null),
        allocationTieOut: { ...SHORT_TIE_OUT, hiddenLines: 1 },
      }),
    );
    const panel = await screen.findByTestId('closing-panel');
    const tieOut = within(panel).getByTestId('closing-tie-out');
    // The commitment and the received total lead: the deal's figures, not the visible line's.
    expect(ledgerRow(tieOut, 'Commitment')).toHaveTextContent('$20.0M');
    expect(ledgerRow(tieOut, 'Allocated')).toHaveTextContent('$12.0M');
    expect(within(tieOut).getByText('Short by $8.0M')).toHaveClass('pb-badge-bad');
    const note = within(tieOut).getByTestId('allocations-hidden-lines');
    expect(note).toHaveTextContent(
      '1 client line is not shown. Client-level lines are for operations, the investment team (the deal team and approvers) and auditors, and for readers entitled to the client.',
    );
    expect(note).toHaveClass('pb-meta');
    expect(within(tieOut).queryByRole('alert')).toBeNull();
    // The hidden line is the one with no received amount; this reader cannot count it, so the
    // blocker speaks of the tie-out, never of a number of lines.
    expect(
      within(within(panel).getByTestId('closing-blockers'))
        .getAllByRole('listitem')
        .map((b) => b.textContent),
    ).toEqual(['Allocations do not tie to the closing commitment, short by $8.0M']);
  });

  it('gives a reader shown no line the tie-out and the count of lines not shown, not an empty state', async () => {
    open(
      ['viewer'],
      closingDetailFixture({
        allocations: [],
        allocationTieOut: { ...closingDetailFixture().allocationTieOut, hiddenLines: 3 },
      }),
    );
    const tieOut = within(await screen.findByTestId('closing-panel')).getByTestId(
      'closing-tie-out',
    );
    expect(ledgerRow(tieOut, 'Allocated')).toHaveTextContent('$20.0M');
    expect(within(tieOut).getByText('Tied out')).toHaveClass('pb-badge-good');
    expect(tieOut).not.toHaveTextContent('No allocation lines');
    expect(within(tieOut).queryByRole('table', { name: 'Allocations' })).toBeNull();
    expect(within(tieOut).getByTestId('allocations-hidden-lines')).toHaveTextContent(
      '3 client lines are not shown. Client-level lines are for operations, the investment team (the deal team and approvers) and auditors, and for readers entitled to the client.',
    );
  });

  it('keeps a confirmed closing as confirmed: item actions name the reason, and operations reopen it with a reason', async () => {
    const state = stateful(confirmedClosingFixture());
    open(['operations'], confirmedClosingFixture(), {
      [PIPE_PATHS.closing(PIPE_ID.closing)]: state.get,
      [PIPE_PATHS.closingCommands(PIPE_ID.closing)]: () =>
        state.set(closingDetailFixture({ itemsRequiredOpen: 0, itemsOpen: 2, rowVersion: 3 })),
    });
    const panel = await screen.findByTestId('closing-panel');
    const CONFIRMED =
      'The closing is confirmed; change the close date or ask operations to reopen it';
    for (const name of [
      'Reopen, Signed subscription and transaction documents',
      'Receive, Side letter',
      'Waive, Side letter',
    ]) {
      expect(button(name)).toBeDisabled();
      expect(button(name)).toHaveAttribute('title', CONFIRMED);
    }
    expect(within(panel).getByTestId('closing-items-lock')).toHaveTextContent(`${CONFIRMED}.`);
    expect(within(panel).getByTestId('closing-tie-out')).toHaveTextContent(`${CONFIRMED}.`);
    // Legal terms are not part of what the confirmation covers.
    expect(button('Confirm, Mfn')).toBeEnabled();

    const reopen = within(panel).getByTestId('closing-reopen');
    expect(reopen).toBeEnabled();
    expect(reopen).toHaveAccessibleName('Reopen closing');
    await userEvent.click(reopen);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(
      'Reopening returns the record to Open so the checklist and the allocations can change; operations confirm again.',
    );
    const submit = within(dialog).getByRole('button', { name: 'Reopen closing' });
    expect(submit).toBeDisabled();
    await userEvent.type(
      within(dialog).getByLabelText(/Reason/),
      'The second vehicle takes part of the allocation',
    );
    await userEvent.click(submit);
    await dialogClosed();
    expect(await screen.findByTestId('closing-action-status')).toHaveTextContent(
      'Closing reopened; the record is Open',
    );
    expect(sentPosts()).toEqual([
      [
        PIPE_PATHS.closingCommands(PIPE_ID.closing),
        { command: 'reopen', reason: 'The second vehicle takes part of the allocation' },
      ],
    ]);
    // Open again: the items take changes and there is nothing to reopen.
    expect(await find('Receive, Side letter')).toBeEnabled();
    expect(screen.queryByTestId('closing-reopen')).toBeNull();
    expect(screen.queryByTestId('closing-items-lock')).toBeNull();
    expect(screen.getByTestId('closing-confirm')).toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();

    // The reopen is for operations: the deal team sees it with the role it needs.
    open(['deal_team'], confirmedClosingFixture());
    await screen.findByTestId('closing-panel');
    expect(screen.getByTestId('closing-reopen')).toBeDisabled();
    expect(screen.getByTestId('closing-reopen')).toHaveAttribute('title', 'Needs operations');
    expect(button('Receive, Side letter')).toHaveAttribute('title', CONFIRMED);
    cleanup();
    vi.restoreAllMocks();

    // A refusal is reported in words.
    open(['operations'], confirmedClosingFixture(), {
      [PIPE_PATHS.closingCommands(PIPE_ID.closing)]: {
        status: 422,
        body: refusalFixture(
          422,
          'the position exists; record the change through a deal change request',
        ),
      },
    });
    await screen.findByTestId('closing-panel');
    await userEvent.click(screen.getByTestId('closing-reopen'));
    const again = await screen.findByRole('dialog');
    await userEvent.type(within(again).getByLabelText(/Reason/), 'A line moved');
    await userEvent.click(within(again).getByRole('button', { name: 'Reopen closing' }));
    await dialogClosed();
    expect(await screen.findByTestId('closing-action-status')).toHaveTextContent(
      'Reopen closing: Blocked by a rule. The position exists; record the change through a deal change request',
    );
  }, 45_000);

  it('offers neither a close date change nor a reopen once the position exists, and says where the change goes', async () => {
    open(['operations'], { ...confirmedClosingFixture(), investmentId: PIPE_ID.investment });
    const panel = await screen.findByTestId('closing-panel');
    const POSITION = 'The position exists; record the change through a deal change request';
    const change = button('Change close date');
    expect(change).toBeDisabled();
    expect(change).toHaveAttribute('title', POSITION);
    const reopen = within(panel).getByTestId('closing-reopen');
    expect(reopen).toBeDisabled();
    expect(reopen).toHaveAttribute('title', POSITION);
    expect(within(panel).getByTestId('closing-record')).toHaveTextContent(
      'Confirmed by operations.',
    );
    expect(button('Receive, Side letter')).toHaveAttribute('title', POSITION);
    // Said once, at the top of the panel; each command it stops names it in its title.
    expect(within(panel).getByTestId('closing-position-note')).toHaveTextContent(`${POSITION}.`);
    expect(panel.textContent?.split(POSITION)).toHaveLength(2);
    expect(within(panel).queryByTestId('closing-items-lock')).toBeNull();
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x2014));
  });

  it('changes the close date with a reason, from a confirmed closing back to Open', async () => {
    const state = stateful(confirmedClosingFixture());
    open(['operations'], confirmedClosingFixture(), {
      [PIPE_PATHS.closing(PIPE_ID.closing)]: state.get,
      [PIPE_PATHS.closingCommands(PIPE_ID.closing)]: () =>
        state.set(
          closingDetailFixture({ closeDate: '2025-08-22', itemsRequiredOpen: 0, itemsOpen: 2 }),
        ),
    });
    await screen.findByTestId('closing-panel');
    await userEvent.click(button('Change close date'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Now Aug 15, 2025.');
    const submit = within(dialog).getByRole('button', { name: 'Change close date' });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Signing slipped a week');
    // The same date is not a change.
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/New close date/), {
      target: { value: '2025-08-22' },
    });
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await dialogClosed();
    expect(await screen.findByTestId('closing-action-status')).toHaveTextContent(
      'Close date is now Aug 22, 2025; the record is Open',
    );
    expect(sentPosts()).toEqual([
      [
        PIPE_PATHS.closingCommands(PIPE_ID.closing),
        { command: 'changeCloseDate', closeDate: '2025-08-22', reason: 'Signing slipped a week' },
      ],
    ]);
    await waitFor(() =>
      expect(screen.getByTestId('closing-close-date')).toHaveTextContent('Aug 22, 2025'),
    );
    expect(screen.getByTestId('closing-confirm')).toBeInTheDocument();
  }, 30_000);

  it('confirms a draft term and adds a term from its typed fields', async () => {
    const confirmed = closingDetailFixture({
      legalTerms: closingDetailFixture().legalTerms.map((t) =>
        t.id === PIPE_ID.termMfn
          ? {
              ...t,
              status: 'confirmed',
              confirmedBy: { id: PIPE_ID.document, name: 'Blake Mbeki' },
            }
          : t,
      ),
    });
    const state = stateful(closingDetailFixture());
    open(['deal_team'], closingDetailFixture(), {
      [PIPE_PATHS.closing(PIPE_ID.closing)]: state.get,
      [PIPE_PATHS.termCommands(PIPE_ID.closing, PIPE_ID.termMfn)]: () => state.set(confirmed),
      [PIPE_PATHS.terms(PIPE_ID.closing)]: () => state.set(confirmed),
    });
    await screen.findByTestId('closing-panel');
    await userEvent.click(button('Confirm, Mfn'));
    expect(await screen.findByTestId('closing-action-status')).toHaveTextContent('Mfn confirmed');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm, Mfn' })).toBeNull());

    const form = screen.getByTestId('legal-term-form');
    const add = within(form).getByRole('button', { name: 'Add term' });
    expect(add).toBeDisabled();
    await userEvent.click(within(form).getByRole('combobox', { name: /Term type/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Key person' }, TIMEOUT));
    await userEvent.type(within(form).getByLabelText('Field name 1'), 'persons');
    await userEvent.type(within(form).getByLabelText('Field value 1'), '2 of 3 partners');
    await userEvent.click(within(form).getByRole('button', { name: 'Add field' }));
    await userEvent.type(within(form).getByLabelText('Field name 2'), 'suspension');
    await userEvent.type(within(form).getByLabelText('Field value 2'), 'investment period');
    await userEvent.type(within(form).getByLabelText(/Source document \(optional\)/), 'nope');
    expect(add).toBeDisabled();
    await userEvent.clear(within(form).getByLabelText(/Source document \(optional\)/));
    await userEvent.type(
      within(form).getByLabelText(/Source document \(optional\)/),
      PIPE_ID.document,
    );
    await userEvent.click(add);
    expect(await screen.findByTestId('closing-action-status')).toHaveTextContent(
      'Legal term added in draft: Key person',
    );
    expect(sentPosts()).toEqual([
      [PIPE_PATHS.termCommands(PIPE_ID.closing, PIPE_ID.termMfn), { command: 'confirm' }],
      [
        PIPE_PATHS.terms(PIPE_ID.closing),
        {
          termType: 'legal_term_type.key_person',
          value: { persons: '2 of 3 partners', suspension: 'investment period' },
          sourceDocumentId: PIPE_ID.document,
        },
      ],
    ]);
    // The deal team cannot confirm the closing: the record names the role.
    expect(screen.getByTestId('closing-confirm')).toHaveAttribute('title', 'Needs operations');
    expect(button('Change close date')).toHaveAttribute('title', 'Needs operations');
  }, 30_000);

  it('shows a viewer the panel read only with every action naming its role', async () => {
    open(['viewer']);
    await screen.findByTestId('closing-panel');
    expect(button('Receive, Wire confirmation')).toHaveAttribute(
      'title',
      'Needs operations or deal team',
    );
    expect(button('Confirm, Mfn')).toHaveAttribute('title', 'Needs deal team or operations');
    expect(
      within(screen.getByTestId('legal-term-form')).getByRole('button', { name: 'Add term' }),
    ).toHaveAttribute('title', 'Needs deal team or operations');
    expect(screen.getByTestId('closing-confirm')).toHaveAttribute('title', 'Needs operations');
  });

  it('says so when the opportunity has no closing yet, and when it is not visible', async () => {
    params.id = OPP_ID.approved;
    mockApi({
      [PIPE_PATHS.me]: ok(rolePrincipal(['viewer'])),
      [PIPE_PATHS.opportunity(OPP_ID.approved)]: ok(
        opportunityDetailFixture({ id: OPP_ID.approved, stage: 'Approved' }),
      ),
    });
    renderWithQuery(<ClosingPage />);
    expect(await screen.findByTestId('closing-page-empty')).toHaveTextContent(
      'No closing record yet',
    );
    cleanup();
    vi.restoreAllMocks();

    params.id = OPP_ID.closing;
    mockApi({
      [PIPE_PATHS.me]: ok(rolePrincipal(['viewer'])),
      [PIPE_PATHS.opportunity(OPP_ID.closing)]: failing(404, '/api/v1/opportunities'),
    });
    renderWithQuery(<ClosingPage />);
    expect(
      await screen.findByText('Opportunity not found or not visible to you'),
    ).toBeInTheDocument();
    // Nothing to go back to but the board.
    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/pipeline']);
    cleanup();
    vi.restoreAllMocks();

    // A load that failed for another reason still leads back to the opportunity by its id.
    params.id = OPP_ID.closing;
    mockApi({
      [PIPE_PATHS.me]: ok(rolePrincipal(['viewer'])),
      [PIPE_PATHS.opportunity(OPP_ID.closing)]: failing(501, '/api/v1/opportunities'),
    });
    renderWithQuery(<ClosingPage />);
    await screen.findByTestId('closing-page-unavailable');
    const back = within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', {
      name: 'Opportunity',
    });
    expect(back).toHaveAttribute('href', `/pipeline/${OPP_ID.closing}`);
    cleanup();
    vi.restoreAllMocks();

    open(['viewer'], closingDetailFixture(), {
      [PIPE_PATHS.closing(PIPE_ID.closing)]: failing(403, '/api/v1/closings'),
    });
    expect(await screen.findByText('Closing not found or not visible to you')).toBeInTheDocument();
  });
});
