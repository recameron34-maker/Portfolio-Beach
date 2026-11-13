import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProblemDetails, UnderwritingRead } from '@pb/contracts';
import { failing, ok } from '../../test/api-mock.js';
import type { MockResponse } from '../../test/api-mock.js';
import { rolePrincipal } from '../../test/fixtures-valuations.js';
import { documentFixture } from '../documents/fixtures.js';
import { UnderwritingCard } from './UnderwritingCard.js';
import {
  caseFixture,
  draftFixture,
  loanCaseFixture,
  readFixture,
  reunderwriteFixture,
  UW_ID,
  UW_INVESTMENT,
  UW_PATH,
  UW_PERSON,
} from './underwriting.fixtures.js';

vi.mock('@tanstack/react-router', async () => {
  const base = (await import('../../test/router-mock.js')).routerMock();
  return {
    ...base,
    Link: (props: { href?: string; 'data-testid'?: string; children?: ReactNode }) => (
      <a href={props.href} data-testid={props['data-testid']}>
        {props.children}
      </a>
    ),
  };
});

/*
 * The actions of the base case card and its form (docs/04 M9, docs/18 section 13): who is
 * offered what, what each action sends, and what the card says when the API refuses.
 */

/** Fluent dialogs and dropdowns take their time on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };
const ME = '/api/v1/auth/me';
const DOCUMENTS = `/api/v1/documents?limit=200&investmentId=${UW_INVESTMENT}`;
const casePath = (id: string): string => `/api/v1/underwriting-cases/${id}`;
const commands = (id: string): string => `${casePath(id)}/commands`;

interface Call {
  method: string;
  path: string;
  body: unknown;
  ifMatch: string | null;
}
let calls: Call[] = [];
const writes = (): Call[] => calls.filter((c) => c.method !== 'GET');

type Handler = MockResponse | (() => MockResponse);

/** Answers fetch by method and path, and keeps what was sent with its If-Match. */
function serve(handlers: Record<string, Handler>): void {
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://test.local');
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({
      method,
      path: url.pathname + url.search,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      ifMatch: new Headers(init?.headers).get('if-match'),
    });
    const handler =
      handlers[`${method} ${url.pathname}${url.search}`] ?? handlers[`${method} ${url.pathname}`];
    const answer =
      handler === undefined
        ? failing(404, url.pathname)
        : typeof handler === 'function'
          ? handler()
          : handler;
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: {
          'content-type': answer.status >= 400 ? 'application/problem+json' : 'application/json',
        },
      }),
    );
  });
}

const refusal = (status: number, code: string, detail: string): MockResponse => {
  const body: ProblemDetails = {
    type: `https://portfolio-beach.example/problems/${code}`,
    title: 'Refused',
    status,
    detail,
    request_id: 'test',
  };
  return { status, body };
};

type Who = keyof typeof UW_PERSON;
const ROLE: Readonly<Record<Who, 'deal_team' | 'approver'>> = {
  entered: 'deal_team',
  confirmed: 'deal_team',
  approver: 'approver',
};

/**
 * The card for a signed-in person over a read the test may replace after a write, as the API
 * would answer the refreshed read. `entered` is the person who entered the fixture's Draft.
 */
function open(
  who: Who | 'viewer',
  read: UnderwritingRead,
  handlers: Record<string, Handler> = {},
): { now: (next: UnderwritingRead) => void; client: QueryClient } {
  let current = read;
  serve({
    [`GET ${ME}`]: ok(
      who === 'viewer'
        ? rolePrincipal(['viewer'])
        : { ...rolePrincipal([ROLE[who]]), userId: UW_PERSON[who].id },
    ),
    [`GET ${UW_PATH}`]: () => ok(current),
    [`GET ${DOCUMENTS}`]: ok({ items: [], nextCursor: null }),
    ...handlers,
  });
  // The page's query client, as renderWithQuery makes it, kept so a test can ask for a refresh.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UnderwritingCard id={UW_INVESTMENT} company="Saltmarsh Holdings" />
    </QueryClientProvider>,
  );
  return {
    now: (next) => {
      current = next;
    },
    client,
  };
}

const button = (name: string): HTMLElement => screen.getByRole('button', { name });
const noButton = (name: string): void => {
  expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
};
const status = (): HTMLElement => screen.getByTestId('underwriting-action-status');
const type = (label: string | RegExp, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

/** Types the fixture's base case into the open form: two plan dates in US$ millions. */
function fillCase(): void {
  type(/^Case date/, '2021-06-30');
  type(/^Planned exit/, '2026-06-30');
  type(/^Exit multiple/, '11');
  type(/^Underwritten gross MOIC/, '2.5');
  type(/^Underwritten gross IRR/, '20');
  type('Twelve months ending, plan date 1', '2021-06-30');
  type('Revenue in US$ millions, plan date 1', '200');
  type('EBITDA in US$ millions, plan date 1', '40');
  type('Net debt in US$ millions, plan date 1', '150');
  type('Revenue in US$ millions, plan date 2', '400');
  type('EBITDA in US$ millions, plan date 2', '80');
  type('Net debt in US$ millions, plan date 2', '100');
  type(/^Where the model is held/, 'Sponsor model, held in the deal folder');
}

const FILLED_BODY = {
  caseDate: '2021-06-30',
  plannedExitDate: '2026-06-30',
  exitMultiple: '11',
  grossMoic: '2.5',
  grossIrr: '0.2',
  points: [
    {
      periodEnd: '2021-06-30',
      revenueLtm: '200000000.00',
      ebitdaLtm: '40000000.00',
      netDebt: '150000000.00',
    },
    {
      periodEnd: '2026-06-30',
      revenueLtm: '400000000.00',
      ebitdaLtm: '80000000.00',
      netDebt: '100000000.00',
    },
  ],
  sourceNote: 'Sponsor model, held in the deal folder',
};

describe('base case card: actions', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('offers a reader nothing to do, whatever stands', async () => {
    open('viewer', readFixture({ versions: [caseFixture(), draftFixture({ version: 2 })] }));
    await screen.findByTestId('deal-underwriting-draft');
    await waitFor(() => expect(calls.some((c) => c.path === ME)).toBe(true));
    for (const name of ['Record base case', 'Revise', 'Retire', 'Edit draft', 'Withdraw draft'])
      noButton(name);
    noButton('Confirm');
    expect(screen.queryByTestId('underwriting-own-figures')).not.toBeInTheDocument();
    expect(writes()).toEqual([]);
  });

  it('lets the deal team record a first case, after showing every figure back in full', async () => {
    const draft = draftFixture();
    const card = open('entered', readFixture({ versions: [] }), {
      [`POST ${UW_PATH}`]: { status: 201, body: draft },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Record base case' }));
    const form = await screen.findByRole('form', { name: 'Record the base case' });
    // The last plan row is the planned exit: its date is the one above, never typed again.
    expect(within(form).getByRole('table', { name: 'Plan, in US$ millions' })).toHaveTextContent(
      'The planned exit',
    );
    expect(screen.queryByLabelText(/^Reason for the revision/)).not.toBeInTheDocument();
    fillCase();
    expect(within(form).getByRole('table', { name: 'Plan, in US$ millions' })).toHaveTextContent(
      'Jun 30, 2026, the planned exit',
    );
    await userEvent.click(button('Review figures'));
    const review = await screen.findByTestId('underwriting-review');
    expect(
      within(within(review).getByRole('table', { name: 'Plan as it will be saved, in dollars' }))
        .getAllByRole('row')
        .map((r) => r.textContent),
    ).toEqual([
      'Twelve months endingRevenueEBITDANet debt',
      'Jun 30, 2021$200,000,000.00$40,000,000.00$150,000,000.00',
      'Jun 30, 2026$400,000,000.00$80,000,000.00$100,000,000.00',
    ]);
    const terms = within(review).getByRole('table', { name: 'Terms as they will be saved' });
    expect(terms).toHaveTextContent('Exit multiple11x');
    expect(terms).toHaveTextContent('Underwritten gross MOIC2.5x');
    expect(terms).toHaveTextContent('Underwritten gross IRR20%');
    expect(terms).toHaveTextContent('SourceSponsor model, held in the deal folder');
    // Nothing is sent until the figures have been seen.
    expect(writes()).toEqual([]);
    card.now(readFixture({ versions: [draft], compared: null }));
    await userEvent.click(button('Save draft'));
    expect(await within(status()).findByText(/^Draft recorded/)).toHaveTextContent(
      'Draft recorded: a second person confirms it (audited)',
    );
    expect(writes()).toEqual([{ method: 'POST', path: UW_PATH, body: FILLED_BODY, ifMatch: null }]);
    // The read is refreshed: the Draft is shown, and its author is told who confirms it.
    expect(await screen.findByTestId('underwriting-own-figures')).toHaveTextContent(
      'You entered these figures. A second person confirms them.',
    );
    noButton('Confirm');
    noButton('Record base case');
  });

  it('says what is wrong before anything is sent, and keeps what was typed when the API refuses', async () => {
    open('entered', readFixture({ versions: [] }), {
      [`POST ${UW_PATH}`]: refusal(
        409,
        'workflow-transition',
        'underwriting_case: a Draft already exists for this position; edit it or withdraw it first',
      ),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Record base case' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Review figures' }));
    expect(await screen.findByText('Give the date of the base case.')).toBeInTheDocument();
    expect(screen.getByText('Give the planned exit date.')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('underwriting-plan-faults'))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Plan date 1: Give the plan date.',
      'Plan date 1: Give at least one of revenue, EBITDA and net debt.',
      'Plan date 2: Give at least one of revenue, EBITDA and net debt.',
    ]);
    expect(screen.queryByTestId('underwriting-review')).not.toBeInTheDocument();
    expect(writes()).toEqual([]);
    fillCase();
    await userEvent.click(button('Review figures'));
    await userEvent.click(await screen.findByRole('button', { name: 'Save draft' }));
    expect(await within(status()).findByText(/^Record the base case:/)).toHaveTextContent(
      'Record the base case: Not allowed from the current state. A Draft already exists for this position; edit it or withdraw it first',
    );
    // Back in the form, with everything typed.
    expect(screen.getByLabelText(/^Exit multiple/)).toHaveValue('11');
    expect(screen.getByLabelText('Revenue in US$ millions, plan date 2')).toHaveValue('400');
  });

  it('adds and removes plan dates, the planned exit always last', async () => {
    open('entered', readFixture({ versions: [] }));
    await userEvent.click(await screen.findByRole('button', { name: 'Record base case' }));
    await screen.findByRole('form', { name: 'Record the base case' });
    fillCase();
    noButton('Remove plan date 1');
    await userEvent.click(button('Add a plan date'));
    // The new date sits before the exit row, which keeps its figures.
    expect(screen.getByLabelText('Revenue in US$ millions, plan date 3')).toHaveValue('400');
    expect(screen.getByLabelText('Revenue in US$ millions, plan date 2')).toHaveValue('');
    type('Twelve months ending, plan date 2', '2023-12-31');
    type('EBITDA in US$ millions, plan date 2', '60');
    await userEvent.click(button('Review figures'));
    expect(
      within(await screen.findByRole('table', { name: 'Plan as it will be saved, in dollars' }))
        .getAllByRole('row')
        .map((r) => r.textContent)[2],
    ).toBe('Dec 31, 2023-$60,000,000.00-');
    await userEvent.click(button('Back to the form'));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove plan date 2' }));
    expect(screen.getByLabelText('Revenue in US$ millions, plan date 2')).toHaveValue('400');
    expect(screen.queryByLabelText('Revenue in US$ millions, plan date 3')).not.toBeInTheDocument();
    await userEvent.click(button('Cancel'));
    expect(await screen.findByTestId('deal-underwriting-empty')).toBeInTheDocument();
  });

  it('edits the Draft against the version it was opened on, and says when the case changed meanwhile', async () => {
    const draft = draftFixture({ rowVersion: 3 });
    let answer: MockResponse = { status: 200, body: { ...draft, rowVersion: 4 } };
    open('confirmed', readFixture({ versions: [draft], compared: null }), {
      [`PATCH ${casePath(draft.id)}`]: () => answer,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));
    await screen.findByRole('form', { name: 'Edit the draft' });
    // The form opens on the Draft's own figures, in the units a person types.
    expect(screen.getByLabelText(/^Exit multiple/)).toHaveValue('11');
    expect(screen.getByLabelText(/^Underwritten gross IRR/)).toHaveValue('20');
    expect(screen.getByLabelText('EBITDA in US$ millions, plan date 2')).toHaveValue('66.38');
    type(/^Exit multiple/, '10.5');
    await userEvent.click(button('Review figures'));
    await userEvent.click(await screen.findByRole('button', { name: 'Save draft' }));
    expect(await within(status()).findByText(/^Draft saved/)).toBeInTheDocument();
    const sent = writes()[0];
    expect(sent).toMatchObject({ method: 'PATCH', path: casePath(draft.id), ifMatch: '"3"' });
    expect(sent?.body).toMatchObject({ exitMultiple: '10.5', points: draft.points });

    // Somebody else changed it first: the form closes on the refreshed card, which says so.
    answer = refusal(
      412,
      'stale-row-version',
      'underwriting_case: the record changed since it was read (it is now at row version 4); open it again',
    );
    await userEvent.click(button('Edit draft'));
    await screen.findByRole('form', { name: 'Edit the draft' });
    await userEvent.click(button('Review figures'));
    await userEvent.click(await screen.findByRole('button', { name: 'Save draft' }));
    expect(
      await within(status()).findByText(
        'This base case changed since you opened it. Open it again.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Edit the draft' })).not.toBeInTheDocument();
    expect(screen.getByTestId('deal-underwriting-draft')).toBeInTheDocument();
  });

  it('has a second person confirm, and words a refusal without its citation', async () => {
    const draft = draftFixture();
    let answer: MockResponse = ok(caseFixture());
    const card = open('confirmed', readFixture({ versions: [draft], compared: null }), {
      [`POST ${commands(draft.id)}`]: () => answer,
    });
    card.now(readFixture());
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await within(status()).findByText('Base case confirmed (audited)')).toBeInTheDocument();
    expect(writes()).toEqual([
      { method: 'POST', path: commands(draft.id), body: { command: 'confirm' }, ifMatch: '"1"' },
    ]);
    // The read is refreshed: the position is now compared with the case.
    expect(await screen.findByTestId('deal-underwriting-tiles')).toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();

    answer = refusal(
      422,
      'workflow-precondition',
      'underwriting_case: a base case names its source before it is confirmed: a document of the position or a note on where the model is held (SEC-9.4)',
    );
    open('approver', readFixture({ versions: [draft], compared: null }), {
      [`POST ${commands(draft.id)}`]: () => answer,
    });
    // An approver confirms too, and neither edits nor withdraws.
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    noButton('Edit draft');
    noButton('Withdraw draft');
    expect(await within(status()).findByText(/^Confirm:/)).toHaveTextContent(
      'Confirm: Blocked by a rule. A base case names its source before it is confirmed: a document of the position or a note on where the model is held',
    );
    expect(status()).not.toHaveTextContent('SEC-');
  });

  it('withdraws a Draft and retires a Confirmed case with a reason', async () => {
    const draft = draftFixture();
    open('confirmed', readFixture({ versions: [draft], compared: null }), {
      [`POST ${commands(draft.id)}`]: ok({ ...draft, state: 'Withdrawn' }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Withdraw draft' }));
    const dialog = await screen.findByRole('dialog', {}, TIMEOUT);
    // No reason, no command.
    expect(within(dialog).getByRole('button', { name: 'Withdraw draft' })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Recorded against the wrong model' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Withdraw draft' }));
    expect(await within(status()).findByText('Draft withdrawn (audited)')).toBeInTheDocument();
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: commands(draft.id),
        body: { command: 'withdraw', reason: 'Recorded against the wrong model' },
        ifMatch: '"1"',
      },
    ]);
    cleanup();
    vi.restoreAllMocks();

    open('approver', readFixture(), {
      [`POST ${commands(UW_ID.entry)}`]: ok(caseFixture({ state: 'Withdrawn' })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Retire' }));
    noButton('Revise');
    const retire = await screen.findByRole('dialog', {}, TIMEOUT);
    fireEvent.change(within(retire).getByRole('textbox'), {
      target: { value: 'Confirmed in error' },
    });
    await userEvent.click(within(retire).getByRole('button', { name: 'Retire' }));
    expect(await within(status()).findByText('Base case retired (audited)')).toBeInTheDocument();
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: commands(UW_ID.entry),
        body: { command: 'retire', reason: 'Confirmed in error' },
        ifMatch: '"2"',
      },
    ]);
  });

  it('keeps the result on the card when the version picked is retired, and compares with what stands', async () => {
    const entry = caseFixture();
    const later = reunderwriteFixture();
    const versions = [entry, later];
    const retired = [
      entry,
      { ...later, state: 'Withdrawn' as const, withdrawnReason: 'Wrong model' },
    ];
    let stands = true;
    open('approver', readFixture({ versions }), {
      // A version that no longer stands is not one the position is compared with: 404.
      [`GET ${UW_PATH}?version=2`]: () =>
        stands ? ok(readFixture({ versions, compared: 2 })) : failing(404, UW_PATH),
      [`GET ${UW_PATH}`]: () => ok(readFixture({ versions: stands ? versions : retired })),
      [`POST ${commands(later.id)}`]: () => {
        stands = false;
        return ok(retired[1]);
      },
    });
    await userEvent.click(await screen.findByRole('combobox', { name: 'Compared with' }));
    await userEvent.click(
      await screen.findByRole('option', { name: 'Re-underwritten Mar 31, 2023' }, TIMEOUT),
    );
    await screen.findByRole('table', { name: 'Re-underwritten Mar 31, 2023, terms' }, TIMEOUT);
    await userEvent.click(button('Retire'));
    const dialog = await screen.findByRole('dialog', {}, TIMEOUT);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Wrong model' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retire' }));
    // The card goes back to the case that stands, and still says what was done.
    expect(
      await screen.findByRole('table', { name: 'Entry case, terms' }, TIMEOUT),
    ).toBeInTheDocument();
    expect(within(status()).getByText('Base case retired (audited)')).toBeInTheDocument();
    expect(screen.getByTestId('underwriting-version-gone')).toHaveTextContent(
      'The version you picked is no longer one the position is compared with.',
    );
    expect(screen.queryByRole('button', { name: 'Show the entry case' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Versions of the base case' })).toHaveTextContent(
        'Withdrawn',
      ),
    );
    expect(writes()).toHaveLength(1);
  });

  it('keeps the card, and an open form, when a later read of the case fails', async () => {
    let failingNow = false;
    const view = open('entered', readFixture({ versions: [] }), {
      [`GET ${UW_PATH}`]: () =>
        failingNow
          ? { status: 500, body: { title: 'Server error', status: 500 } }
          : ok(readFixture({ versions: [] })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Record base case' }));
    await screen.findByRole('form', { name: 'Record the base case' });
    type(/^Exit multiple/, '11');
    failingNow = true;
    await view.client.invalidateQueries();
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'GET' && c.path === UW_PATH)).toHaveLength(2),
    );
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    // What was typed is still there: a read that fails later does not take the form away.
    expect(screen.getByLabelText(/^Exit multiple/)).toHaveValue('11');
    expect(screen.queryByText(/could not load/)).not.toBeInTheDocument();
  });

  it('keeps keyboard focus in the card at every step: the form, the review, the result and the reason dialog', async () => {
    const draft = draftFixture();
    const card = open('entered', readFixture({ versions: [] }), {
      [`POST ${UW_PATH}`]: { status: 201, body: draft },
    });
    const heading = (): HTMLElement =>
      within(screen.getByTestId('deal-underwriting')).getByText("Against the sponsor's base case");
    const opener = await screen.findByRole('button', { name: 'Record base case' });
    // Cancel gives focus back to the button that opened the form.
    await userEvent.click(opener);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Record the base case' })).toHaveFocus(),
    );
    await userEvent.click(button('Cancel'));
    await waitFor(() => expect(button('Record base case')).toHaveFocus());
    // The form, the review and back each take focus to their own heading.
    await userEvent.click(button('Record base case'));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Record the base case' })).toHaveFocus(),
    );
    fillCase();
    await userEvent.click(button('Review figures'));
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Record the base case: check the figures in full' }),
      ).toHaveFocus(),
    );
    await userEvent.click(button('Back to the form'));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Record the base case' })).toHaveFocus(),
    );
    await userEvent.click(button('Review figures'));
    card.now(readFixture({ versions: [draft], compared: null }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save draft' }));
    // Saved: the button that opened the form is gone with the read, so the card's title has focus.
    await within(status()).findByText(/^Draft recorded/);
    await screen.findByTestId('underwriting-own-figures');
    expect(heading()).toHaveFocus();
    // The reason dialog gives focus back to its button when it is cancelled.
    await userEvent.click(button('Withdraw draft'));
    const dialog = await screen.findByRole('dialog', {}, TIMEOUT);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), TIMEOUT);
    await waitFor(() => expect(button('Withdraw draft')).toHaveFocus());
  });

  it('moves focus to the card title when a command takes its own button away', async () => {
    const draft = draftFixture();
    const confirmed = { ...draft, state: 'Confirmed' as const, confirmedBy: UW_PERSON.confirmed };
    const card = open('confirmed', readFixture({ versions: [draft], compared: null }), {
      [`POST ${commands(draft.id)}`]: () => {
        card.now(readFixture({ versions: [confirmed] }));
        return ok(confirmed);
      },
    });
    const heading = (): HTMLElement =>
      within(screen.getByTestId('deal-underwriting')).getByText("Against the sponsor's base case");
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await within(status()).findByText(/^Base case confirmed/);
    await waitFor(() => noButton('Confirm'));
    await waitFor(() => expect(heading()).toHaveFocus());
    cleanup();
    vi.restoreAllMocks();

    // A reason sent: the button that asked for it is busy and then gone, so the title has focus.
    const again = open('confirmed', readFixture({ versions: [draft], compared: null }), {
      [`POST ${commands(draft.id)}`]: () => {
        again.now(readFixture({ versions: [{ ...draft, state: 'Withdrawn' }], compared: null }));
        return ok({ ...draft, state: 'Withdrawn' });
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Withdraw draft' }));
    const dialog = await screen.findByRole('dialog', {}, TIMEOUT);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Wrong model' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Withdraw draft' }));
    await within(status()).findByText(/^Draft withdrawn/);
    await waitFor(() => expect(heading()).toHaveFocus());
  });

  it('revises the Confirmed case from its own figures, with a reason and a source document', async () => {
    const document = documentFixture({
      id: UW_ID.document,
      title: 'Saltmarsh Holdings sponsor model 2023',
      investmentId: UW_INVESTMENT,
    });
    open('entered', readFixture(), {
      [`GET ${DOCUMENTS}`]: ok({ items: [document], nextCursor: null }),
      [`POST ${UW_PATH}`]: { status: 201, body: draftFixture({ version: 2 }) },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Revise' }));
    await screen.findByRole('form', { name: 'Revise the base case' });
    expect(screen.getByTestId('deal-underwriting')).toHaveTextContent(
      'Keep the case date to correct this case',
    );
    expect(screen.getByLabelText(/^Case date/)).toHaveValue('2021-06-30');
    expect(screen.getByLabelText('Revenue in US$ millions, plan date 2')).toHaveValue('281.9');
    // A revision says why.
    await userEvent.click(button('Review figures'));
    expect(await screen.findByText('Say why the base case is revised.')).toBeInTheDocument();
    type(/^Reason for the revision/, 'The exit multiple was mistyped');
    type(/^Exit multiple/, '10');
    // The page and the sheet go with a document of the position.
    expect(screen.getByLabelText(/^Page/)).toBeDisabled();
    await userEvent.click(screen.getByRole('combobox', { name: /^Source document/ }));
    await userEvent.click(
      await screen.findByRole('option', { name: 'Saltmarsh Holdings sponsor model 2023' }, TIMEOUT),
    );
    type(/^Page/, '12');
    type(/^Sheet and cell/, 'Base case!B14');
    await userEvent.click(button('Review figures'));
    const terms = await screen.findByRole('table', { name: 'Terms as they will be saved' });
    expect(terms).toHaveTextContent(
      'SourceSaltmarsh Holdings sponsor model 2023, page 12, Base case!B14, Sponsor base case model at entry, held in the deal folder',
    );
    expect(terms).toHaveTextContent('Reason for the revisionThe exit multiple was mistyped');
    await userEvent.click(button('Save draft'));
    await within(status()).findByText(/^Draft recorded/);
    expect(writes()[0]?.body).toMatchObject({
      caseDate: '2021-06-30',
      exitMultiple: '10',
      revisionReason: 'The exit multiple was mistyped',
      sourceDocumentId: UW_ID.document,
      sourcePage: 12,
      sourceLocator: 'Base case!B14',
    });
  });

  it("records a loan's case with its yield and loss rate: no exit multiple and no plan to type", async () => {
    const draft = loanCaseFixture({
      state: 'Draft',
      confirmedBy: null,
      confirmedAt: null,
      rowVersion: 1,
    });
    const card = open('entered', readFixture({ form: 'credit', versions: [] }), {
      [`POST ${UW_PATH}`]: { status: 201, body: draft },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Record base case' }));
    const form = await screen.findByRole('form', { name: 'Record the base case' });
    // A loan's form: the expected repayment, the yield and the loss rate; nothing of a plan.
    expect(screen.queryByLabelText(/^Planned exit/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Exit multiple/)).not.toBeInTheDocument();
    expect(within(form).queryByRole('table')).not.toBeInTheDocument();
    noButton('Add a plan date');
    expect(form).not.toHaveTextContent('US$ millions');

    // Asked for the review too early, the form names what a loan lacks, in a loan's words.
    await userEvent.click(button('Review figures'));
    expect(await screen.findByText('Give the expected repayment date.')).toBeInTheDocument();
    expect(screen.getByText(/^Give the underwritten yield in percent/)).toBeInTheDocument();
    expect(screen.queryByTestId('underwriting-plan-faults')).not.toBeInTheDocument();
    expect(writes()).toEqual([]);

    type(/^Case date/, '2021-06-30');
    type(/^Expected repayment/, '2026-06-30');
    type(/^Underwritten yield/, '11.5');
    type(/^Annual loss rate/, '1.5');
    type(/^Underwritten gross MOIC/, '1.5');
    type(/^Underwritten gross IRR/, '10');
    type(/^Where the model is held/, 'Underwriting model of the loan, held in the deal folder');
    await userEvent.click(button('Review figures'));
    const review = await screen.findByTestId('underwriting-review');
    expect(
      within(within(review).getByRole('table', { name: 'Terms as they will be saved' }))
        .getAllByRole('row')
        .map((r) => r.textContent),
    ).toEqual([
      'Case dateJun 30, 2021Expected repaymentJun 30, 2026',
      'Underwritten yield11.5%Annual loss rate1.5%',
      'Underwritten gross MOIC1.5xUnderwritten gross IRR10%',
      'SourceUnderwriting model of the loan, held in the deal folder',
    ]);
    expect(
      within(review).queryByRole('table', { name: 'Plan as it will be saved, in dollars' }),
    ).not.toBeInTheDocument();
    expect(review).toHaveTextContent(
      'Saving records a draft: a second person confirms it before the loan is compared with it.',
    );
    card.now(readFixture({ form: 'credit', versions: [draft], compared: null }));
    await userEvent.click(button('Save draft'));
    await within(status()).findByText(/^Draft recorded/);
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: UW_PATH,
        body: {
          caseDate: '2021-06-30',
          plannedExitDate: '2026-06-30',
          grossMoic: '1.5',
          grossIrr: '0.1',
          underwrittenYield: '0.115',
          annualLossRate: '0.015',
          sourceNote: 'Underwriting model of the loan, held in the deal folder',
        },
        ifMatch: null,
      },
    ]);
    // The Draft of a loan shows a loan's terms, and its author is told who confirms it.
    const block = await screen.findByTestId('deal-underwriting-draft');
    expect(within(block).getByRole('table', { name: 'Draft base case, terms' })).toHaveTextContent(
      'Underwritten yield11.50%Annual loss rate1.50%',
    );
    expect(screen.getByTestId('underwriting-own-figures')).toBeInTheDocument();
  });

  it("revises a loan's Confirmed case from its own rates, and a second person confirms a loan without a plan", async () => {
    const entry = loanCaseFixture();
    const correction = loanCaseFixture({
      id: UW_ID.second,
      version: 2,
      state: 'Draft',
      annualLossRate: '0.02000000',
      revisionReason: 'The loss rate was mistyped',
      confirmedBy: null,
      confirmedAt: null,
      rowVersion: 1,
    });
    const card = open('entered', readFixture({ form: 'credit' }), {
      [`POST ${UW_PATH}`]: { status: 201, body: correction },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Revise' }));
    await screen.findByRole('form', { name: 'Revise the base case' });
    // The form opens on the case's own figures, the rates as the percent a person types.
    expect(screen.getByLabelText(/^Underwritten yield/)).toHaveValue('11.5');
    expect(screen.getByLabelText(/^Annual loss rate/)).toHaveValue('1.5');
    expect(screen.getByLabelText(/^Expected repayment/)).toHaveValue('2026-06-30');
    type(/^Annual loss rate/, '2');
    type(/^Reason for the revision/, 'The loss rate was mistyped');
    await userEvent.click(button('Review figures'));
    await screen.findByTestId('underwriting-review');
    card.now(readFixture({ form: 'credit', versions: [entry, correction] }));
    await userEvent.click(button('Save draft'));
    await within(status()).findByText(/^Draft recorded/);
    expect(writes()[0]?.body).toEqual({
      caseDate: '2021-06-30',
      plannedExitDate: '2026-06-30',
      grossMoic: '1.5',
      grossIrr: '0.1',
      underwrittenYield: '0.115',
      annualLossRate: '0.02',
      revisionReason: 'The loss rate was mistyped',
      sourceNote: 'Underwriting model of the loan at entry, held in the deal folder',
    });
    cleanup();
    vi.restoreAllMocks();

    // A second person confirms the correction: one command, with the version it was opened on.
    open('confirmed', readFixture({ form: 'credit', versions: [entry, correction] }), {
      [`POST ${commands(UW_ID.second)}`]: ok({ ...correction, state: 'Confirmed' }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await within(status()).findByText(/^Correction confirmed/);
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: commands(UW_ID.second),
        body: { command: 'confirm' },
        ifMatch: '"1"',
      },
    ]);
  });
});
