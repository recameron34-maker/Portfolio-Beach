import definitions from '../../../../../config/definitions.json';
import extractionSchemaJson from '../../../../../config/extraction_schema.json';
import styleJson from '../../../../../config/style.json';
import {
  AiError,
  EXTRACTION_RULES,
  UNITS_BY_KIND,
  boundsFrom,
  buildInput,
  extractionSettingsFrom,
  fixtureExtractor,
  highlightStyleFrom,
  loadExtractionSchemas,
  outputSchemaFor,
  parseTruth,
  promptRef,
  redact,
  validateExtraction,
} from '@pb/ai';
import type {
  ExtractionField,
  ExtractionOutput,
  ExtractionSchema,
  ExtractionSchemas,
  ExtractionValidation,
  HighlightStyle,
  Truth,
  ValidationFinding,
} from '@pb/ai';
import { CalcError, D, toDollars, unitSanityFlag } from '@pb/calc';
import {
  extractionBatchBody,
  extractionDefinitions,
  extractionRunCommandBody,
  extractionRunListQuery,
  extractionUnit,
  investmentPerformance,
  isQuarterEnd,
  pageQuery,
  valueFitsUnit,
} from '@pb/contracts';
import type {
  ExtractedValue,
  ExtractionBatch,
  ExtractionBatchBody,
  ExtractionBatchPage,
  ExtractionDefinitions,
  ExtractionFinding,
  ExtractionRun,
  ExtractionRunCommandBody,
  ExtractionRunDetail,
  ExtractionRunPage,
  ExtractionUnit,
  ExtractionValidationState,
  ExtractionValueCounts,
  PageLayout,
} from '@pb/contracts';
import { attempt, extractionRunMachine } from '@pb/workflows';
import type { ExtractionCommand, ExtractionState } from '@pb/workflows';
import { ZodError } from 'zod';
import type { PreviewBook } from '../book.js';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import { quarterKey, valuesOfRun } from '../state.js';
import type {
  QuarterlyFigureKey,
  QuarterlyFigures,
  SimActor,
  SimBatch,
  SimPromotedQuarter,
  SimRun,
  SimValue,
} from '../state.js';
import {
  EXCEPTION_SEVERITY,
  SYSTEM_ACTOR,
  canOpen,
  contractBody,
  defineSimRoute,
  flagEnabled,
  noBook,
  openException,
  pageNewestFirst,
  recordActivity,
} from './common.js';
import type { SimContext } from './common.js';
import {
  docTypeLabel,
  documentSettings,
  investmentOf,
  toSummary,
  visibleDocument,
} from './documents.js';

/**
 * AI extraction (docs/04 M4, docs/18 section 7, decision 0012) simulated in the browser, the way
 * apps/api/src/extraction/ serves it. A batch (operations, refused while ai.extraction is off)
 * names documents or a (period end, type) selection of Classified documents; its runs are driven
 * one after another through extractionRunMachine as the system actor: every page of the indexed
 * document is redacted, the input is built with the shared frame of @pb/ai, the fixture extractor
 * answers the truth the book records for the content hash (never reading the text, so a
 * document's instructions cannot move it), the output is checked against the schema's shape and
 * validated with the bounds, the style and the thresholds of config, and one value per schema
 * field plus the highlights and the commentary rows are staged. Retries, budgets and failures
 * follow the config and the table; the switch is read before every attempt, so a batch whose
 * switch is turned off part way fails its remaining runs with kill_switch (SEC-8.10, AI-6); the
 * day budget counts a whole run budget for every run still Running (budget note); a failed run
 * opens a data exception (EXT-RUN-01). The review commands decide values under the rules the
 * validator holds the model to (a money edit inside the configured range, a date edit on the
 * quarter the run covers: FIN-1, FIN-2), a highlight or commentary row that breaks the house
 * style can only be rejected (AI-4), and approval names an undecided record figure, refuses a
 * period end off the run's quarter and a superseded quarter, then promotes the final values of
 * the target fields, converted to dollars, into the simulated quarters the Performance tab
 * overlay reads, with the run's lineage citing the first accepted figure and a fixed default
 * reason that never names the file (W3). A reader sees the runs of documents their own
 * recordings let them open.
 */

/** The kill switch for batch creation and run processing (migration 0003, SEC-8.10): off by default. */
export const EXTRACTION_SWITCH = 'ai.extraction';
/** The data exception a failed run opens (source 'extraction'). */
export const RUN_EXCEPTION_RULE = 'EXT-RUN-01';
export const RUN_NOT_FOUND = 'Extraction run not found';
const DOCUMENT_NOT_FOUND = 'Document not found';
/** The staged rows that are not schema fields: decided like a value, promoted only when accepted. */
export const HIGHLIGHTS_FIELD = 'highlights';
export const COMMENTARY_FIELD = 'commentary';
export const NARRATIVE_FIELDS: readonly string[] = [HIGHLIGHTS_FIELD, COMMENTARY_FIELD];
/** The longest quote the stg.extracted_value column holds (migration 0011). */
const QUOTE_COLUMN_CHARS = 150;
/** The approval reason when the reviewer gives none: a fixed sentence, never the file name (W3, SEC-5.3). */
export const DEFAULT_APPROVAL_REASON = 'Approved from the AI extraction review';
/** The error code of a run that found the switch off when its attempt began (SEC-8.10, AI-6). */
export const KILL_SWITCH_CODE = 'kill_switch';
/** The record status of a quarter that a later approval replaced; a promotion never revives one. */
const SUPERSEDED_STATUS = 'record_status.superseded';
/** The mon.quarterly_performance column a schema target names. */
const TARGET_KEYS: Readonly<Record<string, QuarterlyFigureKey>> = {
  revenue_ltm: 'revenueLtm',
  ebitda_ltm: 'ebitdaLtm',
  ev: 'ev',
  net_debt: 'netDebt',
  cash: 'cash',
  total_equity: 'totalEquity',
};
const ACCEPTED = 'accepted';
const EDITED = 'edited';
const REJECTED = 'rejected';
const machine = extractionRunMachine;

/* ---- Config, through the contracts' and @pb/ai's strict readers (rules 9 and 10) ---- */

/** `definitions.extraction`: concurrency, token budgets, the quote length, the flag threshold, the retry budget and the cost table. */
export function extractionSettings(): ExtractionDefinitions {
  return extractionDefinitions.parse(definitions.extraction);
}

let schemasCache: ExtractionSchemas | null = null;
/** config/extraction_schema.json as @pb/ai loads it. */
export function extractionSchemas(): ExtractionSchemas {
  return (schemasCache ??= loadExtractionSchemas(extractionSchemaJson));
}

let styleCache: HighlightStyle | null = null;
/** The highlights block of config/style.json as the validator reads it. */
function highlightStyle(): HighlightStyle {
  return (styleCache ??= highlightStyleFrom(styleJson));
}

/** The recorded fixture outputs keyed by content hash, from the book's truth sidecars, once per book. */
const truthsByBook = new WeakMap<PreviewBook, Map<string, Truth>>();
export function truthsOf(book: PreviewBook): Map<string, Truth> {
  let truths = truthsByBook.get(book);
  if (truths === undefined) {
    truths = new Map();
    for (const doc of book.documents)
      if (!truths.has(doc.contentHash)) truths.set(doc.contentHash, parseTruth(doc.truth));
    truthsByBook.set(book, truths);
  }
  return truths;
}

/** The schema whose docType is the one given, or null when no schema extracts that type. */
export function schemaForDocType(
  schemas: ExtractionSchemas,
  docType: string,
): ExtractionSchema | null {
  return Object.values(schemas).find((s) => s.docType === docType) ?? null;
}

/** The keys of a schema's money fields: an edit of one of them needs a money unit (contract). */
export function moneyFieldKeys(schema: ExtractionSchema): string[] {
  return schema.fields.filter((f) => f.kind === 'money').map((f) => f.key);
}

/** The unit a value of a kind carries when the reviewer names none: a money field always names one. */
function naturalUnitOf(field: Pick<ExtractionField, 'kind'>): ExtractionUnit | null {
  switch (field.kind) {
    case 'money':
      return null;
    case 'percent':
      return 'PCT';
    case 'count':
      return 'COUNT';
    case 'date':
      return 'DATE';
  }
}

/** The cost of a call: tokens per thousand times the configured rate, in and out, rounded to four places. */
export function costOf(
  tokensIn: number,
  tokensOut: number,
  settings: Pick<ExtractionDefinitions, 'costPerThousandTokensUsd'>,
): string {
  const rate = settings.costPerThousandTokensUsd;
  return D(String(tokensIn))
    .div(1000)
    .times(D(rate.in))
    .plus(D(String(tokensOut)).div(1000).times(D(rate.out)))
    .toFixed(4);
}

/** The findings as the contract stores them, each with the severity its rule carries. */
export function toFindings(findings: readonly ValidationFinding[]): ExtractionFinding[] {
  return findings.map((f) => ({
    ruleId: f.ruleId,
    severity: EXTRACTION_RULES[f.ruleId].severity,
    message: f.message,
  }));
}

function stateOf(findings: readonly ExtractionFinding[]): ExtractionValidationState {
  if (findings.some((f) => f.severity === 'invalid')) return 'invalid';
  return findings.length === 0 ? 'clean' : 'flagged';
}

const clipQuote = (quote: string | null): string | null =>
  quote === null ? null : Array.from(quote).slice(0, QUOTE_COLUMN_CHARS).join('');

const blocked = (detail: string, instance: string): Response =>
  problem(409, 'review-blocked', detail, { instance, simulated: true });
const refused = (detail: string, instance: string): Response =>
  problem(422, 'workflow-precondition', detail, { instance, simulated: true });
const runNotFound = (instance: string): Response =>
  problem(404, 'not-found', RUN_NOT_FOUND, { instance, simulated: true });
/** The problem a caller gets while the switch is off (SEC-8.10). */
export const extractionOff = (instance: string): Response =>
  problem(409, 'kill-switch', `AI extraction is switched off (${EXTRACTION_SWITCH})`, {
    instance,
    simulated: true,
  });

/* ---- Visibility and the contract shapes ---- */

/** Whether the credential may see the run: its document is unlinked, or linked to a position they may open. */
export const runVisible = (ctx: SimContext, credential: string, run: SimRun): boolean =>
  run.investmentId === null || canOpen(ctx, credential, run.investmentId);

function visibleRun(ctx: SimContext, credential: string, id: string): SimRun | undefined {
  const run = ctx.state.runs.get(id);
  return run !== undefined && runVisible(ctx, credential, run) ? run : undefined;
}

const emptyCounts = (): ExtractionValueCounts => ({
  values: 0,
  clean: 0,
  flagged: 0,
  invalid: 0,
  decided: 0,
});

/** The value counts of a run over its schema fields (not the narrative rows). */
export function countsOf(ctx: SimContext, runId: string): ExtractionValueCounts {
  const counts = emptyCounts();
  for (const v of valuesOfRun(ctx.state, runId)) {
    if (NARRATIVE_FIELDS.includes(v.field)) continue;
    counts.values += 1;
    counts[v.validationState] += 1;
    if (v.decision !== null) counts.decided += 1;
  }
  return counts;
}

export function toRun(ctx: SimContext, run: SimRun): ExtractionRun {
  const doc = ctx.state.documents.get(run.documentId);
  const investment = ctx.book === null ? undefined : investmentOf(ctx.book, run.investmentId);
  return {
    id: run.id,
    documentId: run.documentId,
    documentTitle: doc?.title ?? '',
    fileName: doc?.fileName ?? '',
    investmentId: run.investmentId,
    investmentNumber: investment?.investmentNumber ?? null,
    companyName: investment?.companyName ?? null,
    periodEnd: run.periodEnd,
    schemaId: run.schemaId,
    promptId: run.promptId,
    promptVersion: run.promptVersion,
    modelId: run.modelId,
    state: run.state,
    batchId: run.batchId,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    costUsd: run.costUsd,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    errorCode: run.errorCode,
    errorKind: run.errorKind,
    schemaRetries: run.schemaRetries,
    transientRetries: run.transientRetries,
    requestedBy: run.requestedBy,
    approvedBy: run.approvedBy,
    approvedAt: run.approvedAt,
    promotedRecordId: run.promotedRecordId,
    counts: countsOf(ctx, run.id),
    rowVersion: run.rowVersion,
  };
}

/** A batch as the caller sees it: the run states, tokens and cost cover only the runs they may see. */
export function toBatch(ctx: SimContext, credential: string, batch: SimBatch): ExtractionBatch {
  const runs = { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, needsRetry: 0 };
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = D('0');
  for (const run of ctx.state.runs.values()) {
    if (run.batchId !== batch.id || !runVisible(ctx, credential, run)) continue;
    runs.total += 1;
    switch (run.state) {
      case 'Queued':
        runs.queued += 1;
        break;
      case 'Running':
        runs.running += 1;
        break;
      case 'Succeeded':
        runs.succeeded += 1;
        break;
      case 'Failed':
        runs.failed += 1;
        break;
      case 'NeedsRetry':
        runs.needsRetry += 1;
        break;
    }
    tokensIn += run.tokensIn ?? 0;
    tokensOut += run.tokensOut ?? 0;
    if (run.costUsd !== null) cost = cost.plus(run.costUsd);
  }
  return {
    id: batch.id,
    state: batch.state,
    progress: batch.progress,
    requestedBy: batch.requestedBy,
    createdAt: batch.createdAt,
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
    errorCode: batch.errorCode,
    runs,
    tokensIn,
    tokensOut,
    costUsd: cost.toFixed(4),
  };
}

function toValue(row: SimValue, field: ExtractionField): ExtractedValue {
  return {
    id: row.id,
    field: row.field,
    label: field.label,
    kind: field.kind,
    required: field.required,
    value: row.value,
    unit: row.unit,
    page: row.page,
    quote: row.quote,
    confidence: row.confidence,
    validationState: row.validationState,
    findings: row.findings.map((f) => ({ ...f })),
    decision: row.decision,
    editedValue: row.editedValue,
    editedUnit: row.editedUnit,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
  };
}

/** The drafted highlights a staged row holds (a JSON array as text); an unreadable row reads as none. */
function highlightsOf(stored: string | null): string[] {
  if (stored === null) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

/** The run detail: the run, its document, the values in schema order, the narrative and the page layouts of the document. */
function toDetail(
  ctx: SimContext,
  credential: string,
  run: SimRun,
  instance: string,
): ExtractionRunDetail | Response {
  const schema = extractionSchemas()[run.schemaId];
  if (schema === undefined)
    return problem(
      500,
      'configuration',
      `config/extraction_schema.json no longer holds the schema ${run.schemaId}`,
      { instance, simulated: true },
    );
  const doc = visibleDocument(ctx, credential, run.documentId);
  if (doc === undefined) return runNotFound(instance);
  if (doc.pages === null)
    return problem(
      422,
      'unreadable-document',
      `unreadable document (${doc.unreadableCode ?? 'corrupt'}): the reader refused this item`,
      { instance, simulated: true },
    );
  const values = valuesOfRun(ctx.state, run.id);
  const byField = new Map(values.map((v) => [v.field, v]));
  const pages: PageLayout[] = doc.pages.map((p) => ({
    number: p.number,
    width: p.width,
    height: p.height,
    runs: p.runs.map((r) => ({ ...r })),
  }));
  return {
    run: toRun(ctx, run),
    document: toSummary(ctx, doc),
    values: schema.fields.flatMap((field) => {
      const row = byField.get(field.key);
      return row === undefined ? [] : [toValue(row, field)];
    }),
    highlights: highlightsOf(byField.get(HIGHLIGHTS_FIELD)?.value ?? null),
    commentary: byField.get(COMMENTARY_FIELD)?.value ?? null,
    pages,
  };
}

function answerDetail(
  ctx: SimContext,
  credential: string,
  run: SimRun,
  instance: string,
): Response {
  const detail = toDetail(ctx, credential, run, instance);
  return detail instanceof Response ? detail : jsonResponse(200, detail, { simulated: true });
}

/* ---- The run processor (apps/api/src/extraction/runner.ts) ---- */

/** What one attempt over the model ended with. */
type Outcome =
  | {
      kind: 'succeeded';
      output: ExtractionOutput;
      validation: ExtractionValidation;
      tokensIn: number;
      tokensOut: number;
      modelId: string;
    }
  | { kind: 'error'; errorKind: 'schema' | 'transient'; errorCode: string }
  | {
      kind: 'budget';
      errorCode: 'run_budget' | 'day_budget';
      tokensIn: number | null;
      tokensOut: number | null;
      modelId: string | null;
    }
  /** Failed outright: an unreadable document, or the switch off. */
  | { kind: 'failed'; errorCode: string };

/** A table refusal of a system transition is a fault of the simulation, answered as a problem. */
class SimulationFault extends Error {
  constructor(readonly response: Response) {
    super('simulation fault');
  }
}

function systemTransition(
  from: ExtractionState,
  command: ExtractionCommand,
  record: Record<string, unknown>,
  instance: string,
): ExtractionState {
  const result = attempt(machine, from, command, { ...SYSTEM_ACTOR, record });
  if (!result.ok) throw new SimulationFault(workflowProblem(result, { instance, simulated: true }));
  return result.to;
}

/**
 * The day's use when a run starts: the tokens the other runs started that calendar day
 * recorded, plus a whole run budget for each one still Running (its tokens are not known yet),
 * so runs driven together cannot overshoot the day budget by a run each (the API's start step).
 */
export function dayTokensOf(
  runs: Iterable<SimRun>,
  runId: string,
  today: string,
  settings: Pick<ExtractionDefinitions, 'runTokenBudget'>,
): number {
  let tokens = 0;
  for (const other of runs) {
    if (other.id === runId || other.startedAt?.startsWith(today) !== true) continue;
    tokens += (other.tokensIn ?? 0) + (other.tokensOut ?? 0);
    if (other.state === 'Running') tokens += settings.runTokenBudget;
  }
  return tokens;
}

/** Queued > Running (start) or NeedsRetry > Running (retry), stamping started_at; answers the day's use by the other runs. */
function start(ctx: SimContext, actor: SimActor, run: SimRun, instance: string): number {
  const from = run.state;
  const command: ExtractionCommand = from === 'NeedsRetry' ? 'retry' : 'start';
  const to = systemTransition(from, command, {}, instance);
  const now = ctx.env.now();
  const dayTokens = dayTokensOf(
    ctx.state.runs.values(),
    run.id,
    now.slice(0, 10),
    extractionSettings(),
  );
  run.state = to;
  run.startedAt = now;
  recordActivity(ctx, actor, {
    action: `extraction_run.${command}`,
    entity: 'extraction_run',
    entityId: run.id,
    reason: null,
    from,
    to,
  });
  return dayTokens;
}

/** One attempt: the switch, the budgets, the indexed pages, the redaction, the model call and the validation. Nothing here writes. */
function attemptRun(
  ctx: SimContext,
  book: PreviewBook,
  credential: string,
  run: SimRun,
  schema: ExtractionSchema,
  dayTokens: number,
): Outcome {
  // The switch is read per run, not once per batch, so turning it off stops the next run before
  // the store or the model is touched (SEC-8.10, AI-6).
  if (!flagEnabled(ctx, credential, EXTRACTION_SWITCH, false))
    return { kind: 'failed', errorCode: KILL_SWITCH_CODE };
  const settings = extractionSettings();
  if (dayTokens > settings.dayTokenBudget)
    return {
      kind: 'budget',
      errorCode: 'day_budget',
      tokensIn: null,
      tokensOut: null,
      modelId: null,
    };
  const doc = ctx.state.documents.get(run.documentId);
  if (doc === undefined) return { kind: 'error', errorKind: 'transient', errorCode: 'store_read' };
  if (doc.pages === null)
    return { kind: 'failed', errorCode: `unreadable_${doc.unreadableCode ?? 'corrupt'}` };
  const pageTexts = doc.pages.map((p) => redact(p.text).text);
  const investment = investmentOf(book, run.investmentId);
  let output: ExtractionOutput;
  let tokensIn: number;
  try {
    const input = buildInput({
      metadata: {
        file_name: doc.fileName,
        content_hash: doc.contentHash,
        page_count: doc.pageCount ?? doc.pages.length,
        ...(investment === undefined ? {} : { investment_number: investment.investmentNumber }),
        ...(investment === undefined ? {} : { company_name: investment.companyName }),
      },
      pages: pageTexts,
    });
    // The prototype model: the recorded truth for the content hash, checked against the schema's
    // output shape as the mock client checks it; the token counts are the mock client's.
    output = outputSchemaFor(schema, { maxPage: documentSettings().maxPages }).parse(
      fixtureExtractor(truthsOf(book))(input),
    );
    tokensIn = Math.ceil(input.length / 4);
  } catch (error) {
    if (error instanceof ZodError)
      return { kind: 'error', errorKind: 'schema', errorCode: 'schema_invalid' };
    if (error instanceof AiError)
      return { kind: 'error', errorKind: 'schema', errorCode: `ai_${error.code}` };
    return { kind: 'error', errorKind: 'transient', errorCode: 'call_failed' };
  }
  const tokensOut = 64;
  const modelId = 'mock';
  if (tokensIn + tokensOut > settings.runTokenBudget)
    return { kind: 'budget', errorCode: 'run_budget', tokensIn, tokensOut, modelId };
  const validation = validateExtraction(output, {
    schema,
    pageTexts,
    bounds: boundsFrom(definitions),
    style: highlightStyle(),
    ...extractionSettingsFrom(definitions),
    ...(run.periodEnd === null ? {} : { expectedPeriodEnd: run.periodEnd }),
  });
  return { kind: 'succeeded', output, validation, tokensIn, tokensOut, modelId };
}

/** Running > Succeeded: the values staged with their validation, the run stamped with tokens, cost and model. */
function succeed(
  ctx: SimContext,
  actor: SimActor,
  run: SimRun,
  schema: ExtractionSchema,
  outcome: Extract<Outcome, { kind: 'succeeded' }>,
  settings: ExtractionDefinitions,
  instance: string,
): ExtractionState {
  const to = systemTransition('Running', 'succeed', {}, instance);
  const { output, validation } = outcome;
  const stage = (
    field: string,
    f: {
      value: string | null;
      unit: ExtractionUnit | null;
      page: number | null;
      quote: string | null;
      confidence: string | null;
    },
    findings: ExtractionFinding[],
    validationState: ExtractionValidationState,
  ): void => {
    const row: SimValue = {
      id: ctx.env.newId(),
      runId: run.id,
      investmentId: run.investmentId,
      field,
      value: f.value,
      unit: f.unit,
      page: f.page,
      quote: clipQuote(f.quote),
      confidence: f.confidence,
      validationState,
      findings,
      reviewerId: null,
      decidedBy: null,
      decision: null,
      editedValue: null,
      editedUnit: null,
      decidedAt: null,
      rowVersion: 1,
    };
    ctx.state.values.set(row.id, row);
  };
  for (const field of schema.fields) {
    const f = output.fields[field.key];
    const findings = toFindings(validation.fields[field.key]?.findings ?? []);
    stage(
      field.key,
      {
        value: f?.value ?? null,
        unit: f?.unit ?? null,
        page: f?.page ?? null,
        quote: f?.quote ?? null,
        confidence: f?.confidence ?? null,
      },
      findings,
      validation.fields[field.key]?.validationState ?? stateOf(findings),
    );
  }
  const highlightFindings = toFindings(validation.highlights);
  const commentaryFindings = toFindings(validation.commentary);
  const none = { unit: null, page: null, quote: null, confidence: null };
  stage(
    HIGHLIGHTS_FIELD,
    { value: JSON.stringify(output.highlights), ...none },
    highlightFindings,
    stateOf(highlightFindings),
  );
  stage(
    COMMENTARY_FIELD,
    { value: output.commentary, ...none },
    commentaryFindings,
    stateOf(commentaryFindings),
  );
  run.state = to;
  run.tokensIn = outcome.tokensIn;
  run.tokensOut = outcome.tokensOut;
  run.costUsd = costOf(outcome.tokensIn, outcome.tokensOut, settings);
  run.modelId = outcome.modelId;
  run.finishedAt = ctx.env.now();
  run.errorKind = null;
  run.errorCode = null;
  const counts = countsOf(ctx, run.id);
  recordActivity(ctx, actor, {
    action: 'extraction_run.succeed',
    entity: 'extraction_run',
    entityId: run.id,
    reason: null,
    from: 'Running',
    to,
    details: {
      tokensIn: outcome.tokensIn,
      tokensOut: outcome.tokensOut,
      values: counts.values,
      clean: counts.clean,
      flagged: counts.flagged,
      invalid: counts.invalid,
    },
  });
  return to;
}

/** Running > Failed: the run stamped with what it used and why it failed, and a data exception opened (EXT-RUN-01). */
function fail(
  ctx: SimContext,
  actor: SimActor,
  run: SimRun,
  failure: {
    errorKind: 'schema' | 'transient' | null;
    errorCode: string;
    tokensIn: number | null;
    tokensOut: number | null;
    modelId: string | null;
  },
  settings: ExtractionDefinitions,
  instance: string,
): ExtractionState {
  const to = systemTransition('Running', 'fail', {}, instance);
  run.state = to;
  run.errorKind = failure.errorKind;
  run.errorCode = failure.errorCode;
  run.tokensIn = failure.tokensIn;
  run.tokensOut = failure.tokensOut;
  run.costUsd =
    failure.tokensIn === null || failure.tokensOut === null
      ? null
      : costOf(failure.tokensIn, failure.tokensOut, settings);
  run.modelId = failure.modelId;
  run.finishedAt = ctx.env.now();
  openException(ctx, {
    source: 'extraction',
    entity: 'doc.extraction_run',
    entityId: run.id,
    ruleId: RUN_EXCEPTION_RULE,
    expected: 'an extraction run that completes within its budgets',
    actual: `the run failed (${failure.errorCode})`,
    severity: EXCEPTION_SEVERITY,
    candidates: [],
    file: null,
    rowNo: null,
    investmentId: run.investmentId,
  });
  recordActivity(ctx, actor, {
    action: 'extraction_run.fail',
    entity: 'extraction_run',
    entityId: run.id,
    reason: failure.errorCode,
    from: 'Running',
    to,
  });
  return to;
}

/** Writes the outcome as the system actor: succeed, scheduleRetry within the budget, or fail. */
function settle(
  ctx: SimContext,
  actor: SimActor,
  run: SimRun,
  schema: ExtractionSchema,
  outcome: Outcome,
  instance: string,
): ExtractionState {
  const settings = extractionSettings();
  if (outcome.kind === 'succeeded')
    return succeed(ctx, actor, run, schema, outcome, settings, instance);
  if (outcome.kind === 'error') {
    const retries = outcome.errorKind === 'schema' ? run.schemaRetries : run.transientRetries;
    const budget =
      outcome.errorKind === 'schema' ? settings.schemaRetries : settings.transientRetries;
    const scheduled =
      retries < budget
        ? attempt(machine, 'Running', 'scheduleRetry', {
            ...SYSTEM_ACTOR,
            record: {
              lastErrorKind: outcome.errorKind,
              schemaRetries: run.schemaRetries,
              transientRetries: run.transientRetries,
            },
          })
        : null;
    if (scheduled?.ok === true) {
      run.state = scheduled.to;
      run.errorKind = outcome.errorKind;
      run.errorCode = outcome.errorCode;
      if (outcome.errorKind === 'schema') run.schemaRetries += 1;
      else run.transientRetries += 1;
      recordActivity(ctx, actor, {
        action: 'extraction_run.scheduleRetry',
        entity: 'extraction_run',
        entityId: run.id,
        reason: outcome.errorCode,
        from: 'Running',
        to: scheduled.to,
      });
      return scheduled.to;
    }
    return fail(
      ctx,
      actor,
      run,
      {
        errorKind: outcome.errorKind,
        errorCode: outcome.errorCode,
        tokensIn: null,
        tokensOut: null,
        modelId: null,
      },
      settings,
      instance,
    );
  }
  return fail(
    ctx,
    actor,
    run,
    {
      errorKind: null,
      errorCode: outcome.errorCode,
      tokensIn: outcome.kind === 'budget' ? outcome.tokensIn : null,
      tokensOut: outcome.kind === 'budget' ? outcome.tokensOut : null,
      modelId: outcome.kind === 'budget' ? outcome.modelId : null,
    },
    settings,
    instance,
  );
}

/** Drives one run to a terminal state: start, attempt, settle, and again from NeedsRetry while the budget allows. */
function processOne(
  ctx: SimContext,
  book: PreviewBook,
  req: { actor: SimActor; credential: string },
  run: SimRun,
  instance: string,
): 'Succeeded' | 'Failed' | Response {
  const { actor, credential } = req;
  const schema = extractionSchemas()[run.schemaId];
  if (schema === undefined)
    return problem(
      500,
      'configuration',
      `config/extraction_schema.json no longer holds the schema ${run.schemaId}`,
      { instance, simulated: true },
    );
  try {
    for (;;) {
      const dayTokens = start(ctx, actor, run, instance);
      const outcome = attemptRun(ctx, book, credential, run, schema, dayTokens);
      const next = settle(ctx, actor, run, schema, outcome, instance);
      if (next === 'Succeeded' || next === 'Failed') return next;
    }
  } catch (error) {
    if (error instanceof SimulationFault) return error.response;
    throw error;
  }
}

/* ---- Batches ---- */

/** A document as the batch checks it. */
interface Selected {
  id: string;
  fileName: string;
  investmentId: string | null;
  periodEnd: string | null;
}

/**
 * The documents a batch covers, checked: ids named are read under the caller's own view (one they
 * cannot see is not found); a (period end, type) selection takes every Classified document of
 * the book. Every document must be Classified and of a type an extraction schema covers.
 */
function select(
  ctx: SimContext,
  credential: string,
  body: ExtractionBatchBody,
  instance: string,
): { documents: Selected[]; schema: ExtractionSchema } | Response {
  const schemas = extractionSchemas();
  if ('documentIds' in body) {
    const documents: Selected[] = [];
    let schema: ExtractionSchema | null = null;
    for (const id of new Set(body.documentIds)) {
      const doc = visibleDocument(ctx, credential, id);
      if (doc === undefined)
        return problem(404, 'not-found', DOCUMENT_NOT_FOUND, { instance, simulated: true });
      if (doc.reviewStatus !== 'Classified')
        return refused(
          `extraction: ${doc.fileName} is ${doc.reviewStatus}, not Classified; classify it first`,
          instance,
        );
      const found = doc.docType === null ? null : schemaForDocType(schemas, doc.docType);
      if (found === null)
        return refused(
          `extraction: no extraction schema for ${docTypeLabel(ctx, credential, doc.docType)} (${doc.fileName})`,
          instance,
        );
      if (schema !== null && found.id !== schema.id)
        return refused(
          'extraction: a batch covers one document type; split the selection',
          instance,
        );
      schema = found;
      documents.push(doc);
    }
    if (schema === null) return refused('extraction: no document to extract', instance);
    return { documents, schema };
  }
  const schema = schemaForDocType(schemas, body.docType);
  if (schema === null)
    return refused(
      `extraction: no extraction schema for ${docTypeLabel(ctx, credential, body.docType)}`,
      instance,
    );
  const documents = [...ctx.state.documents.values()]
    .filter(
      (d) =>
        d.reviewStatus === 'Classified' &&
        d.docType === body.docType &&
        d.periodEnd === body.periodEnd,
    )
    .sort((a, b) =>
      a.indexedAt < b.indexedAt ? -1 : a.indexedAt > b.indexedAt ? 1 : a.id < b.id ? -1 : 1,
    );
  if (documents.length === 0)
    return refused(
      `extraction: no Classified ${docTypeLabel(ctx, credential, body.docType)} document for ${body.periodEnd}`,
      instance,
    );
  return { documents, schema };
}

/**
 * POST /api/v1/extraction/batches (operations): refused while the kill switch is off (409), for
 * a document that is not Classified, for a type without a schema and for an empty selection
 * (422 naming the first). The job and its Queued runs are written, then driven one after another
 * (the API drives batchConcurrency at a time); the batch is answered as the caller sees it.
 */
export const createBatchRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/extraction/batches',
  what: 'batch',
  body: extractionBatchBody,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const book = ctx.book;
    if (book === null) return noBook(instance);
    if (!flagEnabled(ctx, req.credential, EXTRACTION_SWITCH, false)) return extractionOff(instance);
    const selected = select(ctx, req.credential, req.body, instance);
    if (selected instanceof Response) return selected;
    const { documents, schema } = selected;
    const ref = promptRef(schema.promptId);
    const now = ctx.env.now();
    const batch: SimBatch = {
      id: ctx.env.newId(),
      state: 'queued',
      progress: 0,
      requestedById: req.actor.userId,
      requestedBy: req.actor.displayName,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      errorCode: null,
    };
    ctx.state.batches.set(batch.id, batch);
    const runs: SimRun[] = documents.map((doc) => ({
      id: ctx.env.newId(),
      documentId: doc.id,
      investmentId: doc.investmentId,
      periodEnd: doc.periodEnd,
      schemaId: schema.id,
      promptId: ref.promptId,
      promptVersion: ref.promptVersion,
      modelId: null,
      state: machine.initial,
      batchId: batch.id,
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorKind: null,
      schemaRetries: 0,
      transientRetries: 0,
      requestedById: req.actor.userId,
      requestedBy: req.actor.displayName,
      approvedById: null,
      approvedBy: null,
      approvedAt: null,
      promotedRecordId: null,
      createdAt: now,
      rowVersion: 1,
    }));
    for (const run of runs) {
      ctx.state.runs.set(run.id, run);
      recordActivity(ctx, req.actor, {
        action: 'extraction_run.queue',
        entity: 'extraction_run',
        entityId: run.id,
        reason: null,
        from: null,
        to: machine.initial,
      });
    }
    recordActivity(ctx, req.actor, {
      action: 'extraction_batch.create',
      entity: 'extraction_batch',
      entityId: batch.id,
      reason: null,
      from: null,
      to: batch.state,
      details: { runs: runs.length },
    });
    batch.state = 'running';
    batch.startedAt = ctx.env.now();
    let failed = 0;
    for (const [i, run] of runs.entries()) {
      const outcome = processOne(ctx, book, req, run, instance);
      if (outcome instanceof Response) return outcome;
      if (outcome === 'Failed') failed += 1;
      batch.progress = Math.round(((i + 1) / runs.length) * 100);
    }
    batch.state = failed > 0 ? 'failed' : 'succeeded';
    batch.progress = 100;
    batch.finishedAt = ctx.env.now();
    batch.errorCode = failed > 0 ? 'runs_failed' : null;
    return jsonResponse(201, toBatch(ctx, req.credential, batch), { simulated: true });
  },
});

/** GET /api/v1/extraction/batches: batches newest first, each with the states, tokens and cost of the runs the caller sees. */
export const batchesRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/extraction/batches',
  what: 'query',
  body: null,
  query: pageQuery,
  handle: (req, ctx) => {
    const page = pageNewestFirst(
      [...ctx.state.batches.values()],
      (b) => ({ at: b.createdAt, id: b.id }),
      req.query,
    );
    if (page === null)
      return problem(400, 'validation', 'Invalid cursor', {
        instance: req.url.pathname,
        simulated: true,
      });
    const body: ExtractionBatchPage = {
      items: page.items.map((b) => toBatch(ctx, req.credential, b)),
      nextCursor: page.nextCursor,
    };
    return jsonResponse(200, body, { simulated: true });
  },
});

/** GET /api/v1/extraction/runs: runs newest first, filtered by state, document, investment or batch; what the caller may see. */
export const runsRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/extraction/runs',
  what: 'query',
  body: null,
  query: extractionRunListQuery,
  handle: (req, ctx) => {
    const q = req.query;
    const runs = [...ctx.state.runs.values()].filter(
      (r) =>
        runVisible(ctx, req.credential, r) &&
        (q.state === undefined || r.state === q.state) &&
        (q.documentId === undefined || r.documentId === q.documentId) &&
        (q.investmentId === undefined || r.investmentId === q.investmentId) &&
        (q.batchId === undefined || r.batchId === q.batchId),
    );
    const page = pageNewestFirst(runs, (r) => ({ at: r.createdAt, id: r.id }), q);
    if (page === null)
      return problem(400, 'validation', 'Invalid cursor', {
        instance: req.url.pathname,
        simulated: true,
      });
    const body: ExtractionRunPage = {
      items: page.items.map((r) => toRun(ctx, r)),
      nextCursor: page.nextCursor,
    };
    return jsonResponse(200, body, { simulated: true });
  },
});

/** GET /api/v1/extraction/runs/{id}: the run for review with its document, values, narrative and page layouts; a hidden one is 404. */
export const runRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/extraction/runs/{id}',
  what: 'run',
  body: null,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const run = visibleRun(ctx, req.credential, req.params.id ?? '');
    if (run === undefined) return runNotFound(instance);
    return answerDetail(ctx, req.credential, run, instance);
  },
});

/* ---- Review by exception (apps/api/src/extraction/review.service.ts) ---- */

const invalidCommand = (errors: { path: string; message: string }[], instance: string): Response =>
  problem(400, 'validation', 'Invalid command', { instance, simulated: true, errors });

/** The staged row of a field, which must be a schema field or a narrative row (400 naming the field otherwise). */
function rowOf(
  schema: ExtractionSchema,
  values: readonly SimValue[],
  field: string,
  instance: string,
): { row: SimValue; definition: ExtractionField | null } | Response {
  const definition = schema.fields.find((f) => f.key === field) ?? null;
  const row = values.find((v) => v.field === field);
  if (row === undefined || (definition === null && !NARRATIVE_FIELDS.includes(field)))
    return invalidCommand([{ path: 'field', message: 'Unknown field for this run' }], instance);
  return { row, definition };
}

const labelOf = (definition: ExtractionField | null, field: string): string =>
  definition !== null
    ? definition.label
    : field === HIGHLIGHTS_FIELD
      ? 'Highlights'
      : field === COMMENTARY_FIELD
        ? 'Commentary'
        : field;

/** Writes one decision on a row; recorded with the decision before and after. The model's value and unit are never overwritten (WF-1). */
function decide(
  ctx: SimContext,
  actor: SimActor,
  run: SimRun,
  row: SimValue,
  set: {
    decision: 'accepted' | 'edited' | 'rejected';
    editedValue: string | null;
    editedUnit: ExtractionUnit | null;
  },
  reason: string | undefined,
  at: string,
): void {
  const before = row.decision;
  row.decision = set.decision;
  row.editedValue = set.editedValue;
  row.editedUnit = set.editedUnit;
  row.reviewerId = actor.userId;
  row.decidedBy = actor.displayName;
  row.decidedAt = at;
  row.rowVersion += 1;
  recordActivity(ctx, actor, {
    action: `extraction_value.${set.decision === EDITED ? 'edit' : set.decision === REJECTED ? 'reject' : 'accept'}`,
    entity: 'extracted_value',
    entityId: row.id,
    reason: reason ?? null,
    from: before,
    to: set.decision,
  });
}

const finalOf = (row: SimValue): string | null =>
  row.decision === EDITED ? row.editedValue : row.decision === ACCEPTED ? row.value : null;

/** An edited row converts with the edit's own unit, the model's value with the model's (WF-1). */
const unitOf = (row: SimValue): ExtractionUnit | null =>
  row.decision === EDITED ? row.editedUnit : row.unit;

/**
 * The rules the validator applies to the model's answer, applied to the reviewer's: a money
 * value converted to dollars must sit inside the configured range, which catches dollars typed
 * with the $M unit (docs/08 section 6, FIN-1); a date must be a quarter end, and the quarter the
 * run was opened for, since a report for another quarter is reclassified, not edited (docs/08
 * section 5, FIN-2).
 */
export function valueProblem(
  run: Pick<SimRun, 'periodEnd'>,
  definition: ExtractionField,
  value: string,
  unit: ExtractionUnit,
): string | null {
  if (definition.kind === 'money' && definition.bounds !== null) {
    const range = boundsFrom(definitions)[definition.bounds];
    const dollars = toDollars(value, unit);
    if (unitSanityFlag(dollars, { min: range.minUsd, max: range.maxUsd }))
      return `The value converts to ${dollars.toFixed()} dollars, outside the ${definition.bounds} range ${range.minUsd} to ${range.maxUsd}; check the unit`;
  }
  if (definition.kind === 'date') {
    if (!isQuarterEnd(value)) return 'The date must be a quarter end';
    if (run.periodEnd !== null && value !== run.periodEnd)
      return `The run covers ${run.periodEnd}; a report for another quarter is reclassified, not edited`;
  }
  return null;
}

/**
 * The status of the quarter on record for the period, as the credential's own recorded
 * performance holds it: the API reads mon.quarterly_performance as the system actor, and the
 * recording is the preview's record of a status (every row is served with its stored status).
 * Null when the record holds no quarter for the period.
 */
function statusOnRecord(
  ctx: SimContext,
  credential: string,
  investmentId: string,
  periodEnd: string,
): string | null {
  const perf = ctx.recordings.read(
    credential,
    `/api/v1/investments/${investmentId}/performance`,
    investmentPerformance,
  );
  return perf?.quarters.find((q) => q.periodEnd === periodEnd)?.status ?? null;
}

/**
 * approve: the blockers first (409 naming the first), then the promotion as the system actor
 * into the simulated quarters, then the run's approval. A rejected target leaves the record's
 * column as it was, and so does an accepted value the document did not state (null), since a
 * promotion never writes a number the document did not give; an undecided target is named,
 * never silently left out. The period end must be the quarter the run was opened for, and the
 * quarter on record must not be the entry snapshot or a superseded quarter (422 otherwise:
 * docs/08 section 5, docs/03 record_status, rule 10).
 */
function approve(
  ctx: SimContext,
  book: PreviewBook,
  req: { actor: SimActor; credential: string },
  run: SimRun,
  schema: ExtractionSchema,
  values: readonly SimValue[],
  reason: string | undefined,
  at: string,
  instance: string,
): Response | null {
  const { actor } = req;
  const byField = new Map(values.map((v) => [v.field, v]));
  for (const field of schema.fields) {
    const row = byField.get(field.key);
    if (row === undefined)
      return blocked(`extraction: ${field.label} was not staged for this run`, instance);
    const decided = row.decision === ACCEPTED || row.decision === EDITED;
    if (field.required && !decided)
      return blocked(`extraction: ${field.label} is required and not accepted or edited`, instance);
    if (row.validationState === 'invalid' && row.decision !== EDITED && row.decision !== REJECTED)
      return blocked(`extraction: ${field.label} is invalid and not edited or rejected`, instance);
    if (row.validationState === 'flagged' && row.decision === null)
      return blocked(`extraction: ${field.label} is flagged and undecided`, instance);
    if (field.target !== null && row.decision === null)
      return blocked(
        `extraction: ${field.label} is a record figure and undecided; accept, edit or reject it`,
        instance,
      );
  }
  if (run.investmentId === null)
    return refused(
      'extraction: the document is not linked to an investment; classify it with one first',
      instance,
    );
  const periodEndRow = byField.get('period_end');
  const periodEnd = periodEndRow === undefined ? null : finalOf(periodEndRow);
  if (periodEnd === null)
    return blocked('extraction: Period end is required and not accepted or edited', instance);
  // The figures land on the quarter the run was opened for and no other (FIN-2).
  if (!isQuarterEnd(periodEnd) || (run.periodEnd !== null && periodEnd !== run.periodEnd))
    return refused(
      `extraction: the period end ${periodEnd} is not the quarter the run covers (${run.periodEnd ?? 'a quarter end'}); edit it`,
      instance,
    );
  const figures: QuarterlyFigures = {};
  const promotedFields: string[] = [];
  for (const field of schema.fields) {
    if (field.target === null) continue;
    const row = byField.get(field.key);
    if (row === undefined) continue;
    const final = finalOf(row);
    if (final === null) continue;
    const key = TARGET_KEYS[field.target];
    if (key === undefined) continue;
    const unit = unitOf(row);
    if (unit === null)
      return blocked(`extraction: ${field.label} carries no money unit to convert from`, instance);
    try {
      figures[key] = toDollars(final, extractionUnit.parse(unit)).toFixed();
    } catch (error) {
      if (error instanceof CalcError || error instanceof ZodError)
        return blocked(
          `extraction: ${field.label} carries no money unit to convert from`,
          instance,
        );
      throw error;
    }
    promotedFields.push(field.key);
  }
  // The quarter on record, read again at approval (decision 0009): the book's approved quarter
  // for the period, or the one an earlier approval promoted; the entry snapshot is never written
  // and a superseded quarter is history that a promotion never revives (docs/03 record_status).
  const investmentId = run.investmentId;
  const onRecord = (book.quarters[investmentId] ?? []).find((q) => q.periodEnd === periodEnd);
  if (onRecord?.isEntrySnapshot === true)
    return refused(
      'extraction: the quarter on record is the entry snapshot, which a promotion never changes',
      instance,
    );
  const key = quarterKey(investmentId, periodEnd);
  const previous = ctx.state.promotedQuarters.get(key);
  if (
    previous === undefined &&
    statusOnRecord(ctx, req.credential, investmentId, periodEnd) === SUPERSEDED_STATUS
  )
    return refused(
      'extraction: the quarter on record is superseded, which a promotion never revives',
      instance,
    );
  // The citation: the first promoted figure read from the document, in schema order (an edited
  // value has no page of its own), named in the locator; none when every target was edited.
  const cited = schema.fields.find((field) => {
    if (field.target === null) return false;
    const row = byField.get(field.key);
    return row?.decision === ACCEPTED && row.value !== null;
  });
  const citedRow = cited === undefined ? undefined : byField.get(cited.key);
  const highlightsRow = byField.get(HIGHLIGHTS_FIELD);
  const commentaryRow = byField.get(COMMENTARY_FIELD);
  const approvalReason = reason ?? DEFAULT_APPROVAL_REASON;
  const promoted: SimPromotedQuarter = {
    id: onRecord?.id ?? previous?.id ?? ctx.env.newId(),
    investmentId,
    periodEnd,
    created: onRecord === undefined && (previous?.created ?? true),
    figures: { ...previous?.figures, ...figures },
    approvedById: actor.userId,
    approvedBy: actor.displayName,
    approvedAt: at,
    approvalReason,
    ...(highlightsRow?.decision === ACCEPTED
      ? { highlights: highlightsOf(highlightsRow.value) }
      : previous?.highlights === undefined
        ? {}
        : { highlights: previous.highlights }),
    ...(commentaryRow?.decision === ACCEPTED
      ? { commentary: commentaryRow.value }
      : previous?.commentary === undefined
        ? {}
        : { commentary: previous.commentary }),
    source: {
      documentId: run.documentId,
      runId: run.id,
      page: citedRow?.page ?? null,
      locator: cited === undefined ? null : `field:${cited.key}`,
    },
    promptVersion: run.promptVersion,
    modelId: run.modelId,
  };
  ctx.state.promotedQuarters.set(key, promoted);
  recordActivity(ctx, actor, {
    action: 'quarterly_performance.promote',
    entity: 'quarterly_performance',
    entityId: promoted.id,
    reason: approvalReason,
    from: null,
    to: 'record_status.approved',
    details: { fields: promotedFields.length },
  });
  run.approvedById = actor.userId;
  run.approvedBy = actor.displayName;
  run.approvedAt = at;
  run.promotedRecordId = promoted.id;
  run.rowVersion += 1;
  recordActivity(ctx, actor, {
    action: 'extraction_run.approve',
    entity: 'extraction_run',
    entityId: run.id,
    reason: approvalReason,
    from: null,
    to: 'approved',
  });
  return null;
}

/**
 * retry: a NeedsRetry run is driven again through the table; a Failed run gets a fresh Queued run
 * for the same document (same schema and prompt, no batch, requested by the caller), driven at
 * once and answered. Refused while the kill switch is off (409).
 */
function retry(
  ctx: SimContext,
  book: PreviewBook,
  req: { actor: SimActor; credential: string },
  run: SimRun,
  instance: string,
): Response {
  if (!flagEnabled(ctx, req.credential, EXTRACTION_SWITCH, false)) return extractionOff(instance);
  let target = run;
  if (run.state === 'Failed') {
    target = {
      ...run,
      id: ctx.env.newId(),
      modelId: null,
      state: machine.initial,
      batchId: null,
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorKind: null,
      schemaRetries: 0,
      transientRetries: 0,
      requestedById: req.actor.userId,
      requestedBy: req.actor.displayName,
      approvedById: null,
      approvedBy: null,
      approvedAt: null,
      promotedRecordId: null,
      createdAt: ctx.env.now(),
      rowVersion: 1,
    };
    ctx.state.runs.set(target.id, target);
    recordActivity(ctx, req.actor, {
      action: 'extraction_run.queue',
      entity: 'extraction_run',
      entityId: target.id,
      reason: `retry of ${run.id}`,
      from: null,
      to: machine.initial,
    });
  } else if (run.state !== 'NeedsRetry') {
    return problem(
      409,
      'workflow-transition',
      `extraction_run: retry is not allowed from ${run.state}`,
      { instance, simulated: true },
    );
  }
  const outcome = processOne(ctx, book, req, target, instance);
  if (outcome instanceof Response) return outcome;
  return answerDetail(ctx, req.credential, target, instance);
}

/**
 * POST /api/v1/extraction/runs/{id}/commands (deal team, operations; the run must be visible):
 * accept, reject, edit, acceptClean and approve on a Succeeded, unapproved run; retry on a
 * NeedsRetry or Failed one. Answers the run as it now stands.
 */
export const runCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/extraction/runs/{id}/commands',
  what: 'command',
  body: contractBody<ExtractionRunCommandBody>('POST', '/api/v1/extraction/runs/{id}/commands'),
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const book = ctx.book;
    if (book === null) return noBook(instance);
    const run = visibleRun(ctx, req.credential, req.params.id ?? '');
    if (run === undefined) return runNotFound(instance);
    const body = req.body;
    if (body.command === 'retry') return retry(ctx, book, req, run, instance);
    const schema = extractionSchemas()[run.schemaId];
    if (schema === undefined)
      return problem(
        500,
        'configuration',
        `config/extraction_schema.json no longer holds the schema ${run.schemaId}`,
        { instance, simulated: true },
      );
    if (run.state !== 'Succeeded')
      return blocked(
        `extraction: ${body.command} needs a Succeeded run; this one is ${run.state}`,
        instance,
      );
    if (run.approvedById !== null)
      return blocked('extraction: the run is already approved and promoted', instance);
    const values = valuesOfRun(ctx.state, run.id);
    const at = ctx.env.now();
    switch (body.command) {
      case 'accept': {
        // The value as the model answered it (an earlier edit is dropped). An invalid value is
        // refused with its first finding, and so is a highlights or commentary row with any
        // finding: a banned phrase, a wrong opening or an em dash never reaches the record (AI-4).
        const found = rowOf(schema, values, body.field, instance);
        if (found instanceof Response) return found;
        const label = labelOf(found.definition, body.field);
        const finding = found.row.findings[0];
        const named = finding === undefined ? '' : `: ${finding.message}`;
        if (found.row.validationState === 'invalid')
          return blocked(
            `extraction: ${label} is invalid and cannot be accepted${named}; edit or reject it`,
            instance,
          );
        if (found.definition === null && found.row.validationState !== 'clean')
          return blocked(
            `extraction: ${label} breaks the house style and cannot be accepted${named}; reject it`,
            instance,
          );
        decide(
          ctx,
          req.actor,
          run,
          found.row,
          { decision: ACCEPTED, editedValue: null, editedUnit: null },
          undefined,
          at,
        );
        break;
      }
      case 'reject': {
        const found = rowOf(schema, values, body.field, instance);
        if (found instanceof Response) return found;
        decide(
          ctx,
          req.actor,
          run,
          found.row,
          { decision: REJECTED, editedValue: null, editedUnit: null },
          body.reason,
          at,
        );
        break;
      }
      case 'edit': {
        const parsed = extractionRunCommandBody(moneyFieldKeys(schema)).safeParse(body);
        if (!parsed.success)
          return invalidCommand(
            parsed.error.issues.map((i) => ({
              path: i.path.map(String).join('.') || '(root)',
              message: i.message,
            })),
            instance,
          );
        const found = rowOf(schema, values, body.field, instance);
        if (found instanceof Response) return found;
        if (found.definition === null)
          return invalidCommand(
            [{ path: 'field', message: 'Only a schema field can be edited' }],
            instance,
          );
        // A money field takes a money unit, any other field its own unit, the value must fit it,
        // and the value must pass the rules the validator holds the model to (valueProblem).
        const unit: ExtractionUnit | null = body.unit ?? naturalUnitOf(found.definition);
        const errors: { path: string; message: string }[] = [];
        if (unit === null)
          errors.push({ path: 'unit', message: 'A money edit needs a money unit' });
        else if (!UNITS_BY_KIND[found.definition.kind].includes(unit))
          errors.push({
            path: 'unit',
            message: `A ${found.definition.kind} field does not take ${unit}`,
          });
        else if (!valueFitsUnit(body.value, unit))
          errors.push({ path: 'value', message: 'The value does not fit the unit' });
        else {
          const problem = valueProblem(run, found.definition, body.value, unit);
          if (problem !== null) errors.push({ path: 'value', message: problem });
        }
        if (errors.length > 0 || unit === null) return invalidCommand(errors, instance);
        decide(
          ctx,
          req.actor,
          run,
          found.row,
          { decision: EDITED, editedValue: body.value, editedUnit: unit },
          body.reason,
          at,
        );
        break;
      }
      case 'acceptClean': {
        // Every undecided clean value, the narrative rows included; a flagged highlights or
        // commentary row is left for the reviewer to reject (AI-4).
        const targets = values.filter((v) => v.validationState === 'clean' && v.decision === null);
        for (const row of targets) {
          row.decision = ACCEPTED;
          row.editedValue = null;
          row.editedUnit = null;
          row.reviewerId = req.actor.userId;
          row.decidedBy = req.actor.displayName;
          row.decidedAt = at;
          row.rowVersion += 1;
        }
        recordActivity(ctx, req.actor, {
          action: 'extraction_run.acceptClean',
          entity: 'extraction_run',
          entityId: run.id,
          reason: null,
          from: null,
          to: null,
          details: { fields: targets.length },
        });
        break;
      }
      case 'approve': {
        const refusal = approve(ctx, book, req, run, schema, values, body.reason, at, instance);
        if (refusal !== null) return refusal;
        break;
      }
    }
    return answerDetail(ctx, req.credential, run, instance);
  },
});
