import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import {
  CLEAR_DETAILS,
  commitmentListFixture,
  wireDetailFixture,
  wirePageFixture,
  wireRowFixture,
  wireRows,
  WIRE_ID,
} from '../../test/fixtures-capital.js';
import {
  activePositions,
  POSITION_ID,
  rolePrincipal,
  sentPosts,
  sentRequests,
} from '../../test/fixtures-valuations.js';
import { investmentPageFixture } from '../../test/fixtures.js';
import { renderWithQuery } from '../../test/render.js';
import { WireRegisterPage } from './WireRegister.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const WIRES = '/api/v1/wire-instructions?limit=200';
const ME = '/api/v1/auth/me';
const INVESTMENTS = '/api/v1/investments?limit=200&active=true';
const COMMITMENTS = '/api/v1/commitments';

/** Picks an option of a combobox inside `scope` (the toolbar's filters and the form share labels). */
async function pick(scope: HTMLElement, combobox: string, option: string): Promise<void> {
  await userEvent.click(within(scope).getByRole('combobox', { name: combobox }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

function open(roles: Parameters<typeof rolePrincipal>[0], extra: MockRoutes = {}): void {
  mockApi({
    [ME]: ok(rolePrincipal(roles)),
    [WIRES]: ok(wirePageFixture()),
    [INVESTMENTS]: ok(investmentPageFixture(activePositions())),
    [COMMITMENTS]: ok(commitmentListFixture()),
    ...extra,
  });
  renderWithQuery(<WireRegisterPage />);
}

const rowsOf = (table: HTMLElement): HTMLElement[] => within(table).getAllByRole('row').slice(1);

/** Typing a whole form through userEvent takes a while under a full-suite load. */
const TIMEOUT = { timeout: 20_000 };

/** Types the bank fields of a fresh version into the propose form. */
async function fillBank(form: HTMLElement): Promise<void> {
  const type = async (name: string, value: string): Promise<void> => {
    await userEvent.type(within(form).getByRole('textbox', { name }), value);
  };
  await type('Bank name', CLEAR_DETAILS.bankName);
  await type('Account name', CLEAR_DETAILS.accountName);
  await type('Account number', CLEAR_DETAILS.accountNumber);
  await type('Routing code', CLEAR_DETAILS.routingCode);
}

describe('wire instruction register', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists every version newest first, masked, with the proposer, the callback and the active one', async () => {
    open(['auditor']);
    const table = await screen.findByRole('table', { name: 'Wire instructions' });
    expect(screen.getByRole('navigation', { name: 'Capital activity' })).toHaveTextContent(
      'Wire register',
    );
    const rows = rowsOf(table);
    expect(rows).toHaveLength(4);
    const first = rows[0]!;
    expect(
      within(first).getByRole('link', { name: 'Silverline Partners Fund II' }),
    ).toHaveAttribute('href', `/capital-activity/wires/${WIRE_ID.proposed}`);
    expect(within(first).getByText('Sponsor fund')).toHaveClass('pb-badge-plain');
    expect(first).toHaveTextContent('Version 2');
    expect(within(first).getByText('Proposed')).toHaveClass('pb-badge-watch');
    expect(first).toHaveTextContent('Northline Trust ****9930');
    expect(first).toHaveTextContent('Priya Lindqvist, Jul 10, 2025');
    expect(within(first).getByText('-')).toBeInTheDocument();
    expect(within(first).getByText('No')).toBeInTheDocument();
    const active = rows[2]!;
    expect(within(active).getByText('Verified')).toHaveClass('pb-badge-good');
    expect(active).toHaveTextContent('Tomas Achterberg: confirmed (prior instruction on file)');
    expect(within(active).getByText('Active')).toHaveClass('pb-badge-good');
    const rejected = rows[1]!;
    expect(within(rejected).getByText('Rejected')).toHaveClass('pb-badge-bad');
    expect(rejected).toHaveTextContent('Tomas Achterberg: not confirmed (known contact)');
    expect(screen.getByTestId('wire-count')).toHaveTextContent(
      '4 versions shown; 1 version waiting for a callback.',
    );
    // No account or routing number reaches the register.
    expect(table.textContent).not.toContain(CLEAR_DETAILS.accountNumber);
    const propose = screen.getByRole('button', { name: 'Propose instruction' });
    expect(propose).toBeDisabled();
    expect(propose).toHaveAttribute('title', 'Needs operations');
    expect(screen.queryByTestId('wire-propose-form')).not.toBeInTheDocument();
  });

  it('filters by state and counterparty in the browser over the one read', async () => {
    open(['approver']);
    await screen.findByRole('table', { name: 'Wire instructions' });
    const register = screen.getByTestId('wire-register');
    await pick(register, 'State', 'Proposed');
    expect(rowsOf(screen.getByRole('table', { name: 'Wire instructions' }))).toHaveLength(1);
    await pick(register, 'Counterparty', 'Summit Services Co');
    expect(screen.getByText('No versions match')).toBeInTheDocument();
    await pick(register, 'State', 'All states');
    expect(rowsOf(screen.getByRole('table', { name: 'Wire instructions' }))).toHaveLength(2);
    expect(screen.getByTestId('wire-count')).toHaveTextContent('2 versions shown');
    const gets = sentRequests()
      .filter(([, method]) => method === 'GET')
      .map(([url]) => url);
    expect(gets.filter((u) => u.startsWith('/api/v1/wire-instructions'))).toEqual([WIRES]);
  });

  it('says when the register is empty and when more than one page exists', async () => {
    open(['operations'], { [WIRES]: ok(wirePageFixture([])) });
    expect(await screen.findByText('No wire instructions yet')).toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();
    open(['operations'], { [WIRES]: ok(wirePageFixture(wireRows(), 'next')) });
    expect(await screen.findByTestId('wire-count')).toHaveTextContent(
      'Showing the first 200; more exist.',
    );
  });

  it('shows the unavailable state to a role outside the register, and degrades on a 501', async () => {
    open(['viewer'], { [WIRES]: failing(403, '/api/v1/wire-instructions') });
    expect(
      await screen.findByText('The wire register: not visible to your role'),
    ).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Capital activity' })).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();
    open(['operations'], { [WIRES]: failing(501, '/api/v1/wire-instructions') });
    expect(await screen.findByText('The wire register: not available yet')).toBeInTheDocument();
  });

  it(
    'lets operations propose a version for a position, typed and checked before it is sent',
    TIMEOUT,
    async () => {
      const created = wireDetailFixture(
        wireRowFixture({
          id: '00000000-0000-4000-8000-000000000709',
          counterparty: {
            kind: 'investment',
            id: POSITION_ID.meridian,
            name: 'Meridian Data Partners',
          },
          version: 1,
          state: 'Proposed',
          bankDetailsMasked: 'Northline Trust ****7799',
          callback: null,
          verifiedAt: null,
          active: false,
          rowVersion: 1,
        }),
      );
      open(['operations'], { '/api/v1/wire-instructions': { status: 201, body: created } });
      await screen.findByRole('table', { name: 'Wire instructions' });
      await userEvent.click(screen.getByRole('button', { name: 'Propose instruction' }));
      const form = await screen.findByTestId('wire-propose-form');
      expect(form).toHaveTextContent('Never from the notice or from an email asking for a change');
      await pick(form, 'Counterparty', 'INV-0001 Meridian Data Partners');
      const name = within(form).getByRole('textbox', { name: 'Counterparty name' });
      expect(name).toHaveValue('Meridian Data Partners');

      // A letter in the account number is refused by the form, and nothing is sent.
      await fillBank(form);
      const account = within(form).getByRole('textbox', { name: 'Account number' });
      await userEvent.clear(account);
      await userEvent.type(account, 'AB12');
      await userEvent.click(within(form).getByRole('button', { name: 'Propose version' }));
      expect(within(form).getByText('Digits only, 6 to 20 of them.')).toBeInTheDocument();
      expect(sentPosts()).toEqual([]);

      await userEvent.clear(account);
      await userEvent.type(account, CLEAR_DETAILS.accountNumber);
      await userEvent.type(
        within(form).getByRole('textbox', { name: 'Source note' }),
        'Typed from the closing set',
      );
      await userEvent.click(within(form).getByRole('button', { name: 'Propose version' }));
      expect(
        await within(screen.getByRole('status')).findByText(
          'Version 1 proposed for Meridian Data Partners (Northline Trust ****7799); a second person must verify it by callback (audited)',
        ),
      ).toHaveClass('pb-notice-good');
      expect(sentPosts()).toEqual([
        [
          '/api/v1/wire-instructions',
          {
            investmentId: POSITION_ID.meridian,
            counterpartyName: 'Meridian Data Partners',
            bankDetails: {
              bankName: CLEAR_DETAILS.bankName,
              accountName: CLEAR_DETAILS.accountName,
              accountNumber: CLEAR_DETAILS.accountNumber,
              routingCode: CLEAR_DETAILS.routingCode,
            },
            sourceNote: 'Typed from the closing set',
          },
        ],
      ]);
      expect(screen.queryByTestId('wire-propose-form')).not.toBeInTheDocument();
    },
  );

  it(
    'offers the sponsor funds the firm has commitments to, each once, and sends the fund id',
    TIMEOUT,
    async () => {
      open(['operations'], {
        '/api/v1/wire-instructions': {
          status: 201,
          body: wireDetailFixture(wireRowFixture({ version: 3, state: 'Proposed', active: false })),
        },
      });
      await screen.findByRole('table', { name: 'Wire instructions' });
      await userEvent.click(screen.getByRole('button', { name: 'Propose instruction' }));
      const form = await screen.findByTestId('wire-propose-form');
      await pick(form, 'Counterparty kind', 'Sponsor fund');
      await userEvent.click(within(form).getByRole('combobox', { name: 'Counterparty' }));
      const options = await screen.findAllByRole('option');
      expect(options.map((o) => o.textContent)).toEqual([
        'Kelpwood Fund I',
        'Oysterbed Credit Fund I',
        'Seagrass Growth Fund II',
        'Skerry Fund I',
      ]);
      await userEvent.click(options[0]!);
      expect(within(form).getByRole('textbox', { name: 'Counterparty name' })).toHaveValue(
        'Kelpwood Fund I',
      );
      await fillBank(form);
      await userEvent.click(within(form).getByRole('button', { name: 'Propose version' }));
      await within(screen.getByRole('status')).findByText(/Version 3 proposed/);
      const [sent] = sentPosts();
      expect(sent?.[1]).toMatchObject({
        sponsorFundId: '00000000-0000-4000-8000-000000000601',
        counterpartyName: 'Kelpwood Fund I',
      });
    },
  );

  it('shows a refusal of the proposal through describeActionError', TIMEOUT, async () => {
    open(['operations'], {
      '/api/v1/wire-instructions': {
        status: 404,
        body: {
          type: 'https://portfolio-beach.example/problems/not-found',
          title: 'Not found',
          status: 404,
          detail: 'Investment not found',
          request_id: 'test',
        },
      },
    });
    await screen.findByRole('table', { name: 'Wire instructions' });
    await userEvent.click(screen.getByRole('button', { name: 'Propose instruction' }));
    const form = await screen.findByTestId('wire-propose-form');
    await pick(form, 'Counterparty', 'INV-0004 Silverline Staffing Holdings');
    await fillBank(form);
    await userEvent.click(within(form).getByRole('button', { name: 'Propose version' }));
    expect(
      await within(screen.getByRole('status')).findByText(/^Propose instruction: /),
    ).toHaveClass('pb-notice-bad');
    expect(screen.getByTestId('wire-propose-form')).toBeInTheDocument();
  });
});
