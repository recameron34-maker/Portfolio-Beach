import { addDays, latestQuarterEndOnOrBefore } from '@pb/calc';
import {
  documentPage,
  extractionBatch,
  extractionRunDetail,
  extractionRunPage,
  valuationRow,
  valuationSuggestionPage,
  valuationSuggestionRow,
} from '@pb/contracts';
import type {
  DocumentSummary,
  ExtractionRun,
  ExtractionRunDetail,
  ValuationRow,
  ValuationSuggestionPage,
  ValuationSuggestionRow,
} from '@pb/contracts';
import type { SyntheticDataset } from '@pb/db';
import { STATEMENT_EXAMPLES, positionStatementDocument } from '@pb/synthetic';
import type { PositionStatementInput, StatementExample, SyntheticDocument } from '@pb/synthetic';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

/*
 * What the valuation suggestion tests share (decision 0023): a harness with the extraction
 * engine switched on and statements written beside the synthetic set, and the steps a person
 * takes to get from a document in the inbox to an approved run, each through the API. Positions
 * a test needs that the synthetic book does not hold (one whose mark and contributions are the
 * figures of docs/08 section 12) are written to the record before the documents are indexed.
 */

export const QF = 'doc_type.quarterly_financials';
export const CAS = 'doc_type.capital_account_statement';
export const SUGGESTIONS = '/api/v1/valuation-suggestions';
export const PROBLEM = 'https://portfolio-beach.example/problems/';

/** The calendar quarter end after a calendar quarter end. */
export const nextQuarterEnd = (quarterEnd: string): string =>
  latestQuarterEndOnOrBefore(addDays(quarterEnd, 93));

/** A position written for a test: a company of its own, one approved contribution and one Locked mark. */
export interface CraftedPosition {
  id: string;
  companyId: string;
  investmentNumber: string;
  companyName: string;
  /** The position it borrows its vehicle, fund and sponsor from. */
  like: string;
  dealType?: string;
  currency?: string;
  entryDate: string;
  /** Approved contributions, as positive dollars, by date. */
  contributions: readonly { date: string; amount: string }[];
  /** Locked marks by period end. */
  marks: readonly { periodEnd: string; fairValue: string }[];
}

/** What a statement written for a test names; its lines come from an example of docs/08 section 12 or are given. */
export interface StatementSpec {
  /** The investment number of a seeded position, or of a crafted one. */
  position: string;
  periodEnd: string;
  example?: StatementExample;
  shape?: Partial<
    Pick<
      PositionStatementInput,
      'lines' | 'commitment' | 'denomination' | 'wholeVehicle' | 'fileCompany'
    >
  >;
}

export interface SuggestionKit {
  h: Harness;
  /** The latest quarter end on or before the as-of date, and the one after it. */
  quarterEnd: string;
  nextQuarter: string;
  /** The statements written beside the set, by the key the test gave each. */
  written: ReadonlyMap<string, SyntheticDocument>;
  investment: (number: string) => { id: string; investmentNumber: string };
  userId: (externalId: string) => string;
  get: (
    who: string,
    path: string,
    requestId?: string,
  ) => ReturnType<ReturnType<Harness['http']>['get']>;
  post: (
    who: string,
    path: string,
    body: object,
    requestId?: string,
  ) => ReturnType<ReturnType<Harness['http']>['post']>;
  /** Indexes the inbox, as operations. */
  index: () => Promise<void>;
  /** Every document a wall member of the deal team can see. */
  documents: () => Promise<DocumentSummary[]>;
  /** Queues and runs the extraction of the documents named, as operations; answers the runs by file name. */
  extract: (fileNames: readonly string[]) => Promise<Map<string, ExtractionRun>>;
  /** Queues and runs every classified document of a type and quarter; answers the runs by file name. */
  extractQuarter: (periodEnd: string, docType: string) => Promise<Map<string, ExtractionRun>>;
  /** Decides every value of a run (clean and flagged accepted, the rest rejected) and approves it. */
  approve: (who: string, runId: string, requestId?: string) => Promise<ExtractionRunDetail>;
  /** Decides the values of a run without approving it. */
  review: (who: string, runId: string) => Promise<void>;
  list: (who: string, query?: string) => Promise<ValuationSuggestionPage>;
  detail: (who: string, id: string) => Promise<ValuationSuggestionRow>;
  /** The Open suggestion of a position and quarter as the caller reads it; undefined when there is none. */
  open: (
    who: string,
    number: string,
    periodEnd: string,
  ) => Promise<ValuationSuggestionRow | undefined>;
  /** A valuation command through the API; answers the row. */
  valuationCommand: (who: string, id: string, body: object) => Promise<ValuationRow>;
  rows: <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  count: (sql: string, params?: unknown[]) => Promise<number>;
  close: () => Promise<void>;
}

/** The statement a spec names, written with the generator's own builder. */
function statementOf(
  dataset: SyntheticDataset,
  crafted: readonly CraftedPosition[],
  spec: StatementSpec,
): SyntheticDocument {
  const made = crafted.find((p) => p.investmentNumber === spec.position);
  const seeded = dataset.investments.find(
    (i) => i.investmentNumber === (made?.like ?? spec.position),
  );
  if (seeded === undefined) throw new Error(`no position ${spec.position}`);
  const fund = dataset.sponsorFunds.find((f) => f.id === seeded.sponsorFundId);
  const vehicle = dataset.vehicles.find((v) => v.id === seeded.vehicleId);
  const company = dataset.portfolioCompanies.find((c) => c.id === seeded.portfolioCompanyId);
  if (fund === undefined || vehicle === undefined || company === undefined)
    throw new Error(`position ${spec.position} has no fund, vehicle or company`);
  return positionStatementDocument({
    periodEnd: spec.periodEnd,
    fund,
    vehicleName: vehicle.name,
    investment:
      made === undefined
        ? { id: seeded.id, investmentNumber: seeded.investmentNumber, companyName: company.name }
        : { id: made.id, investmentNumber: made.investmentNumber, companyName: made.companyName },
    ...STATEMENT_EXAMPLES[spec.example ?? 'ties'],
    ...spec.shape,
  });
}

/** Writes a crafted position to the record, as the owner connection: the company, the position, its flows and its marks. */
async function writeCrafted(h: Harness, position: CraftedPosition): Promise<void> {
  const like = h.dataset.investments.find((i) => i.investmentNumber === position.like);
  if (like === undefined) throw new Error(`no position ${position.like}`);
  const user = (externalId: string): string => {
    const found = h.dataset.users.find((u) => u.externalId === externalId);
    if (found === undefined) throw new Error(`no user ${externalId}`);
    return found.id;
  };
  await h.runtime.db.query(
    'insert into core.portfolio_company (id, name, canonical_name) values ($1, $2, $3)',
    [position.companyId, position.companyName, position.companyName.toLowerCase()],
  );
  await h.runtime.db.query(
    `insert into core.investment (id, investment_number, vehicle_id, portfolio_company_id, sponsor_fund_id, sponsor_id, deal_type, entry_date, currency)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      position.id,
      position.investmentNumber,
      like.vehicleId,
      position.companyId,
      like.sponsorFundId,
      like.sponsorId,
      position.dealType ?? like.dealType,
      position.entryDate,
      position.currency ?? 'USD',
    ],
  );
  for (const flow of position.contributions)
    await h.runtime.db.query(
      `insert into mon.cash_flow (investment_id, flow_date, flow_type, amount, status)
       values ($1, $2, 'flow_type.contribution', $3, 'record_status.approved')`,
      [position.id, flow.date, `-${flow.amount}`],
    );
  for (const mark of position.marks)
    await h.runtime.db.query(
      `insert into mon.valuation (investment_id, period_end, version, method, fair_value, state, lock_hash, prepared_by, deal_team_approved_by, approved_by, approved_at)
       values ($1, $2, 1, 'valuation_method.sponsor_mark', $3, 'Locked', 'crafted-for-a-test', $4, $5, $6, now())`,
      [
        position.id,
        mark.periodEnd,
        mark.fairValue,
        user('ops.two'),
        user('deal.two'),
        user('head.one'),
      ],
    );
}

/**
 * A harness with extraction on, the statements the test names written beside the synthetic set
 * and the crafted positions on record. Nothing is indexed yet.
 */
export async function startSuggestionKit(
  options: {
    statements?: (ctx: {
      quarterEnd: string;
      nextQuarter: string;
    }) => Record<string, StatementSpec>;
    crafted?: readonly CraftedPosition[];
  } = {},
): Promise<SuggestionKit> {
  const crafted = options.crafted ?? [];
  const specsOf = (dataset: SyntheticDataset): Record<string, StatementSpec> => {
    const quarterEnd = latestQuarterEndOnOrBefore(dataset.asOf);
    return options.statements?.({ quarterEnd, nextQuarter: nextQuarterEnd(quarterEnd) }) ?? {};
  };
  const build = (dataset: SyntheticDataset): Map<string, SyntheticDocument> =>
    new Map(
      Object.entries(specsOf(dataset)).map(([key, spec]) => [
        key,
        statementOf(dataset, crafted, spec),
      ]),
    );
  const h = await startHarness({
    enableFlags: ['ai.extraction'],
    extraDocuments: (dataset) => [...build(dataset).values()],
  });
  for (const position of crafted) await writeCrafted(h, position);
  const written = build(h.dataset);
  const quarterEnd = latestQuarterEndOnOrBefore(h.dataset.asOf);

  const get: SuggestionKit['get'] = (who, path, requestId = 'req-sug-get') =>
    h.http().get(path).set('authorization', h.as(who)).set('x-request-id', requestId);
  const post: SuggestionKit['post'] = (who, path, body, requestId = 'req-sug-post') =>
    h.http().post(path).set('authorization', h.as(who)).set('x-request-id', requestId).send(body);
  const rows: SuggestionKit['rows'] = (sql, params = []) => h.runtime.db.query(sql, params);
  const documents = async (): Promise<DocumentSummary[]> =>
    documentPage.parse((await get('deal.three', '/api/v1/documents?limit=200').expect(200)).body)
      .items;
  const runsOfBatch = async (body: object): Promise<Map<string, ExtractionRun>> => {
    const batch = extractionBatch.parse(
      (await post('operations', '/api/v1/extraction/batches', body).expect(201)).body,
    );
    const runs = extractionRunPage.parse(
      (await get('deal.three', `/api/v1/extraction/runs?limit=200&batchId=${batch.id}`).expect(200))
        .body,
    ).items;
    return new Map(runs.map((run) => [run.fileName, run]));
  };
  const runCommand = (who: string, id: string, body: object, requestId?: string) =>
    post(who, `/api/v1/extraction/runs/${id}/commands`, body, requestId);
  const review = async (who: string, runId: string): Promise<void> => {
    const before = extractionRunDetail.parse(
      (await get(who, `/api/v1/extraction/runs/${runId}`).expect(200)).body,
    );
    for (const value of before.values) {
      if (value.decision !== null || value.validationState === 'clean') continue;
      await runCommand(
        who,
        runId,
        value.validationState === 'flagged'
          ? { command: 'accept', field: value.field }
          : { command: 'reject', field: value.field, reason: 'not read in this test' },
      ).expect(200);
    }
    await runCommand(who, runId, { command: 'acceptClean' }).expect(200);
  };
  const list: SuggestionKit['list'] = async (who, query = '') =>
    valuationSuggestionPage.parse(
      (await get(who, `${SUGGESTIONS}?limit=200${query}`).expect(200)).body,
    );
  const investment = (number: string): { id: string; investmentNumber: string } => {
    const found =
      crafted.find((p) => p.investmentNumber === number) ??
      h.dataset.investments.find((i) => i.investmentNumber === number);
    if (found === undefined) throw new Error(`no position ${number}`);
    return { id: found.id, investmentNumber: found.investmentNumber };
  };

  return {
    h,
    quarterEnd,
    nextQuarter: nextQuarterEnd(quarterEnd),
    written,
    investment,
    userId: (externalId) => {
      const found = h.dataset.users.find((u) => u.externalId === externalId);
      if (found === undefined) throw new Error(`no user ${externalId}`);
      return found.id;
    },
    get,
    post,
    index: async () => {
      await post('operations', '/api/v1/documents/index', {}).expect(200);
    },
    documents,
    extract: async (fileNames) => {
      const all = await documents();
      const ids = fileNames.map((fileName) => {
        const found = all.find((d) => d.fileName === fileName);
        if (found === undefined) throw new Error(`no document ${fileName}`);
        return found.id;
      });
      return runsOfBatch({ documentIds: ids });
    },
    extractQuarter: (periodEnd, docType) => runsOfBatch({ periodEnd, docType }),
    review,
    approve: async (who, runId, requestId) => {
      await review(who, runId);
      return extractionRunDetail.parse(
        (await runCommand(who, runId, { command: 'approve' }, requestId).expect(200)).body,
      );
    },
    list,
    detail: async (who, id) =>
      valuationSuggestionRow.parse((await get(who, `${SUGGESTIONS}/${id}`).expect(200)).body),
    open: async (who, number, periodEnd) =>
      (await list(who, `&investmentId=${investment(number).id}&periodEnd=${periodEnd}`)).items[0],
    valuationCommand: async (who, id, body) =>
      valuationRow.parse(
        (await post(who, `/api/v1/valuations/${id}/commands`, body).expect(200)).body,
      ),
    rows,
    count: async (sql, params = []) => {
      const [row] = await h.runtime.db.query<{ n: number }>(sql, params);
      return row?.n ?? 0;
    },
    close: () => h.close(),
  };
}
