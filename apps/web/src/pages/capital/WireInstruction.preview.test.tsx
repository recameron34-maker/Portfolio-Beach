import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Principal } from '@pb/contracts';
import { mockApi, ok } from '../../test/api-mock.js';
import {
  CLEAR_DETAILS,
  SPONSOR_FUND_ID,
  wireDetailFixture,
  wirePageFixture,
  wireRows,
  WIRE_ID,
} from '../../test/fixtures-capital.js';
import { rolePrincipal } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { PREVIEW_DETAILS_NOTE, WireInstructionPage } from './WireInstruction.js';

const params = vi.hoisted(() => ({ id: '' }));

vi.mock('../../app/env.js', () => ({ previewMode: true }));
vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: params.id }),
}));

const FUND_VERSIONS = `/api/v1/wire-instructions?limit=200&sponsorFundId=${SPONSOR_FUND_ID.silverline}`;

/** Opens the Verified version of the fund the way the preview answers it: bank details null unless typed this session. */
function open(me: Principal, typedThisSession: boolean): void {
  params.id = WIRE_ID.verified;
  const row = wireRows().find((w) => w.id === WIRE_ID.verified);
  if (row === undefined) throw new Error('no fixture version');
  mockApi({
    '/api/v1/auth/me': ok(me),
    [`/api/v1/wire-instructions/${WIRE_ID.verified}`]: ok(wireDetailFixture(row, typedThisSession)),
    [FUND_VERSIONS]: ok(
      wirePageFixture(wireRows().filter((w) => w.counterparty.id === SPONSOR_FUND_ID.silverline)),
    ),
  });
  renderWithQuery(<WireInstructionPage />);
}

describe('wire instruction page (preview): the bundle carries masked details only (WEB-1)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([['operations'], ['approver']] as const)(
    'the reveal shows %s the masked values with a plain note that full details are not part of the preview',
    async (role) => {
      open(rolePrincipal([role]), false);
      const card = await screen.findByTestId('wire-instruction');
      expect(within(card).getByTestId('wire-masked')).toHaveTextContent(
        'Harbor Street Bank ****4821',
      );
      const reveal = within(card).getByTestId('wire-details-reveal');
      expect(reveal).toHaveTextContent('Show bank details');
      expect(reveal).toHaveAttribute('aria-pressed', 'false');
      await userEvent.click(reveal);
      expect(reveal).toHaveTextContent('Hide bank details');
      expect(reveal).toHaveAttribute('aria-pressed', 'true');
      const shown = within(card).getByRole('table', { name: 'Bank details in this preview' });
      const cells = within(shown)
        .getAllByRole('row')
        .map((r) => r.textContent);
      expect(cells).toEqual([
        'Bank nameHarbor Street Bank',
        'Account numberEnds in 4821',
        'Account nameNot part of the preview',
        'Routing codeNot part of the preview',
        'ReferenceNot part of the preview',
      ]);
      expect(within(card).getByTestId('wire-details-note')).toHaveTextContent(PREVIEW_DETAILS_NOTE);
      expect(PREVIEW_DETAILS_NOTE).toBe(
        'Full bank details are not part of this preview: it carries the bank name and the last four digits of the account number only. In the product, operations and approvers read the full details here and each read is recorded in the audit trail (SEC-11.1).',
      );
      // Nothing clear, and no table that claims to be.
      expect(
        within(card).queryByRole('table', { name: 'Bank details in clear' }),
      ).not.toBeInTheDocument();
      expect(card.textContent).not.toContain(CLEAR_DETAILS.accountNumber);
      expect(card.textContent).not.toContain(CLEAR_DETAILS.routingCode);
      await userEvent.click(reveal);
      expect(
        within(card).queryByRole('table', { name: 'Bank details in this preview' }),
      ).not.toBeInTheDocument();
    },
  );

  it('shows an auditor the masked form only, with no reveal', async () => {
    open(rolePrincipal(['auditor']), false);
    const card = await screen.findByTestId('wire-instruction');
    expect(within(card).queryByTestId('wire-details-reveal')).not.toBeInTheDocument();
    expect(within(card).getByTestId('wire-details-note')).toHaveTextContent(
      'Bank details in clear are shown to operations and approvers only (SEC-12.2); every other role sees the masked form.',
    );
  });

  it('shows details a person typed this session back to them, and says they stay in the session', async () => {
    open(rolePrincipal(['operations']), true);
    const card = await screen.findByTestId('wire-instruction');
    await userEvent.click(within(card).getByTestId('wire-details-reveal'));
    const clear = within(card).getByRole('table', { name: 'Bank details in clear' });
    expect(within(clear).getByText(CLEAR_DETAILS.accountNumber)).toBeInTheDocument();
    expect(within(clear).getByText(CLEAR_DETAILS.routingCode)).toBeInTheDocument();
    expect(within(card).getByTestId('wire-details-note')).toHaveTextContent(
      'These details were typed in this preview session and are shown back to its operations and approver readers only; they are not saved and nothing is audited here.',
    );
  });
});
