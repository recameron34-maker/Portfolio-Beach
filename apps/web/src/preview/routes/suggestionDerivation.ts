import definitions from '../../../../../config/definitions.json';
import extractionSchemaJson from '../../../../../config/extraction_schema.json';
import { loadExtractionSchemas, promotesToRecord } from '@pb/ai';
import type { ExtractionSchema, TargetColumn } from '@pb/ai';
import {
  CALC_VERSION,
  D,
  Decimal,
  alignedQuarterEnd,
  isQuarterEnd,
  summarizeFlows,
} from '@pb/calc';
import type { FlowKind } from '@pb/calc';
import { investmentDetail } from '@pb/contracts';
import type { SuggestionRunOutcome, ValuationSuggestionRow } from '@pb/contracts';
import { EXPECTED_DOC_TYPES } from '@pb/validation';
import {
  PERIOD_END_KEY,
  STATEMENT_LINE_KEYS,
  STATEMENT_SHARE_KEY,
  VALUATION_IN_FLIGHT_STATES,
  attempt,
  derivationStep,
  figureReviewersOf,
  finalValuesOf,
  quarterVersions,
  recordFigureOf,
  referenceOnHand,
  selectSuggestion,
  sourceReviewersOf,
  statementOnHandOf,
  suggestionBar,
  suggestionReading,
  suggestionSchemasOf,
  suggestionSettings,
  valuationSuggestionMachine,
} from '@pb/workflows';
import type {
  DerivationStep,
  FinalValue,
  MarkOnRecord,
  PriorSuggestion,
  QuarterOnRecord,
  RecordFigureColumn,
  ReportOnHand,
  RunBehind,
  Selection,
  SourcedFigure,
  StatementOnHand,
  StoredSuggestion,
  SuggestionPosition,
  SuggestionSettings,
  SuggestionSources,
  SupersededReason,
  ValuationState,
} from '@pb/workflows';
import type { Recordings } from '../fixtures.js';
import { ensureValuations, readAny, valuesOfRun } from '../state.js';
import type { SimActor, SimRun, SimSuggestion } from '../state.js';
import { SYSTEM_ACTOR, canOpen, flagEnabled, recordActivity } from './common.js';
import type { SimContext } from './common.js';

/*
 * The derivation of valuation suggestions in the static preview (docs/04 M10, docs/08 section
 * 12, docs/18 section 14, decision 0023), the way apps/api/src/suggestions/ runs it. Nothing is
 * recorded: a suggestion exists only once a capital account statement or a sponsor report is
 * approved in the session.
 *
 * Every decision is the API's own, taken by the same pure functions of @pb/workflows and
 * @pb/calc: which source gives the suggestion (selectSuggestion), when none applies
 * (suggestionBar), what an approval does to the suggestion already open (derivationStep), what a
 * reader is shown beside one (suggestionReading), and how an approved run and a quarter on
 * record are read (finalValuesOf, statementOnHandOf, recordFigureOf). Only the reading differs:
 * where the API queries the database as the system actor, this file reads the session and the
 * book as the system actor sees them:
 *
 * - the position from the book (preview/book.json), with the currency it is held in;
 * - its valuation versions from the session's valuations (every recorded version, with the
 *   Drafts, locks and reopens of the session laid over them);
 * - its approved cash flows from the recorded one-pager, with the flows a reconciled capital
 *   notice of the session wrote;
 * - its approved quarters from the book, with the quarters an approved report run of the
 *   session promoted laid over them, each naming the run it came from;
 * - the approved runs and their decided values from the session.
 *
 * It runs when a statement or a report run is approved (runApproved, where a suggestion may be
 * opened), when an import is promoted or a valuation is locked or reopened (refreshPosition,
 * where the Open suggestions are derived again and none is created), and before accept and
 * applyToDraft write anything (refreshOne). With the switch valuation.suggestions off nothing is
 * derived. Two approvals cannot race in one browser tab, so the API's advisory lock and its 409
 * have no counterpart here.
 */

/** The switch (ops.feature_flag, migration 0023): on unless a platform admin turns it off. */
export const SUGGESTIONS_SWITCH = 'valuation.suggestions';
const APPROVED = 'record_status.approved';
/** The valuation states in which a version is still on its way to Locked. */
const IN_FLIGHT: readonly string[] = VALUATION_IN_FLIGHT_STATES;

let settingsCache: SuggestionSettings | null = null;
/** The settings of config/definitions.json through the one reader the API uses (rule 9): a missing key throws, naming it. */
export function previewSuggestionSettings(): SuggestionSettings {
  return (settingsCache ??= suggestionSettings(definitions));
}

/** The extraction schemas the suggestions read, by kind. */
export interface SuggestionSchemas {
  /** A capital account statement: no record figure, the document type of a statement. */
  statements: ReadonlyMap<string, ExtractionSchema>;
  /** A sponsor report: it writes to the quarterly record. */
  reports: ReadonlyMap<string, ExtractionSchema>;
}

let schemasCache: SuggestionSchemas | null = null;
/**
 * Which schemas of config/extraction_schema.json are a statement and a report, by the rule the
 * API reads them with (suggestionSchemasOf of @pb/workflows): a report writes to the quarterly
 * record (promotesToRecord of @pb/ai); a statement is a schema of the capital account statement
 * type that does not, and it must carry the lines the rules read.
 */
export function suggestionSchemas(): SuggestionSchemas {
  return (schemasCache ??= suggestionSchemasOf(
    Object.values(loadExtractionSchemas(extractionSchemaJson)),
    { promotesToRecord, statementDocType: EXPECTED_DOC_TYPES.capitalAccountStatement },
  ));
}

/** Whether the switch is on: this session's change, else the credential's recorded flag list, else the migration's default. */
export function suggestionsEnabled(ctx: SimContext, credential: string): boolean {
  return flagEnabled(ctx, credential, SUGGESTIONS_SWITCH, true);
}

/* ---- The sources on hand, as the system actor reads them ---- */

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
  /** Null when the book holds no such position. */
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
  /** The statement run to read the lines from: the run of a stored statement-based suggestion. */
  statementRunId?: string;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every version of a position as the session holds it: by period end, the highest version first. */
export function versionsOf(ctx: SimContext, investmentId: string): PositionVersion[] {
  return [...ensureValuations(ctx.state, ctx.recordings).values()]
    .filter((sim) => sim.row.investmentId === investmentId)
    .map(({ row }) => ({
      id: row.id,
      periodEnd: row.periodEnd,
      version: row.version,
      state: row.state,
      fairValue: row.fairValue,
      method: row.method,
      rowVersion: row.rowVersion,
    }))
    .sort((a, b) => byText(a.periodEnd, b.periodEnd) || b.version - a.version);
}

interface ApprovedFlow {
  date: string;
  flowType: string;
  amount: string;
}

/** The recorded flows of each position, read once per set of recordings (they never change). */
const recordedFlows = new WeakMap<Recordings, Map<string, ApprovedFlow[]>>();

/**
 * The approved cash flows of a position: those of its recorded one-pager (the API lists the
 * approved ones), whoever recorded it, and the flow a reconciled capital notice of this session
 * wrote.
 */
function approvedFlowsOf(ctx: SimContext, investmentId: string): ApprovedFlow[] {
  let cache = recordedFlows.get(ctx.recordings);
  if (cache === undefined) {
    cache = new Map();
    recordedFlows.set(ctx.recordings, cache);
  }
  let recorded = cache.get(investmentId);
  if (recorded === undefined) {
    recorded =
      readAny(
        ctx.recordings,
        `/api/v1/investments/${encodeURIComponent(investmentId)}`,
        investmentDetail,
      )?.cashFlows ?? [];
    cache.set(investmentId, recorded);
  }
  const session = [...(ctx.state.notices?.values() ?? [])]
    .filter((notice) => notice.row.investmentId === investmentId)
    .flatMap((notice) => notice.cashFlows.filter((flow) => flow.status === APPROVED));
  return [...recorded, ...session];
}

/** An approved quarter of the record with the run it names as its source. */
interface LoadedQuarter extends QuarterOnRecord {
  extractionRunId: string | null;
}

/** A figure as the record's column keeps it: to the cent, rounded half away from zero. */
const asStored = (value: string): string =>
  D(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

/**
 * The approved quarters of a position, entry snapshots left out, oldest first: the book's, with
 * the quarters an approved report run of this session promoted laid over them. A promotion
 * writes the figures its run stood behind and leaves the others as the record held them, and
 * the quarter then names that run.
 */
function quartersOf(ctx: SimContext, investmentId: string): LoadedQuarter[] {
  const byPeriod = new Map<string, LoadedQuarter>();
  for (const q of ctx.book?.quarters[investmentId] ?? []) {
    if (q.isEntrySnapshot) continue;
    byPeriod.set(q.periodEnd, {
      id: q.id,
      periodEnd: q.periodEnd,
      ev: q.ev,
      netDebt: q.netDebt,
      ebitdaLtm: q.ebitdaLtm,
      extractionRunId: null,
    });
  }
  for (const promoted of ctx.state.promotedQuarters.values()) {
    if (promoted.investmentId !== investmentId) continue;
    const before = byPeriod.get(promoted.periodEnd);
    const figure = (key: RecordFigureColumn): string | null => {
      const written = promoted.figures[key];
      return typeof written === 'string' ? asStored(written) : (before?.[key] ?? null);
    };
    byPeriod.set(promoted.periodEnd, {
      id: promoted.id,
      periodEnd: promoted.periodEnd,
      ev: figure('ev'),
      netDebt: figure('netDebt'),
      ebitdaLtm: figure('ebitdaLtm'),
      extractionRunId: promoted.source.runId,
    });
  }
  return [...byPeriod.values()].sort((a, b) => byText(a.periodEnd, b.periodEnd));
}

/** What a suggestion records of an approved run; null for a run nobody approved. */
function behindOf(run: SimRun | undefined): RunBehind | null {
  if (run === undefined || run.approvedById === null) return null;
  return {
    id: run.id,
    documentId: run.documentId,
    approvedBy: run.approvedById,
    promptVersion: run.promptVersion,
    modelId: run.modelId,
  };
}

/** The accepted and edited values of a run, by field: what its approval stands behind. */
function finalValues(ctx: SimContext, runId: string): Map<string, FinalValue> {
  return finalValuesOf(valuesOfRun(ctx.state, runId));
}

/** The record's column a target of the report schema writes. */
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

/** A figure of an approved quarter with where it came from (recordFigureOf), for a target of the report schema. */
function recordFigure(
  on: LoadedQuarter,
  target: TargetColumn,
  lineage: LineageRun | null,
): { figure: SourcedFigure | null; reviewers: string[] } {
  const column = RECORD_COLUMN[target];
  if (column === undefined) return { figure: null, reviewers: [] };
  const key =
    lineage === null
      ? null
      : (lineage.schema.fields.find((field) => field.target === target)?.key ?? null);
  return recordFigureOf(
    on,
    column,
    lineage === null || key === null
      ? null
      : { behind: lineage.behind, final: lineage.finals.get(key) },
  );
}

/** The approved statement runs of a position, the latest approval first. */
function approvedStatementRuns(
  ctx: SimContext,
  investmentId: string,
  schemas: SuggestionSchemas,
): SimRun[] {
  return [...ctx.state.runs.values()]
    .filter(
      (run) =>
        run.investmentId === investmentId &&
        schemas.statements.has(run.schemaId) &&
        run.approvedById !== null,
    )
    .sort(
      (a, b) =>
        byText(b.approvedAt ?? '', a.approvedAt ?? '') ||
        (b.approvalOrder ?? 0) - (a.approvalOrder ?? 0) ||
        byText(b.id, a.id),
    );
}

/**
 * Everything the rules read for a position and a quarter, as the session stands (gatherSources
 * of apps/api/src/suggestions/sources.ts). The position is null, and nothing else is read, when
 * the book holds none of that id.
 */
export function gatherSources(
  ctx: SimContext,
  request: GatherRequest,
  settings: SuggestionSettings = previewSuggestionSettings(),
  schemas: SuggestionSchemas = suggestionSchemas(),
): Gathered {
  const { investmentId, periodEnd } = request;
  const tolerance = settings.periodEndToleranceDays;
  const found = ctx.book?.investments.find((inv) => inv.id === investmentId);
  if (found === undefined)
    return {
      position: null,
      versions: [],
      sources: {
        periodEnd,
        statement: null,
        report: null,
        reference: { mark: null, flowsSince: false, quarter: null },
        recordContributions: '0',
      },
      statementRun: null,
      reportRun: null,
      reviewersByKey: new Map(),
    };

  const versions = versionsOf(ctx, investmentId);
  const flows = approvedFlowsOf(ctx, investmentId);
  const quarters = quartersOf(ctx, investmentId);

  // The run a quarter names as its source: approved, and of a report schema.
  const lineageOf = (on: LoadedQuarter): LineageRun | null => {
    if (on.extractionRunId === null) return null;
    const run = ctx.state.runs.get(on.extractionRunId);
    const behind = behindOf(run);
    const reportSchema = run === undefined ? undefined : schemas.reports.get(run.schemaId);
    return behind === null || reportSchema === undefined
      ? null
      : { behind, schema: reportSchema, finals: finalValues(ctx, behind.id) };
  };

  const reviewersByKey = new Map<string, readonly string[]>();

  // The statement on hand.
  let statement: StatementOnHand | null = null;
  let statementRun: RunBehind | null = null;
  if (request.statementRunId !== undefined) {
    const run = ctx.state.runs.get(request.statementRunId);
    if (run !== undefined && schemas.statements.has(run.schemaId)) statementRun = behindOf(run);
  } else {
    for (const candidate of approvedStatementRuns(ctx, investmentId, schemas)) {
      // The quarter is the statement's own period end and no other: the one its approval
      // accepted, which is the run's when the document carries one.
      const own =
        candidate.periodEnd ?? finalValues(ctx, candidate.id).get(PERIOD_END_KEY)?.value ?? null;
      if (own !== periodEnd) continue;
      statementRun = behindOf(candidate);
      break;
    }
  }
  if (statementRun !== null) {
    const staged = valuesOfRun(ctx.state, statementRun.id);
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
    const lineage = lineageOf(current);
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
    const lineage = lineageOf(earlier);
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
      .map((flow) => ({
        date: flow.date,
        // The flow kind @pb/calc expects is the taxonomy code without its domain.
        kind: flow.flowType.replace('flow_type.', '') as FlowKind,
        amount: flow.amount,
      })),
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

/** What a read of one suggestion gathers: the sources of its quarter, with its own statement for a statement-based one. */
export function gatherFor(
  ctx: SimContext,
  sim: Pick<SimSuggestion, 'investmentId' | 'periodEnd' | 'basis' | 'extractionRunId'>,
  settings: SuggestionSettings = previewSuggestionSettings(),
): Gathered {
  return gatherSources(
    ctx,
    {
      investmentId: sim.investmentId,
      periodEnd: sim.periodEnd,
      // A statement-based suggestion names the run its statement was read by.
      ...(sim.basis === 'capital_account_balance' ? { statementRunId: sim.extractionRunId } : {}),
    },
    settings,
  );
}

/* ---- The suggestions written before ---- */

/** What a stored suggestion says: its basis, its value or the reason for none, and its inputs. */
export const storedOf = (sim: SimSuggestion): StoredSuggestion => ({
  basis: sim.basis,
  value: sim.suggestedValue,
  reason: sim.reasonCode,
  inputs: sim.inputs,
});

/** The suggestions written before for a position and quarter, as the derivation reads them. */
export function priorSuggestions(
  ctx: SimContext,
  investmentId: string,
  periodEnd: string,
): { open: (PriorSuggestion & { extractionRunId: string }) | null; decided: PriorSuggestion[] } {
  const valuations = ensureValuations(ctx.state, ctx.recordings);
  let open: (PriorSuggestion & { extractionRunId: string }) | null = null;
  const decided: PriorSuggestion[] = [];
  for (const sim of ctx.state.suggestions.values()) {
    if (sim.investmentId !== investmentId || sim.periodEnd !== periodEnd) continue;
    if (sim.state === 'Superseded') continue;
    const on = sim.valuationId === null ? undefined : valuations.get(sim.valuationId);
    const prior: PriorSuggestion & { extractionRunId: string } = {
      ...storedOf(sim),
      id: sim.id,
      state: sim.state,
      valuationState: on === undefined ? null : (on.row.state satisfies ValuationState),
      extractionRunId: sim.extractionRunId,
    };
    if (sim.state === 'Open') open = prior;
    else decided.push(prior);
  }
  return { open, decided };
}

/**
 * Who cannot approve a valuation version because they stood behind a suggested mark it carries
 * (docs/18 sections 1 and 14): the `sourceReviewers` the valuation machine reads for
 * dealTeamApprove and lock. `chainIds` are the versions of the version's investment and quarter:
 * a reopen copies the mark to the next version while the suggestion still names the one it was
 * accepted onto. Read over every suggestion of the session, whoever asks.
 */
export function sourceReviewersOn(ctx: SimContext, chainIds: readonly string[]): string[] {
  return sourceReviewersOf(
    [...ctx.state.suggestions.values()]
      .filter((sim) => sim.valuationId !== null && chainIds.includes(sim.valuationId))
      .map((sim) => ({ state: sim.state, sourceReviewerIds: sim.sourceReviewerIds })),
  );
}

/* ---- The derivation ---- */

/** An approved run whose approval may open a suggestion. */
export interface ApprovedRun extends RunBehind {
  investmentId: string | null;
  /** The quarter end its approval accepted. */
  periodEnd: string;
  schemaId: string;
}

/** What a derivation did: the step taken and the suggestion written, if one was. */
export interface DerivationResult {
  /** `off` when the switch is off, `not_applicable` for a run that is neither a statement nor a report. */
  action: DerivationStep['action'] | 'off' | 'not_applicable';
  because: string | null;
  writtenId: string | null;
}

/** Who caused a derivation: its writes are the system actor's, and the session's activity list names the person. */
export interface DerivationCause {
  credential: string;
  actor: SimActor;
}

interface DeriveRequest {
  investmentId: string;
  periodEnd: string;
  mode: 'approval' | 'refresh';
  /** The run whose approval caused the derivation; null for a refresh. */
  trigger: RunBehind | null;
  /** Set when that run is a statement: it is the latest approved statement of the quarter, by definition. */
  statementRunId?: string;
}

/** Open to Superseded, the system actor's row of docs/18 section 14. */
function supersede(
  ctx: SimContext,
  cause: DerivationCause,
  target: { id: string; reason: SupersededReason },
  replacedBy: string | null,
  at: string,
): void {
  const sim = ctx.state.suggestions.get(target.id);
  if (sim === undefined) return;
  const result = attempt(valuationSuggestionMachine, sim.state, 'supersede', {
    ...SYSTEM_ACTOR,
    record: { supersededReason: target.reason },
  });
  // The machine refuses only a suggestion that is no longer Open, which no derivation names.
  if (!result.ok) throw new Error(`valuation suggestion: ${result.message}`);
  ctx.state.suggestions.set(sim.id, {
    ...sim,
    state: result.to,
    supersededReason: target.reason,
    supersededById: replacedBy,
    decidedBy: null,
    decidedAt: at,
    rowVersion: sim.rowVersion + 1,
  });
  recordActivity(ctx, cause.actor, {
    action: 'valuation_suggestion.supersede',
    entity: 'valuation_suggestion',
    entityId: sim.id,
    reason: target.reason,
    from: sim.state,
    to: result.to,
  });
}

/**
 * The approved run a suggestion names: the one its value was read by (the statement's run, or
 * the run the quarter on record names); when the record names none, the run whose approval
 * caused the derivation, and for a refresh the run of the suggestion it replaces.
 */
function runBehind(
  ctx: SimContext,
  selection: Selection,
  gathered: Gathered,
  trigger: RunBehind | null,
  replaces: { runId: string } | null,
): RunBehind {
  const own =
    selection.basis === 'capital_account_balance' ? gathered.statementRun : gathered.reportRun;
  if (own !== null) return own;
  if (trigger !== null) return trigger;
  const kept = replaces === null ? null : behindOf(ctx.state.runs.get(replaces.runId));
  if (kept !== null) return kept;
  throw new Error('valuation suggestion: no approved run stands behind the suggestion');
}

/** A suggestion written Open under the id given, with what it rests on (the write of derivation.service.ts). */
function write(
  ctx: SimContext,
  cause: DerivationCause,
  request: DeriveRequest,
  selection: Selection,
  gathered: Gathered,
  id: string,
  behind: RunBehind,
  at: string,
): void {
  const cited = selection.inputs.find(
    (input) => input.source.kind === 'document' && input.source.id === behind.documentId,
  );
  ctx.state.suggestions.set(id, {
    id,
    investmentId: request.investmentId,
    periodEnd: request.periodEnd,
    basis: selection.basis,
    method: selection.method,
    // Dollars to the cent, as the column holds them.
    suggestedValue: selection.value === null ? null : D(selection.value).toFixed(2),
    reasonCode: selection.reason,
    inputs: selection.inputs,
    sourceDocumentId: behind.documentId,
    extractionRunId: behind.id,
    sourcePage: cited?.source.page ?? null,
    sourceLocator: cited === undefined ? null : `field:${cited.key}`,
    sourceReviewerIds: [
      ...new Set(selection.inputs.flatMap((input) => gathered.reviewersByKey.get(input.key) ?? [])),
    ].sort(),
    promptVersion: behind.promptVersion,
    modelId: behind.modelId,
    calcVersion: CALC_VERSION,
    state: 'Open',
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    valuationId: null,
    supersededReason: null,
    supersededById: null,
    createdAt: at,
    rowVersion: 1,
  });
  recordActivity(ctx, cause.actor, {
    action: 'valuation_suggestion.open',
    entity: 'valuation_suggestion',
    entityId: id,
    reason: null,
    from: null,
    to: 'Open',
  });
}

/** One derivation: the sources, the decision and exactly the writes it names. */
function derive(ctx: SimContext, cause: DerivationCause, request: DeriveRequest): DerivationResult {
  const settings = previewSuggestionSettings();
  const at = ctx.env.now();
  const gathered = gatherSources(ctx, request, settings);
  const prior = priorSuggestions(ctx, request.investmentId, request.periodEnd);
  const bar = suggestionBar(
    gathered.position,
    request.periodEnd,
    gathered.versions,
    settings.periodEndToleranceDays,
  );
  const step = derivationStep({
    bar,
    selection: bar === null ? selectSuggestion(gathered.sources, settings) : null,
    open: prior.open,
    decided: prior.decided,
    sourceOrder: settings.sourceOrder,
    mode: request.mode,
  });
  let writtenId: string | null = null;
  if (step.action === 'close') {
    supersede(ctx, cause, step.supersede, null, at);
  } else if (step.action === 'open') {
    const behind = runBehind(ctx, step.selection, gathered, request.trigger, null);
    writtenId = ctx.env.newId();
    write(ctx, cause, request, step.selection, gathered, writtenId, behind, at);
  } else if (step.action === 'replace') {
    // The run behind the replacement is found before anything is written; then the Open
    // suggestion is superseded, naming its replacement, whose row is written next (the API's
    // order within its one transaction).
    const behind = runBehind(
      ctx,
      step.selection,
      gathered,
      request.trigger,
      prior.open === null ? null : { runId: prior.open.extractionRunId },
    );
    writtenId = ctx.env.newId();
    supersede(ctx, cause, step.supersede, writtenId, at);
    write(ctx, cause, request, step.selection, gathered, writtenId, behind, at);
  }
  return { action: step.action, because: 'because' in step ? step.because : null, writtenId };
}

/** Every Open suggestion of the position but the quarter given, derived again in quarter order. */
function refreshOthers(
  ctx: SimContext,
  cause: DerivationCause,
  investmentId: string,
  except: string | null,
): void {
  const open = [...ctx.state.suggestions.values()]
    .filter(
      (sim) =>
        sim.investmentId === investmentId && sim.state === 'Open' && sim.periodEnd !== except,
    )
    .map((sim) => sim.periodEnd)
    .sort(byText);
  for (const periodEnd of open)
    derive(ctx, cause, { investmentId, periodEnd, mode: 'refresh', trigger: null });
}

/**
 * A statement or a report run was approved: the suggestion of its position and quarter is
 * derived and may be opened, and the other Open suggestions of the position are derived again
 * (the figures of this quarter are the earlier quarter of a later one). A statement linked to no
 * position is our account in a fund commitment: nothing applies and nothing is written. The run
 * is already approved when this is called.
 */
export function runApproved(
  ctx: SimContext,
  cause: DerivationCause,
  approved: ApprovedRun,
): DerivationResult {
  const { statements, reports } = suggestionSchemas();
  if (!statements.has(approved.schemaId) && !reports.has(approved.schemaId))
    return { action: 'not_applicable', because: null, writtenId: null };
  if (!suggestionsEnabled(ctx, cause.credential))
    return { action: 'off', because: null, writtenId: null };
  if (approved.investmentId === null)
    return { action: 'none', because: 'fund_commitment', writtenId: null };
  const result = derive(ctx, cause, {
    investmentId: approved.investmentId,
    periodEnd: approved.periodEnd,
    mode: 'approval',
    trigger: approved,
    ...(statements.has(approved.schemaId) ? { statementRunId: approved.id } : {}),
  });
  refreshOthers(ctx, cause, approved.investmentId, approved.periodEnd);
  return result;
}

/**
 * Something the Open suggestions of a position rest on changed (an import was promoted, one of
 * its valuations was locked or reopened): each is derived again, in quarter order. None is
 * created.
 */
export function refreshPosition(
  ctx: SimContext,
  cause: DerivationCause,
  investmentId: string,
): void {
  if (!suggestionsEnabled(ctx, cause.credential)) return;
  refreshOthers(ctx, cause, investmentId, null);
}

/**
 * The Open suggestion of one position and quarter derived again, before accept or applyToDraft
 * writes anything: `none` when it still says what the sources give, otherwise it was replaced or
 * closed. The caller has checked the switch.
 */
export function refreshOne(
  ctx: SimContext,
  cause: DerivationCause,
  investmentId: string,
  periodEnd: string,
): DerivationResult {
  return derive(ctx, cause, { investmentId, periodEnd, mode: 'refresh', trigger: null });
}

/* ---- Reading a suggestion ---- */

/** Whether the credential may see the suggestion: it carries its position's wall. */
export const suggestionVisible = (
  ctx: SimContext,
  credential: string,
  sim: Pick<SimSuggestion, 'investmentId'>,
): boolean => canOpen(ctx, credential, sim.investmentId);

/**
 * The contract row (toSuggestionRow of apps/api/src/suggestions/rows.ts): the stored columns,
 * and what is derived when read from the sources as they stand now. Null when the book no
 * longer holds the position.
 */
export function toSuggestionRow(
  ctx: SimContext,
  sim: SimSuggestion,
  gathered: Gathered = gatherFor(ctx, sim),
  settings: SuggestionSettings = previewSuggestionSettings(),
): ValuationSuggestionRow | null {
  const { position } = gathered;
  if (position === null) return null;
  const view = suggestionReading(storedOf(sim), gathered.sources, settings);
  const inFlight = quarterVersions(
    gathered.versions,
    sim.periodEnd,
    settings.periodEndToleranceDays,
  ).find((version) => IN_FLIGHT.includes(version.state));
  const fileNameOf = (documentId: string): string | null =>
    ctx.state.documents.get(documentId)?.fileName ?? null;
  const inFlightRow =
    inFlight === undefined
      ? undefined
      : ensureValuations(ctx.state, ctx.recordings).get(inFlight.id)?.row;
  return {
    id: sim.id,
    investmentId: sim.investmentId,
    investmentNumber: position.investmentNumber,
    companyName: position.companyName,
    vehicleName: position.vehicleName,
    dealType: position.dealType,
    periodEnd: sim.periodEnd,
    basis: sim.basis,
    method: sim.method,
    suggestedValue: sim.suggestedValue,
    reasonCode: sim.reasonCode,
    workings: {
      inputs: sim.inputs.map((input) => ({
        ...input,
        source: {
          ...input.source,
          fileName: input.source.kind === 'document' ? fileNameOf(input.source.id) : null,
        },
      })),
    },
    source: {
      documentId: sim.sourceDocumentId,
      fileName: fileNameOf(sim.sourceDocumentId),
      extractionRunId: sim.extractionRunId,
      page: sim.sourcePage,
      locator: sim.sourceLocator,
    },
    sourceReviewerIds: sim.sourceReviewerIds,
    promptVersion: sim.promptVersion,
    modelId: sim.modelId,
    calcVersion: sim.calcVersion,
    state: sim.state,
    decidedBy: sim.decidedBy,
    decidedAt: sim.decidedAt,
    decisionReason: sim.decisionReason,
    valuationId: sim.valuationId,
    supersededReason: sim.supersededReason,
    supersededById: sim.supersededById,
    createdAt: sim.createdAt,
    rowVersion: sim.rowVersion,
    currentMark: view.currentMark,
    comparison: view.comparison,
    checks: view.checks,
    crossChecks: view.crossChecks,
    inProgress:
      inFlightRow === undefined
        ? null
        : {
            valuationId: inFlightRow.id,
            periodEnd: inFlightRow.periodEnd,
            version: inFlightRow.version,
            state: inFlightRow.state,
            method: inFlightRow.method,
            fairValue: inFlightRow.fairValue,
            rowVersion: inFlightRow.rowVersion,
          },
    flags: view.flags,
  };
}

/** The period end a run's approval accepted, for a run whose document carries none. */
function acceptedPeriodEnd(ctx: SimContext, runId: string): string | null {
  return finalValues(ctx, runId).get(PERIOD_END_KEY)?.value ?? null;
}

/**
 * What an approved statement or report run did to the suggestions of its position and quarter,
 * as it stands now (runOutcome of apps/api/src/suggestions/suggestions.service.ts): null for a
 * run the credential cannot see, one not approved, or one that is neither a statement nor a
 * report. A run that produced a suggestion `opened` it, or `replaced` the one that was open.
 * With none of its own, the decision a derivation would take now says why, writing nothing.
 */
export function runOutcomeOf(
  ctx: SimContext,
  credential: string,
  runId: string,
): SuggestionRunOutcome | null {
  const settings = previewSuggestionSettings();
  const schemas = suggestionSchemas();
  const run = ctx.state.runs.get(runId);
  if (run === undefined || run.approvedById === null) return null;
  if (run.investmentId !== null && !canOpen(ctx, credential, run.investmentId)) return null;
  if (!schemas.statements.has(run.schemaId) && !schemas.reports.has(run.schemaId)) return null;

  // In the order they were written, which is the order the session holds them in.
  const produced = [...ctx.state.suggestions.values()].filter(
    (sim) => sim.extractionRunId === runId,
  );
  const first = produced[0];
  const newest = produced[produced.length - 1];
  if (first !== undefined && newest !== undefined) {
    const replaced = [...ctx.state.suggestions.values()].some(
      (sim) => sim.supersededById === first.id,
    );
    return { outcome: replaced ? 'replaced' : 'opened', reason: null, suggestionId: newest.id };
  }

  if (run.investmentId === null)
    return { outcome: 'none', reason: 'fund_commitment', suggestionId: null };
  const periodEnd = run.periodEnd ?? acceptedPeriodEnd(ctx, runId);
  if (periodEnd === null || !isQuarterEnd(periodEnd))
    return { outcome: 'none', reason: null, suggestionId: null };
  const gathered = gatherSources(
    ctx,
    { investmentId: run.investmentId, periodEnd },
    settings,
    schemas,
  );
  const prior = priorSuggestions(ctx, run.investmentId, periodEnd);
  const bar = suggestionBar(
    gathered.position,
    periodEnd,
    gathered.versions,
    settings.periodEndToleranceDays,
  );
  const step = derivationStep({
    bar,
    selection: bar === null ? selectSuggestion(gathered.sources, settings) : null,
    open: prior.open,
    decided: prior.decided,
    sourceOrder: settings.sourceOrder,
    mode: 'approval',
  });
  if (step.action === 'close') return { outcome: 'none', reason: step.because, suggestionId: null };
  if (step.action === 'none') {
    if (step.because === 'unchanged')
      return { outcome: 'unchanged', reason: null, suggestionId: prior.open?.id ?? null };
    // `none_open` is a refresh's answer and never an approval's.
    return {
      outcome: 'none',
      reason: step.because === 'none_open' ? null : step.because,
      suggestionId: null,
    };
  }
  // A derivation would write one now (the switch was off when the run was approved, or the
  // record has moved since): no rule keeps a mark from being suggested, and none was.
  return { outcome: 'none', reason: null, suggestionId: null };
}
