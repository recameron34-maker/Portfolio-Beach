import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Principal } from '@pb/adapters';
import { isQuarterEnd } from '@pb/calc';
import type {
  SuggestionRunOutcome,
  ValuationSuggestionListQuery,
  ValuationSuggestionPage,
  ValuationSuggestionRow,
} from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { derivationStep, selectSuggestion, suggestionBar } from '@pb/workflows';
import type { SuggestionSettings } from '@pb/workflows';
import { AT_ID_CURSOR, decodeAtIdCursor, encodeCursor } from '../common/cursor.js';
import { ProblemError } from '../common/problem.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import { SuggestionDerivationService } from './derivation.service.js';
import {
  SUGGESTION_ENTITY,
  SUGGESTION_NOT_FOUND,
  gatherFor,
  inputFileNames,
  loadSuggestion,
  pageSuggestions,
  priorSuggestions,
  suggestion,
  toSuggestionRow,
} from './rows.js';
import type { LoadedSuggestion } from './rows.js';
import { PERIOD_END_KEY } from './settings.js';
import type { SuggestionSchemas } from './settings.js';
import { gatherSources } from './sources.js';

/*
 * Reading valuation suggestions (docs/04 M10, docs/18 section 14, decision 0023). The deal
 * team, operations, approvers and auditors read them; row-level security gives a viewer,
 * investor relations and a platform admin nothing, and hides a suggestion behind the wall of its
 * position, so one the caller cannot see is 404. A suggestion's stored columns are the figures
 * of the approval that produced it; the mark on record, the comparison, the checks, the other
 * sources and the badges are worked out at each read from the record as it then stands, under
 * the caller's own access. Opening one suggestion is audited (SEC-11.1).
 */

const run = schema.extractionRun;

@Injectable()
export class SuggestionsService {
  constructor(
    private readonly db: DbService,
    private readonly derivation: SuggestionDerivationService,
  ) {}

  /**
   * The list, newest first on (createdAt, id): Open unless a state is given, filtered by
   * position, quarter and the run that produced the suggestion. `openCount` counts every Open
   * suggestion the caller can see. With a run id, the answer also says what that approved run
   * did to the suggestions of its position and quarter.
   */
  async list(
    principal: Principal,
    requestId: string,
    opts: ValuationSuggestionListQuery,
  ): Promise<ValuationSuggestionPage> {
    const settings = this.derivation.settings();
    const schemas = this.derivation.schemas();
    return this.db.run(principal, requestId, async (tx) => {
      const conditions: (SQL | undefined)[] = [];
      if (opts.state !== 'all') conditions.push(eq(suggestion.state, opts.state));
      if (opts.investmentId !== undefined)
        conditions.push(eq(suggestion.investmentId, opts.investmentId));
      if (opts.periodEnd !== undefined) conditions.push(eq(suggestion.periodEnd, opts.periodEnd));
      if (opts.extractionRunId !== undefined)
        conditions.push(eq(suggestion.extractionRunId, opts.extractionRunId));
      if (opts.cursor !== undefined) {
        const key = decodeAtIdCursor(opts.cursor, AT_ID_CURSOR);
        const at = sql`${key.at}::timestamptz`;
        conditions.push(
          or(
            lt(suggestion.createdAt, at),
            and(eq(suggestion.createdAt, at), lt(suggestion.id, sql`${key.id}::uuid`)),
          ),
        );
      }
      const rows = await pageSuggestions(tx, conditions, opts.limit + 1);
      const page = rows.slice(0, opts.limit);
      const items = await this.toRows(tx, page, settings, schemas);
      const [open] = await tx
        .select({ n: count() })
        .from(suggestion)
        .where(eq(suggestion.state, 'Open'));
      const last = page[page.length - 1];
      return {
        items,
        nextCursor:
          rows.length > opts.limit && last !== undefined
            ? encodeCursor([last.exactAt, last.id])
            : null,
        openCount: Number(open?.n ?? 0),
        runOutcome:
          opts.extractionRunId === undefined
            ? null
            : await this.runOutcome(tx, opts.extractionRunId, settings, schemas),
      };
    });
  }

  /** One suggestion with everything derived when read; 404 for one the caller cannot see. Audited. */
  async detail(
    principal: Principal,
    requestId: string,
    id: string,
  ): Promise<ValuationSuggestionRow> {
    requireUuid(id, SUGGESTION_NOT_FOUND);
    const settings = this.derivation.settings();
    const schemas = this.derivation.schemas();
    return this.db.run(principal, requestId, async (tx, audit) => {
      const row = await this.rowById(tx, id, settings, schemas);
      if (row === null) throw new ProblemError(404, 'not-found', SUGGESTION_NOT_FOUND);
      await audit({ action: 'valuation_suggestion.read', entity: SUGGESTION_ENTITY, entityId: id });
      return row;
    });
  }

  /** One suggestion as a row, under the transaction's own row-level security; null when it is not there. */
  async rowById(
    tx: Tx,
    id: string,
    settings: SuggestionSettings = this.derivation.settings(),
    schemas: SuggestionSchemas = this.derivation.schemas(),
  ): Promise<ValuationSuggestionRow | null> {
    const loaded = await loadSuggestion(tx, id);
    if (loaded === null) return null;
    const [row] = await this.toRows(tx, [loaded], settings, schemas);
    return row ?? null;
  }

  /** The rows of a page: the sources of each position and quarter are gathered once. */
  private async toRows(
    tx: Tx,
    page: readonly LoadedSuggestion[],
    settings: SuggestionSettings,
    schemas: SuggestionSchemas,
  ): Promise<ValuationSuggestionRow[]> {
    const fileNames = await inputFileNames(tx, page);
    const gathered = new Map<string, ReturnType<typeof gatherFor>>();
    const out: ValuationSuggestionRow[] = [];
    for (const row of page) {
      // A statement-based suggestion is read with its own statement, so it is keyed by its run too.
      const key = `${row.investmentId}|${row.periodEnd}|${row.basis === 'capital_account_balance' ? row.extractionRunId : ''}`;
      let sources = gathered.get(key);
      if (sources === undefined) {
        sources = gatherFor(tx, row, settings, schemas);
        gathered.set(key, sources);
      }
      out.push(toSuggestionRow(row, await sources, settings, fileNames));
    }
    return out;
  }

  /**
   * What an approved statement or report run did to the suggestions of its position and
   * quarter, as it stands now: null for a run the caller cannot see, one not approved, or one
   * that is neither a statement nor a report. A run that produced a suggestion `opened` it, or
   * `replaced` the one that was open. With none of its own, the decision a derivation would
   * take now says why (derivationStep, the one rule the derivation itself asks), read under the
   * caller's own access and writing nothing: the open suggestion is `unchanged`, or there is
   * `none` and the rule that applies is named.
   */
  private async runOutcome(
    tx: Tx,
    runId: string,
    settings: SuggestionSettings,
    schemas: SuggestionSchemas,
  ): Promise<SuggestionRunOutcome | null> {
    const [found] = await tx
      .select({
        id: run.id,
        investmentId: run.investmentId,
        periodEnd: run.periodEnd,
        schemaId: run.schemaId,
        approvedBy: run.approvedBy,
      })
      .from(run)
      .where(eq(run.id, runId));
    if (found === undefined || found.approvedBy === null) return null;
    if (!schemas.statements.has(found.schemaId) && !schemas.reports.has(found.schemaId))
      return null;

    const produced = await tx
      .select({ id: suggestion.id })
      .from(suggestion)
      .where(eq(suggestion.extractionRunId, runId))
      .orderBy(asc(suggestion.createdAt), asc(suggestion.id));
    const first = produced[0];
    const newest = produced[produced.length - 1];
    if (first !== undefined && newest !== undefined) {
      const [replaced] = await tx
        .select({ n: count() })
        .from(suggestion)
        .where(eq(suggestion.supersededById, first.id));
      return {
        outcome: Number(replaced?.n ?? 0) > 0 ? 'replaced' : 'opened',
        reason: null,
        suggestionId: newest.id,
      };
    }

    if (found.investmentId === null)
      return { outcome: 'none', reason: 'fund_commitment', suggestionId: null };
    const periodEnd = found.periodEnd ?? (await this.acceptedPeriodEnd(tx, runId));
    if (periodEnd === null || !isQuarterEnd(periodEnd))
      return { outcome: 'none', reason: null, suggestionId: null };
    const gathered = await gatherSources(
      tx,
      { investmentId: found.investmentId, periodEnd },
      settings,
      schemas,
    );
    const prior = await priorSuggestions(tx, found.investmentId, periodEnd);
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
    if (step.action === 'close')
      return { outcome: 'none', reason: step.because, suggestionId: null };
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

  /** The period end a run's approval accepted, for a run whose document carries none. */
  private async acceptedPeriodEnd(tx: Tx, runId: string): Promise<string | null> {
    const value = schema.extractedValue;
    const [row] = await tx
      .select({ decision: value.decision, value: value.value, editedValue: value.editedValue })
      .from(value)
      .where(and(eq(value.runId, runId), eq(value.field, PERIOD_END_KEY)));
    if (row === undefined) return null;
    return row.decision === 'edited'
      ? row.editedValue
      : row.decision === 'accepted'
        ? row.value
        : null;
  }
}
