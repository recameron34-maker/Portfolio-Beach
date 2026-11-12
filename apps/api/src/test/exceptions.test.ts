import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, toDecimalString } from '@pb/calc';
import {
  dataException,
  dataExceptionPage,
  lookthroughReconcileResult,
  problemDetails,
  weeklyImportResult,
} from '@pb/contracts';
import type { DataException, LookthroughReconcileResult } from '@pb/contracts';
import { lookthroughExtract, weeklyValues } from '@pb/synthetic';
import type { AliasedDataset } from '@pb/synthetic';
import type { SyntheticDataset, Tx } from '@pb/db';
import { ExceptionsService } from '../exceptions/exceptions.service.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const PROBLEM = 'https://portfolio-beach.example/problems/';

/** The harness dataset as the generator typed it: the alias list is present, never undefined (exactOptionalPropertyTypes). */
const aliased = (d: SyntheticDataset): AliasedDataset => {
  const { companyAliases, ...rest } = d;
  return companyAliases === undefined ? rest : { ...rest, companyAliases };
};
const HIGH = 'exception_severity.high';
const MEDIUM = 'exception_severity.medium';

describe('data exceptions (M1 Data Health, docs/18 section 9): the queue the intakes open and operations works', () => {
  let h: Harness;
  let run: LookthroughReconcileResult;
  let walledRun: LookthroughReconcileResult;

  beforeAll(async () => {
    h = await startHarness();
    const folder = join(h.runtime.config.PB_DROP_ROOT, 'lookthrough');
    mkdirSync(folder, { recursive: true });
    // The defects extract opens one exception per difference, unresolved link and unmapped label,
    // none of them on the walled position.
    const defects = lookthroughExtract(aliased(h.dataset), { scenario: 'defects' });
    writeFileSync(join(folder, `${defects.asOf}.json`), defects.json);
    run = await reconcile(defects.asOf, 'req-x-seed-1');
    expect(run.exceptions).toBeGreaterThanOrEqual(6);
    // A second extract that differs from the record on the walled position alone: its one
    // exception sits past the wall (migration 0010, SEC-5.3).
    const clean = lookthroughExtract(aliased(h.dataset), { scenario: 'clean' });
    expect(clean.expectations.walled).toHaveLength(1);
    const rows = clean.rows.map((r) =>
      r.investmentNumber === walledInvestment().investmentNumber
        ? {
            ...r,
            exposureAtNav:
              toDecimalString(D(r.exposureAtNav).times('1.1').toDecimalPlaces(2)) ??
              r.exposureAtNav,
          }
        : r,
    );
    writeFileSync(join(folder, `${clean.asOf}.json`), `${JSON.stringify(rows, null, 2)}\n`);
    walledRun = await reconcile(clean.asOf, 'req-x-seed-2');
    expect(walledRun.exceptions).toBe(1);
    expect(walledRun.hiddenRows).toBe(1);
  });
  afterAll(async () => {
    await h.close();
  });

  const user = (externalId: string) => h.dataset.users.find((u) => u.externalId === externalId)!;
  const walledId = (): string => h.dataset.scenarios.walled_deal![0]!;
  const walledInvestment = () => h.dataset.investments.find((i) => i.id === walledId())!;
  const walledCompanyName = (): string =>
    h.dataset.portfolioCompanies.find((c) => c.id === walledInvestment().portfolioCompanyId)!.name;
  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    (await h.runtime.db.query<{ n: number }>(sql, params))[0]!.n;
  const auditCount = (action: string, requestId: string): Promise<number> =>
    count('select count(*)::int as n from audit.event where action = $1 and request_id = $2', [
      action,
      requestId,
    ]);
  const auditDetails = async (
    action: string,
    requestId: string,
  ): Promise<Record<string, unknown>> =>
    (
      await h.runtime.db.query<{ details: Record<string, unknown>; reason: string | null }>(
        'select details, reason from audit.event where action = $1 and request_id = $2',
        [action, requestId],
      )
    ).map((e) => ({ ...e.details, reason: e.reason }))[0]!;

  async function reconcile(asOf: string, requestId: string): Promise<LookthroughReconcileResult> {
    return lookthroughReconcileResult.parse(
      (
        await h
          .http()
          .post('/api/v1/intake/lookthrough/reconcile')
          .set('authorization', h.as('operations'))
          .set('x-request-id', requestId)
          .send({ asOf })
          .expect(201)
      ).body,
    );
  }
  const listAs = (who: string, query = '', requestId = 'req-x-list') =>
    h
      .http()
      .get(`/api/v1/data-exceptions${query}`)
      .set('authorization', h.as(who))
      .set('x-request-id', requestId);
  const list = async (who: string, query = '') =>
    dataExceptionPage.parse((await listAs(who, query).expect(200)).body);
  const detailAs = (who: string, id: string, requestId = 'req-x-detail') =>
    h
      .http()
      .get(`/api/v1/data-exceptions/${id}`)
      .set('authorization', h.as(who))
      .set('x-request-id', requestId);
  const detail = async (who: string, id: string, requestId = 'req-x-detail') =>
    dataException.parse((await detailAs(who, id, requestId).expect(200)).body);
  const commandAs = (who: string, id: string, body: object, requestId = 'req-x-command') =>
    h
      .http()
      .post(`/api/v1/data-exceptions/${id}/commands`)
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send(body);
  const command = async (id: string, body: object, requestId = 'req-x-command') =>
    dataException.parse((await commandAs('operations', id, body, requestId).expect(200)).body);
  /** The first open exception of a rule, as ops.one sees the queue. */
  const openOf = async (ruleId: string): Promise<DataException> => {
    const found = (await list('ops.one', '?state=open')).items.find((x) => x.ruleId === ruleId);
    if (found === undefined) throw new Error(`no open ${ruleId} exception`);
    return found;
  };
  const walledException = async (): Promise<DataException> => {
    const found = (await list('deal.three')).items.find(
      (x) => x.context.intakeFileId === walledRun.id,
    );
    if (found === undefined) throw new Error('the walled exception is not in the queue');
    return found;
  };

  it('lists what the caller may see, newest first, with its context, its severity from the taxonomy and candidates by reason only', async () => {
    const ops = await list('ops.one');
    expect(ops.items.length).toBe(run.exceptions);
    expect(ops.nextCursor).toBeNull();
    for (const x of ops.items) {
      expect(x.source).toBe('lookthrough_reconcile');
      expect(x.entity).toBe('stg.intake_row');
      expect(x.state).toBe('open');
      expect(x.owner).toBeNull();
      expect(x.externalTicket).toBeNull();
      expect(x.context.intakeFileId).toBe(run.id);
      expect(x.context.intakeFileName).toBe(run.fileName);
      expect(x.context.rowNo).not.toBeNull();
      expect(x.severity).toBe(
        x.ruleId.startsWith('LT-TIE') || x.ruleId.startsWith('LT-XREF') ? HIGH : MEDIUM,
      );
      for (const c of x.candidates) expect(Object.keys(c)).toEqual(['reason']);
      if (x.ruleId.startsWith('LT-XREF')) {
        // An unresolved link names no position: there is none.
        expect(x.context.investmentId).toBeNull();
        expect(x.context.companyName).toBeNull();
      } else {
        expect(x.context.investmentId).not.toBeNull();
        expect(x.context.investmentNumber).not.toBeNull();
        expect(x.context.companyName).not.toBeNull();
      }
    }
    expect(ops.items.map((x) => x.ruleId)).toEqual(
      expect.arrayContaining(['LT-TIE-01', 'LT-TIE-02', 'LT-DIFF-01', 'LT-MAP-01', 'LT-XREF-01']),
    );
    const nearMiss = ops.items.find((x) => x.ruleId === 'LT-XREF-01' && x.candidates.length > 0);
    expect(nearMiss?.candidates).toEqual([{ reason: 'near miss' }]);
    // The walled position's exception is not in the queue of anyone outside the wall.
    expect(JSON.stringify(ops)).not.toContain(walledId());
    expect(JSON.stringify(ops)).not.toContain(walledCompanyName());
    expect(JSON.stringify(ops)).not.toContain(walledRun.id);
    const outsider = await list('deal.one');
    expect(outsider.items.length).toBe(run.exceptions);
    expect(JSON.stringify(outsider)).not.toContain(walledCompanyName());
    // A wall member sees it too, first: it was opened last.
    const member = await list('deal.three');
    expect(member.items.length).toBe(run.exceptions + 1);
    const walled = member.items[0]!;
    expect(walled.context.intakeFileId).toBe(walledRun.id);
    expect(walled.ruleId).toBe('LT-TIE-01');
    expect(walled.context.investmentId).toBe(walledId());
    expect(walled.context.companyName).toBe(walledCompanyName());
    expect(walled.severity).toBe(HIGH);
  });

  it('filters by state, source and severity, and refuses a filter outside the contract', async () => {
    const all = (await list('ops.one')).items;
    expect((await list('ops.one', '?state=open')).items.length).toBe(all.length);
    expect((await list('ops.one', '?state=resolved')).items).toEqual([]);
    expect((await list('ops.one', '?source=lookthrough_reconcile')).items.length).toBe(all.length);
    expect((await list('ops.one', '?source=accounting_import')).items).toEqual([]);
    const high = (await list('ops.one', `?severity=${HIGH}`)).items;
    expect(high.length).toBe(all.filter((x) => x.severity === HIGH).length);
    expect(high.every((x) => x.severity === HIGH)).toBe(true);
    const medium = (await list('ops.one', `?severity=${MEDIUM}`)).items;
    expect(medium.length).toBe(all.filter((x) => x.severity === MEDIUM).length);
    expect(high.length + medium.length).toBe(all.length);
    const bad = problemDetails.parse((await listAs('ops.one', '?state=bogus').expect(400)).body);
    expect(bad.errors?.map((e) => e.path)).toEqual(['state']);
    await listAs('ops.one', '?other=1').expect(400);
  });

  it('pages on (createdAt, id) without overlap, and refuses a forged cursor', async () => {
    const all = (await list('deal.three')).items.map((x) => x.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await list(
        'deal.three',
        `?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`,
      );
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((x) => x.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(Math.ceil(all.length / 2));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(all);
    const forged = Buffer.from('2025-13-40T00:00:00.000000Z|not-an-id').toString('base64url');
    const res = await listAs('ops.one', `?cursor=${forged}`).expect(400);
    expect(problemDetails.parse(res.body).detail).toBe('Invalid cursor');
  });

  it('filters by the intake file or run the exceptions are about, in stg.intake_row or stg.valuation, pages within it, and refuses an id that is not a UUID', async () => {
    const ofRun = await list('ops.one', `?intakeFileId=${run.id}`);
    expect(ofRun.items.length).toBe(run.exceptions);
    expect(ofRun.items.every((x) => x.context.intakeFileId === run.id)).toBe(true);
    // The walled run's one exception sits past the wall: nothing for an outsider, one for a member.
    expect((await list('ops.one', `?intakeFileId=${walledRun.id}`)).items).toEqual([]);
    const member = await list('deal.three', `?intakeFileId=${walledRun.id}`);
    expect(member.items.map((x) => x.context.intakeFileId)).toEqual([walledRun.id]);
    // A weekly file's exceptions are about staged values (stg.valuation): the filter reaches them too.
    const weekly = weeklyValues(aliased(h.dataset), { scenario: 'defects' });
    const weeklyFile = weeklyImportResult.parse(
      (
        await h
          .http()
          .post('/api/v1/intake/weekly')
          .set('authorization', h.as('operations'))
          .set('x-request-id', 'req-x-weekly-1')
          .send({ fileName: weekly.fileName, csv: weekly.csv })
          .expect(201)
      ).body,
    );
    expect(weeklyFile.exceptions).toBeGreaterThan(0);
    const ofWeekly = await list('ops.one', `?intakeFileId=${weeklyFile.id}`);
    expect(ofWeekly.items.length).toBe(weeklyFile.exceptions);
    for (const x of ofWeekly.items) {
      expect(x.entity).toBe('stg.valuation');
      expect(x.source).toBe('weekly_intake');
      expect(x.context.intakeFileId).toBe(weeklyFile.id);
      expect(x.context.intakeFileName).toBe(weekly.fileName);
      expect(x.context.rowNo).not.toBeNull();
    }
    expect((await list('ops.one', `?intakeFileId=${run.id}&source=weekly_intake`)).items).toEqual(
      [],
    );
    // Paged within the filter: every page is of the run, nothing repeated, nothing missed.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await list(
        'ops.one',
        `?intakeFileId=${run.id}&limit=2${cursor === null ? '' : `&cursor=${cursor}`}`,
      );
      expect(page.items.length).toBeLessThanOrEqual(2);
      expect(page.items.every((x) => x.context.intakeFileId === run.id)).toBe(true);
      seen.push(...page.items.map((x) => x.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(ofRun.items.map((x) => x.id));
    const bad = problemDetails.parse(
      (await listAs('ops.one', '?intakeFileId=not-a-uuid').expect(400)).body,
    );
    expect(bad.errors?.map((e) => e.path)).toEqual(['intakeFileId']);
    expect(
      (await list('ops.one', '?intakeFileId=00000000-0000-4000-8000-00000000dead')).items,
    ).toEqual([]);
  });

  it("shows one exception with its context and audits the read; a walled row's exception is 404 outside the wall", async () => {
    const [first] = (await list('ops.one')).items;
    const one = await detail('ops.one', first!.id, 'req-x-detail-1');
    expect(one).toEqual(first);
    expect(await auditCount('data_exception.read', 'req-x-detail-1')).toBe(1);
    const walled = await walledException();
    await detailAs('ops.one', walled.id).expect(404);
    await detailAs('deal.one', walled.id).expect(404);
    const seen = await detail('deal.three', walled.id, 'req-x-detail-member-1');
    expect(seen.context.companyName).toBe(walledCompanyName());
    expect(seen.context.rowNo).not.toBeNull();
    expect(seen.context.investmentId).toBe(walledId());
    await detailAs('operations', '00000000-0000-4000-8000-00000000dead').expect(404);
    await detailAs('operations', 'not-a-uuid').expect(404);
  });

  it('keeps the queue to the reviewing roles and commands to operations', async () => {
    const [first] = (await list('ops.one')).items;
    const viewer = await listAs('viewer').expect(403);
    expect(problemDetails.parse(viewer.body).type).toBe(`${PROBLEM}forbidden`);
    await detailAs('viewer', first!.id).expect(403);
    for (const who of ['deal.three', 'approver', 'auditor']) {
      await listAs(who).expect(200);
      const res = await commandAs(who, first!.id, { command: 'acknowledge' }).expect(403);
      expect(problemDetails.parse(res.body).type, who).toBe(`${PROBLEM}forbidden`);
    }
    expect((await detail('ops.one', first!.id)).state).toBe('open');
  });

  it('acknowledges then resolves with a reason: the operator takes ownership, every step is audited with the state before and after', async () => {
    const target = await openOf('LT-TIE-01');
    const acknowledged = await command(target.id, { command: 'acknowledge' }, 'req-x-ack-1');
    expect(acknowledged.state).toBe('acknowledged');
    expect(acknowledged.owner).toBe(user('ops.one').displayName);
    expect(acknowledged.rowVersion).toBe(target.rowVersion + 1);
    expect(acknowledged.expected).toBe(target.expected);
    expect(acknowledged.actual).toBe(target.actual);
    expect(await auditCount('data_exception.acknowledge', 'req-x-ack-1')).toBe(1);
    const ack = await auditDetails('data_exception.acknowledge', 'req-x-ack-1');
    expect(ack.state).toEqual({ before: 'open', after: 'acknowledged' });
    expect(ack.owner).toEqual({ before: null, after: user('ops.one').id });
    // A resolve needs a reason: none is refused at the boundary, a blank one by the transition table.
    const missing = problemDetails.parse(
      (await commandAs('operations', target.id, { command: 'resolve' }).expect(400)).body,
    );
    expect(missing.errors?.map((e) => e.path)).toEqual(['reason']);
    const blank = problemDetails.parse(
      (await commandAs('operations', target.id, { command: 'resolve', reason: '   ' }).expect(422))
        .body,
    );
    expect(blank.type).toBe(`${PROBLEM}workflow-precondition`);
    expect((await detail('ops.one', target.id)).state).toBe('acknowledged');
    const reason = 'The provider restated the mark; the record stands';
    const resolved = await command(target.id, { command: 'resolve', reason }, 'req-x-resolve-1');
    expect(resolved.state).toBe('resolved');
    expect(resolved.owner).toBe(user('ops.one').displayName);
    const audit = await auditDetails('data_exception.resolve', 'req-x-resolve-1');
    expect(audit.state).toEqual({ before: 'acknowledged', after: 'resolved' });
    expect(audit.reason).toBe(reason);
    expect((await list('ops.one', '?state=resolved')).items.map((x) => x.id)).toEqual([target.id]);
    // Resolved is terminal: a further command is a transition the table does not hold.
    const again = problemDetails.parse(
      (await commandAs('operations', target.id, { command: 'acknowledge' }).expect(409)).body,
    );
    expect(again.type).toBe(`${PROBLEM}workflow-transition`);
  });

  it('closes with wont_fix and a reason straight from open; it is terminal, and the ticket can still be noted', async () => {
    const target = await openOf('LT-MAP-01');
    await commandAs('operations', target.id, { command: 'wont_fix' }).expect(400);
    const closed = await command(
      target.id,
      { command: 'wont_fix', reason: 'The provider has no label for this sector; mapped by hand' },
      'req-x-wontfix-1',
    );
    expect(closed.state).toBe('wont_fix');
    expect(closed.owner).toBeNull();
    const audit = await auditDetails('data_exception.wont_fix', 'req-x-wontfix-1');
    expect(audit.state).toEqual({ before: 'open', after: 'wont_fix' });
    for (const next of ['acknowledge', 'resolve', 'wont_fix']) {
      const res = await commandAs('operations', target.id, {
        command: next,
        reason: 'again',
      }).expect(409);
      expect(problemDetails.parse(res.body).type, next).toBe(`${PROBLEM}workflow-transition`);
    }
    const ticketed = await command(target.id, { command: 'set_ticket', externalTicket: 'HD-77' });
    expect(ticketed.state).toBe('wont_fix');
    expect(ticketed.externalTicket).toBe('HD-77');
  });

  it('sets the external ticket without a state change, replaces an earlier one, and refuses a missing, long or unprintable ticket', async () => {
    const target = await openOf('LT-XREF-01');
    const ticketed = await command(
      target.id,
      { command: 'set_ticket', externalTicket: 'HD-1042' },
      'req-x-ticket-1',
    );
    expect(ticketed.state).toBe('open');
    expect(ticketed.owner).toBeNull();
    expect(ticketed.externalTicket).toBe('HD-1042');
    expect(ticketed.rowVersion).toBe(target.rowVersion + 1);
    const audit = await auditDetails('data_exception.set_ticket', 'req-x-ticket-1');
    expect(audit.state).toBe('open');
    expect(audit.externalTicket).toEqual({ before: null, after: 'HD-1042' });
    const replaced = await command(
      target.id,
      { command: 'set_ticket', externalTicket: 'HD-2000' },
      'req-x-ticket-2',
    );
    expect(replaced.externalTicket).toBe('HD-2000');
    expect(
      (await auditDetails('data_exception.set_ticket', 'req-x-ticket-2')).externalTicket,
    ).toEqual({ before: 'HD-1042', after: 'HD-2000' });
    await commandAs('operations', target.id, { command: 'set_ticket' }).expect(400);
    await commandAs('operations', target.id, {
      command: 'set_ticket',
      externalTicket: 'x'.repeat(65),
    }).expect(400);
    await commandAs('operations', target.id, {
      command: 'set_ticket',
      externalTicket: 'HD\u00001',
    }).expect(400);
    await commandAs('operations', target.id, { command: 'set_ticket', externalTicket: '' }).expect(
      400,
    );
    expect((await detail('ops.one', target.id)).externalTicket).toBe('HD-2000');
  });

  it('answers a command on an unknown or hidden exception with 404 and changes nothing', async () => {
    await commandAs('operations', '00000000-0000-4000-8000-00000000dead', {
      command: 'acknowledge',
    }).expect(404);
    await commandAs('operations', 'nope', { command: 'acknowledge' }).expect(404);
    const walled = await walledException();
    await commandAs('operations', walled.id, { command: 'acknowledge' }).expect(404);
    expect((await detail('deal.three', walled.id)).state).toBe('open');
    // No command event: the audited reads by the wall member are the only trace of it.
    expect(
      await count(
        "select count(*)::int as n from audit.event where action like 'data_exception.%' and action <> 'data_exception.read' and entity_id = $1",
        [walled.id],
      ),
    ).toBe(0);
  });

  it('answers 409 when another command changed the exception between this command reading it and writing it, and audits nothing', async () => {
    const target = await openOf('LT-DIFF-01');
    // The row stays locked for the transaction, so the window another command could use is the
    // one between this command reading the state and writing on it. The test database has one
    // connection: the other operator's change is replayed inside the command's own transaction,
    // right before its write (the service's private write step, reached as the seam this test needs).
    interface WriteSeam {
      claim: (tx: Tx, ...rest: unknown[]) => Promise<void>;
    }
    const seam = h.app.get<ExceptionsService, WriteSeam>(ExceptionsService);
    const original = seam.claim;
    seam.claim = async (tx, ...rest) => {
      await tx.execute(
        sql`update ops.data_exception set state = 'acknowledged' where id = ${target.id}`,
      );
      return original.call(seam, tx, ...rest);
    };
    try {
      for (const body of [
        { command: 'acknowledge' },
        { command: 'set_ticket', externalTicket: 'HD-409' },
      ]) {
        const res = await commandAs('operations', target.id, body, 'req-x-conflict-1').expect(409);
        expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}conflict`);
      }
    } finally {
      seam.claim = original;
    }
    // Nothing of either command is kept: the state, the ticket and the row version read as
    // before, and no event names the command (the batch rolled back, the other change with it).
    const after = await detail('ops.one', target.id);
    expect(after.state).toBe('open');
    expect(after.externalTicket).toBeNull();
    expect(after.rowVersion).toBe(target.rowVersion);
    expect(
      await count(
        "select count(*)::int as n from audit.event where request_id = 'req-x-conflict-1' and action <> 'data_exception.read'",
      ),
    ).toBe(0);
    // Read and written in one go, the same command goes through.
    expect((await command(target.id, { command: 'acknowledge' })).state).toBe('acknowledged');
  });
});
