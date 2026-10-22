import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { AdapterSet, Principal } from '@pb/adapters';
import {
  AiError,
  EXTRACTION_RULES,
  boundsFrom,
  buildInput,
  extractionSettingsFrom,
  outputSchemaFor,
  promptRef,
  redactPages,
  validateExtraction,
} from '@pb/ai';
import type {
  ExtractionOutput,
  ExtractionSchema,
  ExtractionSchemas,
  ExtractionValidation,
  HighlightStyle,
  ValidationFinding,
} from '@pb/ai';
import { extractionRunState } from '@pb/contracts';
import type { ExtractionDefinitions, ExtractionFinding } from '@pb/contracts';
import { SYSTEM_USER_ID, asSystemActor, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import type { PdfDocument } from '@pb/pdf';
import { attempt, extractionRunMachine } from '@pb/workflows';
import type { ExtractionCommand, ExtractionState } from '@pb/workflows';
import { ZodError } from 'zod';
import type { Logger } from '../common/logging.js';
import { ProblemError, workflowProblem } from '../common/problem.js';
import { ADAPTERS, DEFINITIONS, LOGGER } from '../common/tokens.js';
import { DbService } from '../db/db.service.js';
import type { AuditEntry } from '../db/db.service.js';
import { DocumentMissingError, isPdfError, readStoredDocument } from '../documents/read.js';
import {
  EXTRACTION_SCHEMAS,
  documentSettingsOf,
  extractionSettingsOf,
} from '../documents/settings.js';
import { FlagsService } from '../flags/flags.service.js';
import { job, run, value } from './rows.js';
import {
  COMMENTARY_FIELD,
  EXCEPTION_SOURCE,
  EXTRACTION_SWITCH,
  HIGHLIGHTS_FIELD,
  HIGHLIGHT_STYLE,
  RUN_EXCEPTION_RULE,
  costOf,
} from './settings.js';

/*
 * The run processor (docs/04 M4, docs/18 section 7, decision 0012). A batch's runs are driven
 * inline, `batchConcurrency` at a time through a small promise pool; Temporal is the production
 * slot for this loop, and each step is its own short transaction so a worker could pick the run
 * up where a step left it. Every state change goes through extractionRunMachine as the system
 * actor, inside the caller's transaction so the caller's audit event records it:
 *
 * - start (Queued > Running, or retry from NeedsRetry) stamps started_at and reads the day's
 *   token use; then, outside any transaction, the document is read from the store with @pb/pdf,
 *   every page is redacted, the input is built with the shared frame, and the model is called with
 *   the schema's output shape (SEC-8.3, SEC-8.4, SEC-8.7). The call is logged by its ids, tokens,
 *   latency and redaction counts, never its content (SEC-8.9).
 * - A schema failure (the output did not parse, or @pb/ai refused the input) and a transient
 *   failure (anything else the client threw) each schedule a retry while their budget allows
 *   (config, with the machine's own ceiling), then fail.
 * - Token budgets: a run whose tokens exceed runTokenBudget fails with 'run_budget'; when the runs
 *   started on the same calendar day (by the clock) already exceed dayTokenBudget, the run fails
 *   with 'day_budget' before any model call.
 * - Success validates the output deterministically and stages one stg.extracted_value row per
 *   schema field plus the highlights and the commentary rows, each with its validation state and
 *   findings; nothing reaches the record until a reviewer approves (SEC-9.1).
 * - The switch is read before every attempt: turned off mid-batch, the next run fails with
 *   'kill_switch' before the store or the model is touched (SEC-8.10).
 * - An error no step expected fails the run with 'unexpected' in a fresh transaction, so no run
 *   is left Running (docs/18 section 7).
 * - A failed run opens a data exception (EXT-RUN-01) and marks the batch failed. Logs name an
 *   error by its name and a bounded code, never its message (SEC-8.9).
 */

const machine = extractionRunMachine;
const SYSTEM = { actorId: SYSTEM_USER_ID, actorRoles: ['service'] } as const;
const ENTITY = 'doc.extraction_run';
const EXCEPTION_SEVERITY = 'exception_severity.high';
/** The longest quote the stg.extracted_value column holds (migration 0011). */
const QUOTE_COLUMN_CHARS = 150;
const d = schema.document;

/** The run as the processor holds it between its steps. */
interface RunContext {
  id: string;
  documentId: string;
  fileName: string;
  sourceItemId: string;
  contentHash: string;
  investmentId: string | null;
  investmentNumber: string | null;
  companyName: string | null;
  periodEnd: string | null;
  batchId: string | null;
  schema: ExtractionSchema;
  schemaRetries: number;
  transientRetries: number;
  /** Tokens used by the other runs started on the same calendar day, read when this run started. */
  dayTokens: number;
}

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
  /** Failed outright: an unreadable document, the switch off, or an error no step expected. */
  | { kind: 'failed'; errorCode: string };

type Audit = (entry: AuditEntry) => Promise<void>;

/** What a log line may say about an error: its name and a bounded code, never its message (SEC-8.9). */
function errorSummary(error: unknown): { name: string; code: string | null } {
  if (!(error instanceof Error)) return { name: typeof error, code: null };
  const code = (error as { code?: unknown }).code;
  return { name: error.name, code: typeof code === 'string' ? code : null };
}

/** The problem a caller gets while the switch is off (SEC-8.10). */
export const extractionOff = (): ProblemError =>
  new ProblemError(409, 'kill-switch', `AI extraction is switched off (${EXTRACTION_SWITCH})`);

/** Runs `fn` over the items, at most `concurrency` at a time, in order of start; every item runs even when another throws. */
export async function promisePool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      for (;;) {
        const i = next;
        next += 1;
        const item = items[i];
        if (item === undefined) return;
        await fn(item);
      }
    },
  );
  await Promise.all(workers);
}

/** The findings as the contract stores them, each with the severity its rule carries. */
export function toFindings(findings: readonly ValidationFinding[]): ExtractionFinding[] {
  return findings.map((f) => ({
    ruleId: f.ruleId,
    severity: EXTRACTION_RULES[f.ruleId].severity,
    message: f.message,
  }));
}

function stateOf(findings: readonly ExtractionFinding[]): 'clean' | 'flagged' | 'invalid' {
  if (findings.some((f) => f.severity === 'invalid')) return 'invalid';
  return findings.length === 0 ? 'clean' : 'flagged';
}

/** The quote as the column holds it: the first 150 characters (the finding records the real length). */
function clipQuote(quote: string | null): string | null {
  return quote === null ? null : Array.from(quote).slice(0, QUOTE_COLUMN_CHARS).join('');
}

@Injectable()
export class ExtractionRunner {
  constructor(
    private readonly db: DbService,
    private readonly flags: FlagsService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(DEFINITIONS) private readonly definitions: unknown,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(EXTRACTION_SCHEMAS) private readonly schemas: ExtractionSchemas,
    @Inject(HIGHLIGHT_STYLE) private readonly style: HighlightStyle,
  ) {}

  /** Refuses while the kill switch is off. */
  async assertSwitchOn(): Promise<void> {
    if (!(await this.flags.isEnabled(EXTRACTION_SWITCH))) throw extractionOff();
  }

  /**
   * Drives a batch: the job goes queued > running > succeeded or failed (failed when any run
   * failed, progress reaching 100 either way), the runs `concurrency` at a time. An error no run
   * step expected is logged, counted as a failure and rethrown once every run has been driven.
   */
  async processBatch(
    principal: Principal,
    requestId: string,
    jobId: string,
    runIds: readonly string[],
    concurrency: number,
  ): Promise<void> {
    await this.assertSwitchOn();
    await this.updateJob(principal, requestId, jobId, {
      state: 'running',
      startedAt: new Date(this.adapters.clock.now()),
    });
    let done = 0;
    let failed = 0;
    const unexpected: Error[] = [];
    await promisePool(runIds, concurrency, async (runId) => {
      try {
        if ((await this.processOne(principal, requestId, runId)) === 'Failed') failed += 1;
      } catch (error) {
        failed += 1;
        unexpected.push(error instanceof Error ? error : new Error(String(error)));
        this.logger.error(
          { run_id: runId, batch_id: jobId, err: errorSummary(error) },
          'extraction run could not be settled',
        );
      }
      done += 1;
      await this.updateJob(principal, requestId, jobId, {
        progress: Math.round((done / runIds.length) * 100),
      });
    });
    await this.updateJob(principal, requestId, jobId, {
      state: failed > 0 ? 'failed' : 'succeeded',
      progress: 100,
      finishedAt: new Date(this.adapters.clock.now()),
      errorCode: failed > 0 ? 'runs_failed' : null,
    });
    const first = unexpected[0];
    if (first !== undefined) throw first;
  }

  private updateJob(
    principal: Principal,
    requestId: string,
    jobId: string,
    set: Partial<{
      state: string;
      progress: number;
      startedAt: Date;
      finishedAt: Date;
      errorCode: string | null;
    }>,
  ): Promise<void> {
    return this.db.run(principal, requestId, (tx) =>
      asSystemActor(tx, async (stx) => {
        await stx.update(job).set(set).where(eq(job.id, jobId));
      }),
    );
  }

  /**
   * Drives one run to a terminal state: start, attempt, settle, and again from NeedsRetry while
   * the budget allows. Nothing between start and a terminal state may leave the run Running
   * (docs/18 section 7, WF-2): an error no step expected (a store, reader or validator throw, a
   * failed staging write) fails the run in a fresh transaction with its data exception, and only
   * a failure of that write itself reaches the caller.
   */
  async processOne(
    principal: Principal,
    requestId: string,
    runId: string,
  ): Promise<'Succeeded' | 'Failed'> {
    for (;;) {
      const ctx = await this.start(principal, requestId, runId);
      let next: ExtractionState;
      try {
        const outcome = await this.attempt(ctx);
        next = await this.settle(principal, requestId, ctx, outcome);
      } catch (error) {
        this.logger.error(
          { run_id: ctx.id, document_id: ctx.documentId, err: errorSummary(error) },
          'extraction run step failed unexpectedly',
        );
        next = await this.settle(principal, requestId, ctx, {
          kind: 'failed',
          errorCode: 'unexpected',
        });
      }
      if (next === 'Succeeded' || next === 'Failed') return next;
    }
  }

  /** Queued > Running (start) or NeedsRetry > Running (retry), with started_at and the day's token use. */
  private start(principal: Principal, requestId: string, runId: string): Promise<RunContext> {
    const today = this.adapters.clock.today();
    const now = new Date(this.adapters.clock.now());
    return this.db.run(principal, requestId, async (tx, audit) => {
      const ctx = await asSystemActor(tx, async (stx) => {
        // The run row is locked on its own (a locking clause cannot name a joined table), then
        // read with the names its ids carry.
        await stx.select({ id: run.id }).from(run).where(eq(run.id, runId)).for('update');
        const row = (
          await stx
            .select({
              id: run.id,
              documentId: run.documentId,
              fileName: d.fileName,
              sourceItemId: d.sourceItemId,
              contentHash: d.contentHash,
              investmentId: run.investmentId,
              investmentNumber: schema.investment.investmentNumber,
              companyName: schema.portfolioCompany.name,
              periodEnd: run.periodEnd,
              batchId: run.batchId,
              schemaId: run.schemaId,
              state: run.state,
              schemaRetries: run.schemaRetries,
              transientRetries: run.transientRetries,
            })
            .from(run)
            .innerJoin(d, eq(d.id, run.documentId))
            .leftJoin(schema.investment, eq(schema.investment.id, run.investmentId))
            .leftJoin(
              schema.portfolioCompany,
              eq(schema.portfolioCompany.id, schema.investment.portfolioCompanyId),
            )
            .where(eq(run.id, runId))
        )[0];
        if (row === undefined) throw new ProblemError(404, 'not-found', 'Extraction run not found');
        const extractionSchema = this.schemas[row.schemaId];
        if (extractionSchema === undefined)
          throw new ProblemError(
            500,
            'configuration',
            `config/extraction_schema.json no longer holds the schema ${row.schemaId}`,
          );
        const from = extractionRunState.parse(row.state);
        const command: ExtractionCommand = from === 'NeedsRetry' ? 'retry' : 'start';
        const result = attempt(machine, from, command, { ...SYSTEM, record: {} });
        if (!result.ok) throw workflowProblem(result);
        // The day's use: the tokens the other runs started today recorded, plus a whole run
        // budget for each one still running (its tokens are not known yet), so N concurrent runs
        // cannot overshoot the day budget together by (N - 1) runs.
        const used = (
          await stx
            .select({
              tokens: sql<number>`coalesce(sum(${run.tokensIn} + ${run.tokensOut}), 0)::int`,
              running: sql<number>`count(*) filter (where ${run.state} = 'Running')::int`,
            })
            .from(run)
            .where(
              and(
                sql`(${run.startedAt} at time zone 'UTC')::date = ${today}::date`,
                ne(run.id, runId),
              ),
            )
        )[0];
        const dayTokens =
          (used?.tokens ?? 0) +
          (used?.running ?? 0) * extractionSettingsOf(this.definitions).runTokenBudget;
        await stx.update(run).set({ state: result.to, startedAt: now }).where(eq(run.id, runId));
        await audit({
          action: `extraction_run.${command}`,
          entity: ENTITY,
          entityId: runId,
          details: {
            documentId: row.documentId,
            fileName: row.fileName,
            batchId: row.batchId,
            state: { before: from, after: result.to },
          },
        });
        return {
          id: row.id,
          documentId: row.documentId,
          fileName: row.fileName,
          sourceItemId: row.sourceItemId,
          contentHash: row.contentHash,
          investmentId: row.investmentId,
          investmentNumber: row.investmentNumber,
          companyName: row.companyName,
          periodEnd: row.periodEnd,
          batchId: row.batchId,
          schema: extractionSchema,
          schemaRetries: row.schemaRetries,
          transientRetries: row.transientRetries,
          dayTokens,
        };
      });
      return ctx;
    });
  }

  /**
   * One attempt, outside any transaction: the budgets, the store, the reader, the redaction, the
   * model call and the validation. Nothing here writes; the outcome is settled afterwards.
   */
  private async attempt(ctx: RunContext): Promise<Outcome> {
    // The switch is read per run, not once per batch, so turning it off stops the next run
    // before the store or the model is touched (SEC-8.10, AI-6).
    if (!(await this.flags.isEnabled(EXTRACTION_SWITCH)))
      return { kind: 'failed', errorCode: 'kill_switch' };
    const settings = extractionSettingsOf(this.definitions);
    if (ctx.dayTokens > settings.dayTokenBudget)
      return {
        kind: 'budget',
        errorCode: 'day_budget',
        tokensIn: null,
        tokensOut: null,
        modelId: null,
      };
    let doc: PdfDocument;
    try {
      doc = await readStoredDocument(
        this.adapters.documents,
        documentSettingsOf(this.definitions),
        ctx.sourceItemId,
      );
    } catch (error) {
      if (error instanceof DocumentMissingError) {
        this.warn(ctx, error.cause, 'store read failed');
        return { kind: 'error', errorKind: 'transient', errorCode: 'store_read' };
      }
      if (!isPdfError(error)) throw error;
      this.warn(ctx, error, 'document is unreadable');
      return { kind: 'failed', errorCode: `unreadable_${error.code}` };
    }
    const { pages: pageTexts, counts: redactions } = redactPages(doc.pages.map((p) => p.text));
    const ref = promptRef(ctx.schema.promptId);
    let output: ExtractionOutput;
    let tokensIn: number;
    let tokensOut: number;
    let modelId: string;
    try {
      const input = buildInput({
        metadata: {
          file_name: ctx.fileName,
          content_hash: ctx.contentHash,
          page_count: doc.pageCount,
          ...(ctx.investmentNumber === null ? {} : { investment_number: ctx.investmentNumber }),
          ...(ctx.companyName === null ? {} : { company_name: ctx.companyName }),
        },
        pages: pageTexts,
      });
      const res = await this.adapters.ai.complete(
        { promptId: ref.promptId, promptVersion: ref.promptVersion, input },
        outputSchemaFor(ctx.schema, { maxPage: documentSettingsOf(this.definitions).maxPages }),
      );
      this.logger.info(
        {
          prompt_id: ref.promptId,
          prompt_version: ref.promptVersion,
          model_id: res.modelId,
          tokens_in: res.tokensIn,
          tokens_out: res.tokensOut,
          latency_ms: res.latencyMs,
          document_id: ctx.documentId,
          run_id: ctx.id,
          redactions,
        },
        'extraction call',
      );
      output = res.output;
      tokensIn = res.tokensIn;
      tokensOut = res.tokensOut;
      modelId = res.modelId;
    } catch (error) {
      this.warn(ctx, error, 'extraction call failed');
      // The output did not parse, or the input was refused: the model's answer is the problem
      // (schema). Anything else the client threw is the call's problem (transient).
      if (error instanceof ZodError || (error instanceof Error && error.name === 'ZodError'))
        return { kind: 'error', errorKind: 'schema', errorCode: 'schema_invalid' };
      if (error instanceof AiError)
        return { kind: 'error', errorKind: 'schema', errorCode: `ai_${error.code}` };
      return { kind: 'error', errorKind: 'transient', errorCode: 'call_failed' };
    }
    if (tokensIn + tokensOut > settings.runTokenBudget)
      return { kind: 'budget', errorCode: 'run_budget', tokensIn, tokensOut, modelId };
    const validation = validateExtraction(output, {
      schema: ctx.schema,
      pageTexts,
      bounds: boundsFrom(this.definitions),
      style: this.style,
      ...extractionSettingsFrom(this.definitions),
      ...(ctx.periodEnd === null ? {} : { expectedPeriodEnd: ctx.periodEnd }),
    });
    return { kind: 'succeeded', output, validation, tokensIn, tokensOut, modelId };
  }

  private warn(ctx: RunContext, error: unknown, message: string): void {
    this.logger.warn(
      { run_id: ctx.id, document_id: ctx.documentId, err: errorSummary(error) },
      message,
    );
  }

  /** Writes the outcome as the system actor: succeed, scheduleRetry within the budget, or fail with a data exception. */
  private settle(
    principal: Principal,
    requestId: string,
    ctx: RunContext,
    outcome: Outcome,
  ): Promise<ExtractionState> {
    const settings = extractionSettingsOf(this.definitions);
    const now = new Date(this.adapters.clock.now());
    return this.db.run(principal, requestId, (tx, audit) =>
      asSystemActor(tx, async (stx) => {
        if (outcome.kind === 'succeeded')
          return this.succeed(stx, audit, ctx, outcome, settings, now);
        if (outcome.kind === 'error') {
          const retries = outcome.errorKind === 'schema' ? ctx.schemaRetries : ctx.transientRetries;
          const budget =
            outcome.errorKind === 'schema' ? settings.schemaRetries : settings.transientRetries;
          const scheduled =
            retries < budget
              ? attempt(machine, 'Running', 'scheduleRetry', {
                  ...SYSTEM,
                  record: {
                    lastErrorKind: outcome.errorKind,
                    schemaRetries: ctx.schemaRetries,
                    transientRetries: ctx.transientRetries,
                  },
                })
              : null;
          if (scheduled?.ok === true) {
            const counters =
              outcome.errorKind === 'schema'
                ? { schemaRetries: ctx.schemaRetries + 1 }
                : { transientRetries: ctx.transientRetries + 1 };
            await stx
              .update(run)
              .set({
                state: scheduled.to,
                errorKind: outcome.errorKind,
                errorCode: outcome.errorCode,
                ...counters,
              })
              .where(eq(run.id, ctx.id));
            await audit({
              action: 'extraction_run.scheduleRetry',
              entity: ENTITY,
              entityId: ctx.id,
              details: {
                documentId: ctx.documentId,
                fileName: ctx.fileName,
                state: { before: 'Running', after: scheduled.to },
                errorKind: outcome.errorKind,
                errorCode: outcome.errorCode,
                ...counters,
              },
            });
            return scheduled.to;
          }
          return this.fail(stx, audit, ctx, {
            errorKind: outcome.errorKind,
            errorCode: outcome.errorCode,
            tokensIn: null,
            tokensOut: null,
            modelId: null,
            now,
            settings,
          });
        }
        return this.fail(stx, audit, ctx, {
          errorKind: null,
          errorCode: outcome.errorCode,
          tokensIn: outcome.kind === 'budget' ? outcome.tokensIn : null,
          tokensOut: outcome.kind === 'budget' ? outcome.tokensOut : null,
          modelId: outcome.kind === 'budget' ? outcome.modelId : null,
          now,
          settings,
        });
      }),
    );
  }

  /** Running > Succeeded: the values staged with their validation, the run stamped with tokens, cost and model. */
  private async succeed(
    stx: Tx,
    audit: Audit,
    ctx: RunContext,
    outcome: Extract<Outcome, { kind: 'succeeded' }>,
    settings: ExtractionDefinitions,
    now: Date,
  ): Promise<ExtractionState> {
    const result = attempt(machine, 'Running', 'succeed', { ...SYSTEM, record: {} });
    if (!result.ok) throw workflowProblem(result);
    const { output, validation } = outcome;
    const rows = ctx.schema.fields.map((field) => {
      const f = output.fields[field.key];
      const findings = toFindings(validation.fields[field.key]?.findings ?? []);
      return {
        runId: ctx.id,
        investmentId: ctx.investmentId,
        field: field.key,
        value: f?.value ?? null,
        unit: f?.unit ?? null,
        page: f?.page ?? null,
        quote: clipQuote(f?.quote ?? null),
        confidence: f?.confidence ?? null,
        validationState: validation.fields[field.key]?.validationState ?? stateOf(findings),
        findings,
      };
    });
    const highlightFindings = toFindings(validation.highlights);
    const commentaryFindings = toFindings(validation.commentary);
    rows.push(
      {
        runId: ctx.id,
        investmentId: ctx.investmentId,
        field: HIGHLIGHTS_FIELD,
        value: JSON.stringify(output.highlights),
        unit: null,
        page: null,
        quote: null,
        confidence: null,
        validationState: stateOf(highlightFindings),
        findings: highlightFindings,
      },
      {
        runId: ctx.id,
        investmentId: ctx.investmentId,
        field: COMMENTARY_FIELD,
        value: output.commentary,
        unit: null,
        page: null,
        quote: null,
        confidence: null,
        validationState: stateOf(commentaryFindings),
        findings: commentaryFindings,
      },
    );
    await stx.insert(value).values(rows);
    const costUsd = costOf(outcome.tokensIn, outcome.tokensOut, settings);
    await stx
      .update(run)
      .set({
        state: result.to,
        tokensIn: outcome.tokensIn,
        tokensOut: outcome.tokensOut,
        costUsd,
        modelId: outcome.modelId,
        finishedAt: now,
        errorKind: null,
        errorCode: null,
      })
      .where(eq(run.id, ctx.id));
    const states = rows.map((r) => r.validationState);
    await audit({
      action: 'extraction_run.succeed',
      entity: ENTITY,
      entityId: ctx.id,
      details: {
        documentId: ctx.documentId,
        fileName: ctx.fileName,
        state: { before: 'Running', after: result.to },
        tokensIn: outcome.tokensIn,
        tokensOut: outcome.tokensOut,
        costUsd,
        modelId: outcome.modelId,
        overall: validation.overall,
        values: {
          total: rows.length,
          clean: states.filter((s) => s === 'clean').length,
          flagged: states.filter((s) => s === 'flagged').length,
          invalid: states.filter((s) => s === 'invalid').length,
        },
      },
    });
    return result.to;
  }

  /** Running > Failed: the run stamped with what it used and why it failed, and a data exception opened (EXT-RUN-01). */
  private async fail(
    stx: Tx,
    audit: Audit,
    ctx: RunContext,
    failure: {
      errorKind: 'schema' | 'transient' | null;
      errorCode: string;
      tokensIn: number | null;
      tokensOut: number | null;
      modelId: string | null;
      now: Date;
      settings: ExtractionDefinitions;
    },
  ): Promise<ExtractionState> {
    const result = attempt(machine, 'Running', 'fail', { ...SYSTEM, record: {} });
    if (!result.ok) throw workflowProblem(result);
    const costUsd =
      failure.tokensIn === null || failure.tokensOut === null
        ? null
        : costOf(failure.tokensIn, failure.tokensOut, failure.settings);
    await stx
      .update(run)
      .set({
        state: result.to,
        errorKind: failure.errorKind,
        errorCode: failure.errorCode,
        tokensIn: failure.tokensIn,
        tokensOut: failure.tokensOut,
        costUsd,
        modelId: failure.modelId,
        finishedAt: failure.now,
      })
      .where(eq(run.id, ctx.id));
    const exception = (
      await stx
        .insert(schema.dataException)
        .values({
          source: EXCEPTION_SOURCE,
          entity: ENTITY,
          entityId: ctx.id,
          ruleId: RUN_EXCEPTION_RULE,
          expected: 'an extraction run that completes within its budgets',
          actual: `the run failed (${failure.errorCode})`,
          severity: EXCEPTION_SEVERITY,
          state: 'open',
          candidates: [],
        })
        .returning()
    )[0];
    await audit({
      action: 'extraction_run.fail',
      entity: ENTITY,
      entityId: ctx.id,
      details: {
        documentId: ctx.documentId,
        fileName: ctx.fileName,
        state: { before: 'Running', after: result.to },
        errorKind: failure.errorKind,
        errorCode: failure.errorCode,
        tokensIn: failure.tokensIn,
        tokensOut: failure.tokensOut,
        costUsd,
        exceptionId: exception?.id ?? null,
      },
    });
    return result.to;
  }
}
