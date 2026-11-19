import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  capitalNoticeControlDetail,
  capitalNoticeDetail,
  capitalNoticePage,
  featureFlagList,
  investmentDetail,
  problemDetails,
  reportPackageCommandBody,
  reportPackageDetail,
  valuationPage,
  valuationRow,
} from '@pb/contracts';
import type { ValuationRow } from '@pb/contracts';
import {
  capitalNoticeMachine,
  forbiddenPairs,
  reportingPackageMachine,
  valuationMachine,
} from '@pb/workflows';
import type { ReportingPackageCommand, ReportingPackageState } from '@pb/workflows';
import { lockHashOf } from './routes/valuations.js';
import { createPreviewFetch } from './shim.js';
import { createPreviewState } from './state.js';
import type { PreviewState, SimReportPackage } from './state.js';
import { AS_OF, IDS, USERS, buildWorld, personOf, problemOf, send } from './test-fixtures.js';
import type { Answer } from './test-fixtures.js';

const never: typeof fetch = () => Promise.reject(new Error('no network in the preview'));

const command = (kind: 'valuations' | 'capital-notices', id: string): string =>
  `/api/v1/${kind}/${id}/commands`;

let ids = 0;
const env = {
  newId: (): string => `50000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  now: (): string => '2025-07-01T09:00:00.000Z',
};

function setup(options: Parameters<typeof buildWorld>[0] = {}): {
  f: typeof fetch;
  state: PreviewState;
} {
  const state = createPreviewState();
  const { fixtures } = buildWorld(options);
  return { f: createPreviewFetch(fixtures, never, { env, state }), state };
}

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('valuation commands follow docs/18 section 1 through the transition table', () => {
  it('refuses every forbidden (state, command) pair with 409, even for a user holding every role', async () => {
    const { f } = setup();
    const pairs = forbiddenPairs(valuationMachine);
    expect(pairs.length).toBeGreaterThan(0);
    for (const { from, command: cmd } of pairs) {
      const answer = await send(
        f,
        USERS.all.externalId,
        'POST',
        command('valuations', IDS.valuation[from]),
        {
          command: cmd,
          reason: 'testing the table',
        },
      );
      expect(answer.status, `${cmd} from ${from}`).toBe(409);
      expect(problemOf(answer)).toEqual({
        code: 'workflow-transition',
        detail: `valuation: ${cmd} is not allowed from ${from}`,
      });
      expect(answer.headers.get('x-pb-simulated')).toBe('true');
    }
  });

  it('refuses a viewer on every allowed row with 403', async () => {
    const { f } = setup();
    for (const t of valuationMachine.transitions) {
      const answer = await send(
        f,
        USERS.viewer.externalId,
        'POST',
        command('valuations', IDS.valuation[t.from]),
        {
          command: t.command,
          reason: 'testing the table',
        },
      );
      expect(answer.status, `${t.command} from ${t.from}`).toBe(403);
      expect(problemOf(answer).code).toBe('forbidden');
    }
  });

  it('requires a reason to send back and to reopen (422)', async () => {
    const { f } = setup();
    const sendBack = await send(
      f,
      USERS.deal.externalId,
      'POST',
      command('valuations', IDS.valuation.OpsPrepared),
      {
        command: 'sendBack',
      },
    );
    expect(sendBack.status).toBe(422);
    expect(problemOf(sendBack)).toEqual({
      code: 'workflow-precondition',
      detail: 'valuation: a reason is required',
    });
    const reopen = await send(
      f,
      USERS.head.externalId,
      'POST',
      command('valuations', IDS.valuation.Locked),
      {
        command: 'reopen',
      },
    );
    expect(reopen.status).toBe(422);
    expect(problemOf(reopen).detail).toBe('valuation: a reason is required');
  });

  it('keeps segregation of duties on user ids: the preparer cannot approve their own valuation', async () => {
    const { f } = setup();
    const created = await send(f, USERS.all.externalId, 'POST', '/api/v1/valuations', {
      investmentId: IDS.open,
      periodEnd: '2025-06-30',
      method: 'valuation_method.sponsor_mark',
      fairValue: '1200.00',
    });
    const id = valuationRow.parse(created.json).id;
    expect(
      (
        await send(f, USERS.all.externalId, 'POST', command('valuations', id), {
          command: 'prepare',
        })
      ).status,
    ).toBe(200);
    const own = await send(f, USERS.all.externalId, 'POST', command('valuations', id), {
      command: 'dealTeamApprove',
    });
    expect(own.status).toBe(422);
    expect(problemOf(own).detail).toBe(
      'valuation: the preparer cannot approve their own valuation (SEC-5.6)',
    );
  });

  it('maps recorded display names back to user ids, so a recorded preparer is refused too', async () => {
    const { f } = setup();
    const own = await send(
      f,
      USERS.all.externalId,
      'POST',
      command('valuations', IDS.valuation.OpsPrepared),
      {
        command: 'dealTeamApprove',
      },
    );
    expect(own.status).toBe(422);
    expect(problemOf(own).detail).toBe(
      'valuation: the preparer cannot approve their own valuation (SEC-5.6)',
    );
    const ownLock = await send(
      f,
      USERS.all.externalId,
      'POST',
      command('valuations', IDS.valuation.DealTeamApproved),
      {
        command: 'lock',
      },
    );
    expect(ownLock.status).toBe(422);

    const ok = await send(
      f,
      USERS.deal.externalId,
      'POST',
      command('valuations', IDS.valuation.OpsPrepared),
      {
        command: 'dealTeamApprove',
      },
    );
    expect(ok.status).toBe(200);
    expect(valuationRow.parse(ok.json).dealTeamApprovedBy).toBe(USERS.deal.displayName);
    const locked = await send(
      f,
      USERS.head.externalId,
      'POST',
      command('valuations', IDS.valuation.DealTeamApproved),
      {
        command: 'lock',
      },
    );
    expect(locked.status).toBe(200);
    expect(valuationRow.parse(locked.json)).toMatchObject({
      state: 'Locked',
      approvedBy: USERS.head.displayName,
      approvedAt: `${AS_OF}T12:00:00Z`,
      rowVersion: 2,
    });
  });
});

describe('capital notice commands follow docs/18 section 3 through the transition table', () => {
  it('refuses every forbidden (state, command) pair with 409, even for a user holding every role', async () => {
    const { f } = setup();
    for (const { from, command: cmd } of forbiddenPairs(capitalNoticeMachine)) {
      const answer = await send(
        f,
        USERS.all.externalId,
        'POST',
        command('capital-notices', IDS.notice[from]),
        {
          command: cmd,
        },
      );
      expect(answer.status, `${cmd} from ${from}`).toBe(409);
      expect(problemOf(answer)).toEqual({
        code: 'workflow-transition',
        detail: `capital_notice: ${cmd} is not allowed from ${from}`,
      });
    }
  });

  it('refuses a viewer on every allowed row with 403', async () => {
    const { f } = setup();
    for (const t of capitalNoticeMachine.transitions) {
      const answer = await send(
        f,
        USERS.viewer.externalId,
        'POST',
        command('capital-notices', IDS.notice[t.from]),
        {
          command: t.command,
        },
      );
      expect(answer.status, `${t.command} from ${t.from}`).toBe(403);
      expect(problemOf(answer).code).toBe('forbidden');
    }
  });

  it('judges ticket approval on the simulated ticket and register: dual control (SEC-12.3) and the hold on a changed instruction', async () => {
    const { f, state } = setup();
    const id = IDS.notice.wireChange;
    const review = await send(f, USERS.ops.externalId, 'POST', command('capital-notices', id), {
      command: 'review',
    });
    expect(review.status).toBe(200);
    expect(capitalNoticeControlDetail.parse(review.json)).toMatchObject({
      state: 'Reviewed',
      rowVersion: 2,
      ticket: { id: IDS.ticket.drafted, state: 'Drafted' },
    });
    const draft = await send(f, USERS.ops.externalId, 'POST', command('capital-notices', id), {
      command: 'draftTicket',
    });
    // The notice already carries a ticket: it is re-drafted, never given a second one.
    expect(capitalNoticeControlDetail.parse(draft.json)).toMatchObject({
      state: 'TicketDrafted',
      ticket: { id: IDS.ticket.drafted, state: 'Drafted', preparedBy: { id: USERS.ops.userId } },
    });

    const byDrafter = await send(f, USERS.ops.externalId, 'POST', command('capital-notices', id), {
      command: 'approveTicket',
    });
    expect(byDrafter.status).toBe(422);
    expect(problemOf(byDrafter).detail).toBe(
      'capital_notice: the ticket preparer cannot approve it (SEC-12.3)',
    );
    // Anyone else is held by the Proposed version of the fund until a second person's callback.
    for (const other of [USERS.ops2, USERS.head]) {
      const answer = await send(f, other.externalId, 'POST', command('capital-notices', id), {
        command: 'approveTicket',
      });
      expect(answer.status).toBe(422);
      expect(problemOf(answer).detail).toBe(
        'capital_notice: the wire instruction changed recently and needs a second approval (SEC-12.3)',
      );
    }
    const funding = await send(f, USERS.ops.externalId, 'POST', command('capital-notices', id), {
      command: 'confirmFunding',
    });
    expect(funding.status).toBe(409);

    // Reads show the new state to every role that can open the notice.
    const detail = capitalNoticeDetail.parse(
      (await send(f, USERS.viewer.externalId, 'GET', `/api/v1/capital-notices/${id}`)).json,
    );
    expect(detail).toMatchObject({ state: 'TicketDrafted', rowVersion: 3 });
    const page = capitalNoticePage.parse(
      (await send(f, USERS.viewer.externalId, 'GET', '/api/v1/capital-notices?limit=200')).json,
    );
    expect(page.items.find((r) => r.id === id)?.state).toBe('TicketDrafted');
    expect(page.attention.find((r) => r.id === id)?.state).toBe('TicketDrafted');
    expect(state.audit.map((e) => e.action)).toEqual([
      'capital_notice.review',
      'capital_notice.draftTicket',
    ]);
  });

  it('answers 404 for a notice the credential cannot open, without saying it exists', async () => {
    const { f } = setup();
    const hidden = await send(
      f,
      USERS.ops.externalId,
      'POST',
      command('capital-notices', IDS.notice.walled),
      {
        command: 'review',
      },
    );
    expect(hidden.status).toBe(404);
    expect(problemOf(hidden).detail).toBe('Capital notice not found');
    const unknown = await send(
      f,
      USERS.ops.externalId,
      'POST',
      command('capital-notices', IDS.open),
      {
        command: 'review',
      },
    );
    expect(unknown.text).toBe(hidden.text.replace(IDS.notice.walled, IDS.open));
  });
});

/** A package of the session in the state given, prepared by operations' colleague so nobody here is its preparer. */
const packageIn = (state: ReportingPackageState, n: number): SimReportPackage => ({
  id: `5b000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  client: { id: IDS.client, name: 'Test Client One' },
  periodEnd: '2025-03-31',
  asOf: AS_OF,
  basis: 'gross',
  label: 'preliminary',
  version: 1,
  state,
  preparedBy: personOf(USERS.ops2),
  reviewer: null,
  approvedAt: null,
  releasedAt: null,
  rowVersion: 4,
  correctionReason: null,
  contentHash: null,
  releasedBy: null,
  content: null,
  findings: [],
  tieOutExplanations: {},
  changeLog: [],
});

/** The commands the contract lets a person send; qaPass and qaFail are the system's own. */
const PERSON_COMMANDS = reportPackageCommandBody.options.map((o) => o.shape.command.value);

describe('reporting package commands follow docs/18 section 5 through the transition table', () => {
  /** A session holding one package in every state of the machine, Generated included though no package rests there. */
  function seeded(): {
    f: typeof fetch;
    state: PreviewState;
    idOf: (s: ReportingPackageState) => string;
  } {
    const { f, state } = setup();
    const byState = new Map<ReportingPackageState, string>();
    reportingPackageMachine.states.forEach((s, i) => {
      const sim = packageIn(s, i + 1);
      state.reportPackages.set(sim.id, sim);
      byState.set(s, sim.id);
    });
    return { f, state, idOf: (s) => byState.get(s) ?? '' };
  }
  const path = (id: string): string => `/api/v1/report-packages/${id}/commands`;
  const bodyOf = (cmd: ReportingPackageCommand): Record<string, unknown> =>
    cmd === 'overrideQa' ? { command: cmd, reason: 'testing the table' } : { command: cmd };

  it('lets a person send the six commands of the contract, and never the QA outcome', async () => {
    expect([...PERSON_COMMANDS].sort()).toEqual(
      ['approve', 'generate', 'overrideQa', 'regenerate', 'release', 'submit'].sort(),
    );
    const { f, state, idOf } = seeded();
    // qaPass and qaFail are rows of the table for the service alone: at the boundary a person,
    // whatever roles they hold, is refused before the machine is asked, from every state.
    for (const from of reportingPackageMachine.states) {
      for (const cmd of ['qaPass', 'qaFail']) {
        const answer = await send(f, USERS.all.externalId, 'POST', path(idOf(from)), {
          command: cmd,
        });
        expect(answer.status, `${cmd} from ${from}`).toBe(400);
        expect(problemOf(answer).code).toBe('validation');
      }
      expect(state.reportPackages.get(idOf(from))).toMatchObject({ state: from, rowVersion: 4 });
    }
  });

  it('refuses every forbidden (state, command) pair with 409, even for a user holding every role', async () => {
    const { f, state, idOf } = seeded();
    const pairs = forbiddenPairs(reportingPackageMachine).filter((p) =>
      (PERSON_COMMANDS as readonly string[]).includes(p.command),
    );
    // Six states a package rests in and Generated, six commands, eight rows a person can ask for.
    expect(pairs).toHaveLength(7 * 6 - 6);
    for (const { from, command: cmd } of pairs) {
      const answer = await send(f, USERS.all.externalId, 'POST', path(idOf(from)), bodyOf(cmd));
      expect(answer.status, `${cmd} from ${from}`).toBe(409);
      expect(problemOf(answer)).toEqual({
        code: 'workflow-transition',
        detail: `reporting_package: ${cmd} is not allowed from ${from}`,
      });
      expect(answer.headers.get('x-pb-simulated')).toBe('true');
      // A refused command changes nothing.
      expect(state.reportPackages.get(idOf(from))).toMatchObject({ state: from, rowVersion: 4 });
    }
    // There is no way back: nothing leads from QA passed, In review, Approved or Released to an earlier state.
    const order: ReportingPackageState[] = ['QAPassed', 'InReview', 'Approved', 'Released'];
    for (const t of reportingPackageMachine.transitions)
      if (order.includes(t.from))
        expect(order.indexOf(t.to), `${t.command} from ${t.from}`).toBeGreaterThan(
          order.indexOf(t.from),
        );
  });

  it('refuses a role the row does not name with 403, on every row a person can ask for', async () => {
    const { f, state, idOf } = seeded();
    const rows = reportingPackageMachine.transitions.filter((t) =>
      (PERSON_COMMANDS as readonly string[]).includes(t.command),
    );
    expect(rows).toHaveLength(6);
    let refused = 0;
    for (const t of rows) {
      for (const user of [USERS.ops, USERS.head, USERS.deal, USERS.viewer, USERS.admin]) {
        if (t.roles.some((r) => user.roles.includes(r))) continue;
        const answer = await send(
          f,
          user.externalId,
          'POST',
          path(idOf(t.from)),
          bodyOf(t.command),
        );
        expect(answer.status, `${t.command} from ${t.from} as ${user.externalId}`).toBe(403);
        expect(problemOf(answer).code).toBe('forbidden');
        refused += 1;
      }
      expect(state.reportPackages.get(idOf(t.from))).toMatchObject({ state: t.from });
    }
    // Operations and the approver each hold one of the route's roles, so the machine refuses them.
    expect(refused).toBeGreaterThan(rows.length * 3);
    const machine = await send(f, USERS.ops.externalId, 'POST', path(idOf('InReview')), {
      command: 'approve',
    });
    expect(problemOf(machine).detail).toBe(
      'reporting_package: approve from InReview requires one of: approver',
    );
  });

  it('requires a reason to override a failed QA, and the row then moves', async () => {
    const { f, idOf } = seeded();
    // The contract asks for the reason first: without one the body is refused at the boundary.
    for (const body of [{ command: 'overrideQa' }, { command: 'overrideQa', reason: '  ' }])
      expect(
        (await send(f, USERS.head.externalId, 'POST', path(idOf('QAFailed')), body)).status,
      ).toBe(400);
    const moved = await send(f, USERS.head.externalId, 'POST', path(idOf('QAFailed')), {
      command: 'overrideQa',
      reason: 'testing the table',
    });
    expect(reportPackageDetail.parse(moved.json)).toMatchObject({
      state: 'QAPassed',
      rowVersion: 5,
    });
    expect(moved.headers.get('etag')).toBe('"5"');
  });
});

const createBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  investmentId: IDS.open,
  periodEnd: '2025-06-30',
  method: 'valuation_method.sponsor_mark',
  fairValue: '1200.00',
  ...overrides,
});

describe('creating a Draft valuation', () => {
  it('creates version 1 in Draft with the prior quarter mark and the change against it', async () => {
    const { f, state } = setup();
    const answer = await send(f, USERS.ops.externalId, 'POST', '/api/v1/valuations', createBody());
    expect(answer.status).toBe(201);
    expect(answer.headers.get('x-pb-simulated')).toBe('true');
    expect(answer.headers.get('etag')).toBe('"1"');
    const row = valuationRow.parse(answer.json);
    expect(row).toMatchObject({
      investmentId: IDS.open,
      investmentNumber: 'INV-0001',
      periodEnd: '2025-06-30',
      version: 1,
      state: 'Draft',
      fairValue: '1200.00',
      // The recorded Locked mark of 2025-03-31, and (1200 - 1000) / 1000 by the @pb/calc rule.
      priorFairValue: '1000.00',
      changePct: '0.2',
      preparedBy: null,
      rowVersion: 1,
    });
    expect(state.audit).toEqual([
      expect.objectContaining({
        action: 'valuation.create',
        actorId: USERS.ops.userId,
        to: 'Draft',
      }),
    ]);
    // A new version comes only from a reopen (docs/18 section 1): never a parallel chain.
    const again = await send(f, USERS.ops.externalId, 'POST', '/api/v1/valuations', createBody());
    expect(again.status).toBe(422);
  });

  it('files a draft dated a few days early under its quarter, as the API does', async () => {
    const { f } = setup();
    const early = valuationRow.parse(
      (
        await send(
          f,
          USERS.ops.externalId,
          'POST',
          '/api/v1/valuations',
          createBody({ periodEnd: '2025-06-27' }),
        )
      ).json,
    );
    // Within the configured tolerance of 2025-06-30, so it reports for that quarter, and its
    // prior is still the 2025-03-31 Locked mark (packages/calc lockedNear).
    expect([early.periodEnd, early.quarterEnd]).toEqual(['2025-06-27', '2025-06-30']);
    expect([early.priorFairValue, early.changePct]).toEqual(['1000.00', '0.2']);
    const board = valuationPage.parse(
      (await send(f, USERS.ops.externalId, 'GET', '/api/v1/valuations?limit=200')).json,
    );
    expect(board.periods).toContain('2025-06-30');
    expect(board.periods).not.toContain('2025-06-27');
  });

  it('measures the change against the recorded prior mark, and leaves it null without one', async () => {
    const { f } = setup();
    const fall = valuationRow.parse(
      (
        await send(
          f,
          USERS.ops.externalId,
          'POST',
          '/api/v1/valuations',
          createBody({ fairValue: '850.50' }),
        )
      ).json,
    );
    // (850.50 - 1000.00) / 1000.00, rendered the way the API renders it.
    expect([fall.priorFairValue, fall.changePct]).toEqual(['1000.00', '-0.1495']);
    // The board shows the simulated draft with the same figures.
    const board = valuationPage.parse(
      (await send(f, USERS.ops.externalId, 'GET', '/api/v1/valuations?limit=200')).json,
    );
    expect(board.items.find((r) => r.id === fall.id)?.changePct).toBe('-0.1495');
    // No Locked mark is recorded for 2025-06-30, so a 2025-09-30 draft has nothing to compare to.
    const first = valuationRow.parse(
      (
        await send(
          f,
          USERS.ops.externalId,
          'POST',
          '/api/v1/valuations',
          createBody({ periodEnd: '2025-09-30' }),
        )
      ).json,
    );
    expect([first.priorFairValue, first.changePct]).toEqual([null, null]);
  });

  it('applies the guard, visibility, activity and lock rules', async () => {
    const { f } = setup();
    expect(
      (await send(f, USERS.deal.externalId, 'POST', '/api/v1/valuations', createBody())).status,
    ).toBe(403);
    const walled = await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      createBody({ investmentId: IDS.walled }),
    );
    expect(walled.status).toBe(404);
    expect(problemOf(walled).detail).toBe('Investment not found');
    expect(
      (
        await send(
          f,
          USERS.all.externalId,
          'POST',
          '/api/v1/valuations',
          createBody({ investmentId: IDS.walled }),
        )
      ).status,
    ).toBe(201);
    // A position no longer held is not found, as the API answers it: no hint that it exists.
    const realized = await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      createBody({ investmentId: IDS.realized }),
    );
    expect(realized.status).toBe(404);
    expect(problemOf(realized).detail).toBe('Investment not found');
    const locked = await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      createBody({ investmentId: IDS.lockedPeriod }),
    );
    expect(locked.status).toBe(422);
    expect(problemOf(locked).code).toBe('workflow-precondition');
  });

  it('keeps one version chain per quarter and never values a quarter before entry', async () => {
    const { f } = setup();
    const create = (overrides: Record<string, unknown>) =>
      send(f, USERS.ops.externalId, 'POST', '/api/v1/valuations', createBody(overrides));
    // A period a few days after the quarter end reports for the quarter a Locked version closes.
    const late = await create({ investmentId: IDS.lockedPeriod, periodEnd: '2025-07-03' });
    expect(late.status).toBe(422);
    expect(problemOf(late).detail).toBe(
      'valuation: a Locked version exists for this investment and quarter; reopen it to start a new version',
    );
    // Beside a Draft in progress for the quarter, a second chain dated a few days early is refused.
    expect((await create({})).status).toBe(201);
    const second = await create({ periodEnd: '2025-06-27' });
    expect(second.status).toBe(422);
    expect(problemOf(second).detail).toBe(
      'valuation: a version for this investment and quarter is already in progress; continue that version',
    );
    const early = await create({ periodEnd: '2022-12-31' });
    expect(early.status).toBe(422);
    expect(problemOf(early)).toEqual({
      code: 'workflow-precondition',
      detail: 'valuation: the investment was not yet held at this period end',
    });
    // Not a quarter end and not within the tolerance of one.
    const offQuarter = await create({ periodEnd: '2025-05-15' });
    expect(offQuarter.status).toBe(422);
    expect(problemOf(offQuarter).detail).toMatch(/quarter end/);
  });

  it('rejects an invalid body with paths only, never echoing what was sent', async () => {
    const { f, state } = setup();
    const answer = await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      createBody({ fairValue: 'about-SECRET-41', note: 'SECRET-NOTE-77' }),
    );
    expect(answer.status).toBe(400);
    const p = problemDetails.parse(answer.json);
    expect(p.type).toBe('https://portfolio-beach.example/problems/validation');
    expect(p.errors?.map((e) => e.path).sort()).toEqual(['(root)', 'fairValue']);
    expect(answer.text).not.toContain('about-SECRET-41');
    expect(answer.text).not.toContain('SECRET-NOTE-77');
    const notJson = await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      '{"investmentId":',
    );
    expect(notJson.status).toBe(400);
    const badCommand = await send(
      f,
      USERS.ops.externalId,
      'POST',
      command('valuations', IDS.valuation.Draft),
      {
        command: 'approveEverything',
      },
    );
    expect(badCommand.status).toBe(400);
    expect(problemDetails.parse(badCommand.json).errors?.[0]?.path).toBe('command');
    expect(state.audit).toHaveLength(0);
  });
});

describe('the valuation journey across roles', () => {
  it('ops prepares, deal team approves, the approver locks, and a reopen starts version 2 in Draft', async () => {
    const { f, state } = setup();
    const created = valuationRow.parse(
      (await send(f, USERS.ops.externalId, 'POST', '/api/v1/valuations', createBody())).json,
    );
    const run = (credential: string, body: unknown): Promise<Answer> =>
      send(f, credential, 'POST', command('valuations', created.id), body);

    const prepared = await run(USERS.ops.externalId, { command: 'prepare' });
    expect(prepared.status).toBe(200);
    const preparedRow = valuationRow.parse(prepared.json);
    expect(preparedRow).toMatchObject({
      state: 'OpsPrepared',
      preparedBy: USERS.ops.displayName,
      rowVersion: 2,
    });
    // The hash is taken at the lock, over what the version holds then; none before, as the API.
    expect(preparedRow.lockHash).toBeNull();

    expect((await run(USERS.ops.externalId, { command: 'dealTeamApprove' })).status).toBe(403);
    expect((await run(USERS.head.externalId, { command: 'lock' })).status).toBe(409);
    expect(
      valuationRow.parse((await run(USERS.deal.externalId, { command: 'dealTeamApprove' })).json)
        .state,
    ).toBe('DealTeamApproved');
    const locked = valuationRow.parse((await run(USERS.head.externalId, { command: 'lock' })).json);
    expect(locked).toMatchObject({
      state: 'Locked',
      approvedBy: USERS.head.displayName,
      approvedAt: '2025-06-30T12:00:00Z',
      dealTeamApprovedBy: USERS.deal.displayName,
      rowVersion: 4,
    });
    expect(locked.lockHash).toBe(await lockHashOf({ ...locked, inputs: {} }));
    expect(locked.lockHash).toMatch(/^[0-9a-f]{64}$/);

    // A viewer now reads the Locked row in the list and the one-pager; recorded figures stay as recorded.
    const list = valuationPage.parse(
      (await send(f, USERS.viewer.externalId, 'GET', '/api/v1/valuations?limit=200')).json,
    );
    expect(list.items[0]).toEqual(locked);
    expect(list.periods[0]).toBe('2025-06-30');
    const detail = investmentDetail.parse(
      (await send(f, USERS.viewer.externalId, 'GET', `/api/v1/investments/${IDS.open}`)).json,
    );
    expect(detail.valuations.at(-1)).toEqual({
      periodEnd: '2025-06-30',
      version: 1,
      state: 'Locked',
      fairValue: '1200.00',
      method: 'valuation_method.sponsor_mark',
    });
    expect(detail.nav).toBe('1100.00');

    const reopened = await run(USERS.head.externalId, {
      command: 'reopen',
      reason: 'sponsor restated the mark',
    });
    expect(reopened.status).toBe(200);
    // The answer is the next version, a Draft with the same inputs, as the API answers it.
    const draft = valuationRow.parse(reopened.json);
    expect(draft).toMatchObject({
      state: 'Draft',
      version: 2,
      fairValue: locked.fairValue,
      method: locked.method,
      preparedBy: null,
      lockHash: null,
      rowVersion: 1,
    });
    expect(draft.id).not.toBe(created.id);
    const versions = valuationPage
      .parse(
        (
          await send(
            f,
            USERS.ops.externalId,
            'GET',
            `/api/v1/valuations?investmentId=${IDS.open}&limit=200`,
          )
        ).json,
      )
      .items.filter((r) => r.periodEnd === '2025-06-30')
      .map((r) => [r.version, r.state]);
    expect(versions).toEqual(
      expect.arrayContaining([
        [1, 'Reopened'],
        [2, 'Draft'],
      ]),
    );
    expect(state.audit.map((e) => `${e.actorExternalId}:${e.action}`)).toEqual([
      'ops.one:valuation.create',
      'ops.one:valuation.prepare',
      'deal.one:valuation.dealTeamApprove',
      'head.one:valuation.lock',
      'head.one:valuation.reopen',
      'head.one:valuation.create',
    ]);
  });

  it('refuses a fair value that is not above zero and a method outside the taxonomy at the boundary (400), as the API does', async () => {
    const { f } = setup();
    for (const fairValue of ['0', '0.00', '-5.00']) {
      const answer = await send(
        f,
        USERS.ops.externalId,
        'POST',
        '/api/v1/valuations',
        createBody({ fairValue }),
      );
      expect(answer.status).toBe(400);
      expect(problemDetails.parse(answer.json).errors?.map((e) => e.path)).toEqual(['fairValue']);
    }
    const method = await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      createBody({ method: 'sponsor_mark' }),
    );
    expect(method.status).toBe(400);
    expect(problemDetails.parse(method.json).errors?.map((e) => e.path)).toEqual(['method']);
  });
});

describe('one Locked version per investment and quarter', () => {
  it('refuses to lock a version while another version of the quarter is Locked (409)', async () => {
    const { f } = setup({ twoChains: true });
    const answer = await send(
      f,
      USERS.head.externalId,
      'POST',
      command('valuations', IDS.valuation.twoChainsApproved),
      { command: 'lock' },
    );
    expect(answer.status).toBe(409);
    expect(problemOf(answer)).toEqual({
      code: 'conflict',
      detail:
        'valuation: another version is Locked for this investment and quarter; reopen it before locking this one',
    });
    // Nothing changed: the version still awaits its lock at the recorded row version.
    const list = valuationPage.parse(
      (await send(f, USERS.viewer.externalId, 'GET', '/api/v1/valuations?limit=200')).json,
    );
    expect(list.items.find((r) => r.id === IDS.valuation.twoChainsApproved)).toMatchObject({
      state: 'DealTeamApproved',
      rowVersion: 1,
    });
  });

  it('leaves a Locked version untouched when the reopen cannot start its draft', async () => {
    const state = createPreviewState();
    const { fixtures } = buildWorld();
    const broken = {
      ...env,
      newId: (): string => {
        throw new Error('no ids in this test');
      },
    };
    const f = createPreviewFetch(fixtures, never, { env: broken, state });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const answer = await send(
        f,
        USERS.head.externalId,
        'POST',
        command('valuations', IDS.valuation.Locked),
        { command: 'reopen', reason: 'restated by the sponsor' },
      );
      expect(answer.status).toBe(500);
    } finally {
      quiet.mockRestore();
    }
    const list = valuationPage.parse(
      (await send(f, USERS.viewer.externalId, 'GET', '/api/v1/valuations?limit=200')).json,
    );
    expect(list.items.find((r) => r.id === IDS.valuation.Locked)).toMatchObject({
      state: 'Locked',
      rowVersion: 1,
    });
    expect(
      list.items.filter((r) => r.investmentId === IDS.states && r.periodEnd === '2024-12-31'),
    ).toHaveLength(1);
  });
});

describe('reads keep walls per credential', () => {
  it('shows a simulated row on the walled investment only to wall members', async () => {
    const { f } = setup();
    const created = valuationRow.parse(
      (
        await send(
          f,
          USERS.all.externalId,
          'POST',
          '/api/v1/valuations',
          createBody({ investmentId: IDS.walled }),
        )
      ).json,
    );
    const listFor = async (credential: string): Promise<ValuationRow[]> =>
      valuationPage.parse((await send(f, credential, 'GET', '/api/v1/valuations?limit=200')).json)
        .items;
    expect(
      (await listFor(USERS.viewer.externalId)).some((r) => r.investmentId === IDS.walled),
    ).toBe(false);
    expect((await listFor(USERS.ops.externalId)).some((r) => r.id === created.id)).toBe(false);
    expect((await listFor(USERS.dealWall.externalId)).some((r) => r.id === created.id)).toBe(true);
    expect(
      (await send(f, USERS.viewer.externalId, 'GET', `/api/v1/investments/${IDS.walled}`)).status,
    ).toBe(404);
    const memberDetail = investmentDetail.parse(
      (await send(f, USERS.dealWall.externalId, 'GET', `/api/v1/investments/${IDS.walled}`)).json,
    );
    expect(memberDetail.valuations.some((v) => v.periodEnd === '2025-06-30')).toBe(true);
    // Commands on it are a 404 for anyone outside the wall.
    const outside = await send(f, USERS.ops.externalId, 'POST', command('valuations', created.id), {
      command: 'prepare',
    });
    expect(outside.status).toBe(404);
    expect(problemOf(outside).detail).toBe('Valuation not found');
  });

  it('keeps an investment-filtered list to that investment', async () => {
    const { f } = setup();
    await send(f, USERS.ops.externalId, 'POST', '/api/v1/valuations', createBody());
    await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      createBody({ investmentId: IDS.states, periodEnd: '2025-06-30' }),
    );
    const items = valuationPage.parse(
      (
        await send(
          f,
          USERS.ops.externalId,
          'GET',
          `/api/v1/valuations?investmentId=${IDS.open}&limit=200`,
        )
      ).json,
    ).items;
    expect(new Set(items.map((r) => r.investmentId))).toEqual(new Set([IDS.open]));
  });
});

describe('idempotency and optimistic concurrency (docs/17 section 3)', () => {
  it('replays the stored answer for a repeated Idempotency-Key and refuses the key with another body', async () => {
    const { f, state } = setup();
    const key = { 'idempotency-key': 'create-1' };
    const first = await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      createBody(),
      key,
    );
    const second = await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      createBody(),
      key,
    );
    expect(second.status).toBe(201);
    expect(second.text).toBe(first.text);
    expect(state.audit).toHaveLength(1);
    const reused = await send(
      f,
      USERS.ops.externalId,
      'POST',
      '/api/v1/valuations',
      createBody({ fairValue: '9.00' }),
      key,
    );
    expect(reused.status).toBe(422);
    expect(problemOf(reused).code).toBe('idempotency-key-reuse');

    const id = valuationRow.parse(first.json).id;
    const prepareKey = { 'idempotency-key': 'prepare-1' };
    const prepared = await send(
      f,
      USERS.ops.externalId,
      'POST',
      command('valuations', id),
      { command: 'prepare' },
      prepareKey,
    );
    const replayed = await send(
      f,
      USERS.ops.externalId,
      'POST',
      command('valuations', id),
      { command: 'prepare' },
      prepareKey,
    );
    expect(replayed.status).toBe(200);
    expect(replayed.text).toBe(prepared.text);
    // Without the key the same command is evaluated again, and the table refuses it.
    expect(
      (
        await send(f, USERS.ops.externalId, 'POST', command('valuations', id), {
          command: 'prepare',
        })
      ).status,
    ).toBe(409);
  });

  it('answers 412 when If-Match names another row version and proceeds when it matches', async () => {
    const { f } = setup();
    const id = IDS.valuation.Draft;
    const stale = await send(
      f,
      USERS.ops.externalId,
      'POST',
      command('valuations', id),
      { command: 'prepare' },
      { 'if-match': '"2"' },
    );
    expect(stale.status).toBe(412);
    expect(problemOf(stale).code).toBe('stale-row-version');
    const fresh = await send(
      f,
      USERS.ops.externalId,
      'POST',
      command('valuations', id),
      { command: 'prepare' },
      { 'if-match': 'W/"1"' },
    );
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('etag')).toBe('"2"');
    const noticeStale = await send(
      f,
      USERS.ops.externalId,
      'POST',
      command('capital-notices', IDS.notice.Extracted),
      { command: 'review' },
      { 'if-match': '"7"' },
    );
    expect(noticeStale.status).toBe(412);
  });
});

describe('reset', () => {
  it('forgets every simulated change and seeds again from the recordings', async () => {
    const { f, state } = setup();
    await send(f, USERS.admin.externalId, 'PATCH', '/api/v1/flags/ai.extraction', {
      enabled: true,
      reason: 'demo',
    });
    const created = valuationRow.parse(
      (await send(f, USERS.ops.externalId, 'POST', '/api/v1/valuations', createBody())).json,
    );
    await send(f, USERS.ops.externalId, 'POST', command('capital-notices', IDS.notice.Extracted), {
      command: 'review',
    });

    const reset = await send(f, USERS.viewer.externalId, 'POST', '/api/v1/preview/reset');
    expect(reset.status).toBe(200);
    expect(reset.json).toEqual({ reset: true });
    expect(reset.headers.get('x-pb-simulated')).toBe('true');
    expect(state.audit).toHaveLength(0);

    const flags = featureFlagList.parse(
      (await send(f, USERS.admin.externalId, 'GET', '/api/v1/flags')).json,
    );
    expect(flags.flags[0]?.enabled).toBe(false);
    const list = valuationPage.parse(
      (await send(f, USERS.ops.externalId, 'GET', '/api/v1/valuations?limit=200')).json,
    );
    expect(list.items.some((r) => r.id === created.id)).toBe(false);
    const notice = capitalNoticeDetail.parse(
      (
        await send(
          f,
          USERS.ops.externalId,
          'GET',
          `/api/v1/capital-notices/${IDS.notice.Extracted}`,
        )
      ).json,
    );
    expect(notice).toMatchObject({ state: 'Extracted', rowVersion: 1 });
    expect(
      (
        await send(f, USERS.ops.externalId, 'POST', command('valuations', created.id), {
          command: 'prepare',
        })
      ).status,
    ).toBe(404);
  });
});

describe('while the workflow reads are recorded as 501', () => {
  it('starts with no seeded records, still creates from the investment detail, and replays the 501s', async () => {
    const { f } = setup({ workflowEndpoints: 'not-implemented' });
    expect(
      (
        await send(f, USERS.ops.externalId, 'POST', command('valuations', IDS.valuation.Draft), {
          command: 'prepare',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await send(
          f,
          USERS.ops.externalId,
          'POST',
          command('capital-notices', IDS.notice.Extracted),
          { command: 'review' },
        )
      ).status,
    ).toBe(404);
    const created = await send(f, USERS.ops.externalId, 'POST', '/api/v1/valuations', createBody());
    expect(created.status).toBe(201);
    const list = await send(f, USERS.ops.externalId, 'GET', '/api/v1/valuations?limit=200');
    expect(list.status).toBe(501);
    const detail = investmentDetail.parse(
      (await send(f, USERS.ops.externalId, 'GET', `/api/v1/investments/${IDS.open}`)).json,
    );
    expect(detail.valuations.some((v) => v.periodEnd === '2025-06-30' && v.state === 'Draft')).toBe(
      true,
    );
    expect(window.__pbPreviewMisses).toEqual([]);
  });
});
