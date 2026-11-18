import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addMonths, containingQuarterEnd, latestQuarterEndOnOrBefore } from '@pb/calc';
import {
  canonicalJson,
  reportPackageDetail,
  reportPackageList,
  seesAllClients,
  valuationRow,
} from '@pb/contracts';
import type { ClientList, InvestmentDetail, ReportPackageDetail } from '@pb/contracts';
import {
  QA_RULES,
  STALE_FOOTNOTE,
  buildPackageSnapshot,
  qaPassed,
  runReportQa,
  snapshotRequestOf,
} from '@pb/report-engine';
import type { QaFinding, QaSnapshot, SnapshotSource } from '@pb/report-engine';
import { failingPackageCase, generateDataset, previewBook } from '@pb/synthetic';
import definitions from '../../../../../config/definitions.json';
import { parseBook } from '../book.js';
import type { PreviewBook } from '../book.js';
import type { PreviewFixtures, PreviewUser } from '../fixtures.js';
import { sha256Hex } from '../hash.js';
import { getKey } from '../keys.js';
import { createPreviewFetch } from '../shim.js';
import { VALUATIONS_PATH, createPreviewState } from '../state.js';
import type { PreviewState } from '../state.js';
import {
  FixtureBuilder,
  IDS,
  USERS,
  buildWorld,
  investmentFixture,
  notFoundBody,
  problemOf,
  send,
  testBook,
} from '../test-fixtures.js';
import type { Answer } from '../test-fixtures.js';

/**
 * Reporting packages in the static preview (docs/04 M14, docs/18 section 5, docs/08 section 7,
 * decision 0024), against what the API does for the same book
 * (apps/api/src/test/report-packages.test.ts): who starts and reads a package, the refusals in
 * the API's words, the snapshot and the findings, the gate from Draft to Released, the hash and
 * the tie-out. Nothing is recorded: every package here is started in the test's own session.
 *
 * Two worlds. The first is the generator's own book (seed 42, small), recorded the way the build
 * records it: each user's sign-in, their clients, and the one-pager of every position they may
 * open. What the preview builds through those recordings is compared with the snapshot built
 * straight from the dataset by the same shared rule. The second is the small hand-built world of
 * the other preview tests, where a mark is locked and another reopened inside the session.
 */

const never: typeof fetch = () => Promise.reject(new Error('no network in the preview'));
const BASE = '/api/v1/report-packages';
const NO_SUCH_ID = '00000000-0000-4000-8000-00000000abcd';
const APPROVED = 'record_status.approved';
const SETTINGS = {
  toleranceUsd: String(definitions.rollForwardToleranceUsd),
  moversCount: definitions.reporting.weeklyMoversCount,
};

/* ---- The generator's world ---- */

const dataset = generateDataset({ profile: 'small', seed: 42 });
const book = parseBook(JSON.parse(JSON.stringify(previewBook(dataset))));
const period = latestQuarterEndOnOrBefore(dataset.asOf);
const prior = containingQuarterEnd(addMonths(period, -3));

type DatasetUser = (typeof dataset.users)[number];
const userOf = (externalId: string): DatasetUser => {
  const user = dataset.users.find((u) => u.externalId === externalId);
  if (user === undefined) throw new Error(`no user ${externalId}`);
  return user;
};
const clientOf = (externalId: string, index = 0): string => {
  const id = userOf(externalId).clientIds[index];
  if (id === undefined) throw new Error(`${externalId} has no client ${index}`);
  return id;
};
const clientA = clientOf('ir.one');
const clientB = clientOf('ir.one', 1);
const clientC = clientOf('ir.two');
const numberOf = (scenario: string): string => {
  const number = dataset.investments.find(
    (i) => i.id === dataset.scenarios[scenario]?.[0],
  )?.investmentNumber;
  if (number === undefined) throw new Error(`the book has no ${scenario} position`);
  return number;
};
const STALE = numberOf('stale_valuation');
const BREAK = numberOf('roll_forward_break');
const WALLED = numberOf('walled_deal');

/** Whether the user may open the position: everyone may, unless it sits behind a wall they are not on. */
const walledIds = new Set(
  dataset.walls.flatMap((w) =>
    w.records.filter((r) => r.entity === 'investment').map((r) => r.entityId),
  ),
);
const opens = (user: DatasetUser, investmentId: string): boolean =>
  !walledIds.has(investmentId) ||
  dataset.walls.some(
    (w) => w.memberUserIds.includes(user.id) && w.records.some((r) => r.entityId === investmentId),
  );

/** A position as the record holds it: every version of its marks and its approved flows. */
const positionOf = (inv: (typeof dataset.investments)[number]) => ({
  ref: inv.investmentNumber,
  vehicleRef: inv.vehicleId,
  entryDate: inv.entryDate,
  exitDate: inv.exitDate,
  valuations: dataset.valuations
    .filter((v) => v.investmentId === inv.id)
    .sort((a, b) =>
      a.periodEnd === b.periodEnd ? a.version - b.version : a.periodEnd < b.periodEnd ? -1 : 1,
    )
    .map(({ periodEnd, version, state, fairValue, method }) => ({
      periodEnd,
      version,
      state,
      fairValue,
      method,
    })),
  flows: dataset.cashFlows
    .filter((f) => f.investmentId === inv.id && f.status === APPROVED)
    .sort((a, b) => (a.flowDate < b.flowDate ? -1 : a.flowDate > b.flowDate ? 1 : 0))
    .map((f) => ({ date: f.flowDate, flowType: f.flowType, amount: f.amount })),
});

/** The one-pager the API records for a position (GET /investments/{id}). */
function onePager(inv: (typeof dataset.investments)[number]): InvestmentDetail {
  const listed = book.investments.find((i) => i.id === inv.id);
  if (listed === undefined) throw new Error(`the book has no ${inv.investmentNumber}`);
  const record = positionOf(inv);
  return investmentFixture(inv.id, {
    investmentNumber: inv.investmentNumber,
    companyName: listed.companyName,
    dealType: inv.dealType,
    vehicleId: inv.vehicleId,
    vehicleName: listed.vehicleName,
    entryDate: inv.entryDate,
    exitDate: inv.exitDate,
    isActive: inv.isActive,
    cashFlows: record.flows,
    valuations: record.valuations,
  });
}

/**
 * The clients a user reads (GET /clients): every client for the roles that read them all, the
 * entitled ones for investor relations, none for anyone else. The commitments are listed last
 * vehicle first, so nothing here leans on the order a recording happens to carry.
 */
function clientsRead(user: DatasetUser): ClientList {
  const vehicle = new Map(dataset.vehicles.map((v) => [v.id, v]));
  return {
    asOf: dataset.asOf,
    calcVersion: 'test',
    items: dataset.clients
      .filter((c) => seesAllClients(user.roles) || user.clientIds.includes(c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        reportingBases: c.reportingBases,
        reportingCadence: c.reportingCadence,
        vehicles: dataset.lpCommitments
          .filter((l) => l.clientId === c.id)
          .sort((a, b) => (a.vehicleId < b.vehicleId ? 1 : a.vehicleId > b.vehicleId ? -1 : 0))
          .map((l) => ({
            vehicleId: l.vehicleId,
            vehicleName: vehicle.get(l.vehicleId)?.name ?? '',
            vehicleType: vehicle.get(l.vehicleId)?.vehicleType ?? '',
            commitment: l.amount,
            closingNumber: l.closingNumber,
            ownershipPct: l.ownershipPct,
            commitmentDate: l.commitmentDate,
            invested: null,
            distributions: null,
            nav: null,
            grossMoic: null,
          })),
        totals: {
          commitment: null,
          invested: null,
          distributions: null,
          nav: null,
          grossMoic: null,
        },
      })),
  };
}

const previewUsers: PreviewUser[] = dataset.users.map((u) => ({
  externalId: u.externalId,
  roles: u.roles,
  userId: u.id,
  displayName: u.displayName,
}));

function generatedFixtures(): PreviewFixtures {
  const b = new FixtureBuilder(previewUsers, dataset.asOf);
  for (const user of dataset.users) {
    const c = user.externalId;
    b.add(c, '/api/v1/auth/me', {
      userId: user.id,
      externalId: c,
      displayName: user.displayName,
      roles: user.roles,
      clientIds: user.clientIds,
      mockIdentity: true,
    });
    b.add(c, '/api/v1/clients', clientsRead(user));
    // No version changes in these sessions, so the board the simulation would seed from is empty.
    b.add(c, VALUATIONS_PATH, { items: [], nextCursor: null, asOf: dataset.asOf, periods: [] });
    for (const inv of dataset.investments) {
      const path = `/api/v1/investments/${inv.id}`;
      if (opens(user, inv.id)) b.add(c, path, onePager(inv));
      else b.notFound(c, path);
    }
  }
  return b.build();
}
const generated = generatedFixtures();

/**
 * The snapshot of a package built straight from the dataset, as the API builds it from its
 * tables: the positions the preparer may open, the client's commitments, the releases before it.
 */
function snapshotFromDataset(
  preparer: string,
  request: Pick<SnapshotSource, 'clientRef' | 'periodEnd' | 'label' | 'basis'> &
    Partial<Pick<SnapshotSource, 'released' | 'explanations'>>,
): QaSnapshot {
  const user = userOf(preparer);
  return buildPackageSnapshot(
    snapshotRequestOf({
      asOf: dataset.asOf,
      commitments: dataset.lpCommitments
        .filter((l) => l.clientId === request.clientRef)
        .map((l) => ({ vehicleRef: l.vehicleId, ownershipPct: l.ownershipPct })),
      positions: dataset.investments.filter((i) => opens(user, i.id)).map(positionOf),
      released: [],
      explanations: {},
      moversCount: SETTINGS.moversCount,
      ...request,
    }),
  );
}

/** The findings in the order the API answers them: failed first, then by rule, then by what they are about. */
const inAnswerOrder = (findings: readonly QaFinding[]): QaFinding[] => {
  const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...findings].sort(
    (a, b) =>
      Number(a.passed) - Number(b.passed) ||
      byText(a.rule, b.rule) ||
      byText(a.entityRef, b.entityRef),
  );
};

/* ---- Sessions ---- */

let ids = 0;
let ticks = 0;
const env = {
  newId: (): string => `8a000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  now: (): string => new Date(Date.UTC(2025, 6, 1, 9, 0, 0) + ++ticks * 1000).toISOString(),
};

interface Session {
  f: typeof fetch;
  state: PreviewState;
}
function session(
  fixtures: PreviewFixtures = generated,
  withBook: PreviewBook | null = book,
): Session {
  const state = createPreviewState();
  return { f: createPreviewFetch(fixtures, never, { env, state, book: withBook }), state };
}

const create = (f: typeof fetch, who: string, body: Record<string, unknown>): Promise<Answer> =>
  send(f, who, 'POST', BASE, body);
const command = (
  f: typeof fetch,
  who: string,
  id: string,
  body: Record<string, unknown>,
  extra: Record<string, string> = {},
): Promise<Answer> => send(f, who, 'POST', `${BASE}/${id}/commands`, body, extra);
const detailOf = (answer: Answer, status = 200): ReportPackageDetail => {
  expect(answer.status, answer.text).toBe(status);
  expect(answer.headers.get('x-pb-simulated')).toBe('true');
  return reportPackageDetail.parse(answer.json);
};
const started = async (
  f: typeof fetch,
  who: string,
  clientId: string,
  periodEnd: string,
  over: Record<string, unknown> = {},
): Promise<ReportPackageDetail> =>
  detailOf(
    await create(f, who, { clientId, periodEnd, basis: 'gross', label: 'preliminary', ...over }),
    201,
  );
const run = async (
  f: typeof fetch,
  who: string,
  id: string,
  body: Record<string, unknown>,
): Promise<ReportPackageDetail> => detailOf(await command(f, who, id, body));
const contentOf = (d: ReportPackageDetail): NonNullable<ReportPackageDetail['content']> => {
  if (d.content === null) throw new Error('a generated package has content');
  return d.content;
};
const failedOf = (d: ReportPackageDetail): Set<string> =>
  new Set(d.findings.filter((f) => !f.passed).map((f) => `${f.rule} ${f.entityRef}`));

/** Generates, has the approver override a failed gate, and takes the package to Released. */
async function released(
  f: typeof fetch,
  who: { preparer: string; approver: string; releaser: string },
  id: string,
): Promise<ReportPackageDetail> {
  let d = await run(f, who.preparer, id, { command: 'generate' });
  if (d.state === 'QAFailed')
    d = await run(f, who.approver, id, {
      command: 'overrideQa',
      reason: 'Reviewed with operations; the breaks are understood',
    });
  expect(d.state).toBe('QAPassed');
  await run(f, who.preparer, id, { command: 'submit' });
  await run(f, who.approver, id, { command: 'approve' });
  return run(f, who.releaser, id, { command: 'release' });
}
const TEAM = { preparer: 'ir.one', approver: 'head.one', releaser: 'ops.one' };

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('reporting packages in the preview: who starts and who reads', () => {
  it('is started by investor relations for a client they are entitled to, and by nobody else', async () => {
    const { f } = session();
    const body = { clientId: clientA, periodEnd: prior, basis: 'gross', label: 'final' };
    for (const who of ['deal.one', 'ops.one', 'head.one', 'audit.one'])
      expect((await create(f, who, body)).status, who).toBe(403);
    expect((await send(f, 'viewer.one', 'GET', BASE)).status).toBe(403);
    expect((await send(f, 'admin.one', 'GET', BASE)).status).toBe(403);
    // A client the caller is not entitled to does not exist for it.
    const other = await create(f, 'ir.one', { ...body, clientId: clientC });
    expect(other.status).toBe(404);
    expect(problemOf(other)).toEqual({ code: 'not-found', detail: 'Client not found' });
    expect((await create(f, 'ir.one', { ...body, clientId: NO_SUCH_ID })).status).toBe(404);

    const bad = await create(f, 'ir.one', { ...body, periodEnd: '2025-02-28' });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({
      detail: 'Invalid body',
      errors: [{ path: 'periodEnd', message: 'A package period is a calendar quarter end' }],
    });
    const early = await create(f, 'ir.one', { ...body, asOf: '2020-01-01' });
    expect(early.status).toBe(400);
    expect(early.json).toMatchObject({
      errors: [{ path: 'asOf', message: 'The as-of date is on or after the period end' }],
    });
    // The contract's own body: a field it does not know is refused at the boundary.
    expect((await create(f, 'ir.one', { ...body, state: 'Released' })).status).toBe(400);

    const answer = await create(f, 'ir.one', { ...body, basis: 'net' });
    const draft = detailOf(answer, 201);
    expect(answer.headers.get('etag')).toBe('"1"');
    expect(draft).toMatchObject({
      client: { id: clientA, name: dataset.clients.find((c) => c.id === clientA)?.name },
      periodEnd: prior,
      // No as-of date was sent: it is the date of the recordings, the preview's own date.
      asOf: dataset.asOf,
      state: 'Draft',
      version: 1,
      basis: 'net',
      label: 'final',
      preparedBy: { id: userOf('ir.one').id, name: userOf('ir.one').displayName },
      reviewer: null,
      releasedBy: null,
      correctionReason: null,
      content: null,
      findings: [],
      qa: { runNo: null, findings: 0, failed: 0, overridden: 0 },
      contentHash: null,
      tieOutExplanations: {},
      changeLog: [],
      rowVersion: 1,
    });
    // One in progress per client, period and basis.
    const second = await create(f, 'ir.one', { ...body, basis: 'net' });
    expect(second.status).toBe(409);
    expect(problemOf(second)).toEqual({
      code: 'workflow-transition',
      detail: 'A package for this client, period and basis is already in progress',
    });
    // Another basis is another package.
    await started(f, 'ir.one', clientA, prior);

    // Who reads it: the roles that read every client, and investor relations entitled to it.
    for (const who of ['ops.one', 'deal.one', 'head.one', 'audit.one', 'ir.one']) {
      const read = await send(f, who, 'GET', `${BASE}/${draft.id}`);
      expect(detailOf(read), who).toEqual(draft);
      expect(read.headers.get('etag')).toBe('"1"');
    }
    const unseen = await send(f, 'ir.two', 'GET', `${BASE}/${draft.id}`);
    expect(unseen.status).toBe(404);
    expect(problemOf(unseen)).toEqual({
      code: 'not-found',
      detail: 'Reporting package not found',
    });
    const mine = reportPackageList.parse((await send(f, 'ir.two', 'GET', BASE)).json);
    expect(mine.items).toEqual([]);
    expect((await send(f, 'ops.one', 'GET', `${BASE}/${NO_SUCH_ID}`)).status).toBe(404);
    expect((await send(f, 'ops.one', 'GET', `${BASE}/not-a-uuid`)).status).toBe(404);
    expect((await send(f, '', 'GET', BASE)).status).toBe(401);
    // A command on a package the caller cannot see is 404 as well, whatever the command.
    expect((await command(f, 'ir.two', draft.id, { command: 'generate' })).status).toBe(404);
    expect((await command(f, 'ir.one', NO_SUCH_ID, { command: 'generate' })).status).toBe(404);
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('lists the packages a reader may see, newest period first, with the counts of the latest run', async () => {
    const { f } = session();
    const a = await started(f, 'ir.one', clientA, prior);
    const b = await started(f, 'ir.one', clientB, period, { basis: 'net' });
    const c = await started(f, 'ir.two', clientC, period);
    const generatedA = await run(f, 'ir.one', a.id, { command: 'generate' });

    const all = reportPackageList.parse((await send(f, 'audit.one', 'GET', BASE)).json).items;
    // The later quarter first; within a quarter by client name.
    const names = new Map(dataset.clients.map((x) => [x.id, x.name]));
    const byName = [b, c].sort((x, y) =>
      (names.get(x.client.id) ?? '') < (names.get(y.client.id) ?? '') ? -1 : 1,
    );
    expect(all.map((p) => p.id)).toEqual([...byName.map((p) => p.id), a.id]);
    const row = all.find((p) => p.id === a.id);
    expect(row?.qa).toEqual(generatedA.qa);
    expect(row).toMatchObject({ state: generatedA.state, rowVersion: generatedA.rowVersion });
    // A row carries no content and no findings: those are the detail's.
    expect(Object.keys(row ?? {})).not.toContain('content');
    expect(Object.keys(row ?? {})).not.toContain('findings');

    const one = reportPackageList.parse((await send(f, 'ir.one', 'GET', BASE)).json).items;
    expect(one.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    const two = reportPackageList.parse((await send(f, 'ir.two', 'GET', BASE)).json).items;
    expect(two.map((p) => p.id)).toEqual([c.id]);
  });
});

describe('reporting packages in the preview: generating and the QA gate', () => {
  it('builds the snapshot the API builds from the same record, and finds exactly what the rules find on it', async () => {
    const { f } = session();
    const draft = await started(f, 'ir.one', clientA, period);
    const answer = await command(f, 'ir.one', draft.id, { command: 'generate' });
    const d = detailOf(answer);
    // Two writes: the snapshot as the preparer, the QA outcome as the system.
    expect(d.rowVersion).toBe(3);
    expect(answer.headers.get('etag')).toBe('"3"');

    const content = contentOf(d);
    expect(content).toEqual(
      snapshotFromDataset('ir.one', {
        clientRef: clientA,
        periodEnd: period,
        label: 'preliminary',
        basis: 'gross',
      }),
    );
    expect(content.lines.length).toBeGreaterThan(0);
    expect(content.clientLines.length).toBeGreaterThan(0);
    expect(content.clientLines.every((c) => c.clientRef === clientA)).toBe(true);

    // The findings are the rules over that snapshot, nothing more or less, failed first.
    const again = runReportQa(content, SETTINGS);
    expect(d.findings.map(({ id: _id, runNo: _runNo, override: _override, ...f }) => f)).toEqual(
      inAnswerOrder(again),
    );
    expect(d.state).toBe(qaPassed(again) ? 'QAPassed' : 'QAFailed');
    expect(d.qa).toEqual({
      runNo: 1,
      findings: again.length,
      failed: again.filter((x) => !x.passed).length,
      overridden: 0,
    });
    expect(new Set(d.findings.map((x) => x.id)).size).toBe(d.findings.length);
    for (const finding of d.findings) {
      expect(QA_RULES).toContain(finding.rule);
      expect(finding).toMatchObject({ runNo: 1, override: null });
    }
    expect(d.changeLog).toEqual([
      {
        at: expect.stringMatching(/^2025-07-01T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as string,
        by: { id: userOf('ir.one').id, name: userOf('ir.one').displayName },
        runNo: 1,
        lines: content.lines.length,
        findings: again.length,
        failed: again.filter((x) => !x.passed).length,
      },
    ]);
    // Reading it back is the same answer.
    expect(detailOf(await send(f, 'audit.one', 'GET', `${BASE}/${draft.id}`))).toEqual(d);
  });

  it('catches the reporting scenarios of the synthetic book', async () => {
    const { f } = session();
    let seen = 0;
    for (const [who, clients] of [
      ['ir.one', userOf('ir.one').clientIds],
      ['ir.two', userOf('ir.two').clientIds],
    ] as const) {
      for (const clientId of clients) {
        const draft = await started(f, who, clientId, period, { basis: 'net', label: 'final' });
        const d = await run(f, who, draft.id, { command: 'generate' });
        const failed = failedOf(d);
        const lines = contentOf(d).lines;
        if (lines.some((l) => l.ref === STALE)) {
          seen += 1;
          // stale_valuation: no mark for the quarter, so the last one is rolled forward and
          // footnoted, and a package that carries it cannot be labelled final.
          expect(lines.find((l) => l.ref === STALE)?.endNavPeriodEnd).not.toBe(period);
          expect(contentOf(d).footnotes).toContainEqual({ ref: STALE, code: STALE_FOOTNOTE });
          expect(failed.has('QA-LBL-01 status')).toBe(true);
          expect(d.findings.find((x) => x.rule === 'QA-LBL-01' && !x.passed)).toMatchObject({
            expected: 'preliminary',
            actual: 'final',
          });
          expect(d.state).toBe('QAFailed');
        }
        if (lines.some((l) => l.ref === BREAK)) {
          seen += 1;
          // roll_forward_break: no Locked mark at the end of the prior quarter.
          expect(lines.find((l) => l.ref === BREAK)).toMatchObject({
            beginNav: null,
            gainLoss: null,
          });
          expect(failed.has(`QA-QTD-01 ${BREAK}`)).toBe(true);
          expect(failed.has(`QA-RF-01 ${BREAK}`)).toBe(true);
          expect(d.state).toBe('QAFailed');
        }
      }
    }
    // Every client of the book carries at least one of the two: the test is not vacuous.
    expect(seen).toBeGreaterThanOrEqual(3);
  });

  it('fails the gate for the package the generator names as failing, on the position it names', async () => {
    const found = failingPackageCase(dataset);
    if (found === null) throw new Error('the book has no failing package case');
    const { f } = session();
    const who = found.user.externalId;
    const ref = found.positionNumber;
    // Preliminary, so the label check passes: what fails is the record of the position alone.
    const draft = await started(f, who, found.client.id, period);
    const d = await run(f, who, draft.id, { command: 'generate' });
    expect(d.state).toBe('QAFailed');
    expect([...failedOf(d)].sort()).toEqual([
      `QA-QTD-01 ${ref}`,
      `QA-RF-01 ${ref}`,
      `QA-SIGN-01 ${ref}`,
    ]);
    // The line is in the package with no begin NAV and no gain, never a zero, and the client's
    // share of its end NAV is there: the case names a client with a share of the vehicle.
    const content = contentOf(d);
    const line = content.lines.find((l) => l.ref === ref);
    expect(line).toMatchObject({ beginNav: null, gainLoss: null, enteredInPeriod: false });
    expect(line?.endNav).not.toBeNull();
    expect(content.clientLines.some((c) => c.ref === ref)).toBe(true);
    // Labelled final it fails on the same position, whatever else the label adds.
    const final = await started(f, who, found.client.id, period, { basis: 'net', label: 'final' });
    const failed = failedOf(await run(f, who, final.id, { command: 'generate' }));
    expect(failed.has(`QA-QTD-01 ${ref}`)).toBe(true);
  });

  it('leaves out a position behind a wall the preparer is not on', async () => {
    const { f } = session();
    const walled = dataset.investments.find((i) => i.investmentNumber === WALLED);
    // The walled position sits in a vehicle this client is committed to, and is held this quarter.
    expect(
      dataset.lpCommitments.some(
        (l) => l.clientId === clientC && l.vehicleId === walled?.vehicleId,
      ),
    ).toBe(true);
    expect(opens(userOf('ir.two'), walled?.id ?? '')).toBe(false);
    const asMember = buildPackageSnapshot(
      snapshotRequestOf({
        clientRef: clientC,
        periodEnd: period,
        asOf: dataset.asOf,
        label: 'preliminary',
        basis: 'gross',
        commitments: dataset.lpCommitments
          .filter((l) => l.clientId === clientC)
          .map((l) => ({ vehicleRef: l.vehicleId, ownershipPct: l.ownershipPct })),
        positions: dataset.investments.map(positionOf),
        released: [],
        explanations: {},
        moversCount: SETTINGS.moversCount,
      }),
    );
    expect(asMember.lines.map((l) => l.ref)).toContain(WALLED);

    const draft = await started(f, 'ir.two', clientC, period);
    const d = await run(f, 'ir.two', draft.id, { command: 'generate' });
    const content = contentOf(d);
    expect(content.lines.map((l) => l.ref)).not.toContain(WALLED);
    expect(content.clientLines.map((c) => c.ref)).not.toContain(WALLED);
    expect(JSON.stringify(d)).not.toContain(WALLED);
    // Everything else the wall member would see is there.
    expect(content.lines.map((l) => l.ref)).toEqual(
      asMember.lines.map((l) => l.ref).filter((ref) => ref !== WALLED),
    );
    // A reader on the wall reads the package as it was built: the line is not added for them.
    expect(contentOf(detailOf(await send(f, 'head.one', 'GET', `${BASE}/${draft.id}`)))).toEqual(
      content,
    );
  });

  it('moves through the gate: an approver overrides a failed QA with a reason, reviews, and the package is released', async () => {
    const { f, state } = session();
    // The stale position makes a final package of this client fail its label check.
    const draft = await started(f, 'ir.one', clientA, period, { label: 'final' });
    // Nothing moves before it is generated.
    for (const [who, cmd] of [
      ['ir.one', 'submit'],
      ['head.one', 'approve'],
      ['ir.one', 'release'],
      ['ir.one', 'regenerate'],
    ] as const) {
      const refused = await command(f, who, draft.id, { command: cmd });
      expect(refused.status, cmd).toBe(409);
      expect(problemOf(refused)).toEqual({
        code: 'workflow-transition',
        detail: `reporting_package: ${cmd} is not allowed from Draft`,
      });
    }
    const notOps = await command(f, 'ops.one', draft.id, { command: 'generate' });
    expect(notOps.status).toBe(403);
    expect(problemOf(notOps).detail).toBe(
      'reporting_package: generate from Draft requires one of: investor_relations, service',
    );
    // The roles outside the route never reach the machine.
    for (const who of ['deal.one', 'audit.one', 'viewer.one', 'admin.one'])
      expect((await command(f, who, draft.id, { command: 'generate' })).status, who).toBe(403);
    // The QA outcome is the system's: no person states it.
    for (const cmd of ['qaPass', 'qaFail'])
      expect((await command(f, 'ir.one', draft.id, { command: cmd })).status, cmd).toBe(400);

    let d = await run(f, 'ir.one', draft.id, { command: 'generate' });
    expect(d.state).toBe('QAFailed');
    const failed = d.qa.failed;
    expect(failed).toBeGreaterThan(0);
    expect((await command(f, 'ir.one', draft.id, { command: 'submit' })).status).toBe(409);
    // The override is the approver's, and needs a reason.
    const notMine = await command(f, 'ir.one', draft.id, {
      command: 'overrideQa',
      reason: 'Looks fine to me',
    });
    expect(notMine.status).toBe(403);
    expect((await command(f, 'head.one', draft.id, { command: 'overrideQa' })).status).toBe(400);
    expect(
      (await command(f, 'head.one', draft.id, { command: 'overrideQa', reason: 'ok' })).status,
    ).toBe(400);
    const findingsBefore = d.findings;
    d = await run(f, 'head.one', draft.id, {
      command: 'overrideQa',
      reason: 'Timing differences agreed with the client',
    });
    expect(d.state).toBe('QAPassed');
    expect(d.rowVersion).toBe(4);
    expect(d.qa).toMatchObject({ failed, overridden: failed });
    const overridden = d.findings.filter((x) => x.override !== null);
    expect(overridden).toHaveLength(failed);
    expect(overridden.every((x) => !x.passed)).toBe(true);
    for (const finding of overridden)
      expect(finding.override).toEqual({
        reason: 'Timing differences agreed with the client',
        approver: { id: userOf('head.one').id, name: userOf('head.one').displayName },
        at: expect.stringMatching(/^2025-07-01T/) as string,
      });
    // What the rules found is not edited: only the override is added.
    expect(d.findings.map(({ override: _override, ...x }) => x)).toEqual(
      findingsBefore.map(({ override: _override, ...x }) => x),
    );
    // The override is not a run.
    expect(d.changeLog).toHaveLength(1);

    // A stale row version is refused before anything else.
    const stale = await command(
      f,
      'ir.one',
      draft.id,
      { command: 'submit' },
      { 'if-match': `"${d.rowVersion + 7}"` },
    );
    expect(stale.status).toBe(412);
    expect(problemOf(stale)).toEqual({
      code: 'stale-row-version',
      detail: `reporting_package: the record changed since it was read (it is now at row version ${d.rowVersion}); open it again`,
    });
    // Even for a command the machine would refuse.
    expect(
      (
        await command(
          f,
          'ir.one',
          draft.id,
          { command: 'release' },
          { 'if-match': `"${d.rowVersion + 7}"` },
        )
      ).status,
    ).toBe(412);
    d = detailOf(
      await command(
        f,
        'ir.one',
        draft.id,
        { command: 'submit' },
        { 'if-match': `"${d.rowVersion}"` },
      ),
    );
    expect(d).toMatchObject({ state: 'InReview', rowVersion: 5, contentHash: null });

    // The review is the approver's; investor relations cannot approve their own package.
    expect((await command(f, 'ir.one', draft.id, { command: 'approve' })).status).toBe(403);
    expect((await command(f, 'ops.one', draft.id, { command: 'approve' })).status).toBe(403);
    d = await run(f, 'head.one', draft.id, { command: 'approve' });
    expect(d).toMatchObject({
      state: 'Approved',
      rowVersion: 6,
      reviewer: { id: userOf('head.one').id, name: userOf('head.one').displayName },
    });
    expect(d.approvedAt).toMatch(/^2025-07-01T/);
    // SHA-256 over the canonical JSON of the content: the text the API hashes.
    expect(d.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.contentHash).toBe(await sha256Hex(canonicalJson(contentOf(d))));

    expect((await command(f, 'head.one', draft.id, { command: 'release' })).status).toBe(403);
    const hash = d.contentHash;
    d = await run(f, 'ops.one', draft.id, { command: 'release' });
    expect(d).toMatchObject({
      state: 'Released',
      rowVersion: 7,
      contentHash: hash,
      releasedBy: { id: userOf('ops.one').id, name: userOf('ops.one').displayName },
    });
    expect(d.releasedAt).toMatch(/^2025-07-01T/);

    // Released is the end: nothing moves it.
    for (const cmd of ['generate', 'regenerate', 'submit', 'release'])
      expect((await command(f, 'ir.one', draft.id, { command: cmd })).status, cmd).toBe(409);
    for (const body of [{ command: 'overrideQa', reason: 'Once more' }, { command: 'approve' }])
      expect((await command(f, 'head.one', draft.id, body)).status).toBe(409);
    expect(detailOf(await send(f, 'audit.one', 'GET', `${BASE}/${draft.id}`))).toEqual(d);

    // A correction is a new version, with a reason.
    const body = { clientId: clientA, periodEnd: period, basis: 'gross', label: 'final' };
    const again = await create(f, 'ir.one', body);
    expect(again.status).toBe(422);
    expect(problemOf(again)).toEqual({
      code: 'workflow-precondition',
      detail:
        'A package for this client, period and basis was released; a new version needs a reason',
    });
    const v2 = detailOf(
      await create(f, 'ir.one', {
        ...body,
        correctionReason: 'Sponsor restated one position after release',
      }),
      201,
    );
    expect(v2).toMatchObject({
      version: 2,
      state: 'Draft',
      correctionReason: 'Sponsor restated one position after release',
      content: null,
      changeLog: [],
    });
    // And while it is in progress there is no third.
    expect(
      (await create(f, 'ir.one', { ...body, correctionReason: 'Another correction' })).status,
    ).toBe(409);

    // The session's activity names each step with the state before and after, and counts only.
    const steps = state.audit.filter((e) => e.entity === 'report_package' && e.entityId === d.id);
    expect(steps.map((e) => `${e.action} ${String(e.from)} > ${String(e.to)}`)).toEqual([
      'report_package.create null > Draft',
      'report_package.generate Draft > QAFailed',
      'report_package.overrideQa QAFailed > QAPassed',
      'report_package.submit QAPassed > InReview',
      'report_package.approve InReview > Approved',
      'report_package.release Approved > Released',
    ]);
    expect(steps[1]?.details).toEqual({ runNo: 1, findings: d.qa.findings, failed });
    expect(steps[2]).toMatchObject({
      reason: 'Timing differences agreed with the client',
      details: { overridden: failed },
    });
    expect(window.__pbPreviewMisses).toEqual([]);
  });

  it('ties a package to the last one released in the session, and takes an explanation where it does not tie', async () => {
    const { f } = session();
    const first = await started(f, 'ir.one', clientB, prior);
    const firstReleased = await released(f, TEAM, first.id);
    expect(firstReleased.state).toBe('Released');

    const next = await started(f, 'ir.one', clientB, period);
    let d = await run(f, 'ir.one', next.id, { command: 'generate' });
    const priorEnd = Object.fromEntries(
      contentOf(firstReleased).lines.flatMap((l) => (l.endNav === null ? [] : [[l.ref, l.endNav]])),
    );
    expect(contentOf(d).priorRelease).toEqual({ endNav: priorEnd, explanations: {} });
    const ties = d.findings.filter((x) => x.rule === 'QA-TIE-01');
    // One finding per line, none for "no package before this one".
    expect(ties.map((x) => x.entityRef)).not.toContain('package');
    expect(ties.length).toBe(contentOf(d).lines.length);
    // A held position starts where the released package ended it.
    const tied = ties.filter((x) => x.passed && x.expected !== null && x.actual !== null);
    expect(tied.length).toBeGreaterThan(0);
    for (const x of tied)
      expect(Math.abs(Number(x.expected) - Number(x.actual))).toBeLessThanOrEqual(1);

    // The position with no Locked mark at the quarter start has no begin NAV to tie.
    const broken = ties.find((x) => x.entityRef === BREAK);
    expect(broken).toMatchObject({
      passed: false,
      expected: priorEnd[BREAK],
      actual: null,
      detail: 'The line shows no begin NAV to tie to the last released package.',
    });
    expect(d.state).toBe('QAFailed');
    d = await run(f, 'ir.one', next.id, {
      command: 'regenerate',
      explanations: { [BREAK]: 'Carried at the rolled-forward value last quarter' },
    });
    expect(d.qa.runNo).toBe(2);
    expect(d.rowVersion).toBe(5);
    expect(d.tieOutExplanations).toEqual({
      [BREAK]: 'Carried at the rolled-forward value last quarter',
    });
    expect(d.findings.find((x) => x.rule === 'QA-TIE-01' && x.entityRef === BREAK)).toMatchObject({
      passed: true,
      runNo: 2,
      detail: 'One side of the tie-out is missing and an explanation is recorded.',
    });
    // The findings shown are those of the latest run, and the log lists both runs.
    expect(d.findings.every((x) => x.runNo === 2)).toBe(true);
    expect(d.changeLog.map((r) => r.runNo)).toEqual([1, 2]);
    // An explanation stays on the package: a later run without one keeps it.
    d = await run(f, 'ir.one', next.id, { command: 'regenerate' });
    expect(d.qa.runNo).toBe(3);
    expect(d.tieOutExplanations[BREAK]).toBe('Carried at the rolled-forward value last quarter');
    expect(contentOf(d).priorRelease?.explanations).toEqual(d.tieOutExplanations);
    // An explanation is bounded plain text, keyed by a position number.
    expect(
      (
        await command(f, 'ir.one', next.id, {
          command: 'regenerate',
          explanations: { [BREAK]: 'x' },
        })
      ).status,
    ).toBe(400);
  });
});

describe('reporting packages in the preview: which release a package ties to', () => {
  it('picks the latest earlier quarter released to the same client on the same basis, and nothing else', async () => {
    const { f } = session();
    const earlier = containingQuarterEnd(addMonths(prior, -3));
    const endNavOf = (d: ReportPackageDetail): Record<string, string> =>
      Object.fromEntries(
        contentOf(d).lines.flatMap((l) => (l.endNav === null ? [] : [[l.ref, l.endNav]])),
      );
    // Two quarters back, released: the only release this client has on this basis so far.
    const old = await released(f, TEAM, (await started(f, 'ir.one', clientB, earlier)).id);
    // None of these is a prior release of the gross package below: another basis, another
    // client, and the quarter before it still in progress.
    await released(f, TEAM, (await started(f, 'ir.one', clientB, prior, { basis: 'net' })).id);
    await released(
      f,
      { ...TEAM, preparer: 'ir.two' },
      (await started(f, 'ir.two', clientC, prior)).id,
    );
    const inProgress = await started(f, 'ir.one', clientB, prior);
    const generatedOnly = await run(f, 'ir.one', inProgress.id, { command: 'generate' });

    const next = await started(f, 'ir.one', clientB, period);
    let d = await run(f, 'ir.one', next.id, { command: 'generate' });
    expect(contentOf(d).priorRelease?.endNav).toEqual(endNavOf(old));
    expect(d.state).toBe('QAFailed');

    // Once the quarter before it is released, that is the one it ties to.
    if (generatedOnly.state === 'QAFailed')
      await run(f, 'head.one', inProgress.id, { command: 'overrideQa', reason: 'Understood' });
    await run(f, 'ir.one', inProgress.id, { command: 'submit' });
    await run(f, 'head.one', inProgress.id, { command: 'approve' });
    const latest = await run(f, 'ops.one', inProgress.id, { command: 'release' });
    expect(endNavOf(latest)).not.toEqual(endNavOf(old));
    d = await run(f, 'ir.one', next.id, { command: 'regenerate' });
    expect(contentOf(d).priorRelease?.endNav).toEqual(endNavOf(latest));

    // A package never ties to itself or to a later quarter: the first quarter has none before it.
    const back = await started(f, 'ir.one', clientB, earlier, {
      correctionReason: 'Restated after the release',
    });
    const corrected = await run(f, 'ir.one', back.id, { command: 'generate' });
    expect(contentOf(corrected).priorRelease).toBeNull();
    expect(
      corrected.findings.find((x) => x.rule === 'QA-TIE-01' && x.entityRef === 'package'),
    ).toMatchObject({ passed: true });
  });
});

describe('reporting packages in the preview: what the page session keeps', () => {
  it('replays a repeated start for the same key, and refuses the key with another body', async () => {
    const { f } = session();
    const body = { clientId: clientA, periodEnd: period, basis: 'gross', label: 'preliminary' };
    const key = { 'idempotency-key': 'package-start-0001' };
    const first = await send(f, 'ir.one', 'POST', BASE, body, key);
    const draft = detailOf(first, 201);
    const again = await send(f, 'ir.one', 'POST', BASE, body, key);
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotency-replayed')).toBe('true');
    expect(reportPackageDetail.parse(again.json)).toEqual(draft);
    expect((await send(f, 'ir.one', 'POST', BASE, { ...body, basis: 'net' }, key)).status).toBe(
      422,
    );
    expect(reportPackageList.parse((await send(f, 'ir.one', 'GET', BASE)).json).items).toHaveLength(
      1,
    );

    // A command repeated with its key runs once: one run, not two.
    const generate = { 'idempotency-key': 'package-generate-0001' };
    const path = `${BASE}/${draft.id}/commands`;
    const ran = detailOf(await send(f, 'ir.one', 'POST', path, { command: 'generate' }, generate));
    const replay = await send(f, 'ir.one', 'POST', path, { command: 'generate' }, generate);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    expect(reportPackageDetail.parse(replay.json)).toEqual(ran);
    expect(detailOf(await send(f, 'ir.one', 'GET', `${BASE}/${draft.id}`)).changeLog).toHaveLength(
      1,
    );
  });

  it('forgets every package on reset', async () => {
    const { f, state } = session();
    await started(f, 'ir.one', clientA, period);
    expect(state.reportPackages.size).toBe(1);
    expect((await send(f, 'ir.one', 'POST', '/api/v1/preview/reset')).status).toBe(200);
    expect(state.reportPackages.size).toBe(0);
    expect(reportPackageList.parse((await send(f, 'ops.one', 'GET', BASE)).json).items).toEqual([]);
    // And the client, quarter and basis are free again.
    await started(f, 'ir.one', clientA, period);
  });

  it('answers 503 for a generate while the preview carries no book, and changes nothing', async () => {
    const { f } = session(generated, null);
    const draft = await started(f, 'ir.one', clientA, period);
    const refused = await command(f, 'ir.one', draft.id, { command: 'generate' });
    expect(refused.status).toBe(503);
    expect(problemOf(refused).code).toBe('unavailable');
    expect(detailOf(await send(f, 'ir.one', 'GET', `${BASE}/${draft.id}`))).toEqual(draft);
    // The machine still speaks first: a role it refuses is 403, not 503.
    expect((await command(f, 'ops.one', draft.id, { command: 'generate' })).status).toBe(403);
  });

  it('answers 503 for an approval where the browser offers no SHA-256, never an invented hash', async () => {
    const { f } = session();
    const draft = await started(f, 'ir.one', clientB, prior);
    if ((await run(f, 'ir.one', draft.id, { command: 'generate' })).state === 'QAFailed')
      await run(f, 'head.one', draft.id, { command: 'overrideQa', reason: 'Understood' });
    const d = await run(f, 'ir.one', draft.id, { command: 'submit' });
    const real = globalThis.crypto;
    // A page opened over plain http has no SubtleCrypto.
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
    try {
      const refused = await command(f, 'head.one', draft.id, { command: 'approve' });
      expect(refused.status).toBe(503);
      expect(problemOf(refused).code).toBe('unavailable');
      // The refusals of the machine come first, as everywhere.
      expect((await command(f, 'ir.one', draft.id, { command: 'approve' })).status).toBe(403);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(detailOf(await send(f, 'ir.one', 'GET', `${BASE}/${draft.id}`))).toEqual(d);
    // On a secure page the same approval goes through.
    expect((await run(f, 'head.one', draft.id, { command: 'approve' })).contentHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

/* ---- The hand-built world: marks that change inside the session ---- */

const person = (
  n: number,
  externalId: string,
  displayName: string,
  roles: string[],
): PreviewUser => ({
  externalId,
  userId: `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  displayName,
  roles,
});
const IR = person(21, 'ir.test', 'Test Investor Relations', ['investor_relations']);
/** Holds both roles, so the rule that the reviewer is never the preparer is the only thing in the way. */
const IR_HEAD = person(22, 'ir.head', 'Test Preparer And Approver', [
  'investor_relations',
  'approver',
]);
/** Reads every client through a second role, and is entitled to none. */
const IR_DEAL = person(23, 'ir.deal', 'Test Unentitled', ['investor_relations', 'deal_team']);
const Q2 = '2025-06-30';
const Q1 = '2025-03-31';

/**
 * The hand-built world of the other preview tests, with three investor relations users added:
 * their sign-ins, the one client (a fifth of the one vehicle every position is in) and the
 * one-pagers they may open, which is every position but the walled one.
 */
function handBuilt(): { fixtures: PreviewFixtures; book: PreviewBook } {
  const world = buildWorld();
  const fixtures: PreviewFixtures = {
    ...world.fixtures,
    users: [...world.fixtures.users, IR, IR_HEAD, IR_DEAL],
    bodies: { ...world.fixtures.bodies },
    responses: { ...world.fixtures.responses },
  };
  let n = 0;
  const add = (credential: string, path: string, body: unknown, status = 200): void => {
    const hash = `packages-${++n}`;
    fixtures.bodies[hash] = JSON.stringify(body);
    fixtures.responses[getKey(credential, path)] = {
      status,
      contentType: status === 200 ? 'application/json' : 'application/problem+json',
      body: hash,
    };
  };
  const clients: ClientList = {
    asOf: Q2,
    calcVersion: 'test',
    items: [
      {
        id: IDS.client,
        name: 'Test Client One',
        reportingBases: ['gross'],
        reportingCadence: 'quarterly',
        vehicles: [
          {
            vehicleId: IDS.vehicle,
            vehicleName: 'Test Vehicle I',
            vehicleType: 'vehicle_type.co_invest_fund',
            commitment: '5000.00',
            closingNumber: 1,
            ownershipPct: '0.20000000',
            commitmentDate: '2022-06-30',
            invested: null,
            distributions: null,
            nav: null,
            grossMoic: null,
          },
        ],
        totals: {
          commitment: null,
          invested: null,
          distributions: null,
          nav: null,
          grossMoic: null,
        },
      },
    ],
  };
  for (const user of [IR, IR_HEAD, IR_DEAL]) {
    const c = user.externalId;
    add(c, '/api/v1/auth/me', {
      userId: user.userId,
      externalId: c,
      displayName: user.displayName,
      roles: user.roles,
      clientIds: user === IR_DEAL ? [] : [IDS.client],
      mockIdentity: true,
    });
    add(c, '/api/v1/clients', clients);
    for (const inv of Object.values(world.investments)) {
      const path = `/api/v1/investments/${inv.id}`;
      if (inv.id === IDS.walled) add(c, path, notFoundBody(path), 404);
      else add(c, path, inv);
    }
  }
  // The book names the positions; the figures still come from each reader's own recordings.
  const blank = testBook();
  const listed = Object.values(world.investments).map((inv) => ({
    id: inv.id,
    investmentNumber: inv.investmentNumber,
    companyName: inv.companyName,
    canonicalName: inv.companyName.toLowerCase(),
    aliases: [],
    dealType: inv.dealType,
    currency: 'USD',
    entryDate: inv.entryDate,
    exitDate: inv.exitDate,
    isActive: inv.isActive,
    sector: null,
    geography: null,
    sponsorId: inv.sponsorId,
    sponsorFundId: inv.sponsorFundId,
    vehicleId: inv.vehicleId,
    vehicleName: inv.vehicleName,
  }));
  return { fixtures, book: { ...blank, investments: listed } };
}

function handSession(): Session {
  const world = handBuilt();
  return session(world.fixtures, world.book);
}
const lineOf = (d: ReportPackageDetail, ref: string) =>
  contentOf(d).lines.find((l) => l.ref === ref);
const HAND_TEAM = {
  preparer: IR.externalId,
  approver: USERS.head.externalId,
  releaser: USERS.ops.externalId,
};

describe('reporting packages in the preview: the record as the session leaves it', () => {
  it('reads a mark locked in the session when the package is generated again', async () => {
    const { f } = handSession();
    const draft = await started(f, IR.externalId, IDS.client, Q2);
    let d = await run(f, IR.externalId, draft.id, { command: 'generate' });
    // No Locked mark for the quarter: the March mark of 1,000.00 is carried, with its footnote.
    expect(lineOf(d, 'INV-0001')).toMatchObject({
      beginNav: '1000',
      endNav: '1000',
      endNavPeriodEnd: Q1,
      gainLoss: '0',
    });
    expect(contentOf(d).footnotes).toContainEqual({ ref: 'INV-0001', code: STALE_FOOTNOTE });
    // A fifth of 1,000.00 is the client's.
    expect(contentOf(d).clientLines).toContainEqual({
      clientRef: IDS.client,
      ref: 'INV-0001',
      ownershipPct: '0.20000000',
      nav: '200',
    });
    // The walled position is not in the preparer's package; the exited one left before the quarter.
    expect(contentOf(d).lines.map((l) => l.ref)).toEqual([
      'INV-0001',
      'INV-LOCK',
      'INV-STATES',
      'INV-TWO',
    ]);
    expect(d.state).toBe('QAFailed');

    // Operations prepare the June mark, the deal team approves it and the approver locks it.
    const mark = valuationRow.parse(
      (
        await send(f, USERS.ops.externalId, 'POST', '/api/v1/valuations', {
          investmentId: IDS.open,
          periodEnd: Q2,
          method: 'valuation_method.sponsor_mark',
          fairValue: '1200.00',
        })
      ).json,
    );
    const step = async (who: string, cmd: string): Promise<void> => {
      const answer = await send(f, who, 'POST', `/api/v1/valuations/${mark.id}/commands`, {
        command: cmd,
      });
      expect(answer.status, `${cmd}: ${answer.text}`).toBe(200);
    };
    await step(USERS.ops.externalId, 'prepare');
    // Not Locked yet: a mark on its way is not a mark a package may read.
    d = await run(f, IR.externalId, draft.id, { command: 'regenerate' });
    expect(lineOf(d, 'INV-0001')).toMatchObject({ endNav: '1000', endNavPeriodEnd: Q1 });
    await step(USERS.deal.externalId, 'dealTeamApprove');
    await step(USERS.head.externalId, 'lock');

    // The package stands as generated until it is generated again.
    expect(
      lineOf(detailOf(await send(f, IR.externalId, 'GET', `${BASE}/${draft.id}`)), 'INV-0001'),
    ).toMatchObject({ endNav: '1000' });
    d = await run(f, IR.externalId, draft.id, { command: 'regenerate' });
    // 1,200.00 - 1,000.00 - 0.00 + 0.00 = 200.00, and a fifth of 1,200.00 is 240.00.
    expect(lineOf(d, 'INV-0001')).toMatchObject({
      beginNav: '1000',
      endNav: '1200',
      endNavPeriodEnd: Q2,
      gainLoss: '200',
    });
    expect(contentOf(d).footnotes.map((n) => n.ref)).not.toContain('INV-0001');
    expect(contentOf(d).clientLines.find((c) => c.ref === 'INV-0001')?.nav).toBe('240');
    expect(d.qa.runNo).toBe(3);
  });

  it('fails the tie-out of a position whose start mark was reopened after the release, until it is explained', async () => {
    const { f } = handSession();
    // The March package is released with the position at its Locked mark of 1,000.00.
    const first = await started(f, IR.externalId, IDS.client, Q1);
    const firstReleased = await released(f, HAND_TEAM, first.id);
    expect(lineOf(firstReleased, 'INV-0001')?.endNav).toBe('1000');

    // The approver then reopens that mark: the position has no Locked mark at the quarter start.
    const reopened = await send(
      f,
      USERS.head.externalId,
      'POST',
      `/api/v1/valuations/${IDS.valuation.openPrior}/commands`,
      { command: 'reopen', reason: 'Restated by the sponsor' },
    );
    expect(reopened.status, reopened.text).toBe(200);

    const next = await started(f, IR.externalId, IDS.client, Q2);
    let d = await run(f, IR.externalId, next.id, { command: 'generate' });
    expect(contentOf(d).priorRelease?.endNav['INV-0001']).toBe('1000');
    // Nothing to start from and nothing to carry: the missing value, never zero.
    expect(lineOf(d, 'INV-0001')).toMatchObject({ beginNav: null, endNav: null, gainLoss: null });
    const tie = (x: ReportPackageDetail) =>
      x.findings.find((y) => y.rule === 'QA-TIE-01' && y.entityRef === 'INV-0001');
    expect(tie(d)).toMatchObject({
      passed: false,
      expected: '1000',
      actual: null,
      detail: 'The line shows no begin NAV to tie to the last released package.',
    });

    d = await run(f, IR.externalId, next.id, {
      command: 'regenerate',
      explanations: { 'INV-0001': 'The March mark was reopened after the release' },
    });
    expect(tie(d)).toMatchObject({
      passed: true,
      detail: 'One side of the tie-out is missing and an explanation is recorded.',
    });
    expect(d.tieOutExplanations).toEqual({
      'INV-0001': 'The March mark was reopened after the release',
    });
    // The explanation answers the tie-out only: the line still has no figures, so the gate stays shut.
    expect(failedOf(d).has('QA-RDY-01 INV-0001')).toBe(true);
    expect(d.state).toBe('QAFailed');
  });

  it('refuses the preparer as the reviewer, whatever roles they hold', async () => {
    const { f } = handSession();
    const draft = await started(f, IR_HEAD.externalId, IDS.client, Q2);
    expect((await run(f, IR_HEAD.externalId, draft.id, { command: 'generate' })).state).toBe(
      'QAFailed',
    );
    await run(f, USERS.head.externalId, draft.id, { command: 'overrideQa', reason: 'Agreed' });
    let d = await run(f, IR_HEAD.externalId, draft.id, { command: 'submit' });
    const own = await command(f, IR_HEAD.externalId, draft.id, { command: 'approve' });
    expect(own.status).toBe(422);
    expect(problemOf(own)).toEqual({
      code: 'workflow-precondition',
      detail: 'reporting_package: the package preparer cannot approve it (SEC-5.6)',
    });
    expect(detailOf(await send(f, IR.externalId, 'GET', `${BASE}/${draft.id}`))).toEqual(d);
    d = await run(f, USERS.head.externalId, draft.id, { command: 'approve' });
    expect(d).toMatchObject({ state: 'Approved', reviewer: { id: USERS.head.userId } });
  });

  it('holds investor relations to their own clients, even one who reads every client through another role', async () => {
    const { f } = handSession();
    // Not entitled: the client is not theirs to prepare for.
    const refused = await create(f, IR_DEAL.externalId, {
      clientId: IDS.client,
      periodEnd: Q2,
      basis: 'gross',
      label: 'preliminary',
    });
    expect(refused.status).toBe(404);
    expect(problemOf(refused).detail).toBe('Client not found');
    // They read the package through the role that reads every client, and cannot move it.
    const draft = await started(f, IR.externalId, IDS.client, Q2);
    expect(detailOf(await send(f, IR_DEAL.externalId, 'GET', `${BASE}/${draft.id}`))).toEqual(
      draft,
    );
    expect((await command(f, IR_DEAL.externalId, draft.id, { command: 'generate' })).status).toBe(
      404,
    );
    expect(detailOf(await send(f, IR.externalId, 'GET', `${BASE}/${draft.id}`))).toEqual(draft);
  });
});
