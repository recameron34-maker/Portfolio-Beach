import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AdapterSet, Principal } from '@pb/adapters';
import { isQuarterEnd } from '@pb/calc';
import { valuationSuggestionState } from '@pb/contracts';
import type {
  SuggestionRunOutcome,
  ValuationSuggestionCommandBody,
  ValuationSuggestionListQuery,
  ValuationSuggestionPage,
  ValuationSuggestionRow,
} from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import {
  SUGGESTIONS_OFF_REFUSAL,
  SUGGESTION_CHANGED_REFUSAL,
  attempt,
  derivationStep,
  selectSuggestion,
  suggestionBar,
  suggestionCommandRecord,
  suggestionDraftKeys,
  suggestionReading,
  valuationSuggestionMachine,
  withSuggestionKeys,
} from '@pb/workflows';
import type { SuggestionSettings } from '@pb/workflows';
import { AT_ID_CURSOR, decodeAtIdCursor, encodeCursor } from '../common/cursor.js';
import { ProblemError, workflowProblem } from '../common/problem.js';
import { requireFreshRow } from '../common/row-version.js';
import { ADAPTERS } from '../common/tokens.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import type { AuditEntry } from '../db/db.service.js';
import {
  ValuationWorkflowService,
  isVersionRace,
  versionRaceProblem,
} from '../valuations/workflow.service.js';
import {
  SuggestionDerivationService,
  isSuggestionRace,
  suggestionBusy,
} from './derivation.service.js';
import {
  SUGGESTION_ENTITY,
  SUGGESTION_NOT_FOUND,
  gatherFor,
  inputFileNames,
  loadSuggestion,
  pageSuggestions,
  priorSuggestions,
  storedOf,
  suggestion,
  toSuggestionRow,
} from './rows.js';
import type { LoadedSuggestion } from './rows.js';
import { PERIOD_END_KEY } from './settings.js';
import type { SuggestionSchemas } from './settings.js';
import { gatherSources, quarterVersions } from './sources.js';

/*
 * Reading valuation suggestions (docs/04 M10, docs/18 section 14, decision 0023). The deal
 * team, operations, approvers and auditors read them; row-level security gives a viewer,
 * investor relations and a platform admin nothing, and hides a suggestion behind the wall of its
 * position, so one the caller cannot see is 404. A suggestion's stored columns are the figures
 * of the approval that produced it; the mark on record, the comparison, the checks, the other
 * sources and the badges are worked out at each read from the record as it then stands, under
 * the caller's own access. Opening one suggestion is audited (SEC-11.1).
 *
 * Deciding one (docs/18 section 14) is operations' alone, through valuationSuggestionMachine.
 * dismiss sets it aside with a reason. accept opens a draft valuation at the suggested value and
 * applyToDraft puts the value and its method on the Draft open for the quarter, each through the
 * valuation workflow's own write, so a suggestion never writes a mark: the Draft is prepared,
 * approved and Locked like any other. Before either writes anything the suggestion is derived
 * again; one whose figures moved is replaced or closed in that same transaction, which commits,
 * and the answer is 409. Every command is audited with the state before and after.
 */

const run = schema.extractionRun;

/** 409 when a command finds the suggestion already decided or replaced by another command. */
const conflict = (): ProblemError =>
  new ProblemError(
    409,
    'conflict',
    'valuation_suggestion: another command changed the suggestion first; open it again',
  );

/** The suggestion as locked for a command. */
interface LockedSuggestion {
  id: string;
  investmentId: string;
  periodEnd: string;
  basis: string;
  method: string;
  suggestedValue: string | null;
  reasonCode: string | null;
  workings: unknown;
  sourceDocumentId: string;
  extractionRunId: string;
  sourcePage: number | null;
  state: string;
  rowVersion: number;
}

const LOCKED_COLUMNS = {
  id: suggestion.id,
  investmentId: suggestion.investmentId,
  periodEnd: suggestion.periodEnd,
  basis: suggestion.basis,
  method: suggestion.method,
  suggestedValue: suggestion.suggestedValue,
  reasonCode: suggestion.reasonCode,
  workings: suggestion.workings,
  sourceDocumentId: suggestion.sourceDocumentId,
  extractionRunId: suggestion.extractionRunId,
  sourcePage: suggestion.sourcePage,
  state: suggestion.state,
  rowVersion: suggestion.rowVersion,
};

type Audit = (entry: AuditEntry) => Promise<void>;

@Injectable()
export class SuggestionsService {
  constructor(
    private readonly db: DbService,
    private readonly derivation: SuggestionDerivationService,
    private readonly valuations: ValuationWorkflowService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
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

  /**
   * One command on one suggestion (docs/18 section 14). The advisory lock of the position and
   * quarter is taken first and the row second, the order every derivation takes them in. A
   * suggestion the caller cannot see is 404; an If-Match naming another row version is 412; a
   * command the state does not allow is 409; with the switch off accept and applyToDraft are
   * 409 and dismiss still works. accept and applyToDraft derive the suggestion again before they
   * write: when its figures have moved it is replaced or closed, that is committed, and the
   * answer is 409. Otherwise the machine's preconditions decide (422, in the valuation
   * workflow's words) and the valuation workflow's own write opens or corrects the Draft.
   */
  async command(
    principal: Principal,
    requestId: string,
    id: string,
    body: ValuationSuggestionCommandBody,
    ifMatch?: readonly number[],
  ): Promise<ValuationSuggestionRow> {
    requireUuid(id, SUGGESTION_NOT_FOUND);
    const settings = this.derivation.settings();
    const schemas = this.derivation.schemas();
    const at = new Date(this.adapters.clock.now());
    let answer: ValuationSuggestionRow | 'changed';
    try {
      answer = await this.db.run(principal, requestId, async (tx, audit) => {
        const [seen] = await tx
          .select({ investmentId: suggestion.investmentId, periodEnd: suggestion.periodEnd })
          .from(suggestion)
          .where(eq(suggestion.id, id));
        if (seen === undefined) throw new ProblemError(404, 'not-found', SUGGESTION_NOT_FOUND);
        await this.derivation.lockQuarter(tx, seen.investmentId, seen.periodEnd);
        const [locked] = await tx
          .select(LOCKED_COLUMNS)
          .from(suggestion)
          .where(eq(suggestion.id, id))
          .for('update');
        if (locked === undefined) throw new ProblemError(404, 'not-found', SUGGESTION_NOT_FOUND);
        requireFreshRow(ifMatch, locked.rowVersion, 'valuation_suggestion');
        const from = valuationSuggestionState.parse(locked.state);
        const actor = { actorId: principal.userId, actorRoles: principal.roles };

        if (body.command === 'dismiss') {
          const result = attempt(valuationSuggestionMachine, from, 'dismiss', {
            ...actor,
            reason: body.reason,
            record: {},
          });
          if (!result.ok) throw workflowProblem(result);
          await this.decide(tx, audit, locked, 'dismiss', {
            state: result.to,
            decidedBy: principal.userId,
            decidedAt: at,
            decisionReason: body.reason,
          });
          return this.rowOrThrow(tx, id, settings, schemas);
        }

        // The state and the role first: a decided suggestion is 409 whatever else is true.
        const gate = attempt(valuationSuggestionMachine, from, body.command, {
          ...actor,
          record: {},
        });
        if (!gate.ok && gate.code !== 'precondition') throw workflowProblem(gate);
        if (!(await this.derivation.enabled(tx)))
          throw new ProblemError(409, 'kill-switch', SUGGESTIONS_OFF_REFUSAL);
        // The figures behind it, read again: a suggestion that no longer says what the sources
        // give is replaced or closed here, and that is what this command leaves behind.
        const derived = await this.derivation.refreshOne(
          tx,
          audit,
          locked.investmentId,
          locked.periodEnd,
        );
        if (derived.action !== 'none') return 'changed';

        const stored = storedOf(locked);
        const gathered = await gatherFor(tx, locked, settings, schemas);
        const chain = quarterVersions(
          gathered.versions,
          locked.periodEnd,
          settings.periodEndToleranceDays,
        );
        const result = attempt(valuationSuggestionMachine, from, body.command, {
          ...actor,
          record: { ...suggestionCommandRecord(locked.suggestedValue, chain) },
        });
        if (!result.ok) throw workflowProblem(result);
        const value = locked.suggestedValue;
        if (value === null) throw conflict();
        const keys = suggestionDraftKeys({
          id: locked.id,
          basis: stored.basis,
          value,
          periodEnd: locked.periodEnd,
          documentId: locked.sourceDocumentId,
          page: locked.sourcePage,
          runId: locked.extractionRunId,
          inputs: stored.inputs,
          crossChecks: suggestionReading(stored, gathered.sources, settings).crossChecks,
        });
        const origin = { suggestionId: locked.id };
        let onto: { id: string; periodEnd: string; version: number };
        if (body.command === 'accept') {
          onto = await this.valuations.createDraft(
            tx,
            audit,
            {
              investmentId: locked.investmentId,
              periodEnd: locked.periodEnd,
              method: locked.method,
              fairValue: value,
              inputs: keys,
            },
            origin,
          );
        } else {
          const draft = chain.find((version) => version.state === 'Draft');
          if (draft === undefined) throw conflict();
          onto = await this.valuations.editDraft(
            tx,
            audit,
            draft.id,
            (inputs) => ({
              method: locked.method,
              fairValue: value,
              inputs: withSuggestionKeys(inputs, keys),
            }),
            undefined,
            origin,
          );
        }
        await this.decide(
          tx,
          audit,
          locked,
          body.command,
          { state: result.to, decidedBy: principal.userId, decidedAt: at, valuationId: onto.id },
          { valuation: { id: onto.id, periodEnd: onto.periodEnd, version: onto.version } },
        );
        return this.rowOrThrow(tx, id, settings, schemas);
      });
    } catch (error) {
      if (isSuggestionRace(error)) throw suggestionBusy();
      if (isVersionRace(error)) throw versionRaceProblem();
      throw error;
    }
    // Replaced or closed, and committed: the caller reads the list again.
    if (answer === 'changed') throw new ProblemError(409, 'conflict', SUGGESTION_CHANGED_REFUSAL);
    return answer;
  }

  /**
   * The one write of a person's decision: the decision columns, on the suggestion as it was read
   * (Open, at the row version read), audited with the state before and after. Nothing written
   * means another command got there first.
   */
  private async decide(
    tx: Tx,
    audit: Audit,
    locked: LockedSuggestion,
    command: ValuationSuggestionCommandBody['command'],
    patch: {
      state: 'Accepted' | 'Dismissed' | 'Open' | 'Superseded';
      decidedBy: string;
      decidedAt: Date;
      decisionReason?: string;
      valuationId?: string;
    },
    details: Record<string, unknown> = {},
  ): Promise<void> {
    const [written] = await tx
      .update(suggestion)
      .set(patch)
      .where(
        and(
          eq(suggestion.id, locked.id),
          eq(suggestion.state, 'Open'),
          eq(suggestion.rowVersion, locked.rowVersion),
        ),
      )
      .returning();
    if (written === undefined) throw conflict();
    await audit({
      action: `valuation_suggestion.${command}`,
      entity: SUGGESTION_ENTITY,
      entityId: written.id,
      ...(patch.decisionReason !== undefined ? { reason: patch.decisionReason } : {}),
      details: {
        investmentId: written.investmentId,
        periodEnd: written.periodEnd,
        basis: written.basis,
        method: written.method,
        suggestedValue: written.suggestedValue,
        reasonCode: written.reasonCode,
        state: { before: locked.state, after: written.state },
        decidedBy: { before: null, after: written.decidedBy },
        valuationId: { before: null, after: written.valuationId },
        ...details,
      },
    });
  }

  /** The suggestion as a row after a write in this transaction; it was just written, so it reads. */
  private async rowOrThrow(
    tx: Tx,
    id: string,
    settings: SuggestionSettings,
    schemas: SuggestionSchemas,
  ): Promise<ValuationSuggestionRow> {
    const row = await this.rowById(tx, id, settings, schemas);
    if (row === null) throw new ProblemError(404, 'not-found', SUGGESTION_NOT_FOUND);
    return row;
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
