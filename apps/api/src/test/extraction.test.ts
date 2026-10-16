import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureExtractor, parseMetadata } from '@pb/ai';
import type { ExtractFn } from '@pb/ai';
import type { MockAiClient } from '@pb/adapters/mocks';
import { D, latestQuarterEndOnOrBefore, toDollars, unitSanityFlag } from '@pb/calc';
import {
  documentPage,
  extractionBatch,
  extractionBatchPage,
  extractionRunDetail,
  extractionRunPage,
  problemDetails,
} from '@pb/contracts';
import type {
  ExtractedValue,
  ExtractionBatch,
  ExtractionRun,
  ExtractionRunDetail,
  DocumentSummary,
} from '@pb/contracts';
import { UNTAGGED_FILE_NAME } from '@pb/synthetic';
import type { DocumentScenario, SyntheticDocument } from '@pb/synthetic';
import { RUN_EXCEPTION_RULE, costOf } from '../extraction/settings.js';
import { extractionSettingsOf } from '../documents/settings.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const PROBLEM = 'https://portfolio-beach.example/problems/';
const QF = 'doc_type.quarterly_financials';
const CAPITAL_CALL = 'doc_type.capital_call';
const NO_SUCH_ID = '00000000-0000-4000-8000-00000000abcd';
const PROMPT = 'quarterly_extraction';
const SCHEMA_FIELDS = 15;
/** The bounds of config/definitions.json unitSanityBoundsUsd, as the validator reads them. */
const MILLION = D('1000000');

describe('extraction engine (M4, docs/18 section 7): batches, runs, review by exception, promotion', () => {
  let h: Harness;
  let ai: MockAiClient;
  let extractor: ExtractFn;
  let everything: DocumentSummary[];
  let firstBatch: ExtractionBatch;
  let firstRuns: ExtractionRun[];

  beforeAll(async () => {
    h = await startHarness({ enableFlags: ['ai.extraction'] });
    ai = h.runtime.adapters.ai as MockAiClient;
    extractor = fixtureExtractor(h.runtime.truths);
  });
  afterAll(async () => {
    await h.close();
  });

  const set = () => h.documents;
  const user = (externalId: string) => h.dataset.users.find((u) => u.externalId === externalId)!;
  const walledId = (): string => h.dataset.scenarios.walled_deal![0]!;
  const quarterEnd = (): string => latestQuarterEndOnOrBefore(h.dataset.asOf);
  const now = (): string => h.runtime.adapters.clock.now();
  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    (await h.runtime.db.query<{ n: number }>(sql, params))[0]!.n;
  const auditCount = (action: string, requestId: string): Promise<number> =>
    count('select count(*)::int as n from audit.event where action = $1 and request_id = $2', [
      action,
      requestId,
    ]);
  const extractionCalls = (): number => ai.calls.filter((c) => c.promptId === PROMPT).length;
  const settings = () => extractionSettingsOf(h.runtime.definitions);

  /** The synthetic reports of the latest quarter the index classifies (not the duplicate copy, not the untagged scan). */
  const reportsOfQuarter = (): SyntheticDocument[] =>
    set().documents.filter(
      (d) =>
        d.truth.docType === QF &&
        d.truth.periodEnd === quarterEnd() &&
        d.fileName !== UNTAGGED_FILE_NAME &&
        d.fileName !== set().expectations.scenarioFiles.duplicate_doc[1],
    );
  const byName = (fileName: string): DocumentSummary =>
    everything.find((d) => d.fileName === fileName)!;
  const docOf = (fileName: string): SyntheticDocument =>
    set().documents.find((d) => d.fileName === fileName)!;
  const scenarioFile = (scenario: DocumentScenario): string =>
    set().expectations.scenarioFiles[scenario][0]!;
  /** A report of the quarter with no scenario, outside the wall, whose every bounded figure is within the sanity range. */
  const plainReports = (): SyntheticDocument[] =>
    reportsOfQuarter().filter(
      (d) =>
        d.truth.scenarios.length === 0 &&
        d.truth.investmentId !== walledId() &&
        ['revenue_ltm', 'ebitda_ltm', 'revenue_ltm_prior_year', 'ebitda_ltm_prior_year'].every(
          (key) => {
            const f = d.truth.fields[key]!;
            return (
              f.value === null ||
              !unitSanityFlag(toDollars(f.value, f.unit!), {
                min: MILLION,
                max: D('50000000000'),
              })
            );
          },
        ),
    );

  const get = (who: string, path: string, requestId = 'req-ext-get') =>
    h.http().get(path).set('authorization', h.as(who)).set('x-request-id', requestId);
  const createBatch = (who: string, body: object, requestId = 'req-ext-batch') =>
    h
      .http()
      .post('/api/v1/extraction/batches')
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send(body);
  const command = (who: string, id: string, body: object, requestId = 'req-ext-command') =>
    h
      .http()
      .post(`/api/v1/extraction/runs/${id}/commands`)
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .send(body);
  const runsOf = async (who: string, query = ''): Promise<ExtractionRun[]> =>
    extractionRunPage.parse(
      (await get(who, `/api/v1/extraction/runs?limit=200${query}`).expect(200)).body,
    ).items;
  const detail = async (
    who: string,
    id: string,
    requestId?: string,
  ): Promise<ExtractionRunDetail> =>
    extractionRunDetail.parse(
      (await get(who, `/api/v1/extraction/runs/${id}`, requestId).expect(200)).body,
    );
  const batchesOf = async (who: string): Promise<ExtractionBatch[]> =>
    extractionBatchPage.parse(
      (await get(who, '/api/v1/extraction/batches?limit=200').expect(200)).body,
    ).items;
  const setFlag = (key: string, enabled: boolean) =>
    h
      .http()
      .patch(`/api/v1/flags/${key}`)
      .set('authorization', h.as('platform_admin'))
      .send({ enabled, reason: 'extraction test' })
      .expect(200);
  const valueOf = (d: ExtractionRunDetail, field: string): ExtractedValue =>
    d.values.find((v) => v.field === field)!;
  /** Runs the body with the prototype extractor replaced, then puts the fixture extractor back. */
  const withExtractor = async (
    fn: (input: string) => unknown,
    body: () => Promise<void>,
  ): Promise<void> => {
    ai.register(PROMPT, fn);
    try {
      await body();
    } finally {
      ai.register(PROMPT, extractor);
    }
  };
  /** Runs the body with the extraction block of definitions.json overridden, then restores it. */
  const withExtraction = async (
    patch: Record<string, unknown>,
    body: () => Promise<void>,
  ): Promise<void> => {
    const saved = h.runtime.definitions.extraction;
    h.runtime.definitions.extraction = { ...(saved as Record<string, unknown>), ...patch };
    try {
      await body();
    } finally {
      h.runtime.definitions.extraction = saved;
    }
  };
  /** The quarter on record for an investment and period, as mon.quarterly_performance holds it. */
  const onRecord = async (investmentId: string, periodEnd: string) =>
    (
      await h.runtime.db.query<{
        id: string;
        revenue_ltm: string | null;
        ebitda_ltm: string | null;
        ev: string | null;
        net_debt: string | null;
        cash: string | null;
        total_equity: string | null;
        status: string;
        approved_by: string | null;
        approved_at: string | null;
        approval_reason: string | null;
        source_document_id: string | null;
        source_page: number | null;
        source_locator: string | null;
        extraction_run_id: string | null;
        prompt_version: string | null;
        model_id: string | null;
        highlights: string[];
        commentary: string | null;
      }>(
        `select id, revenue_ltm, ebitda_ltm, ev, net_debt, cash, total_equity, status, approved_by,
                approved_at, approval_reason, source_document_id, source_page, source_locator,
                extraction_run_id, prompt_version, model_id, highlights, commentary
           from mon.quarterly_performance where investment_id = $1 and period_end = $2`,
        [investmentId, periodEnd],
      )
    )[0]!;

  it('guards the writes by role and the reads by sign-in', async () => {
    for (const who of ['viewer', 'deal_team', 'approver', 'auditor', 'platform_admin']) {
      const res = await createBatch(who, { periodEnd: quarterEnd(), docType: QF }).expect(403);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}forbidden`);
    }
    for (const who of ['viewer', 'approver', 'auditor', 'platform_admin'])
      await command(who, NO_SUCH_ID, { command: 'acceptClean' }).expect(403);
    await h.http().get('/api/v1/extraction/batches').expect(401);
    await h.http().get('/api/v1/extraction/runs').expect(401);
    await h.http().get(`/api/v1/extraction/runs/${NO_SUCH_ID}`).expect(401);
    await createBatch('operations', { periodEnd: '2025-05-15', docType: QF }).expect(400);
    await createBatch('operations', { documentIds: [] }).expect(400);
    await command('operations', NO_SUCH_ID, {
      command: 'edit',
      field: 'revenue_ltm',
      value: '',
    }).expect(400);
    expect(await count('select count(*)::int as n from doc.extraction_run')).toBe(0);
  });

  it('refuses a batch and a retry while the kill switch is off (409)', async () => {
    await setFlag('ai.extraction', false);
    try {
      const res = await createBatch('operations', { periodEnd: quarterEnd(), docType: QF }).expect(
        409,
      );
      const problem = problemDetails.parse(res.body);
      expect(problem.type).toBe(`${PROBLEM}kill-switch`);
      expect(problem.detail).toBe('AI extraction is switched off (ai.extraction)');
      await command('operations', NO_SUCH_ID, { command: 'retry' }).expect(409);
    } finally {
      await setFlag('ai.extraction', true);
    }
    expect(await count('select count(*)::int as n from ops.job')).toBe(0);
  });

  it('refuses a document that is not indexed, not Classified, or of a type without a schema (M3 AC)', async () => {
    await createBatch('operations', { documentIds: [NO_SUCH_ID] }).expect(404);
    await get('operations', '/api/v1/documents/index').expect(404);
    await h
      .http()
      .post('/api/v1/documents/index')
      .set('authorization', h.as('operations'))
      .set('x-request-id', 'req-ext-index')
      .expect(200);
    await h
      .http()
      .post('/api/v1/expected-documents/generate')
      .set('authorization', h.as('operations'))
      .send({ periodEnd: quarterEnd() })
      .expect(201);
    everything = documentPage.parse(
      (await get('head.one', '/api/v1/documents?limit=200').expect(200)).body,
    ).items;
    expect(everything.length).toBe(set().documents.length);

    const scan = byName(UNTAGGED_FILE_NAME);
    const needsReview = await createBatch('operations', { documentIds: [scan.id] }).expect(422);
    const problem = problemDetails.parse(needsReview.body);
    expect(problem.type).toBe(`${PROBLEM}workflow-precondition`);
    expect(problem.detail).toContain(UNTAGGED_FILE_NAME);
    expect(problem.detail).toContain('NeedsReview');
    const copy = byName(set().expectations.scenarioFiles.duplicate_doc[1]!);
    expect(
      problemDetails.parse(
        (await createBatch('operations', { documentIds: [copy.id] }).expect(422)).body,
      ).detail,
    ).toContain('Duplicate');
    const notice = everything.find((d) => d.docType === CAPITAL_CALL)!;
    const noSchema = await createBatch('operations', { documentIds: [notice.id] }).expect(422);
    expect(problemDetails.parse(noSchema.body).detail).toContain(
      'no extraction schema for Capital call',
    );
    expect(
      problemDetails.parse(
        (
          await createBatch('operations', {
            periodEnd: quarterEnd(),
            docType: CAPITAL_CALL,
          }).expect(422)
        ).body,
      ).detail,
    ).toContain('no extraction schema for Capital call');
    expect(
      problemDetails.parse(
        (await createBatch('operations', { periodEnd: '2016-03-31', docType: QF }).expect(422))
          .body,
      ).detail,
    ).toContain('no Classified Quarterly financials document for 2016-03-31');
    // A walled document named by a caller outside the wall is simply not found.
    const walledFile = reportsOfQuarter().find((d) => d.truth.investmentId === walledId())!;
    await createBatch('operations', { documentIds: [byName(walledFile.fileName).id] }).expect(404);
    expect(await count('select count(*)::int as n from doc.extraction_run')).toBe(0);
    expect(await count('select count(*)::int as n from ops.job')).toBe(0);
  });

  it('runs a batch for the latest quarter: every run Succeeded with the 15 values of the schema, tokens and cost', async () => {
    const reports = reportsOfQuarter();
    expect(reports.length).toBeGreaterThan(5);
    const callsBefore = extractionCalls();
    const res = await createBatch(
      'operations',
      { periodEnd: quarterEnd(), docType: QF },
      'req-ext-batch-1',
    ).expect(201);
    firstBatch = extractionBatch.parse(res.body);
    expect(firstBatch.state).toBe('succeeded');
    expect(firstBatch.progress).toBe(100);
    expect(firstBatch.errorCode).toBeNull();
    expect(firstBatch.requestedBy).toBe(user('ops.one').displayName);
    expect(firstBatch.startedAt).toBe(now());
    expect(firstBatch.finishedAt).toBe(now());
    // Operations stands outside the wall: the walled report's run is not in its counts.
    expect(firstBatch.runs).toEqual({
      total: reports.length - 1,
      queued: 0,
      running: 0,
      succeeded: reports.length - 1,
      failed: 0,
      needsRetry: 0,
    });
    expect(extractionCalls() - callsBefore).toBe(reports.length);
    // A wall member sees every run of the batch.
    const [seen] = await batchesOf('head.one');
    expect(seen!.id).toBe(firstBatch.id);
    expect(seen!.runs.total).toBe(reports.length);
    expect(seen!.runs.succeeded).toBe(reports.length);
    expect(seen!.tokensIn).toBeGreaterThan(0);
    expect(seen!.tokensOut).toBeGreaterThan(0);

    firstRuns = await runsOf('head.one', `&batchId=${firstBatch.id}`);
    expect(firstRuns.length).toBe(reports.length);
    let cost = D('0');
    for (const run of firstRuns) {
      const report = docOf(run.fileName);
      expect(run.state, run.fileName).toBe('Succeeded');
      expect(run.schemaId).toBe('quarterly_financials');
      expect(run.promptId).toBe(PROMPT);
      expect(run.promptVersion).toBe('1');
      expect(run.modelId).toBe('mock');
      expect(run.batchId).toBe(firstBatch.id);
      expect(run.periodEnd).toBe(quarterEnd());
      expect(run.investmentId).toBe(report.truth.investmentId);
      expect(run.investmentNumber).toBe(report.truth.investmentNumber);
      expect(run.companyName).toBe(report.truth.companyName);
      expect(run.documentTitle).toBe(byName(run.fileName).title);
      expect(run.requestedBy).toBe(user('ops.one').displayName);
      expect(run.startedAt).toBe(now());
      expect(run.finishedAt).toBe(now());
      expect(run.errorCode).toBeNull();
      expect(run.errorKind).toBeNull();
      expect(run.schemaRetries).toBe(0);
      expect(run.transientRetries).toBe(0);
      expect(run.approvedBy).toBeNull();
      expect(run.promotedRecordId).toBeNull();
      expect(run.counts.values).toBe(SCHEMA_FIELDS);
      expect(run.counts.decided).toBe(0);
      expect(run.counts.clean + run.counts.flagged + run.counts.invalid).toBe(SCHEMA_FIELDS);
      expect(run.tokensIn).toBeGreaterThan(0);
      expect(run.tokensOut).toBe(64);
      expect(run.costUsd).toBe(costOf(run.tokensIn!, run.tokensOut!, settings()));
      cost = cost.plus(run.costUsd!);
    }
    expect(D(seen!.costUsd).eq(cost)).toBe(true);
    expect(seen!.tokensIn).toBe(firstRuns.reduce((n, r) => n + r.tokensIn!, 0));
    expect(
      await count('select count(*)::int as n from stg.extracted_value where run_id = any($1)', [
        firstRuns.map((r) => r.id),
      ]),
    ).toBe(reports.length * (SCHEMA_FIELDS + 2));
    for (const action of ['extraction_run.queue', 'extraction_run.start', 'extraction_run.succeed'])
      expect(await auditCount(action, 'req-ext-batch-1'), action).toBe(reports.length);
    expect(await auditCount('extraction_batch.create', 'req-ext-batch-1')).toBe(1);
    expect(await auditCount('extraction_run.fail', 'req-ext-batch-1')).toBe(0);
    expect(
      await count("select count(*)::int as n from ops.data_exception where source = 'extraction'"),
    ).toBe(0);
    // The document hub now shows the run as the document's latest.
    const hubDoc = documentPage
      .parse((await get('head.one', `/api/v1/documents?limit=200&docType=${QF}`).expect(200)).body)
      .items.find((d) => d.fileName === firstRuns[0]!.fileName)!;
    expect(hubDoc.latestRun).toEqual({ id: firstRuns[0]!.id, state: 'Succeeded' });
  });

  it('validates every value: the restatement report is clean per the rules and a plain report has no finding at all', async () => {
    const restated = firstRuns.find((r) => r.fileName === scenarioFile('restatement'))!;
    const restatedDetail = await detail('head.one', restated.id);
    const truth = docOf(restated.fileName).truth;
    for (const key of ['revenue_ltm_prior_year', 'ebitda_ltm_prior_year']) {
      const v = valueOf(restatedDetail, key);
      expect(v.value, key).toBe(truth.fields[key]!.value);
      expect(v.value).not.toBeNull();
      // No rule compares a prior-year comparable with the record: the drift is a review matter, not a finding.
      expect(v.validationState).toBe('clean');
      expect(v.findings).toEqual([]);
      expect(v.required).toBe(false);
    }

    const plain = plainReports()[0]!;
    const run = firstRuns.find((r) => r.fileName === plain.fileName)!;
    const d = await detail('head.one', run.id);
    expect(d.values.map((v) => v.field)).toEqual(Object.keys(plain.truth.fields));
    expect(d.values.length).toBe(SCHEMA_FIELDS);
    for (const v of d.values) {
      const f = plain.truth.fields[v.field]!;
      expect(v.value, v.field).toBe(f.value);
      expect(v.unit).toBe(f.unit);
      expect(v.page).toBe(f.page);
      expect(v.quote).toBe(f.quote);
      expect(v.validationState, v.field).toBe('clean');
      expect(v.findings).toEqual([]);
      expect(v.decision).toBeNull();
      expect(v.editedValue).toBeNull();
      expect(v.decidedBy).toBeNull();
      expect(v.label.length).toBeGreaterThan(0);
      if (f.value !== null) expect(D(v.confidence!).eq(D('1'))).toBe(true);
    }
    expect(valueOf(d, 'period_end')).toMatchObject({ kind: 'date', required: true });
    expect(valueOf(d, 'revenue_ltm')).toMatchObject({ kind: 'money', required: true });
    expect(valueOf(d, 'headcount')).toMatchObject({ kind: 'count', required: false });
    expect(valueOf(d, 'sponsor_ownership_pct').kind).toBe('percent');
    expect(d.highlights).toEqual(plain.truth.highlights);
    expect(d.highlights.length).toBe(3);
    expect(d.commentary).toBe(plain.truth.commentary);
    expect(d.run.counts).toEqual({ values: 15, clean: 15, flagged: 0, invalid: 0, decided: 0 });
    expect(d.document.id).toBe(run.documentId);
    expect(d.document.latestRun).toEqual({ id: run.id, state: 'Succeeded' });
    // The narrative rows are staged clean too, undecided.
    const narrative = await h.runtime.db.query<{
      field: string;
      validation_state: string;
      decision: string | null;
    }>(
      "select field, validation_state, decision from stg.extracted_value where run_id = $1 and field in ('highlights', 'commentary') order by field",
      [run.id],
    );
    expect(narrative).toEqual([
      { field: 'commentary', validation_state: 'clean', decision: null },
      { field: 'highlights', validation_state: 'clean', decision: null },
    ]);
  });

  it('extracts the real figures from the injection document: the instruction in its text changes nothing', async () => {
    const injected = firstRuns.find((r) => r.fileName === scenarioFile('injection_doc'))!;
    const d = await detail('head.one', injected.id);
    const truth = docOf(injected.fileName).truth;
    for (const v of d.values) {
      expect(v.value, v.field).toBe(truth.fields[v.field]!.value);
      expect(v.value).not.toBe('999.00');
      expect(v.editedValue).toBeNull();
    }
    expect(valueOf(d, 'revenue_ltm').value).toBe(truth.fields.revenue_ltm!.value);
    expect(d.values.some((v) => v.quote?.includes('999.00') === true)).toBe(false);
    expect(d.highlights.join(' ')).not.toContain('999.00');
    expect(d.commentary ?? '').not.toContain('system prompt');
  });

  it('reads the page layouts with the detail: one layout per page with positioned text runs; the open is audited', async () => {
    const run = firstRuns[0]!;
    const truth = docOf(run.fileName).truth;
    const d = await detail('viewer', run.id, 'req-ext-detail-1');
    expect(d.pages.length).toBe(truth.pageCount);
    expect(d.pages.map((p) => p.number)).toEqual(d.pages.map((_, i) => i + 1));
    for (const page of d.pages) {
      expect(page.width).toBeGreaterThan(0);
      expect(page.height).toBeGreaterThan(0);
      expect(page.runs.length).toBeGreaterThan(0);
      for (const r of page.runs) {
        expect(r.text.length).toBeGreaterThan(0);
        expect(r.size).toBeGreaterThan(0);
      }
    }
    expect(d.pages[0]!.runs.map((r) => r.text).join(' ')).toContain('Quarterly Report');
    // Every cited page carries a run with the quoted figure, so click-to-source can find it.
    for (const v of d.values) {
      if (v.page === null || v.quote === null) continue;
      const texts = d.pages[v.page - 1]!.runs.map((r) => r.text);
      const figure = v.quote.split(' ').pop()!;
      expect(
        texts.some((t) => t.includes(figure)),
        v.field,
      ).toBe(true);
    }
    expect(await auditCount('extraction_run.read', 'req-ext-detail-1')).toBe(1);
    await get('viewer', '/api/v1/extraction/runs/not-a-uuid').expect(404);
    await get('viewer', `/api/v1/extraction/runs/${NO_SUCH_ID}`).expect(404);
  });

  it('hides the walled report run from a non-member and shows it to the wall member', async () => {
    const walledRun = firstRuns.find((r) => r.investmentId === walledId())!;
    expect(walledRun).toBeDefined();
    const outsider = await runsOf('deal.one');
    expect(outsider.length).toBe(firstRuns.length - 1);
    expect(outsider.some((r) => r.id === walledRun.id)).toBe(false);
    expect(JSON.stringify(outsider)).not.toContain(walledId());
    expect(await runsOf('deal.one', `&investmentId=${walledId()}`)).toEqual([]);
    expect((await runsOf('deal.three', `&investmentId=${walledId()}`)).map((r) => r.id)).toEqual([
      walledRun.id,
    ]);
    expect((await runsOf('operations')).length).toBe(firstRuns.length - 1);
    await get('deal.one', `/api/v1/extraction/runs/${walledRun.id}`).expect(404);
    await command('deal.one', walledRun.id, { command: 'accept', field: 'revenue_ltm' }).expect(
      404,
    );
    const member = await detail('deal.three', walledRun.id);
    expect(member.run.investmentId).toBe(walledId());
    expect(member.values.length).toBe(SCHEMA_FIELDS);
    const [outsiderBatch] = await batchesOf('deal.one');
    expect(outsiderBatch!.runs.total).toBe(firstRuns.length - 1);
    const [memberBatch] = await batchesOf('deal.three');
    expect(memberBatch!.runs.total).toBe(firstRuns.length);
  });

  it('reviews a run: accept, edit, reject, acceptClean, then approve promotes dollars with lineage; a second approve is refused', async () => {
    const plain = plainReports()[0]!;
    const run = firstRuns.find((r) => r.fileName === plain.fileName)!;
    const truth = plain.truth;
    const before = await onRecord(truth.investmentId!, quarterEnd());
    const reviewer = user('deal.one');

    const accepted = extractionRunDetail.parse(
      (
        await command(
          'deal.one',
          run.id,
          { command: 'accept', field: 'revenue_ltm' },
          'req-ext-accept-1',
        ).expect(200)
      ).body,
    );
    expect(valueOf(accepted, 'revenue_ltm')).toMatchObject({
      decision: 'accepted',
      decidedBy: reviewer.displayName,
      decidedAt: now(),
      editedValue: null,
    });
    expect(accepted.run.counts.decided).toBe(1);
    expect(await auditCount('extraction_value.accept', 'req-ext-accept-1')).toBe(1);

    // A money edit needs a money unit; a unit must fit the kind; a value must fit the unit.
    for (const body of [
      { command: 'edit', field: 'ebitda_ltm', value: '4.10' },
      { command: 'edit', field: 'ebitda_ltm', value: '4.10', unit: 'PCT' },
      { command: 'edit', field: 'headcount', value: '12.5' },
      { command: 'edit', field: 'sponsor_ownership_pct', value: '0.5', unit: 'COUNT' },
      { command: 'edit', field: 'no_such_field', value: '1', unit: 'USD' },
      { command: 'edit', field: 'highlights', value: 'text' },
      { command: 'accept', field: 'no_such_field' },
    ]) {
      const res = await command('deal.one', run.id, body).expect(400);
      expect(problemDetails.parse(res.body).type).toBe(`${PROBLEM}validation`);
    }
    const edited = extractionRunDetail.parse(
      (
        await command(
          'deal.one',
          run.id,
          {
            command: 'edit',
            field: 'ebitda_ltm',
            value: '4.10',
            unit: 'USD_M',
            reason: 'the report shows 4.10 in the table footnote',
          },
          'req-ext-edit-1',
        ).expect(200)
      ).body,
    );
    expect(valueOf(edited, 'ebitda_ltm')).toMatchObject({
      decision: 'edited',
      editedValue: '4.10',
      unit: 'USD_M',
      value: truth.fields.ebitda_ltm!.value,
    });
    const [editEvent] = await h.runtime.db.query<{
      reason: string;
      details: { field: string; before: Record<string, unknown>; after: Record<string, unknown> };
    }>(
      "select reason, details from audit.event where action = 'extraction_value.edit' and request_id = 'req-ext-edit-1'",
    );
    expect(editEvent!.reason).toBe('the report shows 4.10 in the table footnote');
    expect(editEvent!.details.field).toBe('ebitda_ltm');
    expect(editEvent!.details.before.decision).toBeNull();
    expect(editEvent!.details.after).toEqual({
      decision: 'edited',
      editedValue: '4.10',
      unit: 'USD_M',
    });
    // A count edit takes the field's own unit.
    const headcount = extractionRunDetail.parse(
      (
        await command('deal.one', run.id, {
          command: 'edit',
          field: 'headcount',
          value: '120',
        }).expect(200)
      ).body,
    );
    expect(valueOf(headcount, 'headcount')).toMatchObject({
      decision: 'edited',
      editedValue: '120',
      unit: 'COUNT',
    });

    const rejected = extractionRunDetail.parse(
      (
        await command(
          'deal.one',
          run.id,
          { command: 'reject', field: 'gross_debt', reason: 'not tracked on the record' },
          'req-ext-reject-1',
        ).expect(200)
      ).body,
    );
    expect(valueOf(rejected, 'gross_debt').decision).toBe('rejected');
    expect(await auditCount('extraction_value.reject', 'req-ext-reject-1')).toBe(1);

    // Approval needs every required field decided: period_end is still undecided.
    const early = await command('deal.one', run.id, { command: 'approve' }).expect(409);
    expect(problemDetails.parse(early.body).type).toBe(`${PROBLEM}review-blocked`);
    expect(problemDetails.parse(early.body).detail).toContain('Period end is required');

    const swept = extractionRunDetail.parse(
      (await command('deal.one', run.id, { command: 'acceptClean' }, 'req-ext-clean-1').expect(200))
        .body,
    );
    expect(swept.run.counts.decided).toBe(SCHEMA_FIELDS);
    expect(swept.values.every((v) => v.decision !== null)).toBe(true);
    expect(valueOf(swept, 'gross_debt').decision).toBe('rejected');
    expect(valueOf(swept, 'ebitda_ltm').decision).toBe('edited');
    expect(await auditCount('extraction_run.acceptClean', 'req-ext-clean-1')).toBe(1);
    expect(
      await count(
        "select count(*)::int as n from stg.extracted_value where run_id = $1 and field in ('highlights', 'commentary') and decision = 'accepted'",
        [run.id],
      ),
    ).toBe(2);
    expect(await count('select count(*)::int as n from mon.quarterly_performance')).toBe(
      h.dataset.quarterlyPerformance.length,
    );

    const approved = extractionRunDetail.parse(
      (
        await command(
          'deal.one',
          run.id,
          { command: 'approve', reason: 'figures tie to the report' },
          'req-ext-approve-1',
        ).expect(200)
      ).body,
    );
    expect(approved.run.approvedBy).toBe(reviewer.displayName);
    expect(approved.run.approvedAt).toBe(now());
    expect(approved.run.promotedRecordId).toBe(before.id);
    expect(approved.run.state).toBe('Succeeded');
    const record = await onRecord(truth.investmentId!, quarterEnd());
    expect(record.id).toBe(before.id);
    const dollars = (key: string): string =>
      toDollars(truth.fields[key]!.value!, 'USD_M').toFixed();
    expect(D(record.revenue_ltm!).eq(D(dollars('revenue_ltm')))).toBe(true);
    expect(D(record.revenue_ltm!).eq(D(truth.fields.revenue_ltm!.value!).times(MILLION))).toBe(
      true,
    );
    expect(D(record.ebitda_ltm!).eq(D('4100000'))).toBe(true);
    expect(D(record.ev!).eq(D(dollars('enterprise_value')))).toBe(true);
    expect(D(record.net_debt!).eq(D(dollars('net_debt')))).toBe(true);
    expect(D(record.cash!).eq(D(dollars('cash')))).toBe(true);
    expect(D(record.total_equity!).eq(D(dollars('total_equity')))).toBe(true);
    expect(record.status).toBe('record_status.approved');
    expect(record.approved_by).toBe(reviewer.id);
    expect(new Date(record.approved_at!).toISOString()).toBe(now());
    expect(record.approval_reason).toBe('figures tie to the report');
    expect(record.source_document_id).toBe(run.documentId);
    expect(record.source_page).toBe(truth.fields.revenue_ltm!.page);
    expect(record.source_locator).toBe('field:revenue_ltm');
    expect(record.extraction_run_id).toBe(run.id);
    expect(record.prompt_version).toBe('1');
    expect(record.model_id).toBe('mock');
    expect(record.highlights).toEqual(truth.highlights);
    expect(record.commentary).toBe(truth.commentary);
    expect(await count('select count(*)::int as n from mon.quarterly_performance')).toBe(
      h.dataset.quarterlyPerformance.length,
    );
    // The promotion and the approval are audited with before and after.
    expect(await auditCount('quarterly_performance.promote', 'req-ext-approve-1')).toBe(1);
    expect(await auditCount('extraction_run.approve', 'req-ext-approve-1')).toBe(1);
    const [promote] = await h.runtime.db.query<{
      entity_id: string;
      reason: string;
      details: {
        extractionRunId: string;
        documentId: string;
        fields: string[];
        narrative: string[];
        before: Record<string, string | null>;
        after: Record<string, string | null>;
      };
    }>(
      "select entity_id, reason, details from audit.event where action = 'quarterly_performance.promote' and request_id = 'req-ext-approve-1'",
    );
    expect(promote!.entity_id).toBe(before.id);
    expect(promote!.reason).toBe('figures tie to the report');
    expect(promote!.details.extractionRunId).toBe(run.id);
    expect(promote!.details.documentId).toBe(run.documentId);
    expect(promote!.details.fields.sort()).toEqual(
      ['revenue_ltm', 'ebitda_ltm', 'enterprise_value', 'net_debt', 'cash', 'total_equity'].sort(),
    );
    expect(promote!.details.narrative.sort()).toEqual(['commentary', 'highlights']);
    expect(promote!.details.before.revenueLtm).toBe(before.revenue_ltm);
    expect(promote!.details.after.revenueLtm).toBe(record.revenue_ltm);
    expect(promote!.details.after.ebitdaLtm).toBe(record.ebitda_ltm);

    // Approved once: a second approval and any further decision are refused.
    const again = await command('deal.one', run.id, { command: 'approve' }).expect(409);
    expect(problemDetails.parse(again.body).type).toBe(`${PROBLEM}review-blocked`);
    await command('operations', run.id, { command: 'accept', field: 'cash' }).expect(409);
    await command('operations', run.id, { command: 'acceptClean' }).expect(409);
    expect(
      await count(
        "select count(*)::int as n from audit.event where action = 'quarterly_performance.promote'",
      ),
    ).toBe(1);
  });

  it('refuses approval while an invalid or undecided flagged value remains; a rejected target leaves the record alone', async () => {
    const plain = plainReports()[1]!;
    const doc = byName(plain.fileName);
    const before = await onRecord(plain.truth.investmentId!, quarterEnd());
    let runId = '';
    await withExtractor(
      (input) => {
        const out = extractor(input);
        if (parseMetadata(input).content_hash !== plain.truth.contentHash) return out;
        return {
          ...out,
          fields: {
            ...out.fields,
            cash: { ...out.fields.cash!, quote: 'a figure that is not on this page' },
            headcount: { ...out.fields.headcount!, confidence: '0.5' },
          },
        };
      },
      async () => {
        const batch = extractionBatch.parse(
          (await createBatch('operations', { documentIds: [doc.id] }).expect(201)).body,
        );
        expect(batch.state).toBe('succeeded');
        expect(batch.runs.total).toBe(1);
        const [run] = await runsOf('operations', `&batchId=${batch.id}`);
        runId = run!.id;
        expect(run!.counts).toEqual({ values: 15, clean: 13, flagged: 1, invalid: 1, decided: 0 });
      },
    );
    const d = await detail('operations', runId);
    const cash = valueOf(d, 'cash');
    expect(cash.validationState).toBe('invalid');
    expect(cash.findings.map((f) => f.ruleId)).toEqual(['EXT-CITE-02']);
    expect(cash.findings[0]!.severity).toBe('invalid');
    const headcount = valueOf(d, 'headcount');
    expect(headcount.validationState).toBe('flagged');
    expect(headcount.findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ['EXT-CONF-01', 'flagged'],
    ]);
    expect(d.document.latestRun).toEqual({ id: runId, state: 'Succeeded' });

    await command('operations', runId, { command: 'acceptClean' }).expect(200);
    const invalidLeft = await command('operations', runId, { command: 'approve' }).expect(409);
    expect(problemDetails.parse(invalidLeft.body).detail).toContain(
      'Cash is invalid and not edited or rejected',
    );
    const acceptInvalid = await command('operations', runId, {
      command: 'accept',
      field: 'cash',
    }).expect(409);
    expect(problemDetails.parse(acceptInvalid.body).detail).toContain('not found on page');
    await command('operations', runId, {
      command: 'reject',
      field: 'cash',
      reason: 'the citation does not hold',
    }).expect(200);
    const flaggedLeft = await command('operations', runId, { command: 'approve' }).expect(409);
    expect(problemDetails.parse(flaggedLeft.body).detail).toContain(
      'Headcount is flagged and undecided',
    );
    await command('operations', runId, { command: 'accept', field: 'headcount' }).expect(200);
    const approved = extractionRunDetail.parse(
      (await command('operations', runId, { command: 'approve' }).expect(200)).body,
    );
    expect(approved.run.approvedBy).toBe(user('ops.one').displayName);
    expect(approved.run.promotedRecordId).toBe(before.id);
    const record = await onRecord(plain.truth.investmentId!, quarterEnd());
    expect(record.cash).toBe(before.cash);
    expect(
      D(record.revenue_ltm!).eq(D(plain.truth.fields.revenue_ltm!.value!).times(MILLION)),
    ).toBe(true);
    expect(record.approval_reason).toBe(`AI extraction of ${plain.fileName}`);
    expect(record.extraction_run_id).toBe(runId);
  });

  it('retries a schema failure once, then fails the run with a data exception; a failed run is retried by hand as a fresh run', async () => {
    const plain = plainReports()[2]!;
    const doc = byName(plain.fileName);
    const garbageOnce = (): ((input: string) => unknown) => {
      let served = false;
      return (input) => {
        if (parseMetadata(input).content_hash !== plain.truth.contentHash || served)
          return extractor(input);
        served = true;
        return { nonsense: true };
      };
    };
    await withExtractor(garbageOnce(), async () => {
      const batch = extractionBatch.parse(
        (await createBatch('operations', { documentIds: [doc.id] }, 'req-ext-schema-1').expect(201))
          .body,
      );
      expect(batch.state).toBe('succeeded');
      const [run] = await runsOf('operations', `&batchId=${batch.id}`);
      expect(run!.state).toBe('Succeeded');
      expect(run!.schemaRetries).toBe(1);
      expect(run!.transientRetries).toBe(0);
      expect(run!.errorKind).toBeNull();
      expect(run!.errorCode).toBeNull();
      expect(run!.counts.values).toBe(SCHEMA_FIELDS);
      expect(await auditCount('extraction_run.scheduleRetry', 'req-ext-schema-1')).toBe(1);
      expect(await auditCount('extraction_run.retry', 'req-ext-schema-1')).toBe(1);
      expect(await auditCount('extraction_run.succeed', 'req-ext-schema-1')).toBe(1);
      const [event] = await h.runtime.db.query<{ details: Record<string, unknown> }>(
        "select details from audit.event where action = 'extraction_run.scheduleRetry' and request_id = 'req-ext-schema-1'",
      );
      expect(event!.details).toMatchObject({
        errorKind: 'schema',
        errorCode: 'schema_invalid',
        schemaRetries: 1,
        state: { before: 'Running', after: 'NeedsRetry' },
      });
    });

    let failedId = '';
    const exceptionsBefore = await count(
      "select count(*)::int as n from ops.data_exception where source = 'extraction'",
    );
    await withExtractor(
      (input) =>
        parseMetadata(input).content_hash === plain.truth.contentHash
          ? { nonsense: true }
          : extractor(input),
      async () => {
        const callsBefore = extractionCalls();
        const batch = extractionBatch.parse(
          (
            await createBatch('operations', { documentIds: [doc.id] }, 'req-ext-schema-2').expect(
              201,
            )
          ).body,
        );
        expect(batch.state).toBe('failed');
        expect(batch.errorCode).toBe('runs_failed');
        expect(batch.progress).toBe(100);
        expect(batch.runs).toMatchObject({ total: 1, failed: 1, succeeded: 0 });
        expect(extractionCalls() - callsBefore).toBe(1 + settings().schemaRetries);
        const [run] = await runsOf('operations', `&batchId=${batch.id}`);
        failedId = run!.id;
        expect(run!.state).toBe('Failed');
        expect(run!.errorKind).toBe('schema');
        expect(run!.errorCode).toBe('schema_invalid');
        expect(run!.schemaRetries).toBe(settings().schemaRetries);
        expect(run!.finishedAt).toBe(now());
        expect(run!.counts.values).toBe(0);
        expect(await auditCount('extraction_run.fail', 'req-ext-schema-2')).toBe(1);
        const exceptions = await h.runtime.db.query<{
          rule_id: string;
          entity: string;
          entity_id: string;
          state: string;
          actual: string;
        }>(
          "select rule_id, entity, entity_id, state, actual from ops.data_exception where source = 'extraction' and entity_id = $1",
          [failedId],
        );
        expect(exceptions).toEqual([
          {
            rule_id: RUN_EXCEPTION_RULE,
            entity: 'doc.extraction_run',
            entity_id: failedId,
            state: 'open',
            actual: 'the run failed (schema_invalid)',
          },
        ]);
        expect(
          await count(
            "select count(*)::int as n from ops.data_exception where source = 'extraction'",
          ),
        ).toBe(exceptionsBefore + 1);
        // Nothing of a failed run is staged, and the review commands need a Succeeded run.
        expect(
          await count('select count(*)::int as n from stg.extracted_value where run_id = $1', [
            failedId,
          ]),
        ).toBe(0);
        await command('operations', failedId, { command: 'acceptClean' }).expect(409);
      },
    );
    // Retried by hand with the fixtures back: a fresh Queued run for the same document, driven at once.
    const retried = extractionRunDetail.parse(
      (await command('deal.one', failedId, { command: 'retry' }, 'req-ext-retry-1').expect(200))
        .body,
    );
    expect(retried.run.id).not.toBe(failedId);
    expect(retried.run.state).toBe('Succeeded');
    expect(retried.run.batchId).toBeNull();
    expect(retried.run.documentId).toBe(doc.id);
    expect(retried.run.requestedBy).toBe(user('deal.one').displayName);
    expect(retried.run.schemaRetries).toBe(0);
    expect(retried.values.length).toBe(SCHEMA_FIELDS);
    expect((await detail('operations', failedId)).run.state).toBe('Failed');
    expect(await auditCount('extraction_run.queue', 'req-ext-retry-1')).toBe(1);
    const [queued] = await h.runtime.db.query<{ details: { retryOf: string } }>(
      "select details from audit.event where action = 'extraction_run.queue' and request_id = 'req-ext-retry-1'",
    );
    expect(queued!.details.retryOf).toBe(failedId);
    // retry is only for NeedsRetry and Failed runs.
    const notAllowed = await command('operations', retried.run.id, { command: 'retry' }).expect(
      409,
    );
    expect(problemDetails.parse(notAllowed.body).type).toBe(`${PROBLEM}workflow-transition`);
  });

  it('retries a transient failure within its budget and fails past it', async () => {
    const plain = plainReports()[3] ?? plainReports()[0]!;
    const doc = byName(plain.fileName);
    const failing = (times: number): ((input: string) => unknown) => {
      let thrown = 0;
      return (input) => {
        if (parseMetadata(input).content_hash === plain.truth.contentHash && thrown < times) {
          thrown += 1;
          throw new Error('the model endpoint did not answer');
        }
        return extractor(input);
      };
    };
    await withExtractor(failing(1), async () => {
      const batch = extractionBatch.parse(
        (
          await createBatch('operations', { documentIds: [doc.id] }, 'req-ext-transient-1').expect(
            201,
          )
        ).body,
      );
      expect(batch.state).toBe('succeeded');
      const [run] = await runsOf('operations', `&batchId=${batch.id}`);
      expect(run!.state).toBe('Succeeded');
      expect(run!.transientRetries).toBe(1);
      expect(run!.schemaRetries).toBe(0);
      const [event] = await h.runtime.db.query<{ details: Record<string, unknown> }>(
        "select details from audit.event where action = 'extraction_run.scheduleRetry' and request_id = 'req-ext-transient-1'",
      );
      expect(event!.details).toMatchObject({
        errorKind: 'transient',
        errorCode: 'call_failed',
        transientRetries: 1,
      });
    });
    await withExtractor(failing(100), async () => {
      const callsBefore = extractionCalls();
      const batch = extractionBatch.parse(
        (await createBatch('operations', { documentIds: [doc.id] }).expect(201)).body,
      );
      expect(batch.state).toBe('failed');
      expect(extractionCalls() - callsBefore).toBe(1 + settings().transientRetries);
      const [run] = await runsOf('operations', `&batchId=${batch.id}`);
      expect(run!.state).toBe('Failed');
      expect(run!.errorKind).toBe('transient');
      expect(run!.errorCode).toBe('call_failed');
      expect(run!.transientRetries).toBe(settings().transientRetries);
      expect(run!.tokensIn).toBeNull();
      expect(run!.costUsd).toBeNull();
    });
  });

  it('fails a run over the run token budget, and the day budget stops the rest without a model call', async () => {
    const [a, b] = [plainReports()[0]!, plainReports()[1]!].map((p) => byName(p.fileName));
    await withExtraction({ runTokenBudget: 10 }, async () => {
      const batch = extractionBatch.parse(
        (await createBatch('operations', { documentIds: [a!.id] }).expect(201)).body,
      );
      expect(batch.state).toBe('failed');
      const [run] = await runsOf('operations', `&batchId=${batch.id}`);
      expect(run!.state).toBe('Failed');
      expect(run!.errorCode).toBe('run_budget');
      expect(run!.errorKind).toBeNull();
      expect(run!.tokensIn).toBeGreaterThan(10);
      expect(run!.costUsd).toBe(costOf(run!.tokensIn!, run!.tokensOut!, settings()));
      expect(run!.counts.values).toBe(0);
      expect(
        await count(
          "select count(*)::int as n from ops.data_exception where source = 'extraction' and entity_id = $1",
          [run!.id],
        ),
      ).toBe(1);
    });
    // The budget of the day: what the runs started today have used, so the next run passes and the one after fails.
    const usedToday = await count(
      'select coalesce(sum(tokens_in + tokens_out), 0)::int as n from doc.extraction_run',
    );
    expect(usedToday).toBeGreaterThan(0);
    await withExtraction({ dayTokenBudget: usedToday, batchConcurrency: 1 }, async () => {
      const callsBefore = extractionCalls();
      const batch = extractionBatch.parse(
        (await createBatch('operations', { documentIds: [a!.id, b!.id] }).expect(201)).body,
      );
      expect(batch.state).toBe('failed');
      expect(batch.runs).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
      expect(extractionCalls() - callsBefore).toBe(1);
      const runs = await runsOf('operations', `&batchId=${batch.id}`);
      const stopped = runs.find((r) => r.state === 'Failed')!;
      expect(stopped.errorCode).toBe('day_budget');
      expect(stopped.errorKind).toBeNull();
      expect(stopped.tokensIn).toBeNull();
      expect(stopped.costUsd).toBeNull();
      expect(stopped.documentId).toBe(b!.id);
      expect(runs.find((r) => r.state === 'Succeeded')!.documentId).toBe(a!.id);
    });
  });

  it('pages the runs and the batches without a gap or a repeat, and filters runs by state and document', async () => {
    const all = await runsOf('head.one');
    const seen: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = extractionRunPage.parse(
        (
          await get(
            'head.one',
            `/api/v1/extraction/runs?limit=5${cursor === null ? '' : `&cursor=${cursor}`}`,
          ).expect(200)
        ).body,
      );
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(seen.length).toBe(all.length);
    expect(new Set(seen).size).toBe(seen.length);
    await get('head.one', '/api/v1/extraction/runs?cursor=bm90LWEtY3Vyc29y').expect(400);
    const failed = await runsOf('head.one', '&state=Failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((r) => r.state === 'Failed')).toBe(true);
    const doc = firstRuns[0]!.documentId;
    const ofDocument = await runsOf('head.one', `&documentId=${doc}`);
    expect(ofDocument.length).toBeGreaterThan(0);
    expect(ofDocument.every((r) => r.documentId === doc)).toBe(true);

    const batches = await batchesOf('head.one');
    expect(batches.length).toBeGreaterThan(3);
    expect(batches[batches.length - 1]!.id).toBe(firstBatch.id);
    const first = extractionBatchPage.parse(
      (await get('head.one', '/api/v1/extraction/batches?limit=2').expect(200)).body,
    );
    expect(first.items.length).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    const second = extractionBatchPage.parse(
      (
        await get(
          'head.one',
          `/api/v1/extraction/batches?limit=2&cursor=${first.nextCursor}`,
        ).expect(200)
      ).body,
    );
    expect(second.items.map((b) => b.id)).toEqual(batches.slice(2, 4).map((b) => b.id));
    expect(batches.every((b) => b.progress === 100)).toBe(true);
  });
});
