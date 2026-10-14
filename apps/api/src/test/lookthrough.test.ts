import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@pb/calc';
import {
  intakeFilePage,
  lookthroughReconcileResult,
  lookthroughRunDetail,
  problemDetails,
} from '@pb/contracts';
import type {
  LookthroughReconcileResult,
  LookthroughRow,
  LookthroughRunDetail,
} from '@pb/contracts';
import { lookthroughExtract } from '@pb/synthetic';
import type { AliasedDataset, LookthroughExtract } from '@pb/synthetic';
import type { SyntheticDataset } from '@pb/db';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const PROBLEM = 'https://portfolio-beach.example/problems/';

/** The harness dataset as the generator typed it: the alias list is present, never undefined (exactOptionalPropertyTypes). */
const aliased = (d: SyntheticDataset): AliasedDataset => {
  const { companyAliases, ...rest } = d;
  return companyAliases === undefined ? rest : { ...rest, companyAliases };
};
const SOURCE = 'lookthrough';
const EXCEPTION_SOURCE = 'lookthrough_reconcile';

/** The rule a difference on each field is reported by; the generator's asOf difference is the stale finding, not a difference. */
const RULE_OF_FIELD = {
  exposureAtNav: 'LT-TIE-01',
  exposureAtCost: 'LT-TIE-02',
  sector: 'LT-DIFF-01',
  geography: 'LT-DIFF-02',
} as const;
const HIGH = 'exception_severity.high';
const MEDIUM = 'exception_severity.medium';

interface OpenedException extends Record<string, unknown> {
  rule_id: string;
  state: string;
  severity: string;
  source: string;
  entity: string;
  expected: string | null;
  actual: string | null;
  candidates: unknown[];
  row_no: number;
}

describe('look-through reconcile (M2 lookthrough-reconcile, decision 0010): differences open exceptions and change nothing', () => {
  let h: Harness;
  let folder: string;
  let clean: LookthroughExtract;
  let defects: LookthroughExtract;
  let cleanRun: LookthroughReconcileResult;
  let defectsRun: LookthroughReconcileResult;
  let recordBefore: Record<string, string>;

  beforeAll(async () => {
    h = await startHarness();
    // The folder look-through provider reads <PB_DROP_ROOT>/lookthrough/<asOf>.json (decision 0010).
    folder = join(h.runtime.config.PB_DROP_ROOT, 'lookthrough');
    mkdirSync(folder, { recursive: true });
    // No operations user is on the wall: ops.one reconciles from outside it, deal.three and
    // head.one are its members, deal.one is outside it.
    clean = lookthroughExtract(aliased(h.dataset), { scenario: 'clean' });
    defects = lookthroughExtract(aliased(h.dataset), { scenario: 'defects' });
    recordBefore = await record();
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
  const runCount = (): Promise<number> =>
    count('select count(*)::int as n from stg.intake_file where source = $1', [SOURCE]);
  /** Everything a reconcile must leave alone: the core financial tables and the taxonomy codes on record. */
  const record = async (): Promise<Record<string, string>> => {
    const one = async (sql: string): Promise<string> =>
      (await h.runtime.db.query<{ v: string }>(sql))[0]!.v;
    return {
      valuations: await one('select count(*)::text as v from mon.valuation'),
      valuationsTouched: await one(
        "select coalesce(max(updated_at)::text, '') as v from mon.valuation",
      ),
      quarters: await one('select count(*)::text as v from mon.quarterly_performance'),
      quartersTouched: await one(
        "select coalesce(max(updated_at)::text, '') as v from mon.quarterly_performance",
      ),
      flows: await one('select count(*)::text as v from mon.cash_flow'),
      flowsTouched: await one("select coalesce(max(updated_at)::text, '') as v from mon.cash_flow"),
      companies: await one(
        "select coalesce(md5(string_agg(id::text || coalesce(sector, '') || coalesce(geography, ''), ',' order by id)), '') as v from core.portfolio_company",
      ),
    };
  };

  const writeExtract = (extract: LookthroughExtract, asOf = extract.asOf): void =>
    writeFileSync(join(folder, `${asOf}.json`), extract.json);
  const reconcileAs = (who: string, body: object, requestId = 'req-lt-reconcile') =>
    h
      .http()
      .post('/api/v1/intake/lookthrough/reconcile')
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send(body);
  const reconcile = async (asOf: string, requestId: string): Promise<LookthroughReconcileResult> =>
    lookthroughReconcileResult.parse(
      (await reconcileAs('operations', { asOf }, requestId).expect(201)).body,
    );
  const detailAs = (who: string, id: string, requestId = 'req-lt-detail') =>
    h
      .http()
      .get(`/api/v1/intake/lookthrough/runs/${id}`)
      .set('authorization', h.as(who))
      .set('x-request-id', requestId);
  const detail = async (
    who: string,
    id: string,
    requestId = 'req-lt-detail',
  ): Promise<LookthroughRunDetail> =>
    lookthroughRunDetail.parse((await detailAs(who, id, requestId).expect(200)).body);
  const rowNo = (run: LookthroughRunDetail, n: number): LookthroughRow => {
    const row = run.rows.find((r) => r.rowNo === n);
    if (row === undefined) throw new Error(`row ${n} is not in the run`);
    return row;
  };
  const ruleIds = (row: LookthroughRow): string[] => row.findings.map((f) => f.ruleId);
  const opened = (fileId: string): Promise<OpenedException[]> =>
    h.runtime.db.query<OpenedException>(
      `select x.rule_id, x.state, x.severity, x.source, x.entity, x.expected, x.actual, x.candidates, r.row_no
       from ops.data_exception x join stg.intake_row r on r.id = x.entity_id
       where x.entity = 'stg.intake_row' and r.intake_file_id = $1
       order by r.row_no, x.rule_id`,
      [fileId],
    );

  it('lets only operations reconcile, and refuses a malformed, missing or future as-of before anything is read', async () => {
    for (const who of ['viewer', 'deal_team', 'approver', 'auditor']) {
      const res = await reconcileAs(who, { asOf: clean.asOf }).expect(403);
      expect(problemDetails.parse(res.body).type, who).toBe(`${PROBLEM}forbidden`);
    }
    const malformed = problemDetails.parse(
      (await reconcileAs('operations', { asOf: 'June 2025' }).expect(400)).body,
    );
    expect(malformed.errors?.map((e) => e.path)).toEqual(['asOf']);
    await reconcileAs('operations', {}).expect(400);
    await reconcileAs('operations', { asOf: clean.asOf, extra: true }).expect(400);
    // The record is read as of the run's date; a date after today has nothing to compare with.
    const future = problemDetails.parse(
      (await reconcileAs('operations', { asOf: '2099-01-01' }).expect(400)).body,
    );
    expect(future.errors?.map((e) => e.path)).toEqual(['asOf']);
    expect(await runCount()).toBe(0);
  });

  it('reconciles a clean extract: every row links (one by alias), maps and ties; no difference, no exception, nothing on record changed', async () => {
    writeExtract(clean);
    cleanRun = await reconcile(clean.asOf, 'req-lt-clean-1');
    expect(cleanRun.duplicate).toBe(false);
    expect(cleanRun.source).toBe(SOURCE);
    expect(cleanRun.asOf).toBe(clean.asOf);
    expect(cleanRun.fileName).toBe(`lookthrough-${clean.asOf}.json`);
    expect(cleanRun.templateSignature).toBeNull();
    expect(cleanRun.receivedBy).toBe(user('ops.one').displayName);
    expect(cleanRun.rowCount).toBe(clean.expectations.rows);
    expect(cleanRun.status).toBe('validated');
    expect(cleanRun.counts.validated).toBe(clean.expectations.rows);
    expect(cleanRun.counts.flagged).toBe(0);
    expect(cleanRun.exceptions).toBe(0);
    expect(cleanRun.fileFindings).toEqual([]);
    // The reconciler is outside the wall: the walled position's row linked all the same and is
    // counted, never shown (decision 0009).
    expect(clean.expectations.walled.length).toBeGreaterThan(0);
    expect(cleanRun.hiddenRows).toBe(clean.expectations.walled.length);
    expect(cleanRun.rows.length).toBe(clean.expectations.rows - clean.expectations.walled.length);
    for (const row of cleanRun.rows) {
      expect(row.link.status, `row ${row.rowNo}`).toBe('matched');
      expect(row.link.investmentId).not.toBeNull();
      expect(row.mapped.sector).not.toBeNull();
      expect(row.mapped.geography).not.toBeNull();
      expect(row.differences).toEqual([]);
      expect(row.findings).toEqual([]);
      expect(row.status).toBe('validated');
      expect(row.exceptions).toBe(0);
      // The provider wrote the record's own figures: the invested cost and the Locked mark as the
      // portfolio pages compute them tie to the cent.
      expect(row.approved.exposureAtNav).not.toBeNull();
      expect(row.approved.exposureAtCost).not.toBeNull();
      expect(D(row.approved.exposureAtNav!).eq(D(row.provider.exposureAtNav))).toBe(true);
      expect(D(row.approved.exposureAtCost!).eq(D(row.provider.exposureAtCost))).toBe(true);
    }
    // The alias row carries no number and an alias in place of the name: it links exactly.
    expect(clean.expectations.aliased.length).toBe(1);
    const aliased = rowNo(cleanRun, clean.expectations.aliased[0]!);
    expect(aliased.investmentNumber).toBeNull();
    expect(aliased.link.status).toBe('matched');
    expect(aliased.link.investmentNumber).not.toBeNull();
    expect(aliased.link.companyName).not.toBe(aliased.companyName);
    // One audit event, counts only: no name of the provider's rows travels in it.
    expect(await auditCount('intake.reconcile', 'req-lt-clean-1')).toBe(1);
    const [event] = await h.runtime.db.query<{ details: unknown }>(
      "select details from audit.event where action = 'intake.reconcile' and request_id = $1",
      ['req-lt-clean-1'],
    );
    const details = JSON.stringify(event!.details);
    for (const row of clean.rows) expect(details).not.toContain(row.companyName);
    expect(details).toContain('"exceptions":0');
    expect(await record()).toEqual(recordBefore);
    // The run is an intake file of its source, listed with the others and apart from them.
    const listed = intakeFilePage.parse(
      (
        await h
          .http()
          .get(`/api/v1/intake/files?source=${SOURCE}`)
          .set('authorization', h.as('auditor'))
          .expect(200)
      ).body,
    );
    expect(listed.items.map((f) => f.id)).toEqual([cleanRun.id]);
    expect(listed.items[0]!.source).toBe(SOURCE);
    const accounting = intakeFilePage.parse(
      (
        await h
          .http()
          .get('/api/v1/intake/files?source=accounting')
          .set('authorization', h.as('auditor'))
          .expect(200)
      ).body,
    );
    expect(accounting.items).toEqual([]);
  });

  it("hides the walled position's row from everyone outside the wall, the reconciler included, counts it, and shows it to a wall member", async () => {
    const ops = await detail('ops.one', cleanRun.id, 'req-lt-detail-ops-1');
    expect(ops.hiddenRows).toBe(clean.expectations.walled.length);
    expect(ops.rows.some((r) => r.link.investmentId === walledId())).toBe(false);
    expect(JSON.stringify(ops)).not.toContain(walledId());
    expect(JSON.stringify(ops)).not.toContain(walledCompanyName());
    const outsider = await detail('deal.one', cleanRun.id, 'req-lt-detail-outsider-1');
    expect(outsider.hiddenRows).toBe(clean.expectations.walled.length);
    expect(JSON.stringify(outsider)).not.toContain(walledCompanyName());
    // The counts are facts of the run, the same for every reader.
    expect(outsider.counts).toEqual(ops.counts);
    const member = await detail('deal.three', cleanRun.id, 'req-lt-detail-member-1');
    expect(member.hiddenRows).toBe(0);
    expect(member.rows.length).toBe(clean.expectations.rows);
    const walledRow = member.rows.find((r) => r.link.investmentId === walledId());
    expect(walledRow).toBeDefined();
    expect(walledRow!.link.status).toBe('matched');
    expect(walledRow!.status).toBe('validated');
    expect(walledRow!.rowNo).toBe(clean.expectations.walled[0]);
    expect(await auditCount('intake_file.read', 'req-lt-detail-member-1')).toBe(1);
  });

  it('answers the same extract again with the run it created and stages nothing', async () => {
    const again = await reconcile(clean.asOf, 'req-lt-dup-1');
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(cleanRun.id);
    expect(again.contentHash).toBe(cleanRun.contentHash);
    expect(await runCount()).toBe(1);
    expect(await auditCount('intake_file.read', 'req-lt-dup-1')).toBe(1);
    expect(await auditCount('intake.reconcile', 'req-lt-dup-1')).toBe(0);
  });

  it('reconciles the defects extract: exactly the differences, unmatched names and unmapped labels the generator names open exceptions; stale and duplicate rows are flagged without one', async () => {
    writeExtract(defects);
    defectsRun = await reconcile(defects.asOf, 'req-lt-defects-1');
    expect(defectsRun.duplicate).toBe(false);
    expect(defectsRun.id).not.toBe(cleanRun.id);
    expect(defectsRun.status).toBe('flagged');
    expect(defectsRun.hiddenRows).toBe(defects.expectations.walled.length);
    // A wall member sees every row.
    const full = await detail('deal.three', defectsRun.id, 'req-lt-defects-full-1');
    expect(full.hiddenRows).toBe(0);
    expect(full.rows.length).toBe(defects.expectations.rows);
    const companyOf = (investmentId: string | null) => {
      const inv = h.dataset.investments.find((i) => i.id === investmentId);
      return h.dataset.portfolioCompanies.find((c) => c.id === inv?.portfolioCompanyId);
    };

    const expectedRules: string[] = [];
    for (const { rowNo: n, field } of defects.expectations.differences) {
      const row = rowNo(full, n);
      expect(row.status, `row ${n} (${field})`).toBe('flagged');
      if (field === 'asOf') {
        // An older as-of is the stale finding: not a difference, no exception.
        expect(ruleIds(row)).toContain('LT-STALE-01');
        expect(row.differences).toEqual([]);
        expect(row.exceptions).toBe(0);
        expect(row.asOf < defects.asOf).toBe(true);
        continue;
      }
      const rule = RULE_OF_FIELD[field];
      expect(ruleIds(row), `row ${n}`).toContain(rule);
      const difference = row.differences.find((d) => d.field === field);
      expect(difference, `row ${n}`).toBeDefined();
      expect(row.differences.length).toBe(1);
      expect(difference!.expected).not.toBeNull();
      expect(difference!.actual).not.toBeNull();
      if (field === 'exposureAtNav' || field === 'exposureAtCost') {
        expect(difference!.actual).toBe(D(row.provider[field]).toFixed(2));
        expect(difference!.expected).toBe(D(row.approved[field]!).toFixed(2));
      } else {
        // The record's code first, then the provider's label with the code it maps to.
        expect(difference!.expected).toBe(companyOf(row.link.investmentId)?.[field] ?? null);
        expect(difference!.actual).toBe(`${row.provider[field]} (${row.mapped[field]})`);
      }
      expect(row.exceptions).toBe(1);
      expectedRules.push(rule);
    }
    expect(defects.expectations.unmatched.length).toBe(2);
    for (const n of defects.expectations.unmatched) {
      const row = rowNo(full, n);
      expect(row.link.status).toBe('unmatched');
      expect(row.link.investmentId).toBeNull();
      expect(row.approved).toEqual({ exposureAtCost: null, exposureAtNav: null });
      expect(ruleIds(row)).toContain('LT-XREF-01');
      expect(row.differences).toEqual([]);
      expect(row.status).toBe('flagged');
      expect(row.exceptions).toBe(1);
      expectedRules.push('LT-XREF-01');
    }
    // The near miss (no number) offers its candidate to a person, in the link, never in the finding.
    const nearMiss = defects.expectations.unmatched
      .map((n) => rowNo(full, n))
      .find((r) => r.investmentNumber === null)!;
    expect(nearMiss.link.candidates.length).toBe(1);
    expect(nearMiss.link.candidates[0]!.reason).toBe('near miss');
    const xref = nearMiss.findings.find((f) => f.ruleId === 'LT-XREF-01')!;
    expect(xref.message).not.toContain(nearMiss.link.candidates[0]!.companyName);
    for (const n of defects.expectations.unmapped) {
      const row = rowNo(full, n);
      expect(row.mapped.sector).toBeNull();
      expect(ruleIds(row)).toEqual(['LT-MAP-01']);
      expect(row.differences).toEqual([]);
      expect(row.status).toBe('flagged');
      expect(row.exceptions).toBe(1);
      expectedRules.push('LT-MAP-01');
    }
    for (const n of defects.expectations.duplicates) {
      const row = rowNo(full, n);
      expect(ruleIds(row)).toEqual(['LT-DUP-01']);
      expect(row.exceptions).toBe(0);
      const first = full.rows.find(
        (r) => r.rowNo < n && r.investmentNumber === row.investmentNumber,
      );
      expect(first).toBeDefined();
      expect(row.findings[0]!.message).toBe(
        `Row ${first!.rowNo} already carries this position for ${row.asOf}`,
      );
    }
    for (const { rowNo: n } of defects.expectations.moved) {
      const row = rowNo(full, n);
      expect(row.status, `row ${n}`).toBe('validated');
      expect(row.differences).toEqual([]);
      expect(row.findings).toEqual([]);
    }
    for (const n of defects.expectations.aliased) {
      const row = rowNo(full, n);
      expect(row.investmentNumber).toBeNull();
      expect(row.link.status).toBe('matched');
    }
    // Exactly one exception per difference, unresolved link and unmapped label, and no other.
    expect(defectsRun.exceptions).toBe(expectedRules.length);
    expect(full.rows.reduce((n, r) => n + r.exceptions, 0)).toBe(expectedRules.length);
    const exceptions = await opened(defectsRun.id);
    expect(exceptions.map((x) => x.rule_id).sort()).toEqual([...expectedRules].sort());
    for (const x of exceptions) {
      expect(x.source).toBe(EXCEPTION_SOURCE);
      expect(x.entity).toBe('stg.intake_row');
      expect(x.state).toBe('open');
      expect(x.severity, x.rule_id).toBe(
        x.rule_id.startsWith('LT-TIE') || x.rule_id.startsWith('LT-XREF') ? HIGH : MEDIUM,
      );
      for (const candidate of x.candidates)
        expect(Object.keys(candidate as Record<string, unknown>)).toEqual(['reason']);
      if (x.rule_id.startsWith('LT-TIE') || x.rule_id.startsWith('LT-DIFF')) {
        // The two figures, or the code and the label: what a person needs to decide.
        expect(x.expected).not.toBeNull();
        expect(x.actual).not.toBeNull();
      }
    }
    const nearMissException = exceptions.find((x) => x.row_no === nearMiss.rowNo)!;
    expect(nearMissException.candidates).toEqual([{ reason: 'near miss' }]);
    expect(defectsRun.counts.flagged).toBe(full.rows.filter((r) => r.status === 'flagged').length);
    expect(defectsRun.counts.flagged + defectsRun.counts.validated).toBe(defects.expectations.rows);
    expect(await auditCount('intake.reconcile', 'req-lt-defects-1')).toBe(1);
    expect(await record()).toEqual(recordBefore);
  });

  it("hides the walled position's rows of the defects run from the reconciler, the stale one included, and shows them to a wall member", async () => {
    expect(defects.expectations.walled.length).toBe(2);
    const ops = await detail('ops.one', defectsRun.id, 'req-lt-defects-ops-1');
    expect(ops.hiddenRows).toBe(2);
    expect(ops.rows.map((r) => r.rowNo)).not.toContain(defects.expectations.walled[0]);
    expect(ops.rows.map((r) => r.rowNo)).not.toContain(defects.expectations.walled[1]);
    expect(JSON.stringify(ops)).not.toContain(walledId());
    expect(JSON.stringify(ops)).not.toContain(walledCompanyName());
    expect(JSON.stringify(ops)).not.toContain(walledInvestment().investmentNumber);
    const member = await detail('deal.three', defectsRun.id, 'req-lt-defects-member-1');
    for (const n of defects.expectations.walled) {
      const row = rowNo(member, n);
      expect(row.link.investmentId).toBe(walledId());
    }
    const stale = rowNo(member, defects.expectations.walled[1]!);
    expect(stale.status).toBe('flagged');
    expect(ruleIds(stale)).toContain('LT-STALE-01');
  });

  it('answers 404 for an unknown run and an id that is not a UUID; the run is for the reviewing roles', async () => {
    await detailAs('operations', '00000000-0000-4000-8000-00000000dead').expect(404);
    await detailAs('operations', 'not-a-uuid').expect(404);
    const res = await detailAs('viewer', cleanRun.id).expect(403);
    expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}forbidden`);
    for (const who of ['approver', 'auditor']) await detailAs(who, cleanRun.id).expect(200);
  });

  it('stages a run with no rows and a file finding for a date the folder holds no extract for, and answers it again as a duplicate', async () => {
    const run = await reconcile('2025-05-30', 'req-lt-none-1');
    expect(run.duplicate).toBe(false);
    expect(run.rowCount).toBe(0);
    expect(run.status).toBe('new');
    expect(run.rows).toEqual([]);
    expect(run.hiddenRows).toBe(0);
    expect(run.exceptions).toBe(0);
    expect(run.fileFindings.map((f) => [f.ruleId, f.severity])).toEqual([['LT-FILE-01', 'error']]);
    expect(run.fileFindings[0]!.message).toContain('2025-05-30');
    const again = await reconcile('2025-05-30', 'req-lt-none-2');
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(run.id);
  });

  it('refuses a file in the folder that is not an extract with a 503 and stages nothing', async () => {
    writeFileSync(join(folder, '2025-05-15.json'), '{"not": "an array of rows"}\n');
    const runs = await runCount();
    const res = await reconcileAs('operations', { asOf: '2025-05-15' }).expect(503);
    expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}upstream`);
    expect(await runCount()).toBe(runs);
  });

  it('keeps two runs for different as-of dates apart even when the provider sends the same rows for both', async () => {
    const earlier = '2025-06-27';
    writeExtract(clean, earlier);
    const run = await reconcile(earlier, 'req-lt-earlier-1');
    expect(run.duplicate).toBe(false);
    expect(run.id).not.toBe(cleanRun.id);
    expect(run.asOf).toBe(earlier);
    expect(run.contentHash).not.toBe(cleanRun.contentHash);
    expect(run.rowCount).toBe(clean.expectations.rows);
    // The record is read as of each run's own date: the rows report for a later date and are not stale.
    for (const row of run.rows) expect(ruleIds(row)).not.toContain('LT-STALE-01');
    const listed = intakeFilePage.parse(
      (
        await h
          .http()
          .get(`/api/v1/intake/files?source=${SOURCE}`)
          .set('authorization', h.as('operations'))
          .expect(200)
      ).body,
    );
    expect(listed.items.map((f) => f.id)).toContain(run.id);
    expect(listed.items.map((f) => f.id)).toContain(cleanRun.id);
    expect(await record()).toEqual(recordBefore);
  });
});

describe('an API whose config lacks the intake block', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ withoutDefinitions: ['intake'] });
  });
  afterAll(async () => {
    await h.close();
  });

  it('answers the reconcile with a 500 configuration problem naming the key, never a default', async () => {
    const res = await h
      .http()
      .post('/api/v1/intake/lookthrough/reconcile')
      .set('authorization', h.as('operations'))
      .send({ asOf: h.dataset.asOf })
      .expect(500);
    const problem = problemDetails.parse(res.body);
    expect(problem.type).toBe(`${PROBLEM}configuration`);
    expect(problem.detail).toContain('intake');
  });
});
