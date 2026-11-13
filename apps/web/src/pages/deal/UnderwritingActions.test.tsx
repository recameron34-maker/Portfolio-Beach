import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProblemDetails, UnderwritingRead } from '@pb/contracts';
import { failing, ok } from '../../test/api-mock.js';
import type { MockResponse } from '../../test/api-mock.js';
import { rolePrincipal } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { documentFixture } from '../documents/fixtures.js';
import { UnderwritingCard } from './UnderwritingCard.js';
import {
  caseFixture,
  draftFixture,
  readFixture,
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
): { now: (next: UnderwritingRead) => void } {
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
  renderWithQuery(<UnderwritingCard id={UW_INVESTMENT} company="Saltmarsh Holdings" />);
  return {
    now: (next) => {
      current = next;
    },
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
});
