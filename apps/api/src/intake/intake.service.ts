import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AdapterSet, Principal } from '@pb/adapters';
import type {
  IntakeCommandBody,
  IntakeFileDetail,
  IntakeFilePage,
  IntakeImportBody,
  IntakeImportResult,
  StagingState,
  intakeExportList,
  intakeFileListQuery,
} from '@pb/contracts';
import { SYSTEM_USER_ID, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import {
  diffRow,
  emptyCounts,
  fileStatusOf,
  readAccountingFile,
  sameValue,
  selectTargets,
} from '@pb/validation';
import type { RowDiff } from '@pb/validation';
import { attempt, stagingMachine } from '@pb/workflows';
import type { z } from 'zod';
import { AT_ID_CURSOR, EXACT_AT_FORMAT, decodeAtIdCursor, encodeCursor } from '../common/cursor.js';
import { ProblemError, workflowProblem } from '../common/problem.js';
import { ACCOUNTING_LAYOUT, ADAPTERS, DEFINITIONS } from '../common/tokens.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import type { AuditEntry } from '../db/db.service.js';
import {
  ACCOUNTING_SOURCES,
  NOT_FOUND,
  accountingLayoutOf,
  contentHashOf,
  countsByFile,
  exceptionsByFile,
  fileRowOf,
  fileColumns,
  importLabel,
  intakeSettingsOf,
  loadFile,
  receiver,
  stageFile,
  toFile,
} from './stage.js';
import type { StagedRow } from './stage.js';

/*
 * The accounting import (docs/04 M2, SEC-9.1): a file is read against config/accounting_layout.json,
 * every row is linked to an investment (docs/03 section 5), diffed against the approved quarter on
 * record and run through the validation rules, then staged in stg.* with its findings. Nothing
 * reaches mon.quarterly_performance until a reviewer approves, and promotion happens in the same
 * transaction as the approval with an audit event per row (docs/18 section 2). Linking, the diff and
 * the rules are the shared preparation of @pb/validation (prepare.ts, the same code the preview
 * runs in the browser); the staging itself (the duplicate check, the system-actor preparation, the
 * file, its rows, its exceptions and the audit event) is stage.ts, shared with the operations
 * workbook drop, which reads a workbook into the same rows (decision 0010). There the preparation
 * runs as the system actor (DbService.runAsSystem), the one actor that sees every position on
 * record, walled ones included: an export covers the whole book, and a walled position must link
 * rather than read as "no match". Everything a caller reads or writes runs under their own
 * row-level security through DbService.run: a staged row linked to a position they cannot open is
 * left out and counted, a candidate they cannot open is dropped from the link, and promotion writes
 * only what they may see. A staged diff is a snapshot taken at staging: promotion reads the quarter
 * on record again and refuses the approval when the record no longer matches what the reviewer was
 * shown (decision 0009, promotion safety). The detail and the commands answer the accounting
 * sources only (stage.ts ACCOUNTING_SOURCES): a weekly file or a look-through run has its own
 * pages, and is not found here. The list covers every source.
 */

export type IntakeListOptions = z.infer<typeof intakeFileListQuery>;
export type IntakeExportList = z.infer<typeof intakeExportList>;

const SOURCE = 'accounting';
const EXCEPTION_SOURCE = 'accounting_import';
/** The four figures the import writes; the fair value only ties to the Locked mark (TIE-01) and is never written. */
type PromotedFigures = Record<'revenueLtm' | 'ebitdaLtm' | 'ev' | 'netDebt', string | null>;

const file = schema.intakeFile;
const row = schema.intakeRow;
const quarter = schema.quarterlyPerformance;

/** The same diff: the same kind and the same field changes, values compared as decimals. */
function sameDiff(a: RowDiff, b: RowDiff): boolean {
  return (
    a.kind === b.kind &&
    a.changes.length === b.changes.length &&
    a.changes.every((change, i) => {
      const other = b.changes[i];
      if (other === undefined) return false;
      return (
        other.field === change.field &&
        sameValue(other.before, change.before) &&
        sameValue(other.after, change.after)
      );
    })
  );
}

/** The problem when a command finds a row already changed by another command. */
const rowConflict = (): ProblemError =>
  new ProblemError(
    409,
    'conflict',
    'staging: another command changed the row first; open the file again',
  );

@Injectable()
export class IntakeService {
  constructor(
    private readonly db: DbService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(DEFINITIONS) private readonly definitions: unknown,
    @Inject(ACCOUNTING_LAYOUT) private readonly rawLayout: unknown,
  ) {}

  /** The exports waiting in the accounting drop folder (the local folder adapter in the prototype). */
  async exports(): Promise<IntakeExportList> {
    return { items: await this.adapters.accounting.listExports() };
  }

  /** The file text as uploaded, or read from the drop folder by id; an id the folder does not list is not found. */
  private async fileText(body: IntakeImportBody): Promise<{ fileName: string; text: string }> {
    if ('csv' in body) return { fileName: body.fileName, text: body.csv };
    const listed = await this.adapters.accounting.listExports();
    const ref = listed.find((e) => e.id === body.exportId);
    if (ref === undefined) throw new ProblemError(404, 'not-found', 'Export not found');
    return { fileName: ref.name, text: await this.adapters.accounting.readExport(ref.id) };
  }

  /**
   * Stage an accounting export: the CSV is read against the layout, then staged by the shared
   * staging (stage.ts): idempotent by the SHA-256 of the text, a refused file re-stageable, one
   * transaction for the file, its rows and its exceptions with one audit event of counts only.
   */
  async import(
    principal: Principal,
    requestId: string,
    body: IntakeImportBody,
  ): Promise<IntakeImportResult> {
    const settings = intakeSettingsOf(this.definitions);
    const layout = accountingLayoutOf(this.rawLayout);
    const { fileName, text } = await this.fileText(body);
    if (Buffer.byteLength(text, 'utf8') > settings.maxFileBytes)
      throw new ProblemError(400, 'validation', 'The file is larger than one import accepts');
    return stageFile(this.db, principal, requestId, {
      source: SOURCE,
      exceptionSource: EXCEPTION_SOURCE,
      fileName,
      contentHash: contentHashOf(text),
      read: () => ({
        file: readAccountingFile(text, layout, { maxRows: settings.maxRows }),
        templateSignature: null,
      }),
      layout,
      settings,
      asOf: this.adapters.clock.today(),
    });
  }

  /**
   * Intake files newest first, with the counts of their rows. Row-level security limits the files
   * to the reviewing roles; the controller adds a 403 for the rest.
   */
  async list(
    principal: Principal,
    requestId: string,
    opts: IntakeListOptions,
  ): Promise<IntakeFilePage> {
    return this.db.run(principal, requestId, async (tx) => {
      // Every intake writes stg.intake_file; the list covers them all unless the caller names a source.
      const conditions: (SQL | undefined)[] = [];
      if (opts.source !== undefined) conditions.push(eq(file.source, opts.source));
      // The cursor is "receivedAt|id" of the last file (common/cursor.ts).
      if (opts.cursor !== undefined) {
        const key = decodeAtIdCursor(opts.cursor, AT_ID_CURSOR);
        const at = sql`${key.at}::timestamptz`;
        conditions.push(
          or(
            lt(file.receivedAt, at),
            and(eq(file.receivedAt, at), lt(file.id, sql`${key.id}::uuid`)),
          ),
        );
      }
      if (opts.status !== undefined) conditions.push(eq(file.status, opts.status));
      const rows = await tx
        .select({
          ...fileColumns,
          exactAt: sql<string>`to_char(${file.receivedAt} at time zone 'UTC', ${EXACT_AT_FORMAT})`,
        })
        .from(file)
        .leftJoin(receiver, eq(receiver.id, file.receivedBy))
        .where(and(...conditions))
        .orderBy(desc(file.receivedAt), desc(file.id))
        .limit(opts.limit + 1);
      const page = rows.slice(0, opts.limit);
      const ids = page.map((r) => r.id);
      const counts = await countsByFile(tx, ids);
      const exceptions = await exceptionsByFile(tx, ids);
      const last = page[page.length - 1];
      return {
        items: page.map((r) =>
          toFile(r, counts.get(r.id) ?? emptyCounts(), exceptions.get(r.id) ?? 0),
        ),
        nextCursor:
          rows.length > opts.limit && last !== undefined
            ? encodeCursor([last.exactAt, last.id])
            : null,
      };
    });
  }

  /** The file with every staged row the caller may see; a file the caller cannot see is 404. The open is audited. */
  async detail(principal: Principal, requestId: string, fileId: string): Promise<IntakeFileDetail> {
    requireUuid(fileId, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const loaded = await loadFile(tx, fileId);
      if (loaded === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      await audit({ action: 'intake_file.read', entity: 'stg.intake_file', entityId: fileId });
      return loaded.detail;
    });
  }

  /**
   * approve: the rows named (or every validated row the caller sees) go validated > approved by the
   * caller, then approved > promoted by the system, in this one transaction; promotion writes the
   * approved quarter and audits before and after. reject: the rows named (or every flagged row)
   * are rejected with the reason the machine requires. A command with nothing left to do answers
   * the unchanged file.
   */
  async command(
    principal: Principal,
    requestId: string,
    fileId: string,
    body: IntakeCommandBody,
  ): Promise<IntakeFileDetail> {
    requireUuid(fileId, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      // Commands on one file run one at a time: the file row stays locked until this transaction
      // ends, so a second reviewer's command waits and then reads the rows as this one left them.
      // Only an accounting-shaped file is locked: another source's file is not found below.
      await tx
        .select({ id: file.id })
        .from(file)
        .where(and(eq(file.id, fileId), inArray(file.source, [...ACCOUNTING_SOURCES])))
        .for('update');
      const loaded = await loadFile(tx, fileId);
      if (loaded === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      const wanted: StagingState = body.command === 'approve' ? 'validated' : 'flagged';
      // The rows named must be rows of this file the caller sees, in the state the command needs
      // (the shared rule in @pb/validation); naming a hidden row is the same as naming a row of another file.
      const selected = selectTargets(loaded.visible, body.rowIds, wanted);
      if (!selected.ok)
        throw new ProblemError(400, 'validation', 'Invalid rowIds', [selected.refusal]);
      const targets = selected.rows;
      const at = new Date(this.adapters.clock.now());
      for (const target of targets) {
        if (body.command === 'approve')
          await this.promote(tx, audit, principal, loaded.detail, target, body.reason, at);
        else await this.reject(tx, principal, target, body.reason, at);
      }
      if (targets.length > 0) await this.refreshStatus(tx, fileId);
      await audit({
        action: `intake.${body.command}`,
        entity: 'stg.intake_file',
        entityId: fileId,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        details: { fileName: loaded.detail.fileName, rows: targets.length },
      });
      const after = await loadFile(tx, fileId);
      if (after === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      return after.detail;
    });
  }

  /**
   * One row's approval and promotion. The approved figures replace the matched quarter or create
   * the quarter the record lacked, with the approver, the time, the reason and the lineage to the
   * file and row (SEC-9.4); the audit event carries the figures before and after (CLAUDE.md rule 6).
   */
  private async promote(
    tx: Tx,
    audit: (entry: AuditEntry) => Promise<void>,
    principal: Principal,
    detail: IntakeFileDetail,
    target: StagedRow,
    reason: string | undefined,
    at: Date,
  ): Promise<void> {
    const approved = attempt(stagingMachine, 'validated', 'approve', {
      actorId: principal.userId,
      actorRoles: principal.roles,
      record: {},
    });
    if (!approved.ok) throw workflowProblem(approved);
    const promoted = attempt(stagingMachine, 'approved', 'promote', {
      actorId: SYSTEM_USER_ID,
      actorRoles: ['service'],
      record: {},
    });
    if (!promoted.ok) throw workflowProblem(promoted);
    const investmentId = target.payload.link.investmentId;
    if (investmentId === null)
      throw new ProblemError(
        422,
        'workflow-precondition',
        'staging: the row is not linked to an investment',
      );
    const periodEnd = target.payload.quarterEnd;
    if (periodEnd === null)
      throw new ProblemError(
        422,
        'workflow-precondition',
        'staging: the row has no period end to promote to',
      );
    const figures: PromotedFigures = {
      revenueLtm: target.payload.figures.revenueLtm,
      ebitdaLtm: target.payload.figures.ebitdaLtm,
      ev: target.payload.figures.ev,
      netDebt: target.payload.figures.netDebt,
    };
    const approval = {
      status: 'record_status.approved',
      approvedBy: principal.userId,
      approvedAt: at,
      approvalReason: reason ?? importLabel(detail),
      sourceLocator: `intake_file:${detail.id}/row:${target.rowNo}`,
    };
    const precondition = (detail: string): ProblemError =>
      new ProblemError(422, 'workflow-precondition', detail);

    // The quarter on record: the one the diff was made against, or any row at the period end
    // (docs/04 M2 asks for an upsert), each visible to the caller under row-level security.
    const existing = (
      await tx
        .select({
          id: quarter.id,
          periodEnd: quarter.periodEnd,
          revenueLtm: quarter.revenueLtm,
          ebitdaLtm: quarter.ebitdaLtm,
          ev: quarter.ev,
          netDebt: quarter.netDebt,
          status: quarter.status,
          isEntrySnapshot: quarter.isEntrySnapshot,
        })
        .from(quarter)
        .where(
          target.targetId !== null
            ? eq(quarter.id, target.targetId)
            : and(eq(quarter.investmentId, investmentId), eq(quarter.periodEnd, periodEnd)),
        )
        .limit(1)
    )[0];
    // The diff the reviewer approved is a snapshot taken at staging. The record is read again
    // here, in the approval transaction: an entry snapshot is never written from an import, a
    // quarter that is not approved is not the record, and a record that no longer gives the same
    // diff (a restatement approved from another file in between) would be overwritten blind.
    if (existing?.isEntrySnapshot === true)
      throw precondition(
        'staging: the quarter on record is the entry snapshot, which an import never changes',
      );
    if (existing !== undefined && existing.status !== 'record_status.approved')
      throw precondition('staging: the quarter on record is not approved; import the file again');
    if (!sameDiff(diffRow(fileRowOf(target), existing ?? null), target.diff))
      throw precondition(
        'staging: the quarter on record changed since the file was staged; import the file again',
      );

    let written: { id: string } & PromotedFigures;
    let before: PromotedFigures;
    if (existing !== undefined) {
      const updated = await tx
        .update(quarter)
        .set({ ...figures, ...approval })
        .where(eq(quarter.id, existing.id))
        .returning();
      const result = updated[0];
      if (result === undefined)
        throw precondition('staging: the quarter on record cannot be updated by this caller');
      written = result;
      before = {
        revenueLtm: existing.revenueLtm,
        ebitdaLtm: existing.ebitdaLtm,
        ev: existing.ev,
        netDebt: existing.netDebt,
      };
    } else {
      const inserted = await tx
        .insert(quarter)
        .values({
          investmentId,
          periodEnd,
          ...figures,
          ...approval,
          isEntrySnapshot: false,
          currency: 'USD',
          highlights: [],
          commentary: null,
        })
        .returning();
      const result = inserted[0];
      if (result === undefined) throw precondition('staging: the quarter was not written');
      written = result;
      before = { revenueLtm: null, ebitdaLtm: null, ev: null, netDebt: null };
    }
    // The figures after are the values as stored, read back from the row written, never the
    // file's text (rule 6: the audit records what the record now holds).
    const after: PromotedFigures = {
      revenueLtm: written.revenueLtm,
      ebitdaLtm: written.ebitdaLtm,
      ev: written.ev,
      netDebt: written.netDebt,
    };
    await audit({
      action: 'quarterly_performance.promote',
      entity: 'mon.quarterly_performance',
      entityId: written.id,
      reason: approval.approvalReason,
      details: {
        intakeFileId: detail.id,
        intakeRowId: target.id,
        fileName: detail.fileName,
        rowNo: target.rowNo,
        before,
        after,
      },
    });
    // The row is claimed in the state the command read it in; another command that changed it
    // first makes this one a conflict (the whole batch rolls back).
    const claimed = await tx
      .update(row)
      .set({
        status: 'promoted',
        decision: approval.approvalReason,
        reviewerId: principal.userId,
        decidedAt: at,
        promotedAt: at,
        targetId: written.id,
      })
      .where(and(eq(row.id, target.id), eq(row.status, 'validated')))
      .returning();
    if (claimed[0] === undefined) throw rowConflict();
  }

  private async reject(
    tx: Tx,
    principal: Principal,
    target: StagedRow,
    reason: string | undefined,
    at: Date,
  ): Promise<void> {
    const result = attempt(stagingMachine, 'flagged', 'reject', {
      actorId: principal.userId,
      actorRoles: principal.roles,
      ...(reason !== undefined ? { reason } : {}),
      record: {},
    });
    if (!result.ok) throw workflowProblem(result);
    const claimed = await tx
      .update(row)
      .set({
        status: 'rejected',
        decision: reason ?? null,
        reviewerId: principal.userId,
        decidedAt: at,
      })
      .where(and(eq(row.id, target.id), eq(row.status, 'flagged')))
      .returning();
    if (claimed[0] === undefined) throw rowConflict();
  }

  /** The file status recomputed from every row (the contract's rule), after a command changed some. */
  private async refreshStatus(tx: Tx, fileId: string): Promise<void> {
    const counts = (await countsByFile(tx, [fileId])).get(fileId) ?? emptyCounts();
    await tx
      .update(file)
      .set({ status: fileStatusOf(counts) })
      .where(eq(file.id, fileId));
  }
}
