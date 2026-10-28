import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Principal } from '@pb/contracts';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import {
  CLEAR_DETAILS,
  PERSON,
  SPONSOR_FUND_ID,
  wireDetailFixture,
  wirePageFixture,
  wireRows,
  WIRE_ID,
} from '../../test/fixtures-capital.js';
import { refusalFixture, rolePrincipal, sentPosts } from '../../test/fixtures-valuations.js';
import { ID } from '../../test/fixtures.js';
import { renderWithQuery } from '../../test/render.js';
import { AUDITED_READ_NOTE, WireInstructionPage } from './WireInstruction.js';
import { SECOND_PERSON_RULE } from './wires.js';

const params = vi.hoisted(() => ({ id: '' }));

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: params.id }),
}));

const ME = '/api/v1/auth/me';
const detailPath = (id: string): string => `/api/v1/wire-instructions/${id}`;
const commandsPath = (id: string): string => `/api/v1/wire-instructions/${id}/commands`;
const FUND_VERSIONS = `/api/v1/wire-instructions?limit=200&sponsorFundId=${SPONSOR_FUND_ID.silverline}`;
const INVESTMENT_VERSIONS = `/api/v1/wire-instructions?limit=200&investmentId=${ID.inv3}`;

const rowOf = (id: string) => {
  const row = wireRows().find((w) => w.id === id);
  if (row === undefined) throw new Error(`no fixture version ${id}`);
  return row;
};
/** ops.two: operations, but not the proposer of any fixture version. */
const opsTwo = (): Principal => ({ ...rolePrincipal(['operations']), userId: PERSON.opsTwo.id });

function open(id: string, me: Principal, clear = true, extra: MockRoutes = {}): void {
  params.id = id;
  const row = rowOf(id);
  mockApi({
    [ME]: ok(me),
    [detailPath(id)]: ok(wireDetailFixture(row, clear)),
    [FUND_VERSIONS]: ok(
      wirePageFixture(wireRows().filter((w) => w.counterparty.id === SPONSOR_FUND_ID.silverline)),
    ),
    [INVESTMENT_VERSIONS]: ok(
      wirePageFixture(wireRows().filter((w) => w.counterparty.id === ID.inv3)),
    ),
    ...extra,
  });
  renderWithQuery(<WireInstructionPage />);
}

async function pick(combobox: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole('combobox', { name: combobox }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

/** Filling the callback form through userEvent takes a while under a full-suite load. */
const TIMEOUT = { timeout: 20_000 };

describe('wire instruction page', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the masked version, reveals the clear fields to operations with the audit note, and the history', async () => {
    open(WIRE_ID.verified, rolePrincipal(['operations']));
    const banner = await screen.findByTestId('wire-banner');
    expect(within(banner).getByRole('heading', { level: 1 })).toHaveTextContent(
      'Silverline Partners Fund II: version 1',
    );
    expect(banner).toHaveTextContent('Sponsor fund');
    expect(banner).toHaveTextContent('Proposed by Priya Lindqvist on Mar 4, 2024');
    expect(banner).toHaveTextContent('Source: Typed from the signed subscription pack');
    expect(within(banner).getByText('Verified')).toHaveClass('pb-badge-good');
    expect(within(banner).getByText('Active')).toHaveClass('pb-badge-good');

    const card = screen.getByTestId('wire-instruction');
    expect(within(card).getByTestId('wire-masked')).toHaveTextContent(
      'Harbor Street Bank ****4821',
    );
    expect(card.textContent).not.toContain(CLEAR_DETAILS.accountNumber);
    expect(within(card).getByTestId('wire-details-note')).toHaveTextContent(
      `Shown to operations and approvers only. ${AUDITED_READ_NOTE}`,
    );
    const reveal = within(card).getByTestId('wire-details-reveal');
    expect(reveal).toHaveTextContent('Show bank details');
    await userEvent.click(reveal);
    const clear = within(card).getByRole('table', { name: 'Bank details in clear' });
    expect(within(clear).getByText(CLEAR_DETAILS.accountNumber)).toBeInTheDocument();
    expect(within(clear).getByText(CLEAR_DETAILS.routingCode)).toBeInTheDocument();
    expect(within(clear).getByText('Capital account 44')).toBeInTheDocument();
    expect(within(card).getByTestId('wire-details-note')).toHaveTextContent(AUDITED_READ_NOTE);
    expect(reveal).toHaveTextContent('Hide bank details');
    expect(reveal).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(reveal);
    expect(
      within(card).queryByRole('table', { name: 'Bank details in clear' }),
    ).not.toBeInTheDocument();

    const callback = screen.getByTestId('wire-callback');
    expect(within(callback).getByText('Tomas Achterberg')).toBeInTheDocument();
    expect(within(callback).getByText('Prior instruction on file')).toBeInTheDocument();
    expect(within(callback).getByText('Confirmed')).toBeInTheDocument();
    expect(callback).toHaveTextContent('Verified Mar 5, 2024 15:30:00 UTC.');
    expect(screen.queryByTestId('wire-callback-form')).not.toBeInTheDocument();

    const history = await screen.findByRole('table', { name: 'Versions of this counterparty' });
    const rows = within(history).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Version 2');
    expect(within(rows[0]!).getByRole('link', { name: 'Version 2' })).toHaveAttribute(
      'href',
      `/capital-activity/wires/${WIRE_ID.proposed}`,
    );
    expect(rows[1]).toHaveTextContent('Version 1 (this page)');
    expect(rows[1]).toHaveAttribute('aria-current', 'true');
  });

  it('shows auditors the masked form only, with no reveal button', async () => {
    open(WIRE_ID.verified, rolePrincipal(['auditor']), false);
    const card = await screen.findByTestId('wire-instruction');
    expect(within(card).getByTestId('wire-details-note')).toHaveTextContent(
      'Bank details in clear are shown to operations and approvers only (SEC-12.2); every other role sees the masked form.',
    );
    expect(within(card).queryByTestId('wire-details-reveal')).not.toBeInTheDocument();
    expect(card.textContent).not.toContain(CLEAR_DETAILS.accountNumber);
  });

  it('blocks the proposer from recording the callback and names the rule', async () => {
    open(WIRE_ID.proposed, rolePrincipal(['operations']));
    const form = await screen.findByTestId('wire-callback-form');
    const submit = within(form).getByRole('button', { name: 'Record callback and verify' });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute('title', SECOND_PERSON_RULE);
    // The proposer may still withdraw the version, with a reason.
    expect(within(form).getByRole('button', { name: 'Withdraw version' })).toBeEnabled();
  });

  it('verifies the version through a confirmed callback by a second person', TIMEOUT, async () => {
    const verified = wireDetailFixture({
      ...rowOf(WIRE_ID.proposed),
      state: 'Verified',
      active: true,
      verifiedAt: '2025-07-11T10:00:00.000Z',
      callback: {
        by: PERSON.opsTwo,
        at: '2025-07-11T10:00:00.000Z',
        numberSource: 'sponsor_website',
        result: 'confirmed',
      },
      rowVersion: 2,
    });
    open(WIRE_ID.proposed, opsTwo(), true, { [commandsPath(WIRE_ID.proposed)]: ok(verified) });
    const form = await screen.findByTestId('wire-callback-form');
    const submit = within(form).getByRole('button', { name: 'Record callback and verify' });
    expect(submit).toBeDisabled();
    expect(submit).not.toHaveAttribute('title');
    await pick('Number source', 'Sponsor website');
    await pick('Result', 'Confirmed');
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(
      await within(screen.getByRole('status')).findByText(
        'Version 2 for Silverline Partners Fund II is now Verified and active (audited)',
      ),
    ).toHaveClass('pb-notice-good');
    expect(sentPosts()).toEqual([
      [
        commandsPath(WIRE_ID.proposed),
        { command: 'verify', callbackNumberSource: 'sponsor_website', callbackResult: 'confirmed' },
      ],
    ]);
  });

  it('rejects the version when the callback does not confirm, with a reason', TIMEOUT, async () => {
    const rejected = wireDetailFixture({
      ...rowOf(WIRE_ID.proposed),
      state: 'Rejected',
      rejectionReason: 'The contact did not recognise the account',
      rowVersion: 2,
    });
    open(WIRE_ID.proposed, { ...rolePrincipal(['approver']), userId: PERSON.approver.id }, true, {
      [commandsPath(WIRE_ID.proposed)]: ok(rejected),
    });
    const form = await screen.findByTestId('wire-callback-form');
    await pick('Number source', 'Known contact');
    await pick('Result', 'Not confirmed');
    const submit = within(form).getByRole('button', { name: 'Record callback and reject' });
    expect(submit).toBeDisabled();
    await userEvent.type(
      within(form).getByRole('textbox', { name: 'Reason' }),
      'The contact did not recognise the account',
    );
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(
      await within(screen.getByRole('status')).findByText(
        'Version 2 for Silverline Partners Fund II is now Rejected (audited)',
      ),
    ).toBeInTheDocument();
    expect(sentPosts()).toEqual([
      [
        commandsPath(WIRE_ID.proposed),
        {
          command: 'reject',
          callbackNumberSource: 'known_contact',
          callbackResult: 'not_confirmed',
          reason: 'The contact did not recognise the account',
        },
      ],
    ]);
  });

  it('withdraws a Proposed version with a reason from the dialog', TIMEOUT, async () => {
    open(WIRE_ID.proposed, rolePrincipal(['operations']), true, {
      [commandsPath(WIRE_ID.proposed)]: ok(
        wireDetailFixture({
          ...rowOf(WIRE_ID.proposed),
          state: 'Rejected',
          rejectionReason: 'Typed in error',
        }),
      ),
    });
    await screen.findByTestId('wire-callback-form');
    await userEvent.click(screen.getByRole('button', { name: 'Withdraw version' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Version 2 for Silverline Partners Fund II');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Typed in error');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Withdraw version' }));
    // By test id: jsdom does not return focus to the page after the modal unmounts, so the status
    // region may stay out of the accessibility tree here (a browser lifts it on the focus event).
    await within(screen.getByTestId('wire-action-status')).findByText(/is now Rejected/);
    expect(sentPosts()).toEqual([
      [commandsPath(WIRE_ID.proposed), { command: 'reject', reason: 'Typed in error' }],
    ]);
  });

  it(
    'names the roles a callback needs for a reader who cannot act, and shows a refusal',
    TIMEOUT,
    async () => {
      open(WIRE_ID.proposed, rolePrincipal(['auditor']), false);
      const form = await screen.findByTestId('wire-callback-form');
      const submit = within(form).getByRole('button', { name: 'Record callback and verify' });
      expect(submit).toBeDisabled();
      expect(submit).toHaveAttribute('title', 'Needs operations or approver');
      const withdraw = within(form).getByRole('button', { name: 'Withdraw version' });
      expect(withdraw).toBeDisabled();
      expect(withdraw).toHaveAttribute('title', 'Needs operations or approver');
      cleanup();
      vi.restoreAllMocks();

      open(WIRE_ID.proposed, opsTwo(), true, {
        [commandsPath(WIRE_ID.proposed)]: {
          status: 422,
          body: refusalFixture(
            422,
            'wire_instruction: the callback did not confirm the instruction (SEC-12.2)',
          ),
        },
      });
      await screen.findByTestId('wire-callback-form');
      await pick('Number source', 'Fund administrator');
      await pick('Result', 'Confirmed');
      await userEvent.click(screen.getByRole('button', { name: 'Record callback and verify' }));
      expect(
        await within(screen.getByRole('status')).findByText(
          'Record callback: Blocked by a rule. The callback did not confirm the instruction (SEC-12.2)',
        ),
      ).toHaveClass('pb-notice-bad');
    },
  );

  it('shows a rejected version with its reason and no form, and the investment-level history', async () => {
    open(WIRE_ID.rejected, rolePrincipal(['approver']));
    const callback = await screen.findByTestId('wire-callback');
    expect(callback).toHaveTextContent('Rejected: The contact did not recognise the account');
    expect(within(callback).getByText('Not confirmed')).toBeInTheDocument();
    expect(screen.queryByTestId('wire-callback-form')).not.toBeInTheDocument();
    const history = await screen.findByRole('table', { name: 'Versions of this counterparty' });
    expect(within(history).getAllByRole('row').slice(1)).toHaveLength(2);
  });

  it('says not found on a 404 and not visible on a 403', async () => {
    params.id = WIRE_ID.verified;
    mockApi({
      [ME]: ok(rolePrincipal(['operations'])),
      [detailPath(WIRE_ID.verified)]: failing(404, detailPath(WIRE_ID.verified)),
    });
    renderWithQuery(<WireInstructionPage />);
    expect(await screen.findByTestId('error-state')).toHaveTextContent(
      'Wire instruction not found',
    );
    cleanup();
    vi.restoreAllMocks();
    mockApi({
      [ME]: ok(rolePrincipal(['viewer'])),
      [detailPath(WIRE_ID.verified)]: failing(403, detailPath(WIRE_ID.verified)),
    });
    renderWithQuery(<WireInstructionPage />);
    expect(
      await screen.findByText('This wire instruction: not visible to your role'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });
});
