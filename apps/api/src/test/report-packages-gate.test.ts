import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, containingQuarterEnd, latestQuarterEndOnOrBefore } from '@pb/calc';
import {
  problemDetails,
  reportPackageDetail,
  reportPackageList,
  reportPackageRow,
} from '@pb/contracts';
import type { ReportPackageDetail } from '@pb/contracts';
import type { SyntheticDataset } from '@pb/db';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const BASE = '/api/v1/report-packages';

type User = SyntheticDataset['users'][number];

/**
 * People the seed does not hold. Each of the first four holds investor relations beside a second
 * role, which is where the role lists alone stop telling who may do what; the last two are a
 * second approver and a second investor relations user on ir.one's clients.
 */
function extraUsers(dataset: SyntheticDataset): User[] {
  const clientsOf = (externalId: string): string[] =>
    dataset.users.find((u) => u.externalId === externalId)?.clientIds ?? [];
  const user = (
    n: number,
    externalId: string,
    roles: User['roles'],
    clientIds: string[],
  ): User => ({
    id: `5e000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    externalId,
    displayName: `Test ${externalId.replace(/\./g, ' ')}`,
    email: `${externalId}@portfolio-beach.example`,
    roles,
    clientIds,
  });
  return [
    // Investor relations and approver, entitled to ir.one's clients.
    user(1, 'both.entitled', ['investor_relations', 'approver'], clientsOf('ir.one')),
    // The same two roles, entitled to no client: reads every client through the approver role.
    user(2, 'both.unentitled', ['investor_relations', 'approver'], []),
    // Investor relations entitled to ir.two's client, reading every client through the deal team.
    user(3, 'ir.deal', ['investor_relations', 'deal_team'], clientsOf('ir.two')),
    // Investor relations and operations, entitled to none.
    user(4, 'ir.ops', ['investor_relations', 'operations'], []),
    user(5, 'head.two', ['approver'], []),
    user(6, 'ir.three', ['investor_relations'], clientsOf('ir.one')),
  ];
}

/**
 * Reporting packages, what the verification of decision 0024 found (its section "After the
 * verification"): what the boundary and the gate refuse, for people the seed does not hold. The
 * journey from Draft to Released is in report-packages.test.ts; each test here starts its own
 * packages, for a client, quarter and basis no other test of this file uses.
 */
describe('reporting packages: what the boundary and the gate refuse', () => {
  let h: Harness;
  let period: string;
  let prior: string;
  let earlier: string;
  let clientA: string;
  let clientB: string;
  let clientC: string;

  beforeAll(async () => {
    h = await startHarness({ extraUsers });
    period = latestQuarterEndOnOrBefore(h.dataset.asOf);
    prior = containingQuarterEnd(addMonths(period, -3));
    earlier = containingQuarterEnd(addMonths(prior, -3));
    const clients = h.dataset.users.find((u) => u.externalId === 'ir.one')?.clientIds ?? [];
    const [a, b] = clients;
    if (a === undefined || b === undefined) throw new Error('ir.one has two clients');
    clientA = a;
    clientB = b;
    const c = h.dataset.users.find((u) => u.externalId === 'ir.two')?.clientIds[0];
    if (c === undefined) throw new Error('ir.two has a client');
    clientC = c;
  });
  afterAll(async () => {
    await h.close();
  });

  let keys = 0;
  const get = (who: string, path: string) =>
    h.http().get(path).set('authorization', h.as(who)).set('x-request-id', 'req-pkg-gate');
  const post = (who: string, path: string, body: unknown) =>
    h
      .http()
      .post(path)
      .set('authorization', h.as(who))
      .set('x-request-id', 'req-pkg-gate')
      .set('idempotency-key', `pkg-gate-${String(++keys).padStart(6, '0')}`)
      .send(body as object);
  const create = (who: string, body: Record<string, unknown>) => post(who, BASE, body);
  const command = (who: string, id: string, body: Record<string, unknown>) =>
    post(who, `${BASE}/${id}/commands`, body);
  const detailOf = (body: unknown): ReportPackageDetail => reportPackageDetail.parse(body);
  const read = async (who: string, id: string): Promise<ReportPackageDetail> =>
    detailOf((await get(who, `${BASE}/${id}`).expect(200)).body);
  const started = async (
    who: string,
    clientId: string,
    periodEnd: string,
    over: Record<string, unknown> = {},
  ): Promise<ReportPackageDetail> =>
    detailOf(
      (
        await create(who, {
          clientId,
          periodEnd,
          basis: 'gross',
          label: 'preliminary',
          ...over,
        }).expect(201)
      ).body,
    );
  const run = async (
    who: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<ReportPackageDetail> => detailOf((await command(who, id, body).expect(200)).body);
  /** Generates as its preparer, has the approver override a failed gate, and releases it. */
  const released = async (who: string, id: string): Promise<ReportPackageDetail> => {
    const d = await run(who, id, { command: 'generate' });
    if (d.state === 'QAFailed')
      await run('head.one', id, { command: 'overrideQa', reason: 'Understood with operations' });
    await run(who, id, { command: 'submit' });
    await run('head.one', id, { command: 'approve' });
    return run('ops.one', id, { command: 'release' });
  };
  const versionsOf = async (clientId: string, periodEnd: string): Promise<string[]> =>
    reportPackageList
      .parse((await get('ops.one', BASE).expect(200)).body)
      .items.filter((p) => p.client.id === clientId && p.periodEnd === periodEnd)
      .map((p) => `${p.version} ${p.state}`);

  it('refuses a reason of spaces for a new version with 400 and starts nothing, and keeps a real one trimmed', async () => {
    const first = await started('ir.one', clientA, earlier);
    expect((await released('ir.one', first.id)).state).toBe('Released');

    const body = { clientId: clientA, periodEnd: earlier, basis: 'gross', label: 'preliminary' };
    // Text of spaces is no reason: the boundary says so, and the record is never asked.
    for (const correctionReason of ['    ', ' ab ']) {
      const refused = await create('ir.one', { ...body, correctionReason }).expect(400);
      expect(
        problemDetails.parse(refused.body).errors?.map((e) => e.path),
        correctionReason,
      ).toEqual(['correctionReason']);
    }
    expect(await versionsOf(clientA, earlier)).toEqual(['1 Released']);

    const v2 = detailOf(
      (await create('ir.one', { ...body, correctionReason: '  Corrected figures  ' }).expect(201))
        .body,
    );
    expect(v2).toMatchObject({ version: 2, state: 'Draft', correctionReason: 'Corrected figures' });
  });

  it('keeps an explanation only for a position the package holds, never a blank one, and trims what it keeps', async () => {
    // Labelled final over the stale position, so the gate fails and the package can be run again.
    const draft = await started('ir.one', clientA, period, { label: 'final' });
    let d = await run('ir.one', draft.id, { command: 'generate' });
    expect(d.state).toBe('QAFailed');
    const ref = d.content?.lines[0]?.ref;
    if (ref === undefined) throw new Error('the package holds a position');

    // A position the package does not hold: refused, and nothing is run or kept.
    for (const unknown of ['INV-9999', 'constructor']) {
      const refused = await command('ir.one', draft.id, {
        command: 'regenerate',
        explanations: { [unknown]: 'Not a position of this package' },
      }).expect(400);
      expect(problemDetails.parse(refused.body).errors, unknown).toEqual([
        {
          path: 'explanations',
          message: 'An explanation names a position the package does not hold',
        },
      ]);
    }
    // Text of spaces is no explanation.
    await command('ir.one', draft.id, {
      command: 'regenerate',
      explanations: { [ref]: '     ' },
    }).expect(400);
    expect(await read('ir.one', draft.id)).toEqual(d);

    d = await run('ir.one', draft.id, {
      command: 'regenerate',
      explanations: { [ref]: '  Restated by the sponsor  ' },
    });
    expect(d.tieOutExplanations).toEqual({ [ref]: 'Restated by the sponsor' });
    // A blank one sent later is refused, so the one on record stays.
    await command('ir.one', draft.id, {
      command: 'regenerate',
      explanations: { [ref]: '   ' },
    }).expect(400);
    expect((await read('ir.one', draft.id)).tieOutExplanations).toEqual({
      [ref]: 'Restated by the sponsor',
    });

    // An override reason is kept without the spaces around it too.
    d = await run('head.one', draft.id, { command: 'overrideQa', reason: '  agreed with ops  ' });
    expect(d.findings.find((f) => f.override !== null)?.override?.reason).toBe('agreed with ops');
  });

  it('lists each package as the row of the contract and nothing more', async () => {
    const draft = await started('ir.one', clientB, earlier);
    await run('ir.one', draft.id, { command: 'generate' });
    const body = (await get('ops.one', BASE).expect(200)).body as {
      items: Record<string, unknown>[];
    };
    expect(body.items.length).toBeGreaterThan(0);
    // No snapshot, no stored row: a list read carries what the list shows.
    const keys = Object.keys(reportPackageRow.shape).sort();
    for (const item of body.items) expect(Object.keys(item).sort()).toEqual(keys);
    expect(Object.keys(body)).toEqual(['items']);
  });

  it('answers 404 to investor relations who start a package for a client they are not entitled to, whatever second role they hold', async () => {
    const body = { clientId: clientA, periodEnd: earlier, basis: 'net', label: 'preliminary' };
    // Each reads the client through the second role; none is entitled to it.
    for (const who of ['ir.deal', 'ir.ops', 'both.unentitled']) {
      const refused = await create(who, body).expect(404);
      expect(problemDetails.parse(refused.body).detail, who).toBe('Client not found');
    }
    expect(await versionsOf(clientA, earlier)).not.toContain('1 Draft');
    // Entitled, the same people start one like any investor relations user.
    const own = await started('ir.deal', clientC, earlier, { basis: 'net' });
    expect(own.preparedBy.id).toBe(h.dataset.users.find((u) => u.externalId === 'ir.deal')?.id);
    await started('both.entitled', clientA, earlier, { basis: 'net' });
  });

  it("refuses an as-of date after the API's own date, so a quarter that has not ended is never packaged", async () => {
    const today = h.dataset.asOf;
    const tomorrow = addDays(today, 1);
    // The quarter tomorrow is in has not ended.
    const nextQuarter = containingQuarterEnd(tomorrow);
    const body = { clientId: clientB, basis: 'net', label: 'preliminary' };
    for (const [periodEnd, asOf] of [
      [nextQuarter, nextQuarter],
      [period, tomorrow],
      ['2031-12-31', '2031-12-31'],
    ] as const) {
      const refused = await create('ir.one', { ...body, periodEnd, asOf }).expect(400);
      expect(problemDetails.parse(refused.body).errors, `${periodEnd} ${asOf}`).toEqual([
        { path: 'asOf', message: 'The as-of date is not after today' },
      ]);
    }
    // Without an as-of date a quarter that has not ended is refused as before.
    await create('ir.one', { ...body, periodEnd: nextQuarter }).expect(400);
    expect(await versionsOf(clientB, nextQuarter)).toEqual([]);
    // Today itself is an as-of date like any earlier one.
    const draft = await started('ir.one', clientB, period, { basis: 'net', asOf: today });
    expect(draft.asOf).toBe(today);
  });
});
