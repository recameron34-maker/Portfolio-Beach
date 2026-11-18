import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, heldMultipleMark, impliedStakeMark, toDecimalString, valueChange } from '@pb/calc';
import {
  NO_SUGGESTION_REASON_CODES,
  SUGGESTION_INPUT_SOURCE_KINDS,
  SUGGESTION_SUPERSEDED_REASONS,
  VALUATION_SUGGESTION_STATES,
  intakeImportResult,
  problemDetails,
  valuationRow,
  valuationSuggestionPage,
} from '@pb/contracts';
import type { ExtractionRun, ValuationSuggestionRow } from '@pb/contracts';
import {
  NO_SUGGESTION_REASONS,
  SUGGESTION_BUSY_REFUSAL,
  SUGGESTION_SOURCE_KINDS,
  SUPERSEDED_REASONS,
  valuationSuggestionMachine,
} from '@pb/workflows';
import { createTestDb } from '@pb/db/testing';
import { STATEMENT_EXAMPLES } from '@pb/synthetic';
import { createLogger } from '../common/logging.js';
import { buildRuntime } from '../composition.js';
import { loadConfig } from '../config.js';
import { isSuggestionRace, suggestionBusy } from '../suggestions/derivation.service.js';
import { CAS, PROBLEM, QF, SUGGESTIONS, startSuggestionKit } from './suggestion-kit.js';
import type { CraftedPosition, SuggestionKit } from './suggestion-kit.js';

/*
 * Valuation suggestions, derived and read (docs/04 M10, docs/08 section 12, docs/18 section 14,
 * decision 0023): what the approval of a capital account statement or a sponsor report does to
 * the suggestion of its position and quarter, the rules that keep a mark from being suggested,
 * the replacement and the closing of an Open suggestion, the refresh when the record moves, and
 * what a reader is shown. The commands are tested in suggestion-commands.test.ts.
 */

/** config/extraction_schema.json, as far as a test changes it. */
interface SchemaFile {
  schemas: Record<string, { fields: { key: string }[] }>;
}

const SPONSOR_MARK = 'valuation_method.sponsor_mark';
const REPORT_INDICATION = 'valuation_method.report_indication';

/** Positions whose mark and contributions are the figures of docs/08 section 12, examples 1, 3 and 8. */
const crafted = (quarterEnd: string): CraftedPosition[] =>
  [
    ['INV-0931', 'Harrowgate Logistics', '90000000-0000-4000-8000-000000000931'],
    ['INV-0932', 'Lindenmere Software', '90000000-0000-4000-8000-000000000932'],
    ['INV-0933', 'Castlebrook Dental', '90000000-0000-4000-8000-000000000933'],
  ].map(([investmentNumber = '', companyName = '', id = '']) => ({
    id,
    companyId: id.replace('90000000', '91000000'),
    investmentNumber,
    companyName,
    like: 'INV-0001',
    entryDate: '2024-01-15',
    contributions: [
      { date: '2024-01-15', amount: '10400000.00' },
      { date: '2025-08-15', amount: '2000000.00' },
    ],
    marks: [{ periodEnd: quarterEnd, fairValue: '18420000.00' }],
  }));
/** A position held in euros: nothing is converted, so nothing is suggested. */
const EURO_POSITION: CraftedPosition = {
  id: '90000000-0000-4000-8000-000000000934',
  companyId: '91000000-0000-4000-8000-000000000934',
  investmentNumber: 'INV-0934',
  companyName: 'Oostervaart Marine',
  like: 'INV-0001',
  currency: 'EUR',
  entryDate: '2024-01-15',
  contributions: [{ date: '2024-01-15', amount: '5000000.00' }],
  marks: [],
};

describe('the contract and the machine name the same things', () => {
  it('lists the states, the superseded reasons, the source kinds and the "none when" reasons once each', () => {
    expect([...VALUATION_SUGGESTION_STATES]).toEqual([...valuationSuggestionMachine.states]);
    expect([...SUGGESTION_SUPERSEDED_REASONS]).toEqual([...SUPERSEDED_REASONS]);
    expect([...SUGGESTION_INPUT_SOURCE_KINDS]).toEqual([...SUGGESTION_SOURCE_KINDS]);
    expect([...NO_SUGGESTION_REASON_CODES]).toEqual([...NO_SUGGESTION_REASONS]);
  });

  it('answers two approvals racing for one position and quarter with 409, and nothing else', () => {
    const pg = (code: string, constraint?: string): Error =>
      Object.assign(new Error('Failed query'), {
        cause: Object.assign(new Error('db'), { code, severity: 'ERROR', constraint }),
      });
    expect(isSuggestionRace(pg('55P03'))).toBe(true);
    expect(isSuggestionRace(pg('40P01'))).toBe(true);
    expect(isSuggestionRace(pg('23505', 'valuation_suggestion_one_open_idx'))).toBe(true);
    expect(isSuggestionRace(pg('23505', 'valuation_investment_id_period_end_version_key'))).toBe(
      false,
    );
    expect(isSuggestionRace(pg('23503'))).toBe(false);
    expect(isSuggestionRace(new Error('boom'))).toBe(false);
    const busy = suggestionBusy();
    expect(busy.getStatus()).toBe(409);
    expect(busy.message).toBe(SUGGESTION_BUSY_REFUSAL);
  });

  it('refuses to start without the settings of the suggestions, naming the key and never a value', async () => {
    const source = new URL('../../../../config/', import.meta.url).pathname;
    const startWith = async (
      change: (definitions: Record<string, unknown>, schemas: SchemaFile) => void,
    ): Promise<unknown> => {
      const dir = mkdtempSync(join(tmpdir(), 'pb-config-'));
      cpSync(source, dir, { recursive: true });
      const read = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const definitions = read('definitions.json') as Record<string, unknown>;
      const schemas = read('extraction_schema.json') as SchemaFile;
      change(definitions, schemas);
      writeFileSync(join(dir, 'definitions.json'), JSON.stringify(definitions));
      writeFileSync(join(dir, 'extraction_schema.json'), JSON.stringify(schemas));
      const scratch = mkdtempSync(join(tmpdir(), 'pb-api-'));
      const db = await createTestDb();
      try {
        return await buildRuntime(
          loadConfig({
            NODE_ENV: 'test',
            PB_LOG_LEVEL: 'silent',
            PB_CONFIG_DIR: dir,
            PB_DOCUMENT_ROOT: join(scratch, 'documents'),
            PB_ACCOUNTING_ROOT: join(scratch, 'accounting'),
            PB_DROP_ROOT: join(scratch, 'drops'),
          }),
          { db, logger: createLogger('silent'), mockUsers: [] },
        ).then(
          () => null,
          (error: unknown) => error,
        );
      } finally {
        await db.close();
      }
    };
    expect(await startWith(() => undefined)).toBeNull();
    const missing = (key: string): string => `config/definitions.json is missing a usable ${key}`;
    const cases: [(d: Record<string, unknown>) => void, string][] = [
      [(d) => delete d.valuationSuggestions, 'valuationSuggestions.sourceOrder'],
      [
        (d) => {
          d.valuationSuggestions = {
            ...(d.valuationSuggestions as object),
            sourceOrder: ['capital_account_balance', 'sponsor_equity_value'],
          };
        },
        'valuationSuggestions.sourceOrder',
      ],
      [
        (d) => {
          d.valuationSuggestions = {
            ...(d.valuationSuggestions as object),
            tieToleranceByUnit: { USD_K: 2500, USD_M: 'MARKER-NEVER-ECHOED' },
          };
        },
        'valuationSuggestions.tieToleranceByUnit.USD_M',
      ],
      [
        (d) => {
          d.valuationSuggestions = {
            ...(d.valuationSuggestions as object),
            contributionsTolerancePct: -0.02,
          };
        },
        'valuationSuggestions.contributionsTolerancePct',
      ],
      [(d) => delete d.rollForwardToleranceUsd, 'rollForwardToleranceUsd'],
      [(d) => delete d.valuationVarianceFlag, 'valuationVarianceFlag'],
    ];
    for (const [change, key] of cases) {
      const refused = await startWith(change);
      expect(refused, key).toBeInstanceOf(Error);
      expect((refused as Error).message, key).toBe(missing(key));
      expect((refused as Error).message, key).not.toContain('MARKER');
    }
    // A statement schema that lost a line the rules read is refused too.
    const noBalance = await startWith((_d, schemas) => {
      const statement = schemas.schemas.capital_account_statement!;
      statement.fields = statement.fields.filter((f) => f.key !== 'ending_capital_balance');
    });
    expect((noBalance as Error).message).toBe(
      'config/extraction_schema.json has no money field ending_capital_balance in the schema capital_account_statement',
    );
  }, 60_000);
});

describe('valuation suggestions: derivation and reads (decision 0023)', () => {
  let k: SuggestionKit;
  let q2: string;
  let q3: string;
  let statements: Map<string, ExtractionRun>;
  let seededStatements: Map<string, ExtractionRun>;
  let reports: Map<string, ExtractionRun>;

  const STALE = 'INV-0007';
  const WALLED = 'INV-0010';
  const fileOf = (key: string): string => k.written.get(key)!.fileName;
  const runOf = (key: string): ExtractionRun => statements.get(fileOf(key))!;
  const seededFile = (number: string, periodEnd: string): string =>
    k.h.documents.expectations.positionStatements.find(
      (p) => p.investmentNumber === number && p.periodEnd === periodEnd,
    )!.fileName;
  const reportRun = (number: string, periodEnd: string): ExtractionRun =>
    [...reports.values()].find((r) => r.investmentNumber === number && r.periodEnd === periodEnd)!;
  const outcomeOf = async (who: string, runId: string) =>
    (await k.list(who, `&state=all&extractionRunId=${runId}`)).runOutcome;
  const storedCount = (number: string, periodEnd: string): Promise<number> =>
    k.count(
      'select count(*)::int as n from mon.valuation_suggestion where investment_id = $1 and period_end = $2',
      [k.investment(number).id, periodEnd],
    );
  const quarterOnRecord = async (number: string, periodEnd: string) =>
    (
      await k.rows<{
        id: string;
        ev: string | null;
        net_debt: string | null;
        ebitda_ltm: string | null;
      }>(
        'select id, ev::text as ev, net_debt::text as net_debt, ebitda_ltm::text as ebitda_ltm from mon.quarterly_performance where investment_id = $1 and period_end = $2 and not is_entry_snapshot',
        [k.investment(number).id, periodEnd],
      )
    )[0]!;

  beforeAll(async () => {
    k = await startSuggestionKit({
      crafted: [...crafted('2025-06-30'), EURO_POSITION],
      statements: ({ nextQuarter, quarterEnd }) => ({
        example1: { position: 'INV-0931', periodEnd: nextQuarter, example: 'ties' },
        example3: { position: 'INV-0932', periodEnd: nextQuarter, example: 'wholeVehicle' },
        example8: { position: 'INV-0933', periodEnd: nextQuarter, example: 'contributionsDiffer' },
        withinTolerance: {
          position: 'INV-0003',
          periodEnd: nextQuarter,
          example: 'tiesWithinTolerance',
        },
        doesNotTie: { position: 'INV-0004', periodEnd: nextQuarter, example: 'doesNotTie' },
        noShare: { position: 'INV-0005', periodEnd: nextQuarter, example: 'wholeVehicleNoShare' },
        euroStatement: { position: 'INV-0006', periodEnd: nextQuarter, example: 'euro' },
        thousands: { position: 'INV-0011', periodEnd: nextQuarter, example: 'thousands' },
        fundStyle: { position: 'INV-0012', periodEnd: nextQuarter, example: 'fundStyle' },
        credit: { position: 'INV-0009', periodEnd: nextQuarter },
        euroPosition: { position: 'INV-0934', periodEnd: nextQuarter },
        notHeld: { position: 'INV-0017', periodEnd: nextQuarter },
        earlyMark: { position: 'INV-0002', periodEnd: quarterEnd },
        afterEarlyMark: { position: 'INV-0002', periodEnd: nextQuarter },
        walled: { position: WALLED, periodEnd: nextQuarter },
        handDraft: { position: 'INV-0014', periodEnd: nextQuarter },
        switchedOff: { position: 'INV-0016', periodEnd: nextQuarter },
      }),
    });
    q2 = k.quarterEnd;
    q3 = k.nextQuarter;
    expect([q2, q3]).toEqual(['2025-06-30', '2025-09-30']);
    await k.index();
    // By type and quarter, as operations: the walled statement is extracted with the rest.
    seededStatements = await k.extractQuarter(q2, CAS);
    statements = new Map([...(await k.extractQuarter(q3, CAS)), ...seededStatements]);
    reports = await k.extractQuarter(q2, QF);
  }, 120_000);
  afterAll(async () => {
    await k.close();
  });

  it('starts with no suggestion, and gives the three other roles nothing', async () => {
    expect(await k.count('select count(*)::int as n from mon.valuation_suggestion')).toBe(0);
    for (const who of ['deal.one', 'ops.one', 'head.one', 'audit.one']) {
      const page = await k.list(who);
      expect(page).toEqual({ items: [], nextCursor: null, openCount: 0, runOutcome: null });
    }
    for (const who of ['viewer.one', 'ir.one', 'admin.one']) {
      const refused = await k.get(who, SUGGESTIONS).expect(403);
      expect(problemDetails.parse(refused.body).type).toBe(`${PROBLEM}forbidden`);
      await k.get(who, `${SUGGESTIONS}/90000000-0000-4000-8000-000000000001`).expect(403);
    }
    await k.get('ops.one', `${SUGGESTIONS}/not-a-uuid`).expect(404);
    await k.get('ops.one', `${SUGGESTIONS}/90000000-0000-4000-8000-000000000001`).expect(404);
    await k.get('ops.one', `${SUGGESTIONS}?state=Pending`).expect(400);
    await k.get('ops.one', `${SUGGESTIONS}?cursor=bm90LWEtY3Vyc29y`).expect(400);
  });

  describe('the example sequence on the position with no mark for the quarter', () => {
    let fromReport: ValuationSuggestionRow;
    let fromStatement: ValuationSuggestionRow;

    it('opens a suggestion from the sponsor report: the last Locked mark scaled by the equity value', async () => {
      const run = reportRun(STALE, q2);
      expect(await outcomeOf('deal.one', run.id)).toBeNull();
      const approved = await k.approve('deal.one', run.id, 'req-sug-report');
      expect(approved.run.promotedRecordId).not.toBeNull();

      const page = await k.list('ops.one');
      expect(page.openCount).toBe(1);
      expect(page.items).toHaveLength(1);
      fromReport = page.items[0]!;
      const earlier = await quarterOnRecord(STALE, '2025-03-31');
      const current = await quarterOnRecord(STALE, q2);
      const expected = impliedStakeMark({
        referenceMark: '46078308.34',
        flowsSinceReferenceMark: false,
        reference: { ev: earlier.ev, netDebt: earlier.net_debt },
        current: { ev: current.ev!, netDebt: current.net_debt },
      });
      expect(expected.value).not.toBeNull();
      expect(fromReport).toMatchObject({
        investmentNumber: STALE,
        periodEnd: q2,
        basis: 'sponsor_equity_value',
        method: REPORT_INDICATION,
        reasonCode: null,
        state: 'Open',
        decidedBy: null,
        valuationId: null,
        supersededReason: null,
        checks: null,
        crossChecks: [],
        inProgress: null,
        sourceReviewerIds: [k.userId('deal.one')],
        currentMark: {
          value: '46078308.34',
          periodEnd: '2025-03-31',
          reportsFor: '2025-03-31',
          previousQuarter: true,
          ageQuarters: 1,
        },
      });
      expect(D(fromReport.suggestedValue!).eq(D(expected.value!))).toBe(true);
      // The suggested mark, to the cent, as the column holds it.
      expect(fromReport.suggestedValue).toMatch(/^\d+\.\d{2}$/);
      expect(fromReport.source).toMatchObject({
        documentId: run.documentId,
        fileName: run.fileName,
        extractionRunId: run.id,
        locator: 'field:enterprise_value',
      });
      expect(fromReport.source.page).toBeGreaterThanOrEqual(1);
      // Each input with where it came from: the mark, the earlier quarter on record, the report's pages.
      expect(fromReport.workings.inputs.map((i) => [i.key, i.source.kind, i.periodEnd])).toEqual([
        ['reference_mark', 'valuation', '2025-03-31'],
        ['reference_enterprise_value', 'record', '2025-03-31'],
        ['reference_net_debt', 'record', '2025-03-31'],
        ['enterprise_value', 'document', q2],
        ['net_debt', 'document', q2],
      ]);
      for (const input of fromReport.workings.inputs) {
        expect(input.edited).toBe(false);
        expect(input.source.fileName).toBe(input.source.kind === 'document' ? run.fileName : null);
      }
      const change = D(fromReport.suggestedValue!).minus('46078308.34');
      expect(D(fromReport.comparison.change!).eq(change)).toBe(true);
      expect(fromReport.comparison.changePct).toBe(
        toDecimalString(valueChange(fromReport.suggestedValue, '46078308.34')),
      );
      // More than ten percent below the previous quarter's mark: the board's variance flag.
      expect(fromReport.flags).toEqual({
        variance: true,
        ties: null,
        contributionsDiffer: false,
        sourcesDiffer: false,
        editedByReviewer: false,
      });
      expect(fromReport.comparison.netOfFlows).toBeNull();
      expect(await outcomeOf('deal.one', run.id)).toEqual({
        outcome: 'opened',
        reason: null,
        suggestionId: fromReport.id,
      });

      const events = await k.rows<{
        action: string;
        actor_id: string;
        details: Record<string, unknown>;
      }>(
        "select action, actor_id, details from audit.event where request_id = 'req-sug-report' and action like 'valuation_suggestion.%'",
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'valuation_suggestion.open',
        actor_id: k.userId('deal.one'),
        details: {
          investmentId: k.investment(STALE).id,
          periodEnd: q2,
          basis: 'sponsor_equity_value',
          state: { before: null, after: 'Open' },
          replaces: null,
          mode: 'approval',
          by: 'system',
        },
      });
    });

    it('is read with its ETag by the four roles, and opening it is audited', async () => {
      for (const who of ['deal.one', 'ops.two', 'head.one', 'audit.one']) {
        const res = await k
          .get(who, `${SUGGESTIONS}/${fromReport.id}`, `req-sug-read-${who}`)
          .expect(200);
        expect(res.headers.etag).toBe(`"${fromReport.rowVersion}"`);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toEqual(fromReport);
        expect(
          await k.count(
            "select count(*)::int as n from audit.event where action = 'valuation_suggestion.read' and request_id = $1 and entity_id = $2",
            [`req-sug-read-${who}`, fromReport.id],
          ),
        ).toBe(1);
      }
    });

    it('replaces it when the statement is approved: the ending balance, with the report beside it', async () => {
      const run = seededStatements.get(seededFile(STALE, q2))!;
      await k.approve('ops.one', run.id, 'req-sug-statement');
      const page = await k.list('ops.one');
      expect(page.openCount).toBe(1);
      fromStatement = page.items[0]!;
      expect(fromStatement).toMatchObject({
        investmentNumber: STALE,
        periodEnd: q2,
        basis: 'capital_account_balance',
        method: SPONSOR_MARK,
        suggestedValue: '38140000.00',
        reasonCode: null,
        state: 'Open',
        sourceReviewerIds: [k.userId('ops.one')],
        source: { documentId: run.documentId, extractionRunId: run.id, page: 1 },
      });
      expect(fromStatement.source.locator).toBe('field:ending_capital_balance');
      expect(fromStatement.workings.inputs).toEqual([
        {
          key: 'ending_capital_balance',
          value: '38140000',
          periodEnd: q2,
          source: { kind: 'document', id: run.documentId, page: 1, fileName: run.fileName },
          edited: false,
        },
      ]);
      // The report's indication sits beside it and is not blended in.
      expect(fromStatement.crossChecks).toHaveLength(1);
      const [beside] = fromStatement.crossChecks;
      expect(beside).toMatchObject({ basis: 'sponsor_equity_value', reason: null, differs: false });
      expect(D(beside!.value!).eq(D(fromReport.suggestedValue!))).toBe(true);
      expect(D(beside!.difference!).eq(D(fromReport.suggestedValue!).minus('38140000'))).toBe(true);
      expect(D(beside!.difference!).abs().lt(10000)).toBe(true);
      expect(fromStatement.checks).toMatchObject({
        ties: true,
        ownAccount: true,
        tieToleranceUsd: '25000',
        contributionsCheck: { differs: false, notChecked: null, record: '37860237.78' },
      });
      expect(fromStatement.flags).toEqual({
        variance: true,
        ties: true,
        contributionsDiffer: false,
        sourcesDiffer: false,
        editedByReviewer: false,
      });

      const replaced = await k.detail('ops.one', fromReport.id);
      expect(replaced).toMatchObject({
        state: 'Superseded',
        supersededReason: 'better_source',
        supersededById: fromStatement.id,
        decisionReason: null,
        valuationId: null,
      });
      // The system actor superseded it: no person is named.
      expect(replaced.decidedBy).toBeNull();
      expect(replaced.decidedAt).toBe(k.h.runtime.adapters.clock.now());
      expect(replaced.rowVersion).toBe(fromReport.rowVersion + 1);
      // The figures of a suggestion never change: a new one replaced it.
      expect(replaced.suggestedValue).toBe(fromReport.suggestedValue);
      expect(replaced.workings).toEqual(fromReport.workings);

      const superseded = await k.list('audit.one', '&state=Superseded');
      expect(superseded.items.map((s) => s.id)).toEqual([fromReport.id]);
      expect((await k.list('audit.one', '&state=all')).items.map((s) => s.id)).toEqual([
        fromStatement.id,
        fromReport.id,
      ]);
      expect(await outcomeOf('ops.one', run.id)).toEqual({
        outcome: 'replaced',
        reason: null,
        suggestionId: fromStatement.id,
      });
      expect((await outcomeOf('ops.one', reportRun(STALE, q2).id))?.outcome).toBe('opened');

      const events = await k.rows<{ action: string; details: Record<string, unknown> }>(
        "select action, details from audit.event where request_id = 'req-sug-statement' and action like 'valuation_suggestion.%' order by id",
      );
      expect(events.map((e) => e.action)).toEqual([
        'valuation_suggestion.supersede',
        'valuation_suggestion.open',
      ]);
      expect(events[0]!.details).toMatchObject({
        state: { before: 'Open', after: 'Superseded' },
        supersededReason: { before: null, after: 'better_source' },
        supersededById: { before: null, after: fromStatement.id },
      });
      expect(events[1]!.details).toMatchObject({
        basis: 'capital_account_balance',
        suggestedValue: '38140000.00',
        replaces: fromReport.id,
      });
    });

    it('pages newest first and filters by position, quarter and state', async () => {
      const pageOf = async (query: string) =>
        valuationSuggestionPage.parse(
          (await k.get('ops.one', `${SUGGESTIONS}?state=all&limit=1${query}`).expect(200)).body,
        );
      const first = await pageOf('');
      expect(first.items.map((s) => s.id)).toEqual([fromStatement.id]);
      expect(first.nextCursor).not.toBeNull();
      const second = await pageOf(`&cursor=${encodeURIComponent(first.nextCursor!)}`);
      expect(second.items.map((s) => s.id)).toEqual([fromReport.id]);
      expect(second.nextCursor).toBeNull();
      const here = `&investmentId=${k.investment(STALE).id}`;
      expect((await k.list('ops.one', `${here}&periodEnd=${q2}`)).items).toHaveLength(1);
      expect((await k.list('ops.one', `${here}&periodEnd=2025-03-31`)).items).toHaveLength(0);
      expect(
        (await k.list('ops.one', `&investmentId=${k.investment('INV-0001').id}`)).items,
      ).toHaveLength(0);
      expect((await k.list('ops.one', '&state=Dismissed')).items).toHaveLength(0);
    });
  });

  describe('each statement of docs/08 section 12, read as our mark', () => {
    it('example 1: our own account that ties, set against the previous quarter and net of flows', async () => {
      await k.approve('ops.one', runOf('example1').id);
      const row = (await k.open('ops.one', 'INV-0931', q3))!;
      expect(row).toMatchObject({
        basis: 'capital_account_balance',
        method: SPONSOR_MARK,
        suggestedValue: '20940000.00',
        currentMark: { value: '18420000.00', periodEnd: q2, previousQuarter: true, ageQuarters: 1 },
        comparison: {
          change: '2520000',
          changePct: '0.1368078176',
          variance: true,
          netOfFlows: '870000',
          netOfFlowsPct: '0.0472312704',
          beginningBalance: '18420000',
        },
        checks: {
          ties: true,
          tieDifference: '0',
          tieToleranceUsd: '25000',
          ownAccount: true,
          contributionsCheck: {
            statement: '12400000',
            record: '12400000',
            difference: '0',
            differencePct: '0',
            differs: false,
            notChecked: null,
          },
        },
        crossChecks: [],
        flags: { variance: true, ties: true, contributionsDiffer: false, sourcesDiffer: false },
      });
    });

    it('example 2: lines 20,000 apart tie in millions, lines 50,000 apart do not, and the value is the same', async () => {
      await k.approve('ops.one', runOf('withinTolerance').id);
      await k.approve('ops.one', runOf('doesNotTie').id);
      const within = (await k.open('ops.one', 'INV-0003', q3))!;
      const apart = (await k.open('ops.one', 'INV-0004', q3))!;
      expect(within.checks).toMatchObject({ ties: true, tieDifference: '-20000' });
      expect(within.flags.ties).toBe(true);
      expect(apart.checks).toMatchObject({ ties: false, tieDifference: '-50000' });
      expect(apart.flags.ties).toBe(false);
      // A statement that does not tie is flagged, never held back.
      expect([within.suggestedValue, apart.suggestedValue]).toEqual(['20940000.00', '20940000.00']);
      // The beginning balance is not the mark on record: no figure net of flows, the balance beside it.
      expect(within.comparison.netOfFlows).toBeNull();
      expect(within.comparison.beginningBalance).toBe('18420000');
    });

    it('example 3: the whole vehicle times our share of it', async () => {
      await k.approve('ops.one', runOf('example3').id);
      const row = (await k.open('ops.one', 'INV-0932', q3))!;
      expect(row.suggestedValue).toBe('20940000.00');
      expect(row.workings.inputs.map((i) => [i.key, i.value, i.source.kind])).toEqual([
        ['ending_capital_balance', '83760000', 'document'],
        ['investor_share_pct', '0.2500', 'document'],
      ]);
      expect(row.checks).toMatchObject({
        ownAccount: false,
        ties: true,
        contributionsCheck: { statement: '12400000', differs: false },
      });
      expect(row.comparison).toMatchObject({ netOfFlows: '870000', beginningBalance: '18420000' });
    });

    it('example 8: contributions to date far from the record are flagged, and the value stands', async () => {
      await k.approve('ops.one', runOf('example8').id);
      const row = (await k.open('ops.one', 'INV-0933', q3))!;
      expect(row.suggestedValue).toBe('20940000.00');
      expect(row.checks?.contributionsCheck).toEqual({
        statement: '30000000',
        record: '12400000',
        difference: '17600000',
        differencePct: '1.4193548387',
        differs: true,
        notChecked: null,
      });
      expect(row.flags.contributionsDiffer).toBe(true);
    });

    it('a statement read in thousands: the same value, a tolerance of its own unit', async () => {
      await k.approve('ops.one', runOf('thousands').id);
      const row = (await k.open('ops.one', 'INV-0011', q3))!;
      expect(row.suggestedValue).toBe('20940000.00');
      expect(row.checks).toMatchObject({ ties: true, tieToleranceUsd: '2500' });
      expect(row.flags.contributionsDiffer).toBe(true);
    });

    it('a whole vehicle with no share, a statement in euros and a fund-style statement give no value, with the reason', async () => {
      for (const key of ['noShare', 'euroStatement', 'fundStyle'])
        await k.approve('ops.one', runOf(key).id);
      for (const number of ['INV-0005', 'INV-0006', 'INV-0012']) {
        const row = (await k.open('ops.one', number, q3))!;
        expect(row, number).toMatchObject({
          basis: 'capital_account_balance',
          state: 'Open',
          suggestedValue: null,
          reasonCode: 'no_ending_balance',
          comparison: { change: null, changePct: null, variance: false, netOfFlows: null },
        });
        // Never 100% of a vehicle, nothing converted, and no number in the value's place.
        expect(row.workings.inputs, number).toEqual([]);
        expect(row.source.page, number).toBeNull();
      }
      // The fund-style statement still says its contributions are not the position's.
      expect((await k.open('ops.one', 'INV-0012', q3))!.flags.contributionsDiffer).toBe(true);
      // The run page is told a suggestion came of it; the row carries the reason.
      expect((await outcomeOf('ops.one', runOf('noShare').id))?.outcome).toBe('opened');
    });
  });

  describe('none when', () => {
    const noneFor = async (who: string, run: ExtractionRun, reason: string): Promise<void> => {
      const before = await k.count('select count(*)::int as n from mon.valuation_suggestion');
      await k.approve(who, run.id);
      expect(await k.count('select count(*)::int as n from mon.valuation_suggestion')).toBe(before);
      expect(await outcomeOf(who, run.id)).toEqual({
        outcome: 'none',
        reason,
        suggestionId: null,
      });
    };

    it('the statement is our account in a fund commitment', async () => {
      const fundLevel = [...seededStatements.values()].find((r) => r.investmentId === null)!;
      await noneFor('ops.one', fundLevel, 'fund_commitment');
    });

    it('the position is private credit', async () => {
      await noneFor('ops.one', runOf('credit'), 'private_credit');
    });

    it('the position is not held in US dollars', async () => {
      await noneFor('ops.one', runOf('euroPosition'), 'not_usd');
    });

    it('the position was not held at the period end', async () => {
      await noneFor('ops.one', runOf('notHeld'), 'not_held');
    });

    it('a mark for the quarter is Locked, a mark dated three days early included', async () => {
      // The position's marks are dated three days before each quarter end and count for it.
      await noneFor('ops.one', runOf('earlyMark'), 'mark_locked');
      expect(await storedCount('INV-0002', q2)).toBe(0);
    });

    it('a mark for a later quarter is Locked', async () => {
      // The position has no mark for the first quarter and a Locked one for the second.
      const run = [...(await k.extractQuarter('2025-03-31', CAS)).values()].find(
        (r) => r.investmentNumber === 'INV-0008',
      )!;
      await noneFor('ops.one', run, 'mark_locked');
    });

    it('sets the next quarter against the early mark, as the previous quarter', async () => {
      await k.approve('ops.one', runOf('afterEarlyMark').id);
      const row = (await k.open('ops.one', 'INV-0002', q3))!;
      expect(row.currentMark).toMatchObject({
        periodEnd: '2025-06-27',
        reportsFor: q2,
        previousQuarter: true,
        ageQuarters: 1,
      });
      expect(row.comparison.change).not.toBeNull();
    });
  });

  describe('behind the wall', () => {
    it('a walled statement and its suggestion are seen by the wall members only', async () => {
      const run = runOf('walled');
      await k.approve('deal.three', run.id);
      const inside = (await k.open('deal.three', WALLED, q3))!;
      expect(inside).toMatchObject({ investmentNumber: WALLED, suggestedValue: '20940000.00' });
      expect((await k.detail('head.one', inside.id)).id).toBe(inside.id);
      const insideCount = (await k.list('head.one')).openCount;
      for (const who of ['ops.one', 'deal.one', 'audit.one']) {
        await k.get(who, `${SUGGESTIONS}/${inside.id}`).expect(404);
        const page = await k.list(who, '&state=all');
        expect(page.items.map((s) => s.investmentNumber)).not.toContain(WALLED);
        expect(page.openCount).toBe(insideCount - 1);
        // Asking by the run, or by the position, tells an outsider nothing.
        expect(await outcomeOf(who, run.id)).toBeNull();
        expect((await k.list(who, `&investmentId=${k.investment(WALLED).id}`)).items).toEqual([]);
      }
    });
  });

  describe('closing and refreshing an Open suggestion', () => {
    it('closes the suggestion when a Draft made by hand is Locked for the quarter', async () => {
      await k.approve('ops.one', runOf('handDraft').id);
      const open = (await k.open('ops.one', 'INV-0014', q3))!;
      const draft = valuationRow.parse(
        (
          await k
            .post('ops.one', '/api/v1/valuations', {
              investmentId: k.investment('INV-0014').id,
              periodEnd: q3,
              method: 'valuation_method.market_multiple',
              fairValue: '23000000.00',
            })
            .expect(201)
        ).body,
      );
      // A Draft in progress is shown beside the suggestion, which stays Open.
      expect((await k.detail('ops.one', open.id)).inProgress).toMatchObject({
        valuationId: draft.id,
        state: 'Draft',
        periodEnd: q3,
        fairValue: '23000000.00',
      });
      await k.valuationCommand('ops.one', draft.id, { command: 'prepare' });
      await k.valuationCommand('deal.one', draft.id, { command: 'dealTeamApprove' });
      expect((await k.detail('ops.one', open.id)).inProgress?.state).toBe('DealTeamApproved');
      await k
        .post(
          'head.one',
          `/api/v1/valuations/${draft.id}/commands`,
          { command: 'lock' },
          'req-sug-lock',
        )
        .expect(200);
      const closed = await k.detail('ops.one', open.id);
      expect(closed).toMatchObject({
        state: 'Superseded',
        supersededReason: 'mark_locked',
        supersededById: null,
        valuationId: null,
        inProgress: null,
      });
      expect(await storedCount('INV-0014', q3)).toBe(1);
      const [event] = await k.rows<{ actor_id: string; details: Record<string, unknown> }>(
        "select actor_id, details from audit.event where request_id = 'req-sug-lock' and action = 'valuation_suggestion.supersede'",
      );
      // The approver's lock caused it; the system actor wrote it.
      expect(event).toMatchObject({
        actor_id: k.userId('head.one'),
        details: { mode: 'refresh', because: 'mark_locked', by: 'system' },
      });
      expect(await outcomeOf('ops.one', runOf('handDraft').id)).toEqual({
        outcome: 'opened',
        reason: null,
        suggestionId: open.id,
      });
    });
  });

  it('derives nothing while the switch is off, and reads still work', async () => {
    const setSwitch = (enabled: boolean) =>
      k.h
        .http()
        .patch('/api/v1/flags/valuation.suggestions')
        .set('authorization', k.h.as('platform_admin'))
        .send({ enabled, reason: 'set by the test' })
        .expect(200);
    await setSwitch(false);
    const run = runOf('switchedOff');
    const before = await k.count('select count(*)::int as n from mon.valuation_suggestion');
    await k.approve('ops.one', run.id);
    expect(await k.count('select count(*)::int as n from mon.valuation_suggestion')).toBe(before);
    expect(await k.open('ops.one', 'INV-0016', q3)).toBeUndefined();
    // No rule keeps a mark from being suggested here: none was, because nothing was derived.
    expect(await outcomeOf('ops.one', run.id)).toEqual({
      outcome: 'none',
      reason: null,
      suggestionId: null,
    });
    expect((await k.list('ops.one')).openCount).toBeGreaterThan(0);
    await setSwitch(true);
    // Switched on again, the next approval for the position derives it.
    const again = [...(await k.extract([fileOf('switchedOff')])).values()][0]!;
    await k.approve('ops.two', again.id);
    expect(await k.open('ops.one', 'INV-0016', q3)).toMatchObject({
      suggestedValue: '20940000.00',
      source: { extractionRunId: again.id },
    });
  });
});

describe('valuation suggestions: the other order, the report rules and the refresh (decision 0023)', () => {
  let k: SuggestionKit;
  let q2: string;
  let statementRun: ExtractionRun;
  let report: ExtractionRun;
  const STALE = 'INV-0007';
  const openOne = async (): Promise<ValuationSuggestionRow> =>
    (await k.open('ops.one', STALE, q2))!;
  const stored = (): Promise<
    { id: string; state: string; basis: string; superseded_reason: string | null }[]
  > =>
    k.rows(
      'select id, state::text as state, basis, superseded_reason from mon.valuation_suggestion where investment_id = $1 order by created_at, id',
      [k.investment(STALE).id],
    );

  beforeAll(async () => {
    k = await startSuggestionKit();
    q2 = k.quarterEnd;
    await k.index();
    const statementsOfQuarter = await k.extractQuarter(q2, CAS);
    statementRun = [...statementsOfQuarter.values()].find((r) => r.investmentNumber === STALE)!;
    report = [...(await k.extractQuarter(q2, QF)).values()].find(
      (r) => r.investmentNumber === STALE,
    )!;
  }, 120_000);
  afterAll(async () => {
    await k.close();
  });

  it('two approvals at once end with one Open suggestion, from the statement', async () => {
    await k.review('deal.one', report.id);
    await k.review('ops.one', statementRun.id);
    const approve = (who: string, id: string) =>
      k.post(who, `/api/v1/extraction/runs/${id}/commands`, { command: 'approve' });
    const answers = await Promise.all([
      approve('deal.one', report.id),
      approve('ops.one', statementRun.id),
    ]);
    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    const rows = await stored();
    expect(rows.filter((r) => r.state === 'Open')).toHaveLength(1);
    expect(rows.find((r) => r.state === 'Open')!.basis).toBe('capital_account_balance');
    const row = await openOne();
    expect(row.suggestedValue).toBe('38140000.00');
    expect(row.crossChecks.map((c) => c.basis)).toEqual(['sponsor_equity_value']);
  });
});

describe('valuation suggestions: the statement first, a second statement and a typed figure (decision 0023)', () => {
  let k: SuggestionKit;
  let q2: string;
  let q3: string;
  let runs: Map<string, ExtractionRun>;
  const STALE = 'INV-0007';
  const TWICE = 'INV-0016';
  const TYPED = 'INV-0015';
  const runOf = (key: string): ExtractionRun => runs.get(k.written.get(key)!.fileName)!;
  const outcomeOf = async (runId: string) =>
    (await k.list('ops.one', `&state=all&extractionRunId=${runId}`)).runOutcome;

  beforeAll(async () => {
    k = await startSuggestionKit({
      statements: ({ nextQuarter }) => ({
        first: { position: TWICE, periodEnd: nextQuarter, example: 'ties' },
        // A second statement for the same position and quarter, named by our reference alone.
        second: {
          position: TWICE,
          periodEnd: nextQuarter,
          shape: {
            fileCompany: null,
            lines: {
              ...STATEMENT_EXAMPLES.ties.lines,
              netGainLoss: '1.87',
              endingBalance: '21.94',
            },
          },
        },
        typed: { position: TYPED, periodEnd: nextQuarter, example: 'ties' },
      }),
    });
    q2 = k.quarterEnd;
    q3 = k.nextQuarter;
    await k.index();
    runs = new Map([
      ...(await k.extractQuarter(q3, CAS)),
      ...(await k.extractQuarter(q2, CAS)),
      ...(await k.extractQuarter(q2, QF)),
    ]);
  }, 120_000);
  afterAll(async () => {
    await k.close();
  });

  it('suggests the ending balance at once, with the quarter on record beside it', async () => {
    const statement = [...runs.values()].find(
      (r) =>
        r.investmentNumber === STALE && r.periodEnd === q2 && r.schemaId !== 'quarterly_financials',
    )!;
    await k.approve('ops.one', statement.id);
    const row = (await k.open('ops.one', STALE, q2))!;
    expect(row).toMatchObject({ basis: 'capital_account_balance', suggestedValue: '38140000.00' });
    // The quarter's approved figures are on record already: they give the indication beside it.
    expect(row.crossChecks.map((c) => [c.basis, c.reason])).toEqual([
      ['sponsor_equity_value', null],
    ]);
    expect(await outcomeOf(statement.id)).toEqual({
      outcome: 'opened',
      reason: null,
      suggestionId: row.id,
    });

    // The report approved afterwards changes the figure beside it and nothing else.
    const report = [...runs.values()].find(
      (r) =>
        r.investmentNumber === STALE && r.periodEnd === q2 && r.schemaId === 'quarterly_financials',
    )!;
    const before = await k.count('select count(*)::int as n from mon.valuation_suggestion');
    await k.approve('deal.one', report.id, 'req-sug-report-after');
    expect(await k.count('select count(*)::int as n from mon.valuation_suggestion')).toBe(before);
    const after = (await k.open('ops.one', STALE, q2))!;
    expect(after.id).toBe(row.id);
    expect(after.rowVersion).toBe(row.rowVersion);
    expect(after.sourceReviewerIds).toEqual([k.userId('ops.one')]);
    expect(after.crossChecks).toHaveLength(1);
    expect(after.crossChecks[0]!.value).not.toBeNull();
    expect(await outcomeOf(report.id)).toEqual({
      outcome: 'unchanged',
      reason: null,
      suggestionId: row.id,
    });
    expect(
      await k.count(
        "select count(*)::int as n from audit.event where request_id = 'req-sug-report-after' and action like 'valuation_suggestion.%'",
      ),
    ).toBe(0);
  });

  it('counts the later of two approved statements for a quarter', async () => {
    await k.approve('ops.one', runOf('first').id);
    const first = (await k.open('ops.one', TWICE, q3))!;
    expect(first.suggestedValue).toBe('20940000.00');
    await k.approve('ops.two', runOf('second').id);
    const second = (await k.open('ops.one', TWICE, q3))!;
    expect(second).toMatchObject({
      basis: 'capital_account_balance',
      suggestedValue: '21940000.00',
      sourceReviewerIds: [k.userId('ops.two')],
      source: { extractionRunId: runOf('second').id },
    });
    // The same source, other figures: replaced because the figures changed, not by a better source.
    expect(await k.detail('ops.one', first.id)).toMatchObject({
      state: 'Superseded',
      supersededReason: 'figures_changed',
      supersededById: second.id,
    });
    // The first statement's own checks stay with the suggestion it gave.
    expect((await k.detail('ops.one', first.id)).checks?.tieDifference).toBe('0');
    expect((await outcomeOf(runOf('first').id))?.outcome).toBe('opened');
    expect(await outcomeOf(runOf('second').id)).toEqual({
      outcome: 'replaced',
      reason: null,
      suggestionId: second.id,
    });
  });

  it('says a reviewer typed a figure, cites no page for it and names them as a source reviewer', async () => {
    const run = runOf('typed');
    await k.review('ops.two', run.id);
    await k
      .post('ops.two', `/api/v1/extraction/runs/${run.id}/commands`, {
        command: 'edit',
        field: 'ending_capital_balance',
        value: '21.00',
        unit: 'USD_M',
        reason: 'The balance on the signed copy',
      })
      .expect(200);
    await k
      .post('ops.one', `/api/v1/extraction/runs/${run.id}/commands`, { command: 'approve' })
      .expect(200);
    const row = (await k.open('ops.one', TYPED, q3))!;
    expect(row.suggestedValue).toBe('21000000.00');
    expect(row.workings.inputs).toEqual([
      {
        key: 'ending_capital_balance',
        value: '21000000',
        periodEnd: q3,
        source: { kind: 'reviewer', id: k.userId('ops.two'), page: null, fileName: null },
        edited: true,
      },
    ]);
    expect(row.flags.editedByReviewer).toBe(true);
    expect(row.source).toMatchObject({ documentId: run.documentId, page: null, locator: null });
    // The approver of the run and whoever typed the figure both stand behind it.
    expect([...row.sourceReviewerIds].sort()).toEqual(
      [k.userId('ops.one'), k.userId('ops.two')].sort(),
    );
    // The typed balance no longer adds up with the lines as read.
    expect(row.checks).toMatchObject({ ties: false, tieDifference: '60000' });
  });

  it('suggests nothing from a line nobody accepted', async () => {
    // A statement approved with only its period end decided stands behind no balance.
    const again = await k.extract([k.written.get('typed')!.fileName]);
    const run = [...again.values()][0]!;
    await k
      .post('ops.one', `/api/v1/extraction/runs/${run.id}/commands`, {
        command: 'accept',
        field: 'period_end',
      })
      .expect(200);
    await k
      .post('ops.one', `/api/v1/extraction/runs/${run.id}/commands`, { command: 'approve' })
      .expect(200);
    const row = (await k.open('ops.one', TYPED, q3))!;
    expect(row).toMatchObject({
      suggestedValue: null,
      reasonCode: 'no_ending_balance',
      source: { extractionRunId: run.id },
    });
    expect(row.workings.inputs).toEqual([]);
  });
});

describe('valuation suggestions: statement first, the multiple held and the refresh (decision 0023)', () => {
  let k: SuggestionKit;
  let q2: string;
  let statementRun: ExtractionRun;
  let report: ExtractionRun;
  const STALE = 'INV-0007';
  const Q1 = '2025-03-31';
  const openOne = async (): Promise<ValuationSuggestionRow | undefined> =>
    k.open('ops.one', STALE, q2);
  const quarter = async (periodEnd: string) =>
    (
      await k.rows<{ ev: string | null; net_debt: string | null; ebitda_ltm: string | null }>(
        'select ev::text as ev, net_debt::text as net_debt, ebitda_ltm::text as ebitda_ltm from mon.quarterly_performance where investment_id = $1 and period_end = $2 and not is_entry_snapshot',
        [k.investment(STALE).id, periodEnd],
      )
    )[0]!;

  beforeAll(async () => {
    k = await startSuggestionKit();
    q2 = k.quarterEnd;
    await k.index();
    statementRun = [...(await k.extractQuarter(q2, CAS)).values()].find(
      (r) => r.investmentNumber === STALE,
    )!;
    report = [...(await k.extractQuarter(q2, QF)).values()].find(
      (r) => r.investmentNumber === STALE,
    )!;
  }, 120_000);
  afterAll(async () => {
    await k.close();
  });

  it('holds the earlier multiple when the report states no enterprise value', async () => {
    // The quarter on record has no enterprise value and the reviewer rejects the report's.
    await k.rows(
      'update mon.quarterly_performance set ev = null where investment_id = $1 and period_end = $2',
      [k.investment(STALE).id, q2],
    );
    await k.review('deal.two', report.id);
    await k
      .post('deal.two', `/api/v1/extraction/runs/${report.id}/commands`, {
        command: 'reject',
        field: 'enterprise_value',
        reason: 'The report states no enterprise value this quarter',
      })
      .expect(200);
    await k
      .post('deal.two', `/api/v1/extraction/runs/${report.id}/commands`, { command: 'approve' })
      .expect(200);
    const row = (await openOne())!;
    const earlier = await quarter(Q1);
    const current = await quarter(q2);
    expect(current.ev).toBeNull();
    const expected = heldMultipleMark({
      referenceMark: '46078308.34',
      flowsSinceReferenceMark: false,
      reference: { ev: earlier.ev, netDebt: earlier.net_debt, ebitda: earlier.ebitda_ltm },
      current: { ebitda: current.ebitda_ltm, netDebt: current.net_debt },
    });
    expect(expected.value).not.toBeNull();
    expect(row).toMatchObject({
      basis: 'held_multiple',
      method: REPORT_INDICATION,
      reasonCode: null,
      sourceReviewerIds: [k.userId('deal.two')],
    });
    expect(D(row.suggestedValue!).eq(D(expected.value!))).toBe(true);
    expect(row.workings.inputs.map((i) => [i.key, i.source.kind])).toEqual([
      ['reference_mark', 'valuation'],
      ['reference_enterprise_value', 'record'],
      ['reference_net_debt', 'record'],
      ['reference_ebitda_ltm', 'record'],
      ['ebitda_ltm', 'document'],
      ['net_debt', 'document'],
    ]);
  });

  it('derives the Open suggestion again when an accounting import restates the earlier quarter, whoever approves it', async () => {
    const before = (await openOne())!;
    const earlier = await quarter(Q1);
    const restated = D(earlier.net_debt!).minus(5000000).toFixed(2);
    const header =
      'InvestmentNumber,CompanyName,PeriodEnd,RevenueLTM,EBITDALTM,EnterpriseValue,NetDebt,FairValue';
    const company = k.h.dataset.portfolioCompanies.find(
      (c) =>
        c.id ===
        k.h.dataset.investments.find((i) => i.investmentNumber === STALE)!.portfolioCompanyId,
    )!.name;
    const seeded = k.h.dataset.quarterlyPerformance.find(
      (q) => q.investmentId === k.investment(STALE).id && q.periodEnd === Q1,
    )!;
    const csv = `${header}\n${[STALE, company, Q1, seeded.revenueLtm, seeded.ebitdaLtm, seeded.ev, restated, '46078308.34'].join(',')}\n`;
    const staged = intakeImportResult.parse(
      (
        await k
          .post('ops.one', '/api/v1/intake/accounting', { fileName: 'restated-q1.csv', csv })
          .expect(201)
      ).body,
    );
    // A deal team reviewer approves the import: they may write no suggestion themselves.
    await k
      .post(
        'deal.one',
        `/api/v1/intake/files/${staged.id}/commands`,
        { command: 'approve' },
        'req-sug-import',
      )
      .expect(200);
    expect((await quarter(Q1)).net_debt).toBe(restated);
    const after = (await openOne())!;
    expect(after.id).not.toBe(before.id);
    expect(after.basis).toBe('held_multiple');
    expect(D(after.suggestedValue!).lt(D(before.suggestedValue!))).toBe(true);
    // No run was approved: the new suggestion keeps the run behind the one it replaces.
    expect(after.source.extractionRunId).toBe(report.id);
    expect(after.sourceReviewerIds).toEqual([k.userId('deal.two')]);
    expect(await k.detail('ops.one', before.id)).toMatchObject({
      state: 'Superseded',
      supersededReason: 'figures_changed',
      supersededById: after.id,
    });
    const events = await k.rows<{
      action: string;
      actor_id: string;
      details: Record<string, unknown>;
    }>(
      "select action, actor_id, details from audit.event where request_id = 'req-sug-import' and action like 'valuation_suggestion.%' order by id",
    );
    expect(events.map((e) => [e.action, e.actor_id, e.details.mode])).toEqual([
      ['valuation_suggestion.supersede', k.userId('deal.one'), 'refresh'],
      ['valuation_suggestion.open', k.userId('deal.one'), 'refresh'],
    ]);
  });

  it('derives it again when the earlier mark is reopened, and again when it is locked', async () => {
    const before = (await openOne())!;
    const [mark] = await k.rows<{ id: string }>(
      "select id from mon.valuation where investment_id = $1 and period_end = $2 and state = 'Locked'",
      [k.investment(STALE).id, Q1],
    );
    // Reopened: the last Locked mark is now the quarter before, which has no approved figures.
    const draft = await k.valuationCommand('head.one', mark!.id, {
      command: 'reopen',
      reason: 'The sponsor restated its first quarter mark',
    });
    const reopened = (await openOne())!;
    expect(reopened.id).not.toBe(before.id);
    expect(reopened).toMatchObject({
      basis: 'held_multiple',
      suggestedValue: null,
      reasonCode: 'no_reference_figures',
      currentMark: { periodEnd: '2024-12-31', previousQuarter: false, ageQuarters: 2 },
      flags: { variance: false },
    });
    expect((await k.detail('ops.one', before.id)).supersededReason).toBe('figures_changed');

    // The corrected first quarter mark is locked: the suggestion is worked out from it.
    await k.h
      .http()
      .patch(`/api/v1/valuations/${draft.id}`)
      .set('authorization', k.h.as('ops.one'))
      .send({ fairValue: '45000000.00' })
      .expect(200);
    await k.valuationCommand('ops.one', draft.id, { command: 'prepare' });
    await k.valuationCommand('deal.one', draft.id, { command: 'dealTeamApprove' });
    await k.valuationCommand('head.one', draft.id, { command: 'lock' });
    const relocked = (await openOne())!;
    expect(relocked.id).not.toBe(reopened.id);
    expect(relocked.reasonCode).toBeNull();
    expect(relocked.currentMark).toMatchObject({
      value: '45000000.00',
      periodEnd: Q1,
      previousQuarter: true,
    });
    expect(D(relocked.suggestedValue!).lt(D(before.suggestedValue!))).toBe(true);
  });

  it('gives no report-based value once cash has moved since the last Locked mark', async () => {
    const before = (await openOne())!;
    await k.rows(
      "insert into mon.cash_flow (investment_id, flow_date, flow_type, amount, status) values ($1, '2025-05-20', 'flow_type.contribution', -1500000, 'record_status.approved')",
      [k.investment(STALE).id],
    );
    // Nothing derives on a cash flow by itself: the next approval for the position does.
    expect((await openOne())!.id).toBe(before.id);
    await k.approve('ops.two', statementRun.id);
    const row = (await openOne())!;
    // The statement is the first source and has a value; the report beside it has none, and says why.
    expect(row).toMatchObject({
      basis: 'capital_account_balance',
      suggestedValue: '38140000.00',
      sourceReviewerIds: [k.userId('ops.two')],
    });
    expect(row.crossChecks).toEqual([
      {
        basis: 'held_multiple',
        value: null,
        reason: 'flows_since_reference_mark',
        difference: null,
        differencePct: null,
        differs: false,
      },
    ]);
    expect((await k.detail('ops.one', before.id)).supersededReason).toBe('better_source');
    // The statement's contributions to date no longer agree with the record.
    expect(row.checks?.contributionsCheck.record).toBe('39360237.78');
  });
});
