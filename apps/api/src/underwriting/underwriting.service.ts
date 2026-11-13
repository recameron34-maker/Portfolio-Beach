import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, max, sql } from 'drizzle-orm';
import type { AdapterSet, Principal } from '@pb/adapters';
import { CALC_VERSION, underwritingComparison } from '@pb/calc';
import {
  UNDERWRITING_REFUSALS,
  entryCaseOf,
  isCaseDateAllowed,
  isComparableVersion,
  underwritingBodyIssues,
} from '@pb/contracts';
import type {
  UnderwritingCaseBody,
  UnderwritingCaseVersion,
  UnderwritingCommandBody,
  UnderwritingRead,
  UnderwritingRevenueBounds,
  UnderwritingVersionRef,
} from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { attempt, underwritingCaseMachine } from '@pb/workflows';
import { loadOperatingRows } from '../analytics/analytics.service.js';
import { configDecimal } from '../common/definitions.js';
import { isUniqueViolation, isUniqueViolationOn } from '../common/pg-errors.js';
import { ProblemError, workflowProblem } from '../common/problem.js';
import { requireFreshRow } from '../common/row-version.js';
import { ADAPTERS, DEFINITIONS } from '../common/tokens.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import type { AuditEntry } from '../db/db.service.js';
import { loadInvestmentsWithMetrics } from '../portfolio/loaders.js';
import { str } from '../portfolio/metrics.js';
import { calcCaseOf, comparisonInputs, tolerancesOf, underwritingFormOf } from './comparison.js';
import type { UnderwritingDefinitions } from './comparison.js';
import { loadVersions } from './rows.js';

/*
 * Performance against the sponsor's underwritten base case (docs/04 M9, docs/08 section 11,
 * docs/18 section 13, decision 0022).
 *
 * The read answers every version of a position's base case and the comparison of the position
 * with one of them: the entry case, the Confirmed version with the earliest case date, unless the
 * reader names another that stands or stood as the plan. Only a case a second person confirmed
 * is compared (SEC-9.1): a Draft alone answers no comparison. The comparison is worked out on
 * read by underwritingComparison of @pb/calc, from the figures the value creation card and the
 * position summary carry for the same date; nothing of it is stored.
 *
 * The writes keep the life of a case (docs/18 section 13). The deal team records a Draft (one per
 * position), and edits it whole: whoever edits becomes the person who last changed the figures.
 * A second person confirms it through underwritingCaseMachine, never that person (SEC-5.6), and
 * only once the case names its source (SEC-9.4); the confirmation of a version dated as a
 * Confirmed case supersedes that case first, in the same transaction, so a position never holds
 * two Confirmed cases for one date. A Draft is withdrawn by the deal team and a Confirmed case
 * retired by an approver, each with a reason. Nothing is deleted and a Confirmed case keeps its
 * figures (SEC-9.2): a revision is a new version. The database holds the same line (migration
 * 0021), so a write this service lets through wrongly is refused below it.
 *
 * Every command locks the case for the transaction, answers 412 when the caller's If-Match is
 * stale, guards its write on the state and row version it read, and writes an audit event with
 * the state before and after (SEC-11.1). A position the caller cannot see is 404, its base case
 * with it (SEC-5.3).
 */

const kase = schema.underwritingCase;
const point = schema.underwritingCasePoint;
const ENTITY = 'mon.underwriting_case';
const INVESTMENT_NOT_FOUND = 'Investment not found';
const CASE_NOT_FOUND = 'Base case not found';
const VERSION_NOT_FOUND = 'Base case version not found';
/** The partial unique index of migration 0021: one Draft per position. */
const ONE_DRAFT_INDEX = 'underwriting_case_one_draft_idx';

type CaseRecord = typeof kase.$inferSelect;
type Audit = (entry: AuditEntry) => Promise<void>;

/** The settings the writes read of config/definitions.json, beside the tolerances of the read. */
interface Definitions extends UnderwritingDefinitions {
  unitSanityBoundsUsd?: { revenueMin?: unknown; revenueMax?: unknown };
}

/** A refusal of a create, an edit or a command on its preconditions (422), in the machine's wording. */
const precondition = (detail: string): ProblemError =>
  new ProblemError(422, 'workflow-precondition', detail);

/** A refusal because of where the record stands (409). */
const transition = (detail: string): ProblemError =>
  new ProblemError(409, 'workflow-transition', detail);

/** The prototype keeps US dollars only: a body that names another currency is refused, never converted. */
function requireDollars(body: UnderwritingCaseBody): void {
  if (body.currency !== undefined && body.currency !== 'USD')
    throw precondition(UNDERWRITING_REFUSALS.currency);
}

/** Whether a case names where its figures come from (SEC-9.4): a document, or a note with words in it. */
const hasSource = (record: Pick<CaseRecord, 'sourceDocumentId' | 'sourceNote'>): boolean =>
  record.sourceDocumentId !== null || (record.sourceNote ?? '').trim().length > 0;

/** The terms of a case as the audit trail keeps them, read back from the row written (rule 6). */
const termsOf = (record: CaseRecord): Record<string, unknown> => ({
  caseDate: record.caseDate,
  plannedExitDate: record.plannedExitDate,
  exitMultiple: record.exitMultiple,
  grossMoic: record.grossMoic,
  grossIrr: record.grossIrr,
  underwrittenYield: record.underwrittenYield,
  annualLossRate: record.annualLossRate,
  sourceDocumentId: record.sourceDocumentId,
  sourcePage: record.sourcePage,
  sourceLocator: record.sourceLocator,
  hasSourceNote: record.sourceNote !== null,
  enteredBy: record.enteredBy,
});

@Injectable()
export class UnderwritingService {
  constructor(
    private readonly db: DbService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(DEFINITIONS) private readonly definitions: Definitions,
  ) {}

  /**
   * A position against its base case as of a date. `version` names the version to compare with
   * in place of the entry case; one that is not Confirmed or Superseded is 404. A position that
   * holds no base case (a primary fund) answers `form: null` and nothing else.
   */
  async read(
    principal: Principal,
    requestId: string,
    id: string,
    asOf: string,
    version?: number,
  ): Promise<UnderwritingRead> {
    // Read before the database is, so a missing tolerance discloses nothing and audits nothing.
    const tolerances = tolerancesOf(this.definitions);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const found = (await loadInvestmentsWithMetrics(tx, asOf, eq(schema.investment.id, id)))[0];
      if (found === undefined) throw new ProblemError(404, 'not-found', INVESTMENT_NOT_FOUND);
      const form = underwritingFormOf(found.row.dealType);
      const versions = form === null ? [] : await loadVersions(tx, found.row.id);
      const compared =
        version === undefined
          ? entryCaseOf(versions)
          : (versions.find((v) => v.version === version && isComparableVersion(v)) ?? null);
      if (version !== undefined && compared === null)
        throw new ProblemError(404, 'not-found', VERSION_NOT_FOUND);
      await audit({
        action: 'investment.underwriting.read',
        entity: 'core.investment',
        entityId: found.row.id,
        ...(compared === null ? {} : { details: { comparedVersion: compared.version } }),
      });

      const base = {
        asOf,
        form,
        versions,
        thresholds: {
          onPlanTolerance: str(tolerances.onPlanTolerance)!,
          irrTolerance: str(tolerances.irrTolerance)!,
        },
        calcVersion: CALC_VERSION,
      };
      if (compared === null)
        return {
          ...base,
          comparedVersion: null,
          comparison: null,
          notCalculable:
            form === null
              ? null
              : versions.some((v) => v.state === 'Draft')
                ? 'draft_only'
                : 'no_case',
        };
      const operating = (await loadOperatingRows(tx, [found.row.id])).get(found.row.id) ?? [];
      return {
        ...base,
        comparedVersion: compared.version,
        comparison: underwritingComparison(
          calcCaseOf(compared),
          comparisonInputs({ ...found, operating }, asOf),
          tolerances,
        ),
        notCalculable: null,
      };
    });
  }

  /**
   * The "(new) to Draft" row of docs/18 section 13. The position must be visible (404 otherwise)
   * and of a kind that holds a base case (422). One Draft per position (409). From version 2 the
   * case says why it revises (422), and its case date is a Confirmed case's, which it will
   * correct, or later than every Confirmed case's, a re-underwriting (422). A source document
   * must be one of the position's that the caller can see (422, one sentence for both). The
   * Draft names the caller as the person who entered it.
   */
  async create(
    principal: Principal,
    requestId: string,
    investmentId: string,
    body: UnderwritingCaseBody,
  ): Promise<UnderwritingCaseVersion> {
    requireUuid(investmentId, INVESTMENT_NOT_FOUND);
    const bounds = this.revenueBounds();
    return this.unlessRaced(principal, requestId, async (tx, audit) => {
      const position = (
        await tx
          .select({
            id: schema.investment.id,
            investmentNumber: schema.investment.investmentNumber,
            dealType: schema.investment.dealType,
          })
          .from(schema.investment)
          .where(eq(schema.investment.id, investmentId))
      )[0];
      if (position === undefined) throw new ProblemError(404, 'not-found', INVESTMENT_NOT_FOUND);
      const form = underwritingFormOf(position.dealType);
      if (form === null) throw precondition(UNDERWRITING_REFUSALS.noBaseCase);
      const issues = underwritingBodyIssues(form, body, bounds);
      if (issues.length > 0) throw new ProblemError(400, 'validation', 'Invalid body', issues);
      requireDollars(body);

      const others = await this.versionRefs(tx, position.id);
      if (others.some((v) => v.state === 'Draft'))
        throw transition(UNDERWRITING_REFUSALS.draftExists);
      const version = others.reduce((highest, v) => Math.max(highest, v.version), 0) + 1;
      if (version > 1 && body.revisionReason === undefined)
        throw precondition(UNDERWRITING_REFUSALS.reasonRequired);
      if (!isCaseDateAllowed(body.caseDate, others))
        throw precondition(UNDERWRITING_REFUSALS.caseDate);
      await this.requireSourceDocument(tx, position.id, body.sourceDocumentId);

      const inserted = (
        await tx
          .insert(kase)
          .values({
            investmentId: position.id,
            version,
            form,
            ...this.columnsOf(form, body),
            revisionReason: version === 1 ? null : (body.revisionReason ?? null),
            enteredBy: principal.userId,
            enteredAt: new Date(this.adapters.clock.now()),
          })
          .returning()
      )[0];
      if (inserted === undefined) throw new Error('the base case insert returned no row');
      await this.writePoints(tx, inserted.id, body);
      await audit({
        action: 'underwriting_case.create',
        entity: ENTITY,
        entityId: inserted.id,
        ...(inserted.revisionReason === null ? {} : { reason: inserted.revisionReason }),
        details: {
          investmentId: position.id,
          investmentNumber: position.investmentNumber,
          version,
          form,
          state: { before: null, after: inserted.state },
          terms: termsOf(inserted),
          points: body.points?.length ?? 0,
        },
      });
      return this.versionOrThrow(tx, position.id, inserted.id);
    });
  }

  /**
   * An edit of a Draft (docs/18 section 13): the body replaces the terms and the plan points
   * whole, and its sender becomes the person who last changed the figures, so they cannot confirm
   * it and the person who entered it before them can. Only a Draft is edited: every other state
   * is 409 and keeps every value. The case row is written on every edit, so its row version
   * moves even when only the plan points change.
   */
  async edit(
    principal: Principal,
    requestId: string,
    id: string,
    body: UnderwritingCaseBody,
    ifMatch: readonly number[] | undefined,
  ): Promise<UnderwritingCaseVersion> {
    requireUuid(id, CASE_NOT_FOUND);
    const bounds = this.revenueBounds();
    return this.unlessRaced(principal, requestId, async (tx, audit) => {
      const locked = (await tx.select().from(kase).where(eq(kase.id, id)).for('update'))[0];
      if (locked === undefined) throw new ProblemError(404, 'not-found', CASE_NOT_FOUND);
      requireFreshRow(ifMatch, locked.rowVersion, 'underwriting_case');
      if (locked.state !== 'Draft') throw transition(UNDERWRITING_REFUSALS.notDraft(locked.state));
      const form = locked.form === 'credit' ? 'credit' : 'equity';
      const issues = underwritingBodyIssues(form, body, bounds);
      if (issues.length > 0) throw new ProblemError(400, 'validation', 'Invalid body', issues);
      requireDollars(body);
      if (locked.version > 1 && body.revisionReason === undefined)
        throw precondition(UNDERWRITING_REFUSALS.reasonRequired);
      const others = (await this.versionRefs(tx, locked.investmentId)).filter(
        (v) => v.version !== locked.version,
      );
      if (!isCaseDateAllowed(body.caseDate, others))
        throw precondition(UNDERWRITING_REFUSALS.caseDate);
      await this.requireSourceDocument(tx, locked.investmentId, body.sourceDocumentId);

      // The case first, naming its editor; then the points, which are written only under a Draft.
      const written = await this.claim(tx, locked, {
        ...this.columnsOf(form, body),
        revisionReason: locked.version === 1 ? null : (body.revisionReason ?? null),
        enteredBy: principal.userId,
        enteredAt: new Date(this.adapters.clock.now()),
      });
      const replaced = await tx.delete(point).where(eq(point.caseId, id)).returning();
      await this.writePoints(tx, id, body);
      await audit({
        action: 'underwriting_case.edit',
        entity: ENTITY,
        entityId: id,
        details: {
          investmentId: locked.investmentId,
          version: locked.version,
          state: { before: locked.state, after: written.state },
          terms: { before: termsOf(locked), after: termsOf(written) },
          points: { before: replaced.length, after: body.points?.length ?? 0 },
        },
      });
      return this.versionOrThrow(tx, locked.investmentId, id);
    });
  }

  /**
   * confirm, withdraw and retire, through underwritingCaseMachine. A confirmation names the
   * caller, who is never the person who last changed the figures, and first supersedes the
   * Confirmed case with the same case date, if there is one: that step is the system's row of the
   * table, taken here in the caller's transaction and never sent by anybody.
   */
  async command(
    principal: Principal,
    requestId: string,
    id: string,
    body: UnderwritingCommandBody,
    ifMatch: readonly number[] | undefined,
  ): Promise<UnderwritingCaseVersion> {
    requireUuid(id, CASE_NOT_FOUND);
    return this.unlessRaced(principal, requestId, async (tx, audit) => {
      const locked = (await tx.select().from(kase).where(eq(kase.id, id)).for('update'))[0];
      if (locked === undefined) throw new ProblemError(404, 'not-found', CASE_NOT_FOUND);
      requireFreshRow(ifMatch, locked.rowVersion, 'underwriting_case');
      const from = locked.state;
      const result = attempt(underwritingCaseMachine, from, body.command, {
        actorId: principal.userId,
        actorRoles: principal.roles,
        ...(body.command === 'confirm' ? {} : { reason: body.reason }),
        record: { enteredBy: locked.enteredBy, hasSource: hasSource(locked) },
      });
      if (!result.ok) throw workflowProblem(result);
      const state = { before: from, after: result.to };

      if (body.command !== 'confirm') {
        await this.claim(tx, locked, { state: result.to, withdrawnReason: body.reason });
        await audit({
          action: `underwriting_case.${body.command}`,
          entity: ENTITY,
          entityId: id,
          reason: body.reason,
          details: { investmentId: locked.investmentId, version: locked.version, state },
        });
        return this.versionOrThrow(tx, locked.investmentId, id);
      }

      if (locked.form === 'equity') await this.requirePlan(tx, locked);
      const superseded = await this.supersedeSameDate(tx, audit, principal, locked);
      await this.claim(tx, locked, {
        state: result.to,
        confirmedBy: principal.userId,
        confirmedAt: new Date(this.adapters.clock.now()),
      });
      await audit({
        action: 'underwriting_case.confirm',
        entity: ENTITY,
        entityId: id,
        details: {
          investmentId: locked.investmentId,
          version: locked.version,
          state,
          enteredBy: locked.enteredBy,
          superseded,
        },
      });
      return this.versionOrThrow(tx, locked.investmentId, id);
    });
  }

  /**
   * The system's row of the table: the Confirmed case dated as the one being confirmed becomes
   * Superseded, before the confirmation is written, so the position never holds two Confirmed
   * cases for one date. Answers the versions superseded (one at most, by the unique index).
   */
  private async supersedeSameDate(
    tx: Tx,
    audit: Audit,
    principal: Principal,
    confirming: CaseRecord,
  ): Promise<number[]> {
    const corrected = await tx
      .select()
      .from(kase)
      .where(
        and(
          eq(kase.investmentId, confirming.investmentId),
          eq(kase.caseDate, confirming.caseDate),
          eq(kase.state, 'Confirmed'),
        ),
      )
      .orderBy(asc(kase.version))
      .for('update');
    for (const old of corrected) {
      const step = attempt(underwritingCaseMachine, old.state, 'supersede', {
        actorId: principal.userId,
        actorRoles: ['service'],
        record: { correctedBySameDate: old.caseDate === confirming.caseDate },
      });
      if (!step.ok) throw workflowProblem(step);
      await this.claim(tx, old, { state: step.to });
      await audit({
        action: 'underwriting_case.supersede',
        entity: ENTITY,
        entityId: old.id,
        details: {
          investmentId: old.investmentId,
          version: old.version,
          state: { before: old.state, after: step.to },
          supersededBy: { id: confirming.id, version: confirming.version },
        },
      });
    }
    return corrected.map((old) => old.version);
  }

  /** An equity case is confirmed with its plan: two points or more, the last on the planned exit. */
  private async requirePlan(tx: Tx, record: CaseRecord): Promise<void> {
    const plan = (
      await tx
        .select({ points: sql<number>`count(*)::int`, last: max(point.periodEnd) })
        .from(point)
        .where(eq(point.caseId, record.id))
    )[0];
    if (plan === undefined || plan.points < 2 || plan.last !== record.plannedExitDate)
      throw precondition(UNDERWRITING_REFUSALS.planRequired);
  }

  /** A source document is one of the position's, as the caller may read it; anything else is one refusal. */
  private async requireSourceDocument(
    tx: Tx,
    investmentId: string,
    documentId: string | undefined,
  ): Promise<void> {
    if (documentId === undefined) return;
    const found = (
      await tx
        .select({ id: schema.document.id })
        .from(schema.document)
        .where(
          and(eq(schema.document.id, documentId), eq(schema.document.investmentId, investmentId)),
        )
    )[0];
    if (found === undefined) throw precondition(UNDERWRITING_REFUSALS.sourceDocument);
  }

  /** The columns a body sets, for its form: what the other form holds is null, never a leftover. */
  private columnsOf(form: 'equity' | 'credit', body: UnderwritingCaseBody) {
    return {
      caseDate: body.caseDate,
      plannedExitDate: body.plannedExitDate,
      exitMultiple: form === 'equity' ? (body.exitMultiple ?? null) : null,
      grossMoic: body.grossMoic,
      grossIrr: body.grossIrr,
      underwrittenYield: form === 'credit' ? (body.underwrittenYield ?? null) : null,
      annualLossRate: form === 'credit' ? (body.annualLossRate ?? null) : null,
      note: body.note ?? null,
      sourceDocumentId: body.sourceDocumentId ?? null,
      sourcePage: body.sourcePage ?? null,
      sourceLocator: body.sourceLocator ?? null,
      sourceNote: body.sourceNote ?? null,
    };
  }

  private async writePoints(tx: Tx, caseId: string, body: UnderwritingCaseBody): Promise<void> {
    const points = body.points ?? [];
    if (points.length === 0) return;
    await tx.insert(point).values(points.map((p) => ({ ...p, caseId })));
  }

  /** Writes with a guard on the state and row version read under the lock, and hands back the row written. */
  private async claim(
    tx: Tx,
    locked: CaseRecord,
    values: Partial<typeof kase.$inferInsert>,
  ): Promise<CaseRecord> {
    const written = (
      await tx
        .update(kase)
        .set(values)
        .where(
          and(
            eq(kase.id, locked.id),
            eq(kase.state, locked.state),
            eq(kase.rowVersion, locked.rowVersion),
          ),
        )
        .returning()
    )[0];
    if (written === undefined) throw transition(UNDERWRITING_REFUSALS.raced);
    return written;
  }

  private async versionRefs(tx: Tx, investmentId: string): Promise<UnderwritingVersionRef[]> {
    return tx
      .select({ version: kase.version, state: kase.state, caseDate: kase.caseDate })
      .from(kase)
      .where(eq(kase.investmentId, investmentId))
      .orderBy(asc(kase.version));
  }

  private async versionOrThrow(
    tx: Tx,
    investmentId: string,
    id: string,
  ): Promise<UnderwritingCaseVersion> {
    const found = (await loadVersions(tx, investmentId)).find((v) => v.id === id);
    if (found === undefined) throw new ProblemError(404, 'not-found', CASE_NOT_FOUND);
    return found;
  }

  /** `unitSanityBoundsUsd`: the revenue a plan point may hold, never a default in code. */
  private revenueBounds(): UnderwritingRevenueBounds {
    const bounds = this.definitions.unitSanityBoundsUsd;
    return {
      revenueMin: configDecimal(bounds?.revenueMin, 'unitSanityBoundsUsd.revenueMin'),
      revenueMax: configDecimal(bounds?.revenueMax, 'unitSanityBoundsUsd.revenueMax'),
    };
  }

  /**
   * Runs a write, and answers 409 when the database refused it on a unique key two writers
   * raced for (a second Draft, a version number, a Confirmed case for the date): the caller can
   * act on that, and nothing of the failed statement, whose parameters carry the figures,
   * reaches a log line (SEC-11.4).
   */
  private async unlessRaced<T>(
    principal: Principal,
    requestId: string,
    fn: (tx: Tx, audit: Audit) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.run(principal, requestId, fn);
    } catch (error) {
      if (isUniqueViolationOn(error, ONE_DRAFT_INDEX))
        throw transition(UNDERWRITING_REFUSALS.draftExists);
      if (isUniqueViolation(error)) throw transition(UNDERWRITING_REFUSALS.raced);
      throw error;
    }
  }
}
