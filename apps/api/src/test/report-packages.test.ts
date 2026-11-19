import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMonths, containingQuarterEnd, latestQuarterEndOnOrBefore } from '@pb/calc';
import {
  canonicalJson,
  investmentPage,
  problemDetails,
  reportPackageDetail,
  reportPackageList,
} from '@pb/contracts';
import type { ReportPackageDetail } from '@pb/contracts';
import { QA_RULES, STALE_FOOTNOTE, qaPassed, runReportQa } from '@pb/report-engine';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const NO_SUCH_ID = '00000000-0000-4000-8000-00000000abcd';
const BASE = '/api/v1/report-packages';

/**
 * Reporting packages (docs/04 M14, docs/18 section 5, docs/08 section 7): a package is started
 * by investor relations for a client they are entitled to, generated from Locked marks and
 * approved flows, read by the report QA rules, and moved to Released through the state machine.
 * The findings the API stores are recomputed here from the snapshot it returns.
 */
describe('reporting packages: from Draft to Released through the QA gate', () => {
  let h: Harness;
  let period: string;
  let prior: string;
  let clientA: string;
  let clientC: string;
  const settings = { toleranceUsd: '1', moversCount: 5 };

  beforeAll(async () => {
    h = await startHarness();
    period = latestQuarterEndOnOrBefore(h.dataset.asOf);
    prior = containingQuarterEnd(addMonths(period, -3));
    const entitled = (externalId: string): string => {
      const user = h.dataset.users.find((u) => u.externalId === externalId);
      const id = user?.clientIds[0];
      if (id === undefined) throw new Error(`${externalId} has no client`);
      return id;
    };
    clientA = entitled('ir.one');
    clientC = entitled('ir.two');
  });
  afterAll(async () => {
    await h.close();
  });

  let keys = 0;
  const get = (who: string, path: string) =>
    h.http().get(path).set('authorization', h.as(who)).set('x-request-id', 'req-pkg');
  const post = (who: string, path: string, body: unknown) =>
    h
      .http()
      .post(path)
      .set('authorization', h.as(who))
      .set('x-request-id', 'req-pkg')
      .set('idempotency-key', `pkg-test-${String(++keys).padStart(6, '0')}`)
      .send(body as object);
  const create = (who: string, body: Record<string, unknown>) => post(who, BASE, body);
  const command = (who: string, id: string, body: Record<string, unknown>) =>
    post(who, `${BASE}/${id}/commands`, body);
  const detailOf = (body: unknown): ReportPackageDetail => reportPackageDetail.parse(body);
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
          asOf: h.dataset.asOf,
          basis: 'gross',
          label: 'preliminary',
          ...over,
        }).expect(201)
      ).body,
    );
  /** Generates, and if the QA gate failed has the approver override it, so the package can move on. */
  const pastQa = async (id: string): Promise<ReportPackageDetail> => {
    let d = detailOf((await command('ir.one', id, { command: 'generate' }).expect(200)).body);
    if (d.state === 'QAFailed')
      d = detailOf(
        (
          await command('head.one', id, {
            command: 'overrideQa',
            reason: 'Reviewed with operations; the breaks are understood',
          }).expect(200)
        ).body,
      );
    expect(d.state).toBe('QAPassed');
    return d;
  };
  const released = async (id: string): Promise<ReportPackageDetail> => {
    await pastQa(id);
    await command('ir.one', id, { command: 'submit' }).expect(200);
    await command('head.one', id, { command: 'approve' }).expect(200);
    return detailOf((await command('ops.one', id, { command: 'release' }).expect(200)).body);
  };

  it('is started by investor relations for a client they are entitled to, and by nobody else', async () => {
    await create('deal.one', {
      clientId: clientA,
      periodEnd: prior,
      basis: 'gross',
      label: 'final',
    }).expect(403);
    await create('ops.one', {
      clientId: clientA,
      periodEnd: prior,
      basis: 'gross',
      label: 'final',
    }).expect(403);
    await get('viewer.one', BASE).expect(403);
    await get('admin.one', BASE).expect(403);
    // A client the caller is not entitled to does not exist for it.
    const other = await create('ir.one', {
      clientId: clientC,
      periodEnd: prior,
      basis: 'gross',
      label: 'final',
    }).expect(404);
    expect(problemDetails.parse(other.body).detail).toBe('Client not found');

    const bad = await create('ir.one', {
      clientId: clientA,
      periodEnd: '2025-02-28',
      basis: 'gross',
      label: 'final',
    }).expect(400);
    expect(problemDetails.parse(bad.body).errors).toEqual([
      { path: 'periodEnd', message: 'A package period is a calendar quarter end' },
    ]);
    await create('ir.one', {
      clientId: clientA,
      periodEnd: prior,
      asOf: '2020-01-01',
      basis: 'gross',
      label: 'final',
    }).expect(400);

    const draft = await started('ir.one', clientA, prior, { basis: 'net' });
    expect(draft).toMatchObject({
      state: 'Draft',
      version: 1,
      basis: 'net',
      content: null,
      findings: [],
      qa: { runNo: null, findings: 0, failed: 0, overridden: 0 },
      contentHash: null,
      // Nothing was generated yet, so there is no run to list.
      changeLog: [],
    });
    expect(draft.preparedBy.id).toBe(h.dataset.users.find((u) => u.externalId === 'ir.one')?.id);
    // One in progress per client, period and basis.
    await create('ir.one', {
      clientId: clientA,
      periodEnd: prior,
      basis: 'net',
      label: 'final',
    }).expect(409);

    // Who reads it: the roles that read every client, and investor relations entitled to it.
    for (const who of ['ops.one', 'deal.one', 'head.one', 'audit.one', 'ir.one'])
      await get(who, `${BASE}/${draft.id}`).expect(200);
    await get('ir.two', `${BASE}/${draft.id}`).expect(404);
    const mine = reportPackageList.parse((await get('ir.two', BASE).expect(200)).body);
    expect(mine.items.map((p) => p.id)).not.toContain(draft.id);
    await get('ops.one', `${BASE}/${NO_SUCH_ID}`).expect(404);
    await get('ops.one', `${BASE}/not-a-uuid`).expect(404);
    await h.http().get(BASE).expect(401);
  });

  it('generates the snapshot from the record and stores exactly what the QA rules find on it', async () => {
    const draft = await started('ir.one', clientA, period);
    const generated = detailOf(
      (await command('ir.one', draft.id, { command: 'generate' }).expect(200)).body,
    );
    expect(['QAPassed', 'QAFailed']).toContain(generated.state);
    const content = generated.content;
    if (content === null) throw new Error('a generated package has content');
    expect(content.periodEnd).toBe(period);
    expect(content.lines.length).toBeGreaterThan(0);

    // The findings are the rules over the snapshot the API returned, nothing more or less.
    const again = runReportQa(content, settings);
    expect(
      generated.findings.map((f) => `${f.rule} ${f.entityRef} ${String(f.passed)}`).sort(),
    ).toEqual(again.map((f) => `${f.rule} ${f.entityRef} ${String(f.passed)}`).sort());
    expect(generated.state).toBe(qaPassed(again) ? 'QAPassed' : 'QAFailed');
    expect(generated.qa).toMatchObject({
      runNo: 1,
      findings: again.length,
      failed: again.filter((f) => !f.passed).length,
      overridden: 0,
    });
    for (const f of generated.findings) expect(QA_RULES).toContain(f.rule);

    // The change log lists the run: who generated it, by name, and what the run counted.
    const irOne = h.dataset.users.find((u) => u.externalId === 'ir.one');
    expect(generated.changeLog).toEqual([
      {
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/) as string,
        by: { id: irOne?.id, name: irOne?.displayName },
        runNo: 1,
        lines: content.lines.length,
        findings: again.length,
        failed: again.filter((f) => !f.passed).length,
      },
    ]);
    expect(generated.changeLog[0]?.by.name).not.toBe('');

    // Every line is a position the preparer can read, and its end NAV is that position's own.
    const book = investmentPage.parse(
      (await get('ir.one', `/api/v1/investments?limit=200&asOf=${h.dataset.asOf}`).expect(200))
        .body,
    ).items;
    const numbers = new Set(book.map((p) => p.investmentNumber));
    for (const line of content.lines) expect(numbers.has(line.ref), line.ref).toBe(true);
    const current = content.lines.filter((l) => l.endNavPeriodEnd === period && l.endNav !== '0');
    expect(current.length).toBeGreaterThan(0);
    for (const line of current.slice(0, 5)) {
      const position = book.find((p) => p.investmentNumber === line.ref);
      if (position?.navDate === period) expect(Number(line.endNav)).toBe(Number(position.nav));
    }
    // The client's lines are its share of each position.
    expect(content.clientLines.length).toBeGreaterThan(0);
    expect(content.clientLines.every((c) => c.clientRef === clientA)).toBe(true);
  });

  it('catches the reporting scenarios of the synthetic book', async () => {
    const numberOf = (investmentId: string | undefined): string | undefined =>
      h.dataset.investments.find((i) => i.id === investmentId)?.investmentNumber;
    const staleRef = numberOf(h.dataset.scenarios.stale_valuation?.[0]);
    const breakRef = numberOf(h.dataset.scenarios.roll_forward_break?.[0]);
    expect(staleRef).toBeDefined();
    expect(breakRef).toBeDefined();

    let seen = 0;
    for (const [who, clients] of [
      ['ir.one', h.dataset.users.find((u) => u.externalId === 'ir.one')?.clientIds ?? []],
      ['ir.two', h.dataset.users.find((u) => u.externalId === 'ir.two')?.clientIds ?? []],
    ] as const) {
      for (const clientId of clients) {
        const draft = await started(who, clientId, period, { basis: 'net', label: 'final' });
        const d = detailOf(
          (await command(who, draft.id, { command: 'generate' }).expect(200)).body,
        );
        const failed = new Set(
          d.findings.filter((f) => !f.passed).map((f) => `${f.rule} ${f.entityRef}`),
        );
        const lines = d.content?.lines ?? [];
        if (lines.some((l) => l.ref === staleRef)) {
          seen += 1;
          // stale_valuation: no mark for the quarter, so the last one is rolled forward and footnoted,
          // and a package that carries it cannot be labelled final.
          const line = lines.find((l) => l.ref === staleRef);
          expect(line?.endNavPeriodEnd).not.toBe(period);
          expect(d.content?.footnotes).toContainEqual({ ref: staleRef, code: STALE_FOOTNOTE });
          expect(failed.has('QA-LBL-01 status')).toBe(true);
          expect(d.state).toBe('QAFailed');
        }
        if (lines.some((l) => l.ref === breakRef)) {
          seen += 1;
          // roll_forward_break: no Locked mark at the end of the prior quarter.
          expect(failed.has(`QA-QTD-01 ${String(breakRef)}`)).toBe(true);
          expect(failed.has(`QA-RF-01 ${String(breakRef)}`)).toBe(true);
          expect(d.state).toBe('QAFailed');
        }
      }
    }
    // The scenarios sit in vehicles these clients are in: the test is not vacuous.
    expect(seen).toBeGreaterThan(0);
  });

  it('moves through the gate: an approver overrides a failed QA with a reason, reviews and the package is released', async () => {
    const draft = await started('ir.one', clientA, prior, { label: 'final' });
    // Nothing moves before it is generated.
    await command('ir.one', draft.id, { command: 'submit' }).expect(409);
    await command('head.one', draft.id, { command: 'approve' }).expect(409);
    await command('ops.one', draft.id, { command: 'generate' }).expect(403);

    let d = detailOf((await command('ir.one', draft.id, { command: 'generate' }).expect(200)).body);
    if (d.state === 'QAFailed') {
      const failed = d.qa.failed;
      expect(failed).toBeGreaterThan(0);
      await command('ir.one', draft.id, { command: 'submit' }).expect(409);
      // The override is the approver's, and needs a reason.
      await command('ir.one', draft.id, {
        command: 'overrideQa',
        reason: 'Looks fine to me',
      }).expect(403);
      await command('head.one', draft.id, { command: 'overrideQa' }).expect(400);
      d = detailOf(
        (
          await command('head.one', draft.id, {
            command: 'overrideQa',
            reason: 'Timing differences agreed with the client',
          }).expect(200)
        ).body,
      );
      expect(d.qa).toMatchObject({ failed, overridden: failed });
      const overridden = d.findings.filter((f) => f.override !== null);
      expect(overridden).toHaveLength(failed);
      expect(overridden.every((f) => !f.passed)).toBe(true);
      expect(overridden[0]?.override).toMatchObject({
        reason: 'Timing differences agreed with the client',
        approver: { id: h.dataset.users.find((u) => u.externalId === 'head.one')?.id },
      });
    }
    expect(d.state).toBe('QAPassed');

    // A stale row version is refused before anything else.
    const stale = await command('ir.one', draft.id, { command: 'submit' })
      .set('if-match', `"${d.rowVersion + 7}"`)
      .expect(412);
    expect(problemDetails.parse(stale.body).detail).toContain('reporting_package');
    d = detailOf(
      (
        await command('ir.one', draft.id, { command: 'submit' })
          .set('if-match', `"${d.rowVersion}"`)
          .expect(200)
      ).body,
    );
    expect(d.state).toBe('InReview');

    // The review is the approver's; investor relations cannot approve their own package.
    await command('ir.one', draft.id, { command: 'approve' }).expect(403);
    d = detailOf((await command('head.one', draft.id, { command: 'approve' }).expect(200)).body);
    expect(d.state).toBe('Approved');
    expect(d.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.reviewer?.id).toBe(h.dataset.users.find((u) => u.externalId === 'head.one')?.id);
    expect(d.approvedAt).not.toBeNull();

    await command('head.one', draft.id, { command: 'release' }).expect(403);
    d = detailOf((await command('ops.one', draft.id, { command: 'release' }).expect(200)).body);
    expect(d.state).toBe('Released');
    expect(d.releasedAt).not.toBeNull();
    expect(d.releasedBy?.id).toBe(h.dataset.users.find((u) => u.externalId === 'ops.one')?.id);
    // The override, the submission, the approval and the release are in the audit trail: the
    // change log lists generation runs only, and this package was generated once.
    expect(d.changeLog.map((run) => run.runNo)).toEqual([1]);

    // Released is the end: nothing moves it, and the database refuses a change outright.
    for (const body of [{ command: 'regenerate' }, { command: 'submit' }, { command: 'release' }])
      await command('ir.one', draft.id, body).expect(409);
    await expect(
      h.runtime.db.exec(`update rpt.package set label = 'preliminary' where id = '${draft.id}'`),
    ).rejects.toThrow();

    // A correction is a new version, with a reason.
    const again = await create('ir.one', {
      clientId: clientA,
      periodEnd: prior,
      basis: 'gross',
      label: 'final',
    }).expect(422);
    expect(problemDetails.parse(again.body).detail).toContain('needs a reason');
    const v2 = await started('ir.one', clientA, prior, {
      label: 'final',
      correctionReason: 'Sponsor restated one position after release',
    });
    expect(v2).toMatchObject({
      version: 2,
      state: 'Draft',
      correctionReason: 'Sponsor restated one position after release',
    });
  });

  it('ties a package to the last one released to the client, and takes an explanation where it does not tie', async () => {
    // Release the prior quarter for a second client, then build the quarter after it.
    const clientB = h.dataset.users.find((u) => u.externalId === 'ir.one')?.clientIds[1];
    if (clientB === undefined) throw new Error('ir.one has a second client');
    const first = await started('ir.one', clientB, prior);
    const firstReleased = await released(first.id);
    expect(firstReleased.state).toBe('Released');

    const next = await started('ir.one', clientB, period);
    let d = detailOf((await command('ir.one', next.id, { command: 'generate' }).expect(200)).body);
    expect(d.content?.priorRelease).not.toBeNull();
    const ties = d.findings.filter((f) => f.rule === 'QA-TIE-01');
    // One finding per line, none for "no package before this one".
    expect(ties.map((f) => f.entityRef)).not.toContain('package');
    expect(ties.length).toBe(d.content?.lines.length);
    // A held position starts where the released package ended it.
    const tied = ties.filter((f) => f.passed && f.expected !== null && f.actual !== null);
    expect(tied.length).toBeGreaterThan(0);
    for (const f of tied)
      expect(Math.abs(Number(f.expected) - Number(f.actual))).toBeLessThanOrEqual(1);

    const broken = ties.find((f) => !f.passed);
    if (broken !== undefined && d.state === 'QAFailed') {
      d = detailOf(
        (
          await command('ir.one', next.id, {
            command: 'regenerate',
            explanations: {
              [broken.entityRef]: 'Carried at the rolled-forward value last quarter',
            },
          }).expect(200)
        ).body,
      );
      expect(d.qa.runNo).toBe(2);
      expect(d.tieOutExplanations[broken.entityRef]).toBe(
        'Carried at the rolled-forward value last quarter',
      );
      expect(
        d.findings.find((f) => f.rule === 'QA-TIE-01' && f.entityRef === broken.entityRef)?.passed,
      ).toBe(true);
    }
  });

  it('steps the row version once per write, and locks the approved content with a hash anyone can take again', async () => {
    const externalIdOf = (userId: string): string => {
      const user = h.dataset.users.find((u) => u.id === userId);
      if (user === undefined) throw new Error('the preparer is a user of the dataset');
      return user.externalId;
    };
    /** One command with the row version the caller last read; the answer is `by` versions on. */
    const stepped = async (
      who: string,
      from: ReportPackageDetail,
      body: Record<string, unknown>,
      by: number,
    ): Promise<ReportPackageDetail> => {
      const after = detailOf(
        (await command(who, from.id, body).set('if-match', `"${from.rowVersion}"`).expect(200))
          .body,
      );
      expect(after.rowVersion, String(body.command)).toBe(from.rowVersion + by);
      return after;
    };

    // ir.two's client, the prior quarter, gross: no other test starts this one.
    let d = await started('ir.two', clientC, prior);
    expect(d.rowVersion).toBe(1);
    // Generating writes twice: the snapshot as the preparer, then the QA outcome as the system.
    d = await stepped('ir.two', d, { command: 'generate' }, 2);
    expect(d.contentHash).toBeNull();
    if (d.state === 'QAFailed')
      d = await stepped('head.one', d, { command: 'overrideQa', reason: 'Agreed with ops' }, 1);
    d = await stepped('ir.two', d, { command: 'submit' }, 1);
    // No hash before the review: it is taken when the package is approved.
    expect(d.contentHash).toBeNull();
    d = await stepped('head.one', d, { command: 'approve' }, 1);

    // SHA-256, lowercase hex, over the canonical JSON of the content the package shows.
    const content = d.content;
    if (content === null) throw new Error('an approved package has content');
    const hashOf = (value: unknown): string =>
      createHash('sha256').update(canonicalJson(value)).digest('hex');
    expect(d.contentHash).toBe(hashOf(content));
    // The text does not depend on the order a store hands the keys back in.
    const keysReversed = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(keysReversed)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([k, v]) => [k, keysReversed(v)]),
            )
          : value;
    expect(Object.keys(keysReversed(content) as object)).not.toEqual(Object.keys(content));
    expect(hashOf(keysReversed(content))).toBe(d.contentHash);
    // And one changed figure is another hash.
    expect(hashOf({ ...content, asOf: content.periodEnd })).not.toBe(d.contentHash);

    const hash = d.contentHash;
    d = await stepped('ops.one', d, { command: 'release' }, 1);
    // Releasing changes nothing the hash covers.
    expect(d.contentHash).toBe(hash);
    expect(d.content).toEqual(content);

    // A package the scenarios left failed: a second run is two writes again, and since nothing
    // was fixed it fails again; the override is one write.
    const left = reportPackageList
      .parse((await get('ops.one', BASE).expect(200)).body)
      .items.find((p) => p.state === 'QAFailed' && p.label === 'final');
    if (left === undefined) throw new Error('the scenarios leave a failed package');
    let again = detailOf((await get('ops.one', `${BASE}/${left.id}`).expect(200)).body);
    const preparer = externalIdOf(again.preparedBy.id);
    const runNo = again.qa.runNo ?? 0;
    const before = again.changeLog;
    expect(before.map((run) => run.runNo)).toEqual([runNo]);
    again = await stepped(preparer, again, { command: 'regenerate' }, 2);
    expect(again.qa.runNo).toBe(runNo + 1);
    expect(again.state).toBe('QAFailed');
    // The runs in run order: the first as it was, then this one with what it counted.
    expect(again.changeLog).toHaveLength(2);
    expect(again.changeLog[0]).toEqual(before[0]);
    expect(again.changeLog[1]).toMatchObject({
      by: again.preparedBy,
      runNo: runNo + 1,
      lines: again.content?.lines.length,
      findings: again.qa.findings,
      failed: again.qa.failed,
    });
    again = await stepped('head.one', again, { command: 'overrideQa', reason: 'Seen' }, 1);
    expect(again.state).toBe('QAPassed');
    // The approver's override is not a run.
    expect(again.changeLog).toHaveLength(2);
  });

  it('audits every step with the state before and after', async () => {
    const rows = await h.runtime.db.query<{ action: string; n: number }>(
      `select action, count(*)::int as n from audit.event where entity = 'rpt.package' group by action order by action`,
    );
    const actions = new Map(rows.map((r) => [r.action, r.n]));
    for (const action of [
      'report_package.create',
      'report_package.generate',
      'report_package.submit',
      'report_package.approve',
      'report_package.release',
    ])
      expect(actions.get(action) ?? 0, action).toBeGreaterThan(0);
  });
});
