import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { AdapterSet, Principal } from '@pb/adapters';
import { UNITS_BY_KIND, boundsFrom } from '@pb/ai';
import type { ExtractionField, ExtractionSchema, ExtractionSchemas } from '@pb/ai';
import { CalcError, isQuarterEnd, toDollars, unitSanityFlag } from '@pb/calc';
import { extractionRunCommandBody, extractionUnit, valueFitsUnit } from '@pb/contracts';
import type { ExtractionRunCommandBody, ExtractionRunDetail, ExtractionUnit } from '@pb/contracts';
import { asSystemActor, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { ProblemError, zodIssues } from '../common/problem.js';
import { ADAPTERS, DEFINITIONS } from '../common/tokens.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import type { AuditEntry } from '../db/db.service.js';
import { EXTRACTION_SCHEMAS } from '../documents/settings.js';
import { promoteQuarterlyPerformance } from '../intake/promote.js';
import type { QuarterlyFigureKey, QuarterlyFigures } from '../intake/promote.js';
import { ExtractionService } from './extraction.service.js';
import { ExtractionRunner } from './runner.js';
import {
  RUN_NOT_FOUND,
  findingsOf,
  highlightsOf,
  loadRunDetail,
  loadValues,
  run,
  value,
} from './rows.js';
import type { LoadedValue } from './rows.js';
import {
  COMMENTARY_FIELD,
  HIGHLIGHTS_FIELD,
  NARRATIVE_FIELDS,
  moneyFieldKeys,
  naturalUnitOf,
} from './settings.js';

/*
 * Review by exception (docs/04 M4, SEC-9.1, SEC-11.1, decision 0012). A reviewer (deal team,
 * operations) decides the staged values of a Succeeded, unapproved run they can see: accept,
 * reject with a reason, edit (a corrected value in its own unit, kept beside the model's value
 * and unit, never over them: WF-1), or accept every clean undecided value at once; an invalid
 * value can only be edited or rejected, and a highlight or commentary row that breaks the house
 * style can only be rejected (docs/07 section 3, AI-4). An edit is held to the rules the
 * validator applies to the model (docs/08 sections 5 and 6): a money value must convert to
 * dollars inside the configured range, a date must be the quarter end the run was opened for.
 * Approval checks that every required field is accepted or edited, that no invalid value stands,
 * that no flagged value and no record figure is undecided, and that the period end is the run's
 * quarter, then promotes the final values of the target fields, converted to dollars (an edited
 * value with the edit's unit), into mon.quarterly_performance through the one promotion write the
 * accounting import uses (intake/promote.ts), as the system actor, in the same transaction, with
 * the lineage of the run and the document, citing the first promoted figure read from the
 * document; the highlights and the commentary are written only when their rows are accepted.
 * The default approval reason is a fixed sentence, since the file name names the company and
 * the audit trail is read by role, not by wall (W3). Every decision and the approval are audited
 * with before and after. retry drives a NeedsRetry run again through the machine, or queues a
 * fresh run for a Failed one (the machine has no Failed > Running row: a failed run stays on
 * record as it failed).
 */

const ENTITY = 'doc.extraction_run';
const VALUE_ENTITY = 'stg.extracted_value';
const ACCEPTED = 'accepted';
const EDITED = 'edited';
const REJECTED = 'rejected';

/** The mon.quarterly_performance column a schema target names. */
const TARGET_KEYS: Readonly<Record<string, QuarterlyFigureKey>> = {
  revenue_ltm: 'revenueLtm',
  ebitda_ltm: 'ebitdaLtm',
  ev: 'ev',
  net_debt: 'netDebt',
  cash: 'cash',
  total_equity: 'totalEquity',
};
/** The approval reason when the reviewer gives none: a fixed sentence, never the file name (W3, SEC-5.3). */
export const DEFAULT_APPROVAL_REASON = 'Approved from the AI extraction review';

/** The run as locked for a command. */
interface LockedRun {
  id: string;
  documentId: string;
  fileName: string;
  investmentId: string | null;
  /** The quarter the run was opened for (the document's period end), which the promotion lands on. */
  periodEnd: string | null;
  schemaId: string;
  promptVersion: string;
  modelId: string | null;
  state: string;
  approvedBy: string | null;
  rowVersion: number;
}

/** A refusal of the review: the run or the value is not in a state the command can work (409). */
const blocked = (detail: string): ProblemError => new ProblemError(409, 'review-blocked', detail);
/** The problem when a command finds the row already changed by another command. */
const conflict = (): ProblemError =>
  new ProblemError(
    409,
    'conflict',
    'extraction: another command changed the run first; open it again',
  );

@Injectable()
export class ExtractionReviewService {
  constructor(
    private readonly db: DbService,
    private readonly extraction: ExtractionService,
    private readonly runner: ExtractionRunner,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(DEFINITIONS) private readonly definitions: unknown,
    @Inject(EXTRACTION_SCHEMAS) private readonly schemas: ExtractionSchemas,
  ) {}

  /** One review command on a run the caller can see (404 otherwise); answers the run as it now stands. */
  async command(
    principal: Principal,
    requestId: string,
    id: string,
    body: ExtractionRunCommandBody,
  ): Promise<ExtractionRunDetail> {
    requireUuid(id, RUN_NOT_FOUND);
    if (body.command === 'retry') return this.retry(principal, requestId, id);
    const at = new Date(this.adapters.clock.now());
    const loaded = await this.db.run(principal, requestId, async (tx, audit) => {
      const locked = await this.lock(tx, id);
      const extractionSchema = this.schemaOf(locked);
      if (locked.state !== 'Succeeded')
        throw blocked(
          `extraction: ${body.command} needs a Succeeded run; this one is ${locked.state}`,
        );
      if (locked.approvedBy !== null)
        throw blocked('extraction: the run is already approved and promoted');
      const values = await loadValues(tx, id);
      switch (body.command) {
        case 'accept':
          await this.accept(tx, audit, principal, locked, extractionSchema, values, body.field, at);
          break;
        case 'reject':
          await this.reject(tx, audit, principal, locked, extractionSchema, values, body, at);
          break;
        case 'edit':
          await this.edit(tx, audit, principal, locked, extractionSchema, values, body, at);
          break;
        case 'acceptClean':
          await this.acceptClean(tx, audit, principal, locked, values, at);
          break;
        case 'approve':
          await this.approve(
            tx,
            audit,
            principal,
            locked,
            extractionSchema,
            values,
            body.reason,
            at,
          );
          break;
      }
      const after = await loadRunDetail(tx, id, this.schemas);
      if (after === null) throw new ProblemError(404, 'not-found', RUN_NOT_FOUND);
      return after;
    });
    return this.extraction.withPages(loaded);
  }

  /** The run row locked for the transaction, under the caller's own row-level security. */
  private async lock(tx: Tx, id: string): Promise<LockedRun> {
    const locked = (
      await tx
        .select({
          id: run.id,
          documentId: run.documentId,
          investmentId: run.investmentId,
          periodEnd: run.periodEnd,
          schemaId: run.schemaId,
          promptVersion: run.promptVersion,
          modelId: run.modelId,
          state: run.state,
          approvedBy: run.approvedBy,
          rowVersion: run.rowVersion,
        })
        .from(run)
        .where(eq(run.id, id))
        .for('update')
    )[0];
    if (locked === undefined) throw new ProblemError(404, 'not-found', RUN_NOT_FOUND);
    const doc = (
      await tx
        .select({ fileName: schema.document.fileName })
        .from(schema.document)
        .where(eq(schema.document.id, locked.documentId))
    )[0];
    return { ...locked, fileName: doc?.fileName ?? '' };
  }

  private schemaOf(locked: Pick<LockedRun, 'schemaId'>): ExtractionSchema {
    const found = this.schemas[locked.schemaId];
    if (found === undefined)
      throw new ProblemError(
        500,
        'configuration',
        `config/extraction_schema.json no longer holds the schema ${locked.schemaId}`,
      );
    return found;
  }

  /** The staged row of a field, which must be a schema field or a narrative row (400 naming the field otherwise). */
  private rowOf(
    extractionSchema: ExtractionSchema,
    values: readonly LoadedValue[],
    field: string,
  ): { row: LoadedValue; definition: ExtractionField | null } {
    const definition = extractionSchema.fields.find((f) => f.key === field) ?? null;
    const row = values.find((v) => v.field === field);
    if (row === undefined || (definition === null && !NARRATIVE_FIELDS.includes(field)))
      throw new ProblemError(400, 'validation', 'Invalid command', [
        { path: 'field', message: 'Unknown field for this run' },
      ]);
    return { row, definition };
  }

  private labelOf(definition: ExtractionField | null, field: string): string {
    if (definition !== null) return definition.label;
    return field === HIGHLIGHTS_FIELD
      ? 'Highlights'
      : field === COMMENTARY_FIELD
        ? 'Commentary'
        : field;
  }

  /**
   * Writes one decision, claimed on the row version the command read; audited with before and
   * after. The model's value and unit are never overwritten: an edit lives in its own two columns
   * and an accept clears them, so the row always shows what the model said (WF-1).
   */
  private async decide(
    tx: Tx,
    audit: (entry: AuditEntry) => Promise<void>,
    principal: Principal,
    locked: LockedRun,
    row: LoadedValue,
    set: { decision: string; editedValue: string | null; editedUnit: string | null },
    reason: string | undefined,
    at: Date,
  ): Promise<void> {
    const claimed = await tx
      .update(value)
      .set({
        decision: set.decision,
        editedValue: set.editedValue,
        editedUnit: set.editedUnit,
        reviewerId: principal.userId,
        decidedAt: at,
      })
      .where(and(eq(value.id, row.id), eq(value.rowVersion, row.rowVersion)))
      .returning();
    if (claimed[0] === undefined) throw conflict();
    await audit({
      action: `extraction_value.${set.decision === EDITED ? 'edit' : set.decision === REJECTED ? 'reject' : 'accept'}`,
      entity: VALUE_ENTITY,
      entityId: row.id,
      ...(reason !== undefined ? { reason } : {}),
      details: {
        runId: locked.id,
        documentId: locked.documentId,
        fileName: locked.fileName,
        field: row.field,
        validationState: row.validationState,
        before: {
          decision: row.decision,
          editedValue: row.editedValue,
          editedUnit: row.editedUnit,
        },
        after: {
          decision: set.decision,
          editedValue: set.editedValue,
          editedUnit: set.editedUnit,
        },
      },
    });
  }

  /**
   * accept: the value as the model answered it (an earlier edit is dropped). An invalid value is
   * refused with its first finding, and so is a highlights or commentary row with any finding:
   * a banned phrase, a wrong opening or an em dash is never written to the record (AI-4).
   */
  private async accept(
    tx: Tx,
    audit: (entry: AuditEntry) => Promise<void>,
    principal: Principal,
    locked: LockedRun,
    extractionSchema: ExtractionSchema,
    values: readonly LoadedValue[],
    field: string,
    at: Date,
  ): Promise<void> {
    const { row, definition } = this.rowOf(extractionSchema, values, field);
    const finding = findingsOf(row.findings)[0];
    const named = finding === undefined ? '' : `: ${finding.message}`;
    if (row.validationState === 'invalid')
      throw blocked(
        `extraction: ${this.labelOf(definition, field)} is invalid and cannot be accepted${named}; edit or reject it`,
      );
    if (definition === null && row.validationState !== 'clean')
      throw blocked(
        `extraction: ${this.labelOf(definition, field)} breaks the house style and cannot be accepted${named}; reject it`,
      );
    await this.decide(
      tx,
      audit,
      principal,
      locked,
      row,
      { decision: ACCEPTED, editedValue: null, editedUnit: null },
      undefined,
      at,
    );
  }

  /** reject: the value is left out of the promotion; the reason travels on the audit event. */
  private async reject(
    tx: Tx,
    audit: (entry: AuditEntry) => Promise<void>,
    principal: Principal,
    locked: LockedRun,
    extractionSchema: ExtractionSchema,
    values: readonly LoadedValue[],
    body: Extract<ExtractionRunCommandBody, { command: 'reject' }>,
    at: Date,
  ): Promise<void> {
    const { row } = this.rowOf(extractionSchema, values, body.field);
    await this.decide(
      tx,
      audit,
      principal,
      locked,
      row,
      { decision: REJECTED, editedValue: null, editedUnit: null },
      body.reason,
      at,
    );
  }

  /**
   * edit: a corrected value for a schema field, checked against the field's kind: a money field
   * takes a money unit (the contract, built with the schema's money fields), any other field takes
   * its own unit, the value must fit it, and the value must pass the rules the validator holds the
   * model to (valueProblem). The edited value, in the edit's unit, replaces the model's at
   * promotion; the model's value and unit stay on the row (WF-1).
   */
  private async edit(
    tx: Tx,
    audit: (entry: AuditEntry) => Promise<void>,
    principal: Principal,
    locked: LockedRun,
    extractionSchema: ExtractionSchema,
    values: readonly LoadedValue[],
    body: Extract<ExtractionRunCommandBody, { command: 'edit' }>,
    at: Date,
  ): Promise<void> {
    const parsed = extractionRunCommandBody(moneyFieldKeys(extractionSchema)).safeParse(body);
    if (!parsed.success)
      throw new ProblemError(400, 'validation', 'Invalid command', zodIssues(parsed.error));
    const { row, definition } = this.rowOf(extractionSchema, values, body.field);
    if (definition === null)
      throw new ProblemError(400, 'validation', 'Invalid command', [
        { path: 'field', message: 'Only a schema field can be edited' },
      ]);
    const unit: ExtractionUnit | null = body.unit ?? naturalUnitOf(definition);
    const errors: { path: string; message: string }[] = [];
    if (unit === null) errors.push({ path: 'unit', message: 'A money edit needs a money unit' });
    else if (!UNITS_BY_KIND[definition.kind].includes(unit))
      errors.push({ path: 'unit', message: `A ${definition.kind} field does not take ${unit}` });
    else if (!valueFitsUnit(body.value, unit))
      errors.push({ path: 'value', message: 'The value does not fit the unit' });
    else {
      const problem = this.valueProblem(locked, definition, body.value, unit);
      if (problem !== null) errors.push({ path: 'value', message: problem });
    }
    if (errors.length > 0 || unit === null)
      throw new ProblemError(400, 'validation', 'Invalid command', errors);
    await this.decide(
      tx,
      audit,
      principal,
      locked,
      row,
      { decision: EDITED, editedValue: body.value, editedUnit: unit },
      body.reason,
      at,
    );
  }

  /**
   * The rules the validator applies to the model's answer, applied to the reviewer's: a money
   * value converted to dollars must sit inside the configured range, which catches dollars typed
   * with the $M unit (docs/08 section 6, FIN-1); a date must be a quarter end, and the quarter the
   * run was opened for, since a report for another quarter is reclassified, not edited (docs/08
   * section 5, FIN-2).
   */
  private valueProblem(
    locked: LockedRun,
    definition: ExtractionField,
    value: string,
    unit: ExtractionUnit,
  ): string | null {
    if (definition.kind === 'money' && definition.bounds !== null) {
      const range = boundsFrom(this.definitions)[definition.bounds];
      const dollars = toDollars(value, unit);
      if (unitSanityFlag(dollars, { min: range.minUsd, max: range.maxUsd }))
        return `The value converts to ${dollars.toFixed()} dollars, outside the ${definition.bounds} range ${range.minUsd} to ${range.maxUsd}; check the unit`;
    }
    if (definition.kind === 'date') {
      if (!isQuarterEnd(value)) return 'The date must be a quarter end';
      if (locked.periodEnd !== null && value !== locked.periodEnd)
        return `The run covers ${locked.periodEnd}; a report for another quarter is reclassified, not edited`;
    }
    return null;
  }

  /** acceptClean: every undecided clean value, the narrative rows included, in one audited sweep. */
  private async acceptClean(
    tx: Tx,
    audit: (entry: AuditEntry) => Promise<void>,
    principal: Principal,
    locked: LockedRun,
    values: readonly LoadedValue[],
    at: Date,
  ): Promise<void> {
    const targets = values.filter((v) => v.validationState === 'clean' && v.decision === null);
    for (const row of targets) {
      const claimed = await tx
        .update(value)
        .set({
          decision: ACCEPTED,
          editedValue: null,
          editedUnit: null,
          reviewerId: principal.userId,
          decidedAt: at,
        })
        .where(and(eq(value.id, row.id), eq(value.rowVersion, row.rowVersion)))
        .returning();
      if (claimed[0] === undefined) throw conflict();
    }
    await audit({
      action: 'extraction_run.acceptClean',
      entity: ENTITY,
      entityId: locked.id,
      details: {
        documentId: locked.documentId,
        fileName: locked.fileName,
        fields: targets.map((v) => v.field),
      },
    });
  }

  /**
   * approve: the blockers first (409 naming the first), then the promotion as the system actor,
   * then the run's approval columns claimed on the row version the command read. A rejected
   * target leaves the record's column as it was, and so does an accepted value the document did
   * not state (null), since a promotion never writes a number the document did not give; an
   * undecided target is named, never silently left out. The period end must be the quarter the
   * run was opened for (422 otherwise: docs/08 section 5, rule 10).
   */
  private async approve(
    tx: Tx,
    audit: (entry: AuditEntry) => Promise<void>,
    principal: Principal,
    locked: LockedRun,
    extractionSchema: ExtractionSchema,
    values: readonly LoadedValue[],
    reason: string | undefined,
    at: Date,
  ): Promise<void> {
    const byField = new Map(values.map((v) => [v.field, v]));
    for (const field of extractionSchema.fields) {
      const row = byField.get(field.key);
      if (row === undefined)
        throw blocked(`extraction: ${field.label} was not staged for this run`);
      const decided = row.decision === ACCEPTED || row.decision === EDITED;
      if (field.required && !decided)
        throw blocked(`extraction: ${field.label} is required and not accepted or edited`);
      if (row.validationState === 'invalid' && row.decision !== EDITED && row.decision !== REJECTED)
        throw blocked(`extraction: ${field.label} is invalid and not edited or rejected`);
      if (row.validationState === 'flagged' && row.decision === null)
        throw blocked(`extraction: ${field.label} is flagged and undecided`);
      if (field.target !== null && row.decision === null)
        throw blocked(
          `extraction: ${field.label} is a record figure and undecided; accept, edit or reject it`,
        );
    }
    if (locked.investmentId === null)
      throw new ProblemError(
        422,
        'workflow-precondition',
        'extraction: the document is not linked to an investment; classify it with one first',
      );
    const finalOf = (row: LoadedValue): string | null =>
      row.decision === EDITED ? row.editedValue : row.decision === ACCEPTED ? row.value : null;
    const periodEndRow = byField.get('period_end');
    const periodEnd = periodEndRow === undefined ? null : finalOf(periodEndRow);
    if (periodEnd === null)
      throw blocked('extraction: Period end is required and not accepted or edited');
    // The figures land on the quarter the run was opened for and no other (FIN-2).
    if (!isQuarterEnd(periodEnd) || (locked.periodEnd !== null && periodEnd !== locked.periodEnd))
      throw new ProblemError(
        422,
        'workflow-precondition',
        `extraction: the period end ${periodEnd} is not the quarter the run covers (${locked.periodEnd ?? 'a quarter end'}); edit it`,
      );
    // An edited row converts with the edit's own unit, the model's value with the model's (WF-1).
    const unitOf = (row: LoadedValue): string | null =>
      row.decision === EDITED ? row.editedUnit : row.unit;
    const figures: QuarterlyFigures = {};
    const promotedFields: string[] = [];
    for (const field of extractionSchema.fields) {
      if (field.target === null) continue;
      const row = byField.get(field.key);
      if (row === undefined) continue;
      const final = finalOf(row);
      if (final === null) continue;
      const key = TARGET_KEYS[field.target];
      if (key === undefined) continue;
      const unit = unitOf(row);
      if (unit === null)
        throw blocked(`extraction: ${field.label} carries no money unit to convert from`);
      try {
        figures[key] = toDollars(final, extractionUnit.parse(unit)).toFixed();
      } catch (error) {
        if (error instanceof CalcError)
          throw blocked(`extraction: ${field.label} carries no money unit to convert from`);
        throw error;
      }
      promotedFields.push(field.key);
    }
    // The citation: the first promoted figure read from the document, in schema order (an edited
    // value has no page of its own), named in the locator.
    const cited = extractionSchema.fields.find((field) => {
      if (field.target === null) return false;
      const row = byField.get(field.key);
      return row?.decision === ACCEPTED && row.value !== null;
    });
    const citedRow = cited === undefined ? undefined : byField.get(cited.key);
    const highlightsRow = byField.get(HIGHLIGHTS_FIELD);
    const commentaryRow = byField.get(COMMENTARY_FIELD);
    const narrative = {
      ...(highlightsRow?.decision === ACCEPTED
        ? { highlights: highlightsOf(highlightsRow.value) }
        : {}),
      ...(commentaryRow?.decision === ACCEPTED ? { commentary: commentaryRow.value } : {}),
    };
    const approvalReason = reason ?? DEFAULT_APPROVAL_REASON;
    const investmentId = locked.investmentId;
    const promoted = await asSystemActor(tx, (stx) =>
      promoteQuarterlyPerformance(stx, audit, {
        label: 'extraction',
        investmentId,
        periodEnd,
        figures,
        approval: { approvedBy: principal.userId, approvedAt: at, approvalReason },
        lineage: {
          sourceDocumentId: locked.documentId,
          sourcePage: citedRow?.page ?? null,
          sourceLocator: cited === undefined ? null : `field:${cited.key}`,
          extractionRunId: locked.id,
          promptVersion: locked.promptVersion,
          modelId: locked.modelId,
        },
        narrative,
        details: {
          extractionRunId: locked.id,
          documentId: locked.documentId,
          fileName: locked.fileName,
          fields: promotedFields,
          narrative: Object.keys(narrative),
        },
      }),
    );
    const claimed = await tx
      .update(run)
      .set({ approvedBy: principal.userId, approvedAt: at, promotedRecordId: promoted.id })
      .where(and(eq(run.id, locked.id), eq(run.rowVersion, locked.rowVersion)))
      .returning();
    if (claimed[0] === undefined) throw conflict();
    await audit({
      action: 'extraction_run.approve',
      entity: ENTITY,
      entityId: locked.id,
      reason: approvalReason,
      details: {
        documentId: locked.documentId,
        fileName: locked.fileName,
        investmentId,
        periodEnd,
        before: { approvedBy: null, promotedRecordId: null },
        after: { approvedBy: principal.userId, promotedRecordId: promoted.id },
        created: promoted.created,
        figures: { before: promoted.before, after: promoted.after },
      },
    });
  }

  /**
   * retry: a NeedsRetry run is driven again through the machine; a Failed run gets a fresh Queued
   * run for the same document (same schema and prompt, no batch, requested by the caller), which
   * is driven at once and answered. Refused while the kill switch is off (409).
   */
  private async retry(
    principal: Principal,
    requestId: string,
    id: string,
  ): Promise<ExtractionRunDetail> {
    await this.runner.assertSwitchOn();
    const target = await this.db.run(principal, requestId, async (tx, audit) => {
      const locked = await this.lock(tx, id);
      if (locked.state === 'NeedsRetry') return locked.id;
      if (locked.state !== 'Failed')
        throw new ProblemError(
          409,
          'workflow-transition',
          `extraction_run: retry is not allowed from ${locked.state}`,
        );
      const source = (
        await tx
          .select({
            documentId: run.documentId,
            investmentId: run.investmentId,
            periodEnd: run.periodEnd,
            schemaId: run.schemaId,
            promptId: run.promptId,
            promptVersion: run.promptVersion,
          })
          .from(run)
          .where(eq(run.id, id))
      )[0];
      if (source === undefined) throw new ProblemError(404, 'not-found', RUN_NOT_FOUND);
      const created = await asSystemActor(tx, async (stx) => {
        const inserted = (
          await stx
            .insert(run)
            .values({ ...source, requestedBy: principal.userId })
            .returning()
        )[0];
        if (inserted === undefined)
          throw new ProblemError(500, 'internal', 'extraction: the run was not written');
        return inserted.id;
      });
      await audit({
        action: 'extraction_run.queue',
        entity: ENTITY,
        entityId: created,
        details: {
          documentId: source.documentId,
          fileName: locked.fileName,
          batchId: null,
          schemaId: source.schemaId,
          retryOf: id,
          state: { before: null, after: 'Queued' },
        },
      });
      return created;
    });
    await this.runner.processOne(principal, requestId, target);
    return this.extraction.detail(principal, requestId, target);
  }
}
