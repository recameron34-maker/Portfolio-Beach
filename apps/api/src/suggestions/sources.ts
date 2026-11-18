import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { ExtractionSchema, TargetColumn } from '@pb/ai';
import { alignedQuarterEnd, summarizeFlows } from '@pb/calc';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import {
  PERIOD_END_KEY,
  STATEMENT_LINE_KEYS,
  STATEMENT_SHARE_KEY,
  figureReviewersOf,
  finalValuesOf,
  recordFigureOf,
  referenceOnHand,
  statementOnHandOf,
} from '@pb/workflows';
import type {
  FinalValue,
  MarkOnRecord,
  QuarterOnRecord,
  RecordFigureColumn,
  ReportOnHand,
  RunBehind,
  SourcedFigure,
  StagedFigure,
  StatementOnHand,
  SuggestionPosition,
  SuggestionSettings,
  SuggestionSources,
} from '@pb/workflows';
import { APPROVED } from '../intake/promote.js';
import { kindOf } from '../portfolio/metrics.js';
import { fieldKeyOf } from './settings.js';
import type { SuggestionSchemas } from './settings.js';

export type { RunBehind } from '@pb/workflows';

/*
 * The sources on hand for one position and quarter (docs/08 section 12, docs/18 section 14,
 * decision 0023), read under whatever identity the transaction holds: the system actor for a
 * derivation, the caller for a read (every table here follows the position's wall, so a reader
 * who can see the suggestion can see what it was worked out from, and nobody else can).
 *
 * - The position, its valuation versions, its approved cash flows and its approved quarters
 *   (never an entry snapshot).
 * - The statement on hand: the latest approved run of a capital account statement of the
 *   position whose own period end is the quarter, with the lines a person accepted or typed. A
 *   line nobody decided is not on hand: nothing is suggested from a value no person stood behind.
 * - The report on hand: the approved quarter on record. A figure is the record's; where the run
 *   the record names as its source read that same figure, the figure is cited to the page of
 *   that document, or to the reviewer who typed it, otherwise to the record (an accounting import
 *   restated it, or nothing was extracted).
 * - Who stands behind each input: the approver of the run it came from and whoever typed it,
 *   for the figures of the earlier quarter too.
 *
 * What a run's approval stands behind, how a statement's lines are read and when a figure of the
 * record is cited to a run are rules of @pb/workflows (controls-suggestion.ts), which the static
 * preview reads its own session through; only the queries are here.
 */

const run = schema.extractionRun;
const value = schema.extractedValue;
const quarter = schema.quarterlyPerformance;
const valuation = schema.valuation;

/** A valuation version of the position, as the rules and the commands read it. */
export interface PositionVersion extends MarkOnRecord {
  version: number;
  method: string;
  rowVersion: number;
}

/** The position with the names a row carries. */
export interface GatheredPosition extends SuggestionPosition {
  id: string;
  investmentNumber: string;
  companyName: string;
  vehicleName: string;
}

export interface Gathered {
  /** Null when the position does not exist or the transaction's identity cannot see it. */
  position: GatheredPosition | null;
  /** Every version of the position, highest version first within a period end. */
  versions: PositionVersion[];
  sources: SuggestionSources;
  /** The run the statement on hand was read by; null without a statement. */
  statementRun: RunBehind | null;
  /** The approved run the quarter on record names as its source; null when it names none. */
  reportRun: RunBehind | null;
  /** By input key: the approver of the run the figure came from, and whoever typed it. */
  reviewersByKey: ReadonlyMap<string, readonly string[]>;
}

export interface GatherRequest {
  investmentId: string;
  /** A calendar quarter end. */
  periodEnd: string;
  /**
   * The statement run to read the lines from: the run of a stored statement-based suggestion,
   * so its checks are those of the statement it came from. Without it, the latest approved
   * statement run of the quarter.
   */
  statementRunId?: string;
}

/** The staged values of a run as the rules read them (stg.extracted_value). */
function stagedFigures(tx: Tx, runId: string): Promise<StagedFigure[]> {
  return tx
    .select({
      field: value.field,
      value: value.value,
      unit: value.unit,
      page: value.page,
      decision: value.decision,
      editedValue: value.editedValue,
      editedUnit: value.editedUnit,
      reviewerId: value.reviewerId,
    })
    .from(value)
    .where(eq(value.runId, runId));
}

/** The accepted and edited values of a run, by field: what its approval stands behind. */
async function finalValues(tx: Tx, runId: string): Promise<Map<string, FinalValue>> {
  return finalValuesOf(await stagedFigures(tx, runId));
}

/** An approved run by id, with what a suggestion records of it; null when it is not approved or not visible. */
async function approvedRun(
  tx: Tx,
  id: string,
): Promise<(RunBehind & { schemaId: string; periodEnd: string | null }) | null> {
  const [row] = await tx
    .select({
      id: run.id,
      documentId: run.documentId,
      approvedBy: run.approvedBy,
      promptVersion: run.promptVersion,
      modelId: run.modelId,
      schemaId: run.schemaId,
      periodEnd: run.periodEnd,
    })
    .from(run)
    .where(eq(run.id, id));
  if (row === undefined || row.approvedBy === null) return null;
  return { ...row, approvedBy: row.approvedBy };
}

/** An approved quarter of the record with the lineage it names. */
interface LoadedQuarter extends QuarterOnRecord {
  extractionRunId: string | null;
}

/** The record's figure for a target column of the report schema. */
const RECORD_COLUMN: Readonly<Partial<Record<TargetColumn, RecordFigureColumn>>> = {
  ev: 'ev',
  net_debt: 'netDebt',
  ebitda_ltm: 'ebitdaLtm',
};

/** The run behind a quarter on record, with its final values and its schema. */
interface LineageRun {
  behind: RunBehind;
  schema: ExtractionSchema;
  finals: ReadonlyMap<string, FinalValue>;
}

/** A figure of an approved quarter with where it came from (recordFigureOf), for a column of the report schema. */
function recordFigure(
  on: LoadedQuarter,
  target: TargetColumn,
  lineage: LineageRun | null,
): { figure: SourcedFigure | null; reviewers: string[] } {
  const column = RECORD_COLUMN[target];
  if (column === undefined) return { figure: null, reviewers: [] };
  const key = lineage === null ? null : fieldKeyOf(lineage.schema, target);
  return recordFigureOf(
    on,
    column,
    lineage === null || key === null
      ? null
      : { behind: lineage.behind, final: lineage.finals.get(key) },
  );
}

/**
 * Everything the rules read for a position and a quarter, as the record stands in this
 * transaction. The position is null (and nothing else is read) when it is not visible.
 */
export async function gatherSources(
  tx: Tx,
  request: GatherRequest,
  settings: SuggestionSettings,
  schemas: SuggestionSchemas,
): Promise<Gathered> {
  const { investmentId, periodEnd } = request;
  const tolerance = settings.periodEndToleranceDays;
  const empty: SuggestionSources = {
    periodEnd,
    statement: null,
    report: null,
    reference: { mark: null, flowsSince: false, quarter: null },
    recordContributions: '0',
  };
  const [found] = await tx
    .select({
      id: schema.investment.id,
      investmentNumber: schema.investment.investmentNumber,
      companyName: schema.portfolioCompany.name,
      vehicleName: schema.vehicle.name,
      dealType: schema.investment.dealType,
      currency: schema.investment.currency,
      isActive: schema.investment.isActive,
      entryDate: schema.investment.entryDate,
      exitDate: schema.investment.exitDate,
    })
    .from(schema.investment)
    .innerJoin(
      schema.portfolioCompany,
      eq(schema.portfolioCompany.id, schema.investment.portfolioCompanyId),
    )
    .innerJoin(schema.vehicle, eq(schema.vehicle.id, schema.investment.vehicleId))
    .where(eq(schema.investment.id, investmentId));
  if (found === undefined)
    return {
      position: null,
      versions: [],
      sources: empty,
      statementRun: null,
      reportRun: null,
      reviewersByKey: new Map(),
    };

  const versions: PositionVersion[] = await tx
    .select({
      id: valuation.id,
      periodEnd: valuation.periodEnd,
      version: valuation.version,
      state: valuation.state,
      fairValue: valuation.fairValue,
      method: valuation.method,
      rowVersion: valuation.rowVersion,
    })
    .from(valuation)
    .where(eq(valuation.investmentId, investmentId))
    .orderBy(asc(valuation.periodEnd), desc(valuation.version));

  const flows = await tx
    .select({
      date: schema.cashFlow.flowDate,
      flowType: schema.cashFlow.flowType,
      amount: schema.cashFlow.amount,
    })
    .from(schema.cashFlow)
    .where(
      and(eq(schema.cashFlow.investmentId, investmentId), eq(schema.cashFlow.status, APPROVED)),
    );

  const quarters: LoadedQuarter[] = await tx
    .select({
      id: quarter.id,
      periodEnd: quarter.periodEnd,
      ev: quarter.ev,
      netDebt: quarter.netDebt,
      ebitdaLtm: quarter.ebitdaLtm,
      extractionRunId: quarter.extractionRunId,
    })
    .from(quarter)
    .where(
      and(
        eq(quarter.investmentId, investmentId),
        eq(quarter.status, APPROVED),
        eq(quarter.isEntrySnapshot, false),
      ),
    )
    .orderBy(asc(quarter.periodEnd));

  // The run a quarter names as its source, read once per run: approved, and of a report schema.
  const lineageCache = new Map<string, LineageRun | null>();
  const lineageOf = async (on: LoadedQuarter): Promise<LineageRun | null> => {
    if (on.extractionRunId === null) return null;
    const cached = lineageCache.get(on.extractionRunId);
    if (cached !== undefined) return cached;
    const behind = await approvedRun(tx, on.extractionRunId);
    const reportSchema = behind === null ? undefined : schemas.reports.get(behind.schemaId);
    const lineage =
      behind === null || reportSchema === undefined
        ? null
        : { behind, schema: reportSchema, finals: await finalValues(tx, behind.id) };
    lineageCache.set(on.extractionRunId, lineage);
    return lineage;
  };

  const reviewersByKey = new Map<string, readonly string[]>();

  // The statement on hand.
  let statement: StatementOnHand | null = null;
  let statementRun: RunBehind | null = null;
  if (request.statementRunId !== undefined) {
    const behind = await approvedRun(tx, request.statementRunId);
    if (behind !== null && schemas.statements.has(behind.schemaId)) statementRun = behind;
  } else if (schemas.statements.size > 0) {
    const candidates = await tx
      .select({ id: run.id, periodEnd: run.periodEnd })
      .from(run)
      .where(
        and(
          eq(run.investmentId, investmentId),
          inArray(run.schemaId, [...schemas.statements.keys()]),
          isNotNull(run.approvedBy),
        ),
      )
      // The later approval counts. An approved run is never written again, so its last write is
      // its approval: that orders two approvals the clock stamped alike.
      .orderBy(desc(run.approvedAt), desc(run.updatedAt), desc(run.id));
    for (const candidate of candidates) {
      // The quarter is the statement's own period end and no other: the one its approval
      // accepted, which is the run's when the document carries one.
      const own =
        candidate.periodEnd ??
        (await finalValues(tx, candidate.id)).get(PERIOD_END_KEY)?.value ??
        null;
      if (own !== periodEnd) continue;
      statementRun = await approvedRun(tx, candidate.id);
      break;
    }
  }
  if (statementRun !== null) {
    const staged = await stagedFigures(tx, statementRun.id);
    const finals = finalValuesOf(staged);
    statement = statementOnHandOf(staged, statementRun);
    for (const key of [STATEMENT_LINE_KEYS.endingBalance, STATEMENT_SHARE_KEY]) {
      const final = finals.get(key);
      if (final !== undefined) reviewersByKey.set(key, figureReviewersOf(final, statementRun));
    }
  }

  // The report on hand: the approved quarter that reports for this quarter end.
  let current: LoadedQuarter | null = null;
  for (const row of quarters)
    if (alignedQuarterEnd(row.periodEnd, tolerance) === periodEnd) current = row;
  let report: ReportOnHand | null = null;
  let reportRun: RunBehind | null = null;
  if (current !== null) {
    const lineage = await lineageOf(current);
    reportRun = lineage?.behind ?? null;
    const ev = recordFigure(current, 'ev', lineage);
    const netDebt = recordFigure(current, 'net_debt', lineage);
    const ebitda = recordFigure(current, 'ebitda_ltm', lineage);
    report = { ev: ev.figure, netDebt: netDebt.figure, ebitda: ebitda.figure };
    reviewersByKey.set('enterprise_value', ev.reviewers);
    reviewersByKey.set('net_debt', netDebt.reviewers);
    reviewersByKey.set('ebitda_ltm', ebitda.reviewers);
  }

  const reference = referenceOnHand({
    periodEnd,
    marks: versions,
    flowDates: flows.map((flow) => flow.date),
    quarters,
    toleranceDays: tolerance,
  });
  // The earlier quarter's figures are cited to the record; whoever approved the run they were
  // read by, or typed them, stands behind them all the same.
  const earlier = quarters.find((row) => row.id === reference.quarter?.id);
  if (earlier !== undefined) {
    const lineage = await lineageOf(earlier);
    reviewersByKey.set(
      'reference_enterprise_value',
      recordFigure(earlier, 'ev', lineage).reviewers,
    );
    reviewersByKey.set('reference_net_debt', recordFigure(earlier, 'net_debt', lineage).reviewers);
    reviewersByKey.set(
      'reference_ebitda_ltm',
      recordFigure(earlier, 'ebitda_ltm', lineage).reviewers,
    );
  }

  const contributions = summarizeFlows(
    flows
      .filter((flow) => flow.date <= periodEnd)
      .map((flow) => ({ date: flow.date, kind: kindOf(flow.flowType), amount: flow.amount })),
  ).contributions;

  return {
    position: {
      id: found.id,
      investmentNumber: found.investmentNumber,
      companyName: found.companyName,
      vehicleName: found.vehicleName,
      dealType: found.dealType,
      currency: found.currency,
      isActive: found.isActive,
      entryDate: found.entryDate,
      exitDate: found.exitDate,
    },
    versions,
    sources: {
      periodEnd,
      statement,
      report,
      reference,
      recordContributions: contributions.toFixed(),
    },
    statementRun,
    reportRun,
    reviewersByKey,
  };
}
