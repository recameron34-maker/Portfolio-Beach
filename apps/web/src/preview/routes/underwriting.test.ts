import { beforeEach, describe, expect, it } from 'vitest';
import { underwritingComparison } from '@pb/calc';
import {
  UNDERWRITING_REFUSALS,
  problemDetails,
  underwritingCaseVersion,
  underwritingRead,
} from '@pb/contracts';
import type {
  InvestmentPerformance,
  InvestmentValueCreation,
  QuarterRow,
  UnderwritingCaseBody,
  UnderwritingCaseVersion,
  UnderwritingRead,
} from '@pb/contracts';
import { forbiddenPairs, underwritingCaseMachine } from '@pb/workflows';
import {
  investmentValueCreationFixture,
  saltmarsh,
} from '../../pages/analytics/value-creation.fixtures.js';
import {
  caseFixture,
  draftFixture,
  inputsFixture,
  noFormFixture,
  readFixture,
  reunderwriteFixture,
  UW_AS_OF,
  UW_THRESHOLDS,
} from '../../pages/deal/underwriting.fixtures.js';
import { getKey } from '../keys.js';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import type { PreviewState, SimDocument, SimPromotedQuarter } from '../state.js';
import {
  IDS,
  USERS,
  WALL_MEMBERS,
  buildWorld,
  investmentFixture,
  notFoundBody,
  personOf,
  problemOf,
  send,
} from '../test-fixtures.js';
import type { Answer } from '../test-fixtures.js';
import { comparisonInputs } from './underwriting.js';

/*
 * A position's base case in the static preview (routes/underwriting.ts): the read worked out in
 * the browser from the credential's other recordings, and the writes through the transition
 * table the API runs (docs/18 section 13), with the two-person rule.
 *
 * One company, the page fixtures' Saltmarsh Holdings as of 2023-06-30 (IDS.open): its recorded
 * one-pager, performance and value creation answers carry exactly what the page fixture's
 * inputs hold, so the recorded read (the calculation library's answer over those inputs, as the
 * API gives it) is what the browser must work out again.
 */

const never: typeof fetch = () => Promise.reject(new Error('no network in the preview'));
const position = (id: string): string => `/api/v1/investments/${id}`;
const readOf = (id: string): string => `${position(id)}/underwriting`;
const casePath = (id: string): string => `/api/v1/underwriting-cases/${id}`;
const commands = (id: string): string => `${casePath(id)}/commands`;
const NO_SUCH_ID = '00000000-0000-4000-8000-00000000abcd';
const REPLAYED = 'idempotency-replayed';
const ifMatch = (rowVersion: number): Record<string, string> => ({ 'if-match': `"${rowVersion}"` });

let ids = 0;
const env = {
  newId: (): string => `58000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  now: (): string => '2025-07-01T09:00:00.000Z',
};

const quarter = (
  periodEnd: string,
  figures: Partial<
    Pick<QuarterRow, 'revenueLtm' | 'ebitdaLtm' | 'ev' | 'netDebt' | 'status' | 'isEntrySnapshot'>
  >,
): QuarterRow => ({
  periodEnd,
  isEntrySnapshot: false,
  status: 'record_status.approved',
  revenueLtm: null,
  ebitdaLtm: null,
  ev: null,
  netDebt: null,
  cash: null,
  totalEquity: null,
  evToEbitda: null,
  netDebtToEbitda: null,
  ebitdaMargin: null,
  revenueYoy: null,
  ebitdaYoy: null,
  highlights: [],
  source: null,
  ...figures,
});

const ENTRY = quarter('2021-06-30', {
  isEntrySnapshot: true,
  revenueLtm: '200000000.00',
  ebitdaLtm: '40000000.00',
  ev: '400000000.00',
  netDebt: '150000000.00',
});
const CURRENT = quarter('2023-06-30', {
  revenueLtm: '320000000.00',
  ebitdaLtm: '65000000.00',
  ev: '715000000.00',
  netDebt: '120000000.00',
});

/** The performance as recorded: the page fixture's three approved quarters, and three rows that never count. */
const performance = (overrides: Partial<InvestmentPerformance> = {}): InvestmentPerformance => ({
  investmentId: IDS.open,
  asOf: UW_AS_OF,
  entry: ENTRY,
  quarters: [
    quarter('2022-12-31', {
      revenueLtm: '290000000.00',
      ebitdaLtm: '60000000.00',
      ev: '640000000.00',
      netDebt: '125000000.00',
    }),
    quarter('2023-03-31', { revenueLtm: '310000000.00', netDebt: '122000000.00' }),
    // Not approved: never the current quarter, never on the chart.
    quarter('2023-05-31', {
      status: 'record_status.draft',
      revenueLtm: '1.00',
      ebitdaLtm: '1.00',
      ev: '1.00',
      netDebt: '1.00',
    }),
    CURRENT,
    // Approved, and dated after the as-of date.
    quarter('2023-09-30', {
      revenueLtm: '999000000.00',
      ebitdaLtm: '99000000.00',
      ev: '999000000.00',
      netDebt: '1.00',
    }),
  ],
  sinceEntry: null,
  credit: null,
  realizationOutlook: null,
  calcVersion: 'test',
  ...overrides,
});

/** The one-pager as recorded: our flows as the book holds them (unsigned by kind), one of them after the as-of date. */
const detail = investmentFixture(IDS.open, {
  investmentNumber: 'INV-0001',
  companyName: 'Saltmarsh Holdings',
  entryDate: '2021-06-30',
  invested: '10000000',
  distributions: '1000000',
  nav: '12000000',
  grossMoic: '1.3',
  grossIrr: '0.1401754251',
  irrFlag: null,
  cashFlows: [
    { date: '2021-06-30', flowType: 'flow_type.contribution', amount: '-10000000.00' },
    { date: '2023-06-30', flowType: 'flow_type.distribution', amount: '1000000.00' },
    { date: '2023-08-15', flowType: 'flow_type.distribution', amount: '500000.00' },
  ],
});

const point = (q: QuarterRow) => ({
  periodEnd: q.periodEnd,
  revenueLtm: q.revenueLtm,
  ebitdaLtm: q.ebitdaLtm,
  ev: q.ev,
  netDebt: q.netDebt,
  equityValue: null,
  evToEbitda: null,
  netDebtToEbitda: null,
});

/** The value creation answer as recorded: the two quarters the bridge runs between, and the bridge (250 + 65 + 30). */
const valueCreation = (overrides: Parameters<typeof saltmarsh>[0] = {}): InvestmentValueCreation =>
  investmentValueCreationFixture({
    asOf: UW_AS_OF,
    investmentId: IDS.open,
    position: saltmarsh({
      id: IDS.open,
      entry: point(ENTRY),
      current: point(CURRENT),
      ...overrides,
    }),
  });

const DEAL = USERS.deal;
const SECOND = USERS.dealWall;
const HEAD = USERS.head;
const entryCase = (overrides: Partial<UnderwritingCaseVersion> = {}): UnderwritingCaseVersion =>
  caseFixture({
    investmentId: IDS.open,
    enteredBy: personOf(DEAL),
    confirmedBy: personOf(SECOND),
    ...overrides,
  });

interface WorldOptions {
  /** The versions recorded for the open position; the Confirmed entry case by default. */
  versions?: readonly UnderwritingCaseVersion[];
  performance?: InvestmentPerformance;
  valueCreation?: InvestmentValueCreation;
}

/**
 * The test world with the base case recordings the build makes: the open position's read with
 * its inputs for every user; the walled position's Draft for the wall's members and the API's
 * 404 for everyone else; a position that holds no base case (form null); nothing for the rest.
 */
function world(options: WorldOptions = {}): {
  f: typeof fetch;
  state: PreviewState;
  recorded: UnderwritingRead;
} {
  const { fixtures } = buildWorld();
  let n = 0;
  const add = (who: string, path: string, body: unknown, status = 200): void => {
    const hash = `uw-${++n}`;
    fixtures.bodies[hash] = JSON.stringify(body);
    fixtures.responses[getKey(who, path)] = {
      status,
      contentType: status === 200 ? 'application/json' : 'application/problem+json',
      body: hash,
    };
  };
  const recorded = readFixture({ versions: options.versions ?? [entryCase()] });
  const walledDraft = readFixture({
    versions: [
      draftFixture({ id: WALLED_DRAFT, investmentId: IDS.walled, enteredBy: personOf(SECOND) }),
    ],
    compared: null,
  });
  for (const user of Object.values(USERS)) {
    const c = user.externalId;
    add(c, position(IDS.open), detail);
    add(c, `${position(IDS.open)}/performance`, options.performance ?? performance());
    add(c, `${position(IDS.open)}/value-creation`, options.valueCreation ?? valueCreation());
    add(c, readOf(IDS.open), recorded);
    add(c, readOf(IDS.realized), noFormFixture());
    if (WALL_MEMBERS.includes(c)) add(c, readOf(IDS.walled), walledDraft);
    else add(c, readOf(IDS.walled), notFoundBody(readOf(IDS.walled)), 404);
  }
  const state = createPreviewState();
  return { f: createPreviewFetch(fixtures, never, { env, state }), state, recorded };
}

const WALLED_DRAFT = '00000000-0000-4000-8000-0000000005b1';

/** A base case as the deal team records it: two plan points and a note on where the model is held. */
const body = (overrides: Partial<UnderwritingCaseBody> = {}): UnderwritingCaseBody => ({
  caseDate: '2021-06-30',
  plannedExitDate: '2026-06-30',
  exitMultiple: '11',
  grossMoic: '2.5',
  grossIrr: '0.2',
  points: [
    {
      periodEnd: '2021-06-30',
      revenueLtm: '200000000',
      ebitdaLtm: '40000000',
      netDebt: '150000000',
    },
    {
      periodEnd: '2026-06-30',
      revenueLtm: '400000000',
      ebitdaLtm: '80000000',
      netDebt: '100000000',
    },
  ],
  sourceNote: 'Sponsor base case model, held in the deal folder',
  ...overrides,
});

/** How many versions the session holds for the open position (the walled Draft is seeded beside them). */
const heldFor = (state: PreviewState, investmentId: string = IDS.open): number =>
  [...(state.underwritingCases?.values() ?? [])].filter((v) => v.investmentId === investmentId)
    .length;

const versionOf = (answer: Answer, status = 200): UnderwritingCaseVersion => {
  expect(answer.status, answer.text).toBe(status);
  return underwritingCaseVersion.parse(answer.json);
};
const readAs = async (f: typeof fetch, who: string, query = ''): Promise<UnderwritingRead> => {
  const answer = await send(f, who, 'GET', `${readOf(IDS.open)}${query}`);
  expect(answer.status, answer.text).toBe(200);
  return underwritingRead.parse(answer.json);
};
const refused = (answer: Answer, status: number, detail: string): void => {
  expect(answer.status, answer.text).toBe(status);
  expect(problemOf(answer).detail).toBe(detail);
  expect(answer.headers.get('x-pb-simulated')).toBe('true');
};

beforeEach(() => {
  ids = 0;
  window.__pbPreviewMisses = [];
});

describe('preview: the base case read, worked out in the browser', () => {
  it('answers what the API recorded, from the other recordings of the credential', async () => {
    const { f, recorded } = world();
    for (const who of [USERS.viewer, DEAL, USERS.ops, HEAD]) {
      const answer = await send(f, who.externalId, 'GET', readOf(IDS.open));
      expect(answer.status).toBe(200);
      expect(answer.json).toEqual(recorded);
      expect(answer.headers.get('x-pb-simulated')).toBe('true');
    }
    // The recorded as-of date is the one the preview can answer; naming it changes nothing.
    expect(await readAs(f, USERS.viewer.externalId, `?asOf=${UW_AS_OF}`)).toEqual(recorded);
    expect(recorded.comparison?.headline).toBe('behind');
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('builds the inputs as the API does: approved quarters to the as-of date, our signed flows to it', () => {
    const inputs = comparisonInputs(UW_AS_OF, detail, performance(), valueCreation().position);
    expect(inputs).toEqual(inputsFixture());
    // No approved entry snapshot on or before the date: no entry, and the recorded reason stands.
    const forward = comparisonInputs(
      UW_AS_OF,
      detail,
      performance({ entry: { ...ENTRY, periodEnd: '2023-09-30' } }),
      saltmarsh({
        id: IDS.open,
        entry: null,
        current: point(CURRENT),
        bridge: null,
        notCalculable: 'entry_snapshot_forward_dated',
      }),
    );
    expect(forward.entry).toBeNull();
    expect(forward.bridge).toBeNull();
    expect(forward.bridgeNotCalculable).toBe('entry_snapshot_forward_dated');
    // A position realized before the date stops at its exit: what came after is not ours.
    const exited = comparisonInputs(
      UW_AS_OF,
      { ...detail, isActive: false, exitDate: '2023-04-30' },
      performance(),
      undefined,
    );
    expect(exited.isActive).toBe(false);
    expect(exited.current?.periodEnd).toBe('2023-03-31');
    // Its March quarter has no EBITDA, so there is no bridge to it.
    expect(exited.bridge).toBeNull();
    expect(exited.bridgeNotCalculable).toBe('missing_figures');
  });

  it('takes the recorded bridge while it describes the quarters, and derives it again when the session moves one', async () => {
    // A recorded bridge that no calculation over these quarters gives: it is used as it is.
    const marked = valueCreation({
      bridge: {
        ...saltmarsh().bridge!,
        ebitdaGrowth: '251000000',
        multipleExpansion: '64000000',
      },
    });
    const { f, state } = world({ valueCreation: marked });
    const before = await readAs(f, USERS.viewer.externalId);
    expect(before.comparison?.valueCreation?.actual).toEqual({
      ebitdaGrowth: '251000000',
      multipleExpansion: '64000000',
      debtPaydown: '30000000',
      total: '345000000',
    });

    // An approved extraction run promotes the quarter again with a higher EBITDA and EV.
    const promoted: SimPromotedQuarter = {
      id: NO_SUCH_ID,
      investmentId: IDS.open,
      periodEnd: '2023-06-30',
      created: false,
      figures: { ebitdaLtm: '70000000.00', ev: '770000000.00' },
      approvedById: HEAD.userId,
      approvedBy: HEAD.displayName,
      approvedAt: '2025-07-01T09:00:00.000Z',
      approvalReason: 'Revised report',
      source: { documentId: IDS.document, runId: null, page: null, locator: null },
      promptVersion: null,
      modelId: null,
    };
    state.promotedQuarters.set(`${IDS.open}|2023-06-30`, promoted);
    const after = await readAs(f, USERS.viewer.externalId);
    // 30 of EBITDA growth at 10.0x; EV up 370 in all; net debt down 30.
    expect(after.comparison?.valueCreation?.actual).toEqual({
      ebitdaGrowth: '300000000',
      multipleExpansion: '70000000',
      debtPaydown: '30000000',
      total: '400000000',
    });
    const ebitda = after.comparison?.metrics.find((m) => m.metric === 'ebitda');
    expect(ebitda).toMatchObject({ actual: '70000000', plan: '70000000', status: 'on_plan' });
  });

  it('compares with the version the reader names when it stands or stood as the plan', async () => {
    const versions = [entryCase(), reunderwriteFixture({ investmentId: IDS.open })];
    const { f } = world({ versions });
    const entry = await readAs(f, USERS.viewer.externalId);
    expect(entry.comparedVersion).toBe(1);
    const later = await readAs(f, USERS.viewer.externalId, '?version=2');
    expect(later.comparedVersion).toBe(2);
    // Never recorded: the calculation library's own answer for that version.
    expect(later).toEqual(readFixture({ versions, compared: 2 }));
    expect(later.versions.map((v) => v.kind)).toEqual(['entry', 'reunderwrite']);
    for (const query of ['?version=3', '?version=0', '?version=two']) {
      const answer = await send(f, USERS.viewer.externalId, 'GET', `${readOf(IDS.open)}${query}`);
      expect(answer.status, query).toBe(query === '?version=3' ? 404 : 400);
    }
    refused(
      await send(f, USERS.viewer.externalId, 'GET', `${readOf(IDS.open)}?version=3`),
      404,
      'Base case version not found',
    );
  });

  it('replays the wall and a position that holds no base case, and answers no other as-of date', async () => {
    const { f } = world();
    const walled = await send(f, USERS.viewer.externalId, 'GET', readOf(IDS.walled));
    expect(walled.status).toBe(404);
    expect(walled.json).toEqual(notFoundBody(readOf(IDS.walled)));
    // A wall member reads the Draft, which is never compared.
    const member = await send(f, SECOND.externalId, 'GET', readOf(IDS.walled));
    expect(underwritingRead.parse(member.json)).toMatchObject({
      comparedVersion: null,
      comparison: null,
      notCalculable: 'draft_only',
    });
    const none = await send(f, USERS.viewer.externalId, 'GET', readOf(IDS.realized));
    expect(none.json).toEqual(noFormFixture());
    expect(
      (await send(f, USERS.viewer.externalId, 'GET', `${readOf(IDS.realized)}?version=1`)).status,
    ).toBe(404);
    const earlier = await send(
      f,
      USERS.viewer.externalId,
      'GET',
      `${readOf(IDS.open)}?asOf=2022-12-31`,
    );
    expect(earlier.status).toBe(404);
    expect(problemDetails.parse(earlier.json).detail).toBe(
      'This request is outside the recorded preview',
    );
    // A position nothing was recorded for has no answer either.
    expect((await send(f, USERS.viewer.externalId, 'GET', readOf(IDS.states))).status).toBe(404);
  });
});

describe('preview: recording a base case (docs/18 section 13)', () => {
  it('lets the deal team record a Draft, once, and nobody else', async () => {
    const { f, state } = world({ versions: [] });
    expect((await readAs(f, USERS.viewer.externalId)).notCalculable).toBe('no_case');
    for (const who of [USERS.viewer, USERS.ops, HEAD])
      expect(
        (await send(f, who.externalId, 'POST', readOf(IDS.open), body())).status,
        who.externalId,
      ).toBe(403);
    const created = await send(f, DEAL.externalId, 'POST', readOf(IDS.open), body(), {
      'idempotency-key': 'create-1',
    });
    const draft = versionOf(created, 201);
    expect(created.headers.get('etag')).toBe('"1"');
    expect(created.headers.get('x-pb-simulated')).toBe('true');
    // The figures read back as their columns answer them.
    expect(draft).toMatchObject({
      investmentId: IDS.open,
      version: 1,
      form: 'equity',
      state: 'Draft',
      kind: 'entry',
      exitMultiple: '11.000000',
      grossMoic: '2.500000',
      grossIrr: '0.20000000',
      currency: 'USD',
      revisionReason: null,
      enteredBy: personOf(DEAL),
      enteredAt: env.now(),
      confirmedBy: null,
      rowVersion: 1,
    });
    expect(draft.points[0]).toEqual({
      periodEnd: '2021-06-30',
      revenueLtm: '200000000.00',
      ebitdaLtm: '40000000.00',
      netDebt: '150000000.00',
    });
    expect(draft.source).toEqual({
      document: null,
      page: null,
      locator: null,
      note: 'Sponsor base case model, held in the deal folder',
    });
    // The same key and body replay the answer and record nothing twice.
    const replay = await send(f, DEAL.externalId, 'POST', readOf(IDS.open), body(), {
      'idempotency-key': 'create-1',
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get(REPLAYED)).toBe('true');
    expect(replay.json).toEqual(created.json);
    expect(heldFor(state)).toBe(1);
    // One Draft per position.
    refused(
      await send(f, SECOND.externalId, 'POST', readOf(IDS.open), body()),
      409,
      UNDERWRITING_REFUSALS.draftExists,
    );
    // A Draft alone is shown and never compared, to every reader of the position.
    const read = await readAs(f, USERS.viewer.externalId);
    expect(read.versions).toEqual([draft]);
    expect(read).toMatchObject({
      comparedVersion: null,
      comparison: null,
      notCalculable: 'draft_only',
    });
    expect(state.audit.map((e) => [e.action, e.actorExternalId, e.to])).toEqual([
      ['underwriting_case.create', DEAL.externalId, 'Draft'],
    ]);
  });

  it('finds no position past the wall and no base case on a kind of position that holds none', async () => {
    const { f, state } = world();
    refused(
      await send(f, DEAL.externalId, 'POST', readOf(IDS.walled), body()),
      404,
      'Investment not found',
    );
    refused(
      await send(f, DEAL.externalId, 'POST', readOf(NO_SUCH_ID), body()),
      404,
      'Investment not found',
    );
    refused(
      await send(f, DEAL.externalId, 'POST', readOf(IDS.realized), body()),
      422,
      UNDERWRITING_REFUSALS.noBaseCase,
    );
    // The walled Draft is not found by a deal team member outside the wall, whatever is sent.
    refused(
      await send(f, DEAL.externalId, 'PATCH', casePath(WALLED_DRAFT), body()),
      404,
      'Base case not found',
    );
    refused(
      await send(f, DEAL.externalId, 'POST', commands(WALLED_DRAFT), {
        command: 'withdraw',
        reason: 'not ours',
      }),
      404,
      'Base case not found',
    );
    refused(
      await send(f, DEAL.externalId, 'POST', commands(NO_SUCH_ID), { command: 'confirm' }),
      404,
      'Base case not found',
    );
    // A wall member of the deal team withdraws it.
    const withdrawn = versionOf(
      await send(f, SECOND.externalId, 'POST', commands(WALLED_DRAFT), {
        command: 'withdraw',
        reason: 'Recorded against the wrong model',
      }),
    );
    expect(withdrawn).toMatchObject({
      state: 'Withdrawn',
      withdrawnReason: 'Recorded against the wrong model',
      rowVersion: 2,
    });
    expect(state.audit).toHaveLength(1);
  });

  it('refuses what the API refuses of a body, in its order and its words, and keeps nothing', async () => {
    const { f, state } = world();
    // The contract's own rules, at the boundary: 400 with paths, never the values.
    const malformed = await send(f, DEAL.externalId, 'POST', readOf(IDS.open), {
      ...body(),
      grossMoic: '0',
      plannedExitDate: '2021-06-30',
    });
    expect(malformed.status).toBe(400);
    expect(problemDetails.parse(malformed.json).errors?.map((e) => e.path)).toEqual([
      'grossMoic',
      'plannedExitDate',
    ]);
    // What the form needs: revenue typed in millions is refused, never guessed.
    const millions = await send(
      f,
      DEAL.externalId,
      'POST',
      readOf(IDS.open),
      body({
        revisionReason: 'A correction',
        points: [
          { periodEnd: '2021-06-30', revenueLtm: '200', ebitdaLtm: '40', netDebt: '150' },
          { periodEnd: '2026-06-30', revenueLtm: '400', ebitdaLtm: '80', netDebt: '100' },
        ],
      }),
    );
    expect(millions.status).toBe(400);
    expect(problemDetails.parse(millions.json)).toMatchObject({
      detail: 'Invalid body',
      errors: [
        {
          path: 'points.0.revenueLtm',
          message: 'Revenue is in US dollars, between 1000000 and 50000000000',
        },
        {
          path: 'points.1.revenueLtm',
          message: 'Revenue is in US dollars, between 1000000 and 50000000000',
        },
      ],
    });
    expect(millions.text).not.toContain('"200"');
    const onePoint = await send(
      f,
      DEAL.externalId,
      'POST',
      readOf(IDS.open),
      body({ points: body().points!.slice(0, 1), underwrittenYield: '0.1' }),
    );
    expect(problemDetails.parse(onePoint.json).errors?.map((e) => e.path)).toEqual([
      'underwrittenYield',
      'points',
    ]);
    const send422 = (overrides: Partial<UnderwritingCaseBody>): Promise<Answer> =>
      send(f, DEAL.externalId, 'POST', readOf(IDS.open), body(overrides));
    refused(
      await send422({ currency: 'EUR', revisionReason: 'A correction' }),
      422,
      UNDERWRITING_REFUSALS.currency,
    );
    // From version 2 a case says why it revises.
    refused(await send422({}), 422, UNDERWRITING_REFUSALS.reasonRequired);
    // Neither the Confirmed case's date nor later than it.
    refused(
      await send422({ caseDate: '2021-03-31', revisionReason: 'An earlier case' }),
      422,
      UNDERWRITING_REFUSALS.caseDate,
    );
    // A source document is one of the position's that the caller can see: one sentence for the rest.
    const document = (id: string, investmentId: string | null): SimDocument => ({
      id,
      sourceItemId: `inbox/${id}.pdf`,
      fileName: `${id}.pdf`,
      folder: 'inbox',
      title: 'Sponsor model 2023',
      docType: 'doc_type.other',
      reviewStatus: 'Classified',
      sponsorId: null,
      sponsorFundId: null,
      investmentId,
      periodEnd: null,
      contentHash: 'c'.repeat(64),
      sizeBytes: 100,
      pageCount: 20,
      receivedAt: '2025-06-01T10:00:00.000Z',
      indexedAt: '2025-06-01T10:00:00.000Z',
      classificationConfidence: null,
      classifierEvidence: { keywords: [], candidates: [] },
      classifiedById: null,
      classifiedBy: null,
      classifiedAt: null,
      duplicateOfId: null,
      textExcerpt: null,
      pages: null,
      unreadableCode: null,
      rowVersion: 1,
    });
    const OWN = '00000000-0000-4000-8000-00000000d201';
    const OTHER = '00000000-0000-4000-8000-00000000d202';
    state.documents.set(OWN, document(OWN, IDS.open));
    state.documents.set(OTHER, document(OTHER, IDS.states));
    const sourced = {
      revisionReason: 'A correction',
      sourcePage: 12,
      sourceLocator: 'Base case!B14',
    };
    for (const sourceDocumentId of [OTHER, NO_SUCH_ID])
      refused(
        await send422({ ...sourced, sourceDocumentId }),
        422,
        UNDERWRITING_REFUSALS.sourceDocument,
      );
    expect(heldFor(state)).toBe(1);
    expect(state.audit).toHaveLength(0);
    // The position's own document is named on the Draft, with the place in it.
    const created = versionOf(await send422({ ...sourced, sourceDocumentId: OWN }), 201);
    expect(created).toMatchObject({
      version: 2,
      kind: 'correction',
      revisionReason: 'A correction',
    });
    expect(created.source.document).toEqual({ id: OWN, name: 'Sponsor model 2023' });
    expect(created.source).toMatchObject({ page: 12, locator: 'Base case!B14' });
  });

  it('holds the two-person rule: whoever last changed the figures cannot confirm them', async () => {
    const { f, state } = world({ versions: [] });
    const draft = versionOf(await send(f, DEAL.externalId, 'POST', readOf(IDS.open), body()), 201);
    const confirm = (who: string, rowVersion?: number): Promise<Answer> =>
      send(
        f,
        who,
        'POST',
        commands(draft.id),
        { command: 'confirm' },
        rowVersion === undefined ? {} : ifMatch(rowVersion),
      );
    const SAME_PERSON =
      'underwriting_case: the person who last changed the figures cannot confirm them (SEC-5.6)';
    // A enters and cannot confirm.
    refused(await confirm(DEAL.externalId), 422, SAME_PERSON);
    // B edits: B is now the person who last changed the figures.
    const edited = await send(
      f,
      SECOND.externalId,
      'PATCH',
      casePath(draft.id),
      body({ exitMultiple: '10.5', note: 'Exit multiple as the model has it' }),
      ifMatch(1),
    );
    expect(versionOf(edited)).toMatchObject({
      exitMultiple: '10.500000',
      note: 'Exit multiple as the model has it',
      enteredBy: personOf(SECOND),
      state: 'Draft',
      rowVersion: 2,
    });
    expect(edited.headers.get('etag')).toBe('"2"');
    // B cannot confirm what B edited; the version A read is stale.
    refused(await confirm(SECOND.externalId, 2), 422, SAME_PERSON);
    const stale = await confirm(DEAL.externalId, 1);
    expect(stale.status).toBe(412);
    expect(problemOf(stale).detail).toBe(
      'underwriting_case: the record changed since it was read (it is now at row version 2); open it again',
    );
    // A, who entered it first, is now the second person.
    const confirmed = versionOf(await confirm(DEAL.externalId, 2));
    expect(confirmed).toMatchObject({
      state: 'Confirmed',
      confirmedBy: personOf(DEAL),
      confirmedAt: env.now(),
      enteredBy: personOf(SECOND),
      rowVersion: 3,
    });
    // Only now is the position compared, with the confirmed figures.
    const read = await readAs(f, USERS.viewer.externalId);
    expect(read.comparedVersion).toBe(1);
    expect(read.comparison).toEqual(
      underwritingComparison(confirmed, inputsFixture(), UW_THRESHOLDS),
    );
    expect(state.audit.map((e) => e.action)).toEqual([
      'underwriting_case.create',
      'underwriting_case.edit',
      'underwriting_case.confirm',
    ]);
    // An approver confirms too, and a viewer never does.
    expect((await confirm(USERS.viewer.externalId)).status).toBe(403);
  });

  it('needs a source and a plan before a second person confirms', async () => {
    const { f } = world({ versions: [] });
    const { sourceNote: _none, ...unsourced } = body();
    const draft = versionOf(
      await send(f, DEAL.externalId, 'POST', readOf(IDS.open), unsourced),
      201,
    );
    refused(
      await send(f, HEAD.externalId, 'POST', commands(draft.id), { command: 'confirm' }),
      422,
      'underwriting_case: a base case names its source before it is confirmed: a document of the position or a note on where the model is held (SEC-9.4)',
    );
    const sourced = versionOf(
      await send(f, DEAL.externalId, 'PATCH', casePath(draft.id), body(), ifMatch(1)),
    );
    // An approver is a second person as well.
    expect(
      versionOf(
        await send(f, HEAD.externalId, 'POST', commands(sourced.id), { command: 'confirm' }),
      ),
    ).toMatchObject({ state: 'Confirmed', confirmedBy: personOf(HEAD) });
  });

  it('supersedes the case a correction replaces, and keeps both for a re-underwriting', async () => {
    const { f, state } = world();
    // A correction: dated as the Confirmed case.
    const correction = versionOf(
      await send(
        f,
        DEAL.externalId,
        'POST',
        readOf(IDS.open),
        body({ exitMultiple: '10', revisionReason: 'The exit multiple was mistyped' }),
      ),
      201,
    );
    expect(correction).toMatchObject({ version: 2, state: 'Draft', kind: 'correction' });
    // Until it is confirmed the entry case stands, and is the one compared.
    expect((await readAs(f, USERS.viewer.externalId)).comparedVersion).toBe(1);
    versionOf(
      await send(f, SECOND.externalId, 'POST', commands(correction.id), { command: 'confirm' }),
    );
    const corrected = await readAs(f, USERS.viewer.externalId);
    expect(corrected.versions.map((v) => [v.version, v.state, v.kind, v.rowVersion])).toEqual([
      [1, 'Superseded', 'entry', 3],
      [2, 'Confirmed', 'correction', 2],
    ]);
    expect(corrected.comparedVersion).toBe(2);
    // The superseded case can still be picked.
    expect((await readAs(f, USERS.viewer.externalId, '?version=1')).comparedVersion).toBe(1);

    // A re-underwriting: dated later, and both stay Confirmed.
    const later = body({
      caseDate: '2023-03-31',
      revisionReason: 'Sponsor re-underwrote after the acquisition',
      points: [
        {
          periodEnd: '2023-03-31',
          revenueLtm: '300000000',
          ebitdaLtm: '62000000',
          netDebt: '124000000',
        },
        {
          periodEnd: '2026-06-30',
          revenueLtm: '380000000',
          ebitdaLtm: '76000000',
          netDebt: '104000000',
        },
      ],
    });
    const second = versionOf(await send(f, DEAL.externalId, 'POST', readOf(IDS.open), later), 201);
    expect(second.kind).toBe('reunderwrite');
    versionOf(await send(f, HEAD.externalId, 'POST', commands(second.id), { command: 'confirm' }));
    const both = await readAs(f, USERS.viewer.externalId);
    expect(both.versions.map((v) => [v.version, v.state, v.kind])).toEqual([
      [1, 'Superseded', 'entry'],
      [2, 'Confirmed', 'correction'],
      [3, 'Confirmed', 'reunderwrite'],
    ]);
    // The entry case is still the one compared; the re-underwriting is a pick.
    expect(both.comparedVersion).toBe(2);
    expect((await readAs(f, USERS.viewer.externalId, '?version=3')).comparedVersion).toBe(3);
    expect(state.audit.map((e) => [e.action, e.from, e.to])).toEqual([
      ['underwriting_case.create', null, 'Draft'],
      ['underwriting_case.supersede', 'Confirmed', 'Superseded'],
      ['underwriting_case.confirm', 'Draft', 'Confirmed'],
      ['underwriting_case.create', null, 'Draft'],
      ['underwriting_case.confirm', 'Draft', 'Confirmed'],
    ]);
  });

  it('edits a Draft only, and withdraws or retires with a reason', async () => {
    const { f } = world();
    const entry = entryCase();
    // A Confirmed case keeps its figures: an edit is refused and nothing moves.
    refused(
      await send(
        f,
        DEAL.externalId,
        'PATCH',
        casePath(entry.id),
        body(),
        ifMatch(entry.rowVersion),
      ),
      409,
      UNDERWRITING_REFUSALS.notDraft('Confirmed'),
    );
    // A stale If-Match is judged before the state.
    expect(
      (await send(f, DEAL.externalId, 'PATCH', casePath(entry.id), body(), ifMatch(1))).status,
    ).toBe(412);
    expect(
      (
        await send(f, DEAL.externalId, 'PATCH', casePath(entry.id), body(), {
          'if-match': 'two',
        })
      ).status,
    ).toBe(400);
    // The deal team withdraws a Draft, never a Confirmed case; an approver retires one, with a reason.
    refused(
      await send(f, DEAL.externalId, 'POST', commands(entry.id), {
        command: 'withdraw',
        reason: 'Confirmed in error',
      }),
      409,
      'underwriting_case: withdraw is not allowed from Confirmed',
    );
    expect(
      (
        await send(f, DEAL.externalId, 'POST', commands(entry.id), {
          command: 'retire',
          reason: 'Confirmed in error',
        })
      ).status,
    ).toBe(403);
    expect(
      (await send(f, HEAD.externalId, 'POST', commands(entry.id), { command: 'retire' })).status,
    ).toBe(400);
    const retired = versionOf(
      await send(
        f,
        HEAD.externalId,
        'POST',
        commands(entry.id),
        { command: 'retire', reason: 'Confirmed against the wrong model' },
        ifMatch(entry.rowVersion),
      ),
    );
    expect(retired).toMatchObject({
      state: 'Withdrawn',
      withdrawnReason: 'Confirmed against the wrong model',
      rowVersion: entry.rowVersion + 1,
    });
    // Nothing stands: no comparison, and the version stays on record.
    const read = await readAs(f, USERS.viewer.externalId);
    expect(read).toMatchObject({
      comparedVersion: null,
      comparison: null,
      notCalculable: 'no_case',
    });
    expect(read.versions).toHaveLength(1);
    // A withdrawn case never counts: the next one is the entry case again, at any date.
    const next = versionOf(
      await send(
        f,
        DEAL.externalId,
        'POST',
        readOf(IDS.open),
        body({ revisionReason: 'Recorded again from the right model' }),
      ),
      201,
    );
    expect(next).toMatchObject({ version: 2, kind: 'entry' });
  });

  it('refuses every transition the table forbids, for a caller who holds every role', async () => {
    const pairs = forbiddenPairs(underwritingCaseMachine).filter((p) => p.command !== 'supersede');
    expect(pairs.length).toBeGreaterThan(0);
    for (const { from, command } of pairs) {
      const { f, state } = world({ versions: [entryCase({ state: from })] });
      const answer = await send(
        f,
        USERS.all.externalId,
        'POST',
        commands(entryCase().id),
        command === 'confirm' ? { command } : { command, reason: 'Not allowed from here' },
      );
      expect(answer.status, `${command} from ${from}`).toBe(409);
      expect(problemOf(answer).code).toBe('workflow-transition');
      expect(state.underwritingCases?.get(entryCase().id)?.state).toBe(from);
      expect(state.audit).toHaveLength(0);
    }
    // supersede is the system's step: nobody can send it.
    const { f } = world();
    expect(
      (
        await send(f, USERS.all.externalId, 'POST', commands(entryCase().id), {
          command: 'supersede',
        })
      ).status,
    ).toBe(400);
  });
});
