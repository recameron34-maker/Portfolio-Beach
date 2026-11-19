import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { AdapterSet } from '@pb/adapters';
import type { ExtractionSchemas } from '@pb/ai';
import { CALC_VERSION } from '@pb/calc';
import { SYSTEM_USER_ID, asSystemActor, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import {
  SUGGESTION_BUSY_REFUSAL,
  attempt,
  derivationStep,
  selectSuggestion,
  suggestionBar,
  valuationSuggestionMachine,
} from '@pb/workflows';
import type {
  DerivationStep,
  Selection,
  SuggestionSettings,
  SupersededReason,
} from '@pb/workflows';
import type { Logger } from '../common/logging.js';
import { isUniqueViolationOn, pgErrorCode } from '../common/pg-errors.js';
import { ProblemError, workflowProblem } from '../common/problem.js';
import { ADAPTERS, DEFINITIONS, LOGGER } from '../common/tokens.js';
import type { AuditEntry } from '../db/db.service.js';
import { EXTRACTION_SCHEMAS } from '../documents/settings.js';
import { SUGGESTION_ENTITY, priorSuggestions, suggestion } from './rows.js';
import { SUGGESTIONS_SWITCH, suggestionSchemasOf, suggestionSettingsOf } from './settings.js';
import type { SuggestionSchemas } from './settings.js';
import { gatherSources } from './sources.js';
import type { Gathered, RunBehind } from './sources.js';

/*
 * The derivation of valuation suggestions (docs/04 M10, docs/08 section 12, docs/18 section 14,
 * decision 0023): what an approval does to the suggestion of a position and quarter. It always
 * runs as the system actor, inside the transaction of whatever caused it, so the approval and
 * what follows from it commit together or not at all:
 *
 * - when a capital account statement or a sponsor report run is approved (runApproved), where a
 *   suggestion may be opened;
 * - when the quarterly record is promoted by an accounting import, and when a valuation is
 *   locked or reopened (refreshPosition), where the Open suggestions of the position are derived
 *   again and none is ever created;
 * - inside accept and applyToDraft, before anything is written (refreshOne).
 *
 * Each derivation takes an advisory lock on the position and quarter before it reads, gathers
 * the sources on hand (sources.ts), asks the one pure decision the static preview shares
 * (derivationStep of @pb/workflows) and writes exactly what it says: nothing, a suggestion, the
 * Open one superseded, or both. Every write is audited with the state before and after. With
 * the switch valuation.suggestions off nothing is derived. A log line carries the outcome, the
 * basis and the reason code, never a figure (SEC-11.4).
 */

const run = schema.extractionRun;

/** The partial unique index that keeps one Open suggestion per position and quarter (migration 0023). */
const ONE_OPEN_KEY = 'valuation_suggestion_one_open_idx';
/**
 * How long a derivation waits for another one on the same position and quarter before it gives
 * up and the caller is asked to try again. A wait on a lock, not a business threshold.
 */
const LOCK_WAIT_MS = 5000;
/** SQLSTATE lock_not_available (the wait above ran out) and deadlock_detected. */
const LOCK_NOT_AVAILABLE = '55P03';
const DEADLOCK_DETECTED = '40P01';

/** 409: another approval is working on this position and quarter; nothing of this one was written. */
export const suggestionBusy = (): ProblemError =>
  new ProblemError(409, 'conflict', SUGGESTION_BUSY_REFUSAL);

/** True for the errors two derivations racing for one position and quarter can raise. */
export function isSuggestionRace(error: unknown): boolean {
  const code = pgErrorCode(error);
  return (
    code === LOCK_NOT_AVAILABLE ||
    code === DEADLOCK_DETECTED ||
    isUniqueViolationOn(error, ONE_OPEN_KEY)
  );
}

/** An approved run whose approval may open a suggestion. */
export interface ApprovedRun extends RunBehind {
  investmentId: string | null;
  /** The quarter end its approval accepted. */
  periodEnd: string;
  schemaId: string;
}

/** What a derivation did, for the caller and the log: the step taken and the suggestion written, if one was. */
export interface DerivationResult {
  /** `off` when the switch is off, `not_applicable` for a run that is neither a statement nor a report. */
  action: DerivationStep['action'] | 'off' | 'not_applicable';
  because: string | null;
  /** The suggestion written by this derivation; null when none was. */
  writtenId: string | null;
}

type Audit = (entry: AuditEntry) => Promise<void>;

interface DeriveRequest {
  investmentId: string;
  periodEnd: string;
  mode: 'approval' | 'refresh';
  /** The run whose approval caused the derivation; null for a refresh. */
  trigger: RunBehind | null;
  /** Set when that run is a statement: it is the latest approved statement of the quarter, by definition. */
  statementRunId?: string;
}

@Injectable()
export class SuggestionDerivationService {
  private schemaCache: SuggestionSchemas | null = null;

  constructor(
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(DEFINITIONS) private readonly definitions: unknown,
    @Inject(EXTRACTION_SCHEMAS) private readonly extractionSchemas: ExtractionSchemas,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** The settings of config/definitions.json, read at every use so a missing key is a 500 that names it. */
  settings(): SuggestionSettings {
    return suggestionSettingsOf(this.definitions);
  }

  /** Which extraction schemas are a statement and a report. */
  schemas(): SuggestionSchemas {
    this.schemaCache ??= suggestionSchemasOf(this.extractionSchemas);
    return this.schemaCache;
  }

  /**
   * Whether the switch is on, read inside the transaction given: a derivation runs deep inside
   * another command's transaction, where the flag cache's own connection is not to be waited on.
   */
  async enabled(tx: Tx): Promise<boolean> {
    const found = await tx.execute<{ enabled: boolean }>(
      sql`select enabled from ops.feature_flag where key = ${SUGGESTIONS_SWITCH}`,
    );
    return found.rows[0]?.enabled === true;
  }

  /**
   * A statement or a report run was approved, in this transaction: the suggestion of its
   * position and quarter is derived and may be opened, and the other Open suggestions of the
   * position are derived again (the figures of this quarter are the earlier quarter of a later
   * one). A statement linked to no position is our account in a fund commitment: nothing applies
   * and nothing is written. The run is already approved when this is called.
   */
  async runApproved(tx: Tx, audit: Audit, approved: ApprovedRun): Promise<DerivationResult> {
    const { statements, reports } = this.schemas();
    if (!statements.has(approved.schemaId) && !reports.has(approved.schemaId))
      return { action: 'not_applicable', because: null, writtenId: null };
    if (!(await this.enabled(tx))) return { action: 'off', because: null, writtenId: null };
    if (approved.investmentId === null) {
      this.log({ mode: 'approval', action: 'none', because: 'fund_commitment', selection: null });
      return { action: 'none', because: 'fund_commitment', writtenId: null };
    }
    const result = await this.derive(tx, audit, {
      investmentId: approved.investmentId,
      periodEnd: approved.periodEnd,
      mode: 'approval',
      trigger: approved,
      ...(statements.has(approved.schemaId) ? { statementRunId: approved.id } : {}),
    });
    await this.refreshOthers(tx, audit, approved.investmentId, approved.periodEnd);
    return result;
  }

  /**
   * Something the Open suggestions of a position rest on changed (its quarterly record was
   * promoted, one of its valuations was locked or reopened): each is derived again, in quarter
   * order. None is created.
   */
  async refreshPosition(tx: Tx, audit: Audit, investmentId: string): Promise<void> {
    if (!(await this.enabled(tx))) return;
    await this.refreshOthers(tx, audit, investmentId, null);
  }

  /**
   * The Open suggestion of one position and quarter derived again, before accept or applyToDraft
   * writes anything: `none` when it still says what the sources give, otherwise it was replaced
   * or closed in this transaction. The caller has checked the switch.
   */
  refreshOne(
    tx: Tx,
    audit: Audit,
    investmentId: string,
    periodEnd: string,
  ): Promise<DerivationResult> {
    return this.derive(tx, audit, { investmentId, periodEnd, mode: 'refresh', trigger: null });
  }

  /** Every Open suggestion of the position but the quarter given, derived again in quarter order. */
  private async refreshOthers(
    tx: Tx,
    audit: Audit,
    investmentId: string,
    except: string | null,
  ): Promise<void> {
    // Read as the system actor: whoever caused the refresh may read no suggestion at all.
    const open = await asSystemActor(tx, (stx) =>
      stx
        .select({ periodEnd: suggestion.periodEnd })
        .from(suggestion)
        .where(
          and(
            eq(suggestion.investmentId, investmentId),
            eq(suggestion.state, 'Open'),
            except === null ? undefined : ne(suggestion.periodEnd, except),
          ),
        )
        .orderBy(asc(suggestion.periodEnd)),
    );
    for (const { periodEnd } of open)
      await this.derive(tx, audit, { investmentId, periodEnd, mode: 'refresh', trigger: null });
  }

  /**
   * One derivation, as the system actor: the lock, the sources, the decision and its writes. Two
   * derivations racing for one position and quarter end with one of them refused (409, nothing
   * of it written), never with two Open suggestions.
   */
  private async derive(tx: Tx, audit: Audit, request: DeriveRequest): Promise<DerivationResult> {
    const settings = this.settings();
    const schemas = this.schemas();
    const at = new Date(this.adapters.clock.now());
    try {
      return await asSystemActor(tx, async (stx) => {
        await this.lockQuarter(stx, request.investmentId, request.periodEnd);
        const gathered = await gatherSources(stx, request, settings, schemas);
        const prior = await priorSuggestions(stx, request.investmentId, request.periodEnd);
        const bar = suggestionBar(
          gathered.position,
          request.periodEnd,
          gathered.versions,
          settings.periodEndToleranceDays,
        );
        const selection = bar === null ? selectSuggestion(gathered.sources, settings) : null;
        const step = derivationStep({
          bar,
          selection,
          open: prior.open,
          decided: prior.decided,
          sourceOrder: settings.sourceOrder,
          mode: request.mode,
        });
        let writtenId: string | null = null;
        if (step.action === 'close') {
          await this.supersede(stx, audit, request, step.supersede, null, step.because, at);
        } else if (step.action === 'open') {
          writtenId = await this.write(stx, audit, request, step.selection, gathered, null, null);
        } else if (step.action === 'replace') {
          // The Open suggestion is superseded first (one Open per position and quarter) and names
          // its replacement, whose row is written next; the reference is checked at commit.
          writtenId = randomUUID();
          await this.supersede(stx, audit, request, step.supersede, writtenId, null, at);
          await this.write(
            stx,
            audit,
            request,
            step.selection,
            gathered,
            writtenId,
            prior.open === null ? null : { id: prior.open.id, runId: prior.open.extractionRunId },
          );
        }
        const because = 'because' in step ? step.because : null;
        this.log({
          mode: request.mode,
          action: step.action,
          because,
          selection: 'selection' in step ? step.selection : null,
        });
        return { action: step.action, because, writtenId };
      });
    } catch (error) {
      if (isSuggestionRace(error)) throw suggestionBusy();
      throw error;
    }
  }

  /**
   * The advisory lock of a position and quarter, held to the end of the transaction, taken
   * before anything is read. The wait is bounded for this one statement and the session's own
   * setting is put back, so nothing else in the transaction inherits the bound. A command on a
   * suggestion takes it before it locks the row, in the order every derivation takes the two.
   */
  async lockQuarter(tx: Tx, investmentId: string, periodEnd: string): Promise<void> {
    const before = await tx.execute<{ timeout: string }>(
      sql`select current_setting('lock_timeout') as timeout`,
    );
    const prior = before.rows[0]?.timeout ?? '0';
    await tx.execute(sql`select set_config('lock_timeout', ${`${LOCK_WAIT_MS}ms`}, true)`);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`valuation_suggestion:${investmentId}:${periodEnd}`}))`,
    );
    await tx.execute(sql`select set_config('lock_timeout', ${prior}, true)`);
  }

  /** Open to Superseded, the system actor's row of docs/18 section 14, audited with before and after. */
  private async supersede(
    tx: Tx,
    audit: Audit,
    request: DeriveRequest,
    target: { id: string; reason: SupersededReason },
    replacedBy: string | null,
    because: string | null,
    at: Date,
  ): Promise<void> {
    const result = attempt(valuationSuggestionMachine, 'Open', 'supersede', {
      actorId: SYSTEM_USER_ID,
      actorRoles: ['service'],
      record: { supersededReason: target.reason },
    });
    if (!result.ok) throw workflowProblem(result);
    const [written] = await tx
      .update(suggestion)
      .set({
        state: result.to,
        supersededReason: target.reason,
        supersededById: replacedBy,
        decidedBy: SYSTEM_USER_ID,
        decidedAt: at,
      })
      .where(and(eq(suggestion.id, target.id), eq(suggestion.state, 'Open')))
      .returning();
    // Nothing written: another command decided the suggestion in between.
    if (written === undefined) throw suggestionBusy();
    await audit({
      action: 'valuation_suggestion.supersede',
      entity: SUGGESTION_ENTITY,
      entityId: written.id,
      details: {
        investmentId: written.investmentId,
        periodEnd: written.periodEnd,
        basis: written.basis,
        suggestedValue: written.suggestedValue,
        reasonCode: written.reasonCode,
        state: { before: 'Open', after: written.state },
        supersededReason: { before: null, after: written.supersededReason },
        supersededById: { before: null, after: written.supersededById },
        mode: request.mode,
        because,
        by: 'system',
      },
    });
  }

  /**
   * A suggestion written Open, with what it rests on. The run it names is the one its value was
   * read by: the statement's run for a statement-based suggestion, the run the quarter on record
   * names for a report-based one; when the record names none, the run whose approval caused the
   * derivation, and for a refresh the run of the suggestion it replaces. The page and the
   * locator are those of the first input read from that run's document, null when none was.
   */
  private async write(
    tx: Tx,
    audit: Audit,
    request: DeriveRequest,
    selection: Selection,
    gathered: Gathered,
    id: string | null,
    replaces: { id: string; runId: string } | null,
  ): Promise<string> {
    const behind = await this.runBehind(tx, selection, gathered, request.trigger, replaces);
    const cited = selection.inputs.find(
      (input) => input.source.kind === 'document' && input.source.id === behind.documentId,
    );
    const reviewers = [
      ...new Set(selection.inputs.flatMap((input) => gathered.reviewersByKey.get(input.key) ?? [])),
    ].sort();
    const [written] = await tx
      .insert(suggestion)
      .values({
        ...(id === null ? {} : { id }),
        investmentId: request.investmentId,
        periodEnd: request.periodEnd,
        basis: selection.basis,
        method: selection.method,
        suggestedValue: selection.value,
        reasonCode: selection.reason,
        workings: { inputs: selection.inputs },
        sourceDocumentId: behind.documentId,
        extractionRunId: behind.id,
        sourcePage: cited?.source.page ?? null,
        sourceLocator: cited === undefined ? null : `field:${cited.key}`,
        sourceReviewerIds: reviewers,
        promptVersion: behind.promptVersion,
        modelId: behind.modelId,
        calcVersion: CALC_VERSION,
      })
      .returning();
    if (written === undefined)
      throw new ProblemError(
        500,
        'internal',
        'valuation_suggestion: the suggestion was not written',
      );
    await audit({
      action: 'valuation_suggestion.open',
      entity: SUGGESTION_ENTITY,
      entityId: written.id,
      details: {
        investmentId: written.investmentId,
        periodEnd: written.periodEnd,
        basis: written.basis,
        method: written.method,
        suggestedValue: written.suggestedValue,
        reasonCode: written.reasonCode,
        sourceDocumentId: written.sourceDocumentId,
        extractionRunId: written.extractionRunId,
        sourcePage: written.sourcePage,
        sourceReviewerIds: written.sourceReviewerIds,
        state: { before: null, after: written.state },
        replaces: replaces?.id ?? null,
        mode: request.mode,
        by: 'system',
      },
    });
    return written.id;
  }

  /** The approved run a suggestion names (see write). */
  private async runBehind(
    tx: Tx,
    selection: Selection,
    gathered: Gathered,
    trigger: RunBehind | null,
    replaces: { id: string; runId: string } | null,
  ): Promise<RunBehind> {
    const own =
      selection.basis === 'capital_account_balance' ? gathered.statementRun : gathered.reportRun;
    if (own !== null) return own;
    if (trigger !== null) return trigger;
    if (replaces !== null) {
      const [kept] = await tx
        .select({
          id: run.id,
          documentId: run.documentId,
          approvedBy: run.approvedBy,
          promptVersion: run.promptVersion,
          modelId: run.modelId,
        })
        .from(run)
        .where(eq(run.id, replaces.runId));
      if (kept !== undefined && kept.approvedBy !== null)
        return { ...kept, approvedBy: kept.approvedBy };
    }
    throw new ProblemError(
      500,
      'internal',
      'valuation_suggestion: no approved run stands behind the suggestion',
    );
  }

  private log(entry: {
    mode: string;
    action: string;
    because: string | null;
    selection: Selection | null;
  }): void {
    this.logger.info(
      {
        mode: entry.mode,
        outcome: entry.action,
        because: entry.because,
        basis: entry.selection?.basis ?? null,
        reason_code: entry.selection?.reason ?? null,
      },
      'valuation suggestion derived',
    );
  }
}
