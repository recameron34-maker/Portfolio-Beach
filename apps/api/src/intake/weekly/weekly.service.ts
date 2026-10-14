import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AdapterSet, Principal } from '@pb/adapters';
import { intakeFinding, intakeLink, intakeSource, weeklyPriorSource } from '@pb/contracts';
import type {
  IntakeCommandBody,
  IntakeExportList,
  IntakeFile,
  StagingState,
  WeeklyFileDetail,
  WeeklyImportBody,
  WeeklyImportResult,
  WeeklyRow as WeeklyRowOut,
} from '@pb/contracts';
import { asSystemActor, SYSTEM_USER_ID, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import {
  IntakeSettingsError,
  WEEKLY_RULES,
  countsOf,
  digitsOf,
  emptyCounts,
  exceptionsOpenedBy,
  fileStatusOf,
  intakeSettingsFrom,
  linkOf,
  linkRows,
  readWeeklyFile,
  reportDateOf,
  reportedValueOf,
  runRules,
  selectTargets,
  statusFromFindings,
  weeklyFlagOf,
  weeklyRuleConfigFrom,
  weeklyVariance,
} from '@pb/validation';
import type {
  Finding,
  LinkResult,
  StagingCounts,
  WeeklyLinkedRow,
  WeeklyPrior,
  WeeklyRow,
  WeeklyRuleConfig,
} from '@pb/validation';
import { attempt, stagingMachine } from '@pb/workflows';
import { z } from 'zod';
import { configError } from '../../common/definitions.js';
import { ProblemError, workflowProblem } from '../../common/problem.js';
import { ADAPTERS, DEFINITIONS } from '../../common/tokens.js';
import { requireUuid } from '../../common/validate.js';
import { DbService } from '../../db/db.service.js';
import type { AuditEntry } from '../../db/db.service.js';
import { investmentDirectory, matchGuards } from '../directory.js';

/*
 * The weekly report values (docs/04 M2 weekly-report-intake, decision 0010, SEC-9.1): a
 * four-column file is read, every row is linked to an investment as the system actor (the one
 * actor that sees the whole book, walled positions included, decision 0009), compared with its
 * prior (the latest Locked mark on or before the report date, or the weekly value promoted after
 * that mark) and run through the weekly rules, then staged in stg.valuation with its findings.
 * A weekly value never becomes a mark: approval creates a Draft valuation of method
 * weekly_report for the valuation workflow to carry, in the same transaction as the approval,
 * with an audit event per valuation (docs/18 sections 1 and 2). Every caller reads and writes
 * under their own row-level security through DbService.run: a staged value linked to a position
 * they cannot open is left out and counted, a candidate they cannot open is dropped from the
 * link, and a command acts on the rows they see.
 */

const SOURCE = 'weekly';
const EXCEPTION_SOURCE = 'weekly_intake';
const ENTITY = 'stg.valuation';
/** The valuation method of a Draft created from a weekly value (core.taxonomy_term, migration 0010). */
const METHOD = 'valuation_method.weekly_report';
/** A rule error opens a high exception (core.taxonomy_term exception_severity): the row cannot be promoted until a person resolves it. */
const EXCEPTION_SEVERITY = 'exception_severity.high';
const NOT_FOUND = 'Weekly values file not found';
const INSERT_CHUNK = 500;
/** Digits before the point that stg.valuation.variance_pct (numeric 20,8) holds. */
const VARIANCE_INTEGER_DIGITS = 12;
const VARIANCE_SCALE = 8;

const findingList = z.array(intakeFinding);
const rawCells = z.record(z.string(), z.string());

/** One staged value as the database holds it, with its jsonb columns parsed. */
interface StagedValue {
  id: string;
  rowNo: number;
  investmentNumber: string | null;
  companyName: string | null;
  investmentId: string | null;
  reportDate: string | null;
  reportedValue: string | null;
  priorValue: string | null;
  priorSource: string | null;
  priorDate: string | null;
  variancePct: string | null;
  flag: string | null;
  status: StagingState;
  decision: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  valuationId: string | null;
  link: z.infer<typeof intakeLink>;
  findings: Finding[];
  raw: Record<string, string>;
}

/** A row of the file after linking, comparison and the rules, ready to stage. */
interface PreparedValue {
  row: WeeklyRow;
  link: LinkResult;
  /** The report date when it is a real day the intake reads; else null (the raw cell stays on the row). */
  reportDate: string | null;
  /** The value when it is a decimal the record holds as written; else null. */
  reportedValue: string | null;
  prior: WeeklyPrior | null;
  variancePct: string | null;
  flag: 'above_threshold' | null;
  findings: Finding[];
  status: 'validated' | 'flagged';
}

/** A file with every row (for counts) and the rows the caller may see (for the response). */
interface LoadedFile {
  detail: WeeklyFileDetail;
  visible: StagedValue[];
}

const file = schema.intakeFile;
const staged = schema.stagedValuation;
const valuation = schema.valuation;
const receiver = alias(schema.appUser, 'receiver');
const reviewer = alias(schema.appUser, 'reviewer');

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A refused file (the header was wrong, so it holds no rows) is read again when the same bytes come back. */
const restageable = (f: Pick<IntakeFile, 'status' | 'rowCount'>): boolean =>
  f.status === 'new' && f.rowCount === 0;

/** The problem when a command finds a row already changed by another command. */
const rowConflict = (): ProblemError =>
  new ProblemError(
    409,
    'conflict',
    'staging: another command changed the row first; open the file again',
  );

const precondition = (detail: string): ProblemError =>
  new ProblemError(422, 'workflow-precondition', detail);

/** A Locked mark as the prior rule reads it. */
interface Mark {
  periodEnd: string;
  fairValue: string;
  version: number;
}

/** A promoted weekly value as the prior rule reads it. */
interface PromotedWeekly {
  reportDate: string;
  reportedValue: string;
}

/**
 * The prior for a report date (decision 0010): the latest Locked mark on or before the report
 * date (a mark locked for a later date did not exist when the week was reported), or the latest
 * promoted weekly value reported after that mark and on or before this report date.
 */
export function priorFor(
  reportDate: string,
  marks: readonly Mark[],
  weeklies: readonly PromotedWeekly[],
): WeeklyPrior | null {
  let mark: Mark | null = null;
  for (const m of marks) {
    if (m.periodEnd > reportDate) continue;
    if (
      mark === null ||
      m.periodEnd > mark.periodEnd ||
      (m.periodEnd === mark.periodEnd && m.version > mark.version)
    )
      mark = m;
  }
  let weekly: PromotedWeekly | null = null;
  for (const w of weeklies) {
    if (w.reportDate > reportDate) continue;
    if (mark !== null && w.reportDate <= mark.periodEnd) continue;
    // The list is in promotion order: a later promotion of the same date is the one that stands.
    if (weekly === null || w.reportDate >= weekly.reportDate) weekly = w;
  }
  if (weekly !== null)
    return { value: weekly.reportedValue, source: 'weekly', date: weekly.reportDate };
  if (mark !== null) return { value: mark.fairValue, source: 'locked_mark', date: mark.periodEnd };
  return null;
}

@Injectable()
export class WeeklyService {
  constructor(
    private readonly db: DbService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(DEFINITIONS) private readonly definitions: unknown,
  ) {}

  /**
   * Every limit and threshold through the strict readers (CLAUDE.md rules 9 and 10): the byte
   * and row limits one import takes are the intake's, the weekly thresholds the rule module's;
   * a missing key is a 500 naming it, never a default.
   */
  private settings(): { maxRows: number; maxFileBytes: number; rules: WeeklyRuleConfig } {
    try {
      const shared = intakeSettingsFrom(this.definitions);
      return {
        maxRows: shared.maxRows,
        maxFileBytes: shared.maxFileBytes,
        rules: weeklyRuleConfigFrom(this.definitions),
      };
    } catch (error) {
      if (error instanceof IntakeSettingsError) throw configError(error.key);
      throw error;
    }
  }

  /** The files waiting in the weekly drop folder (the local folder adapter in the prototype). */
  async drops(): Promise<IntakeExportList> {
    return { items: await this.adapters.weeklyDrop.listFiles() };
  }

  /** The file text as uploaded, or read from the drop folder by id; an id the folder does not list is not found. */
  private async fileText(body: WeeklyImportBody): Promise<{ fileName: string; text: string }> {
    if ('csv' in body) return { fileName: body.fileName, text: body.csv };
    const listed = await this.adapters.weeklyDrop.listFiles();
    const ref = listed.find((e) => e.id === body.dropId);
    if (ref === undefined) throw new ProblemError(404, 'not-found', 'Drop file not found');
    return { fileName: ref.name, text: await this.adapters.weeklyDrop.readText(ref.id) };
  }

  /**
   * Stage a weekly values file. Idempotent by content: the same text answers the file it created
   * before with `duplicate` true and stages nothing (docs/04 M2), audited as a read of that file.
   * A file whose header was refused (status new, no rows) is read again. Otherwise the file, its
   * rows and the data exceptions land in one transaction with one audit event that carries counts
   * only.
   */
  async import(
    principal: Principal,
    requestId: string,
    body: WeeklyImportBody,
  ): Promise<WeeklyImportResult> {
    const settings = this.settings();
    const { fileName, text } = await this.fileText(body);
    if (Buffer.byteLength(text, 'utf8') > settings.maxFileBytes)
      throw new ProblemError(400, 'validation', 'The file is larger than one import accepts');
    const contentHash = createHash('sha256').update(text).digest('hex');
    const asOf = this.adapters.clock.today();

    const existing = await this.db.run(principal, requestId, async (tx, audit) => {
      const found = await this.findByHash(tx, contentHash);
      if (found !== null && !restageable(found))
        await audit({ action: 'intake_file.read', entity: 'stg.intake_file', entityId: found.id });
      return found;
    });
    if (existing !== null && !restageable(existing)) return { ...existing, duplicate: true };

    const read = readWeeklyFile(text, { maxRows: settings.maxRows });
    // A file the layout refuses (a column missing or added, nothing to read) holds no rows: a
    // renamed column must never be guessed at.
    const refused = read.fileFindings.some((f) => f.severity === 'error');
    // The system actor links against the whole book and reads the priors (see the module comment).
    const prepared = refused
      ? []
      : await this.db.runAsSystem((tx) => this.prepare(tx, read.rows, settings.rules, asOf));

    return this.db.run(principal, requestId, async (tx, audit) => {
      const counts = countsOf(prepared.map((p) => p.status));
      const header = {
        rowCount: prepared.length,
        status: fileStatusOf(counts),
        findings: read.fileFindings,
      };
      // The same content landed from another request meanwhile: answer that file.
      const raced = async (): Promise<WeeklyImportResult> => {
        const found = await this.findByHash(tx, contentHash);
        if (found === null) throw new ProblemError(409, 'conflict', 'The import did not complete');
        return { ...found, duplicate: true };
      };
      let fileId: string;
      let name: string;
      if (existing === null) {
        const inserted = await tx
          .insert(file)
          .values({
            source: SOURCE,
            fileName,
            contentHash,
            receivedBy: principal.userId,
            ...header,
          })
          .onConflictDoNothing({ target: [file.source, file.contentHash] })
          .returning();
        const id = inserted[0]?.id;
        if (id === undefined) return raced();
        fileId = id;
        name = fileName;
      } else {
        // A refused file staged again: the row the refusal left behind is reused (the content hash
        // is its key). Refused again, it keeps its name and receipt with the findings brought up
        // to date and the earlier answer (duplicate). The guard keeps two re-imports apart.
        const updated = await tx
          .update(file)
          .set(
            refused
              ? { findings: read.fileFindings }
              : { ...header, receivedAt: sql`now()`, receivedBy: principal.userId },
          )
          .where(and(eq(file.id, existing.id), eq(file.status, 'new'), eq(file.rowCount, 0)))
          .returning();
        if (updated[0] === undefined) return raced();
        fileId = existing.id;
        name = existing.fileName;
      }

      await this.insertRows(tx, fileId, prepared);
      await audit({
        action: 'intake.import',
        entity: 'stg.intake_file',
        entityId: fileId,
        details: { fileName: name, rowCount: prepared.length, counts },
      });
      const loaded = await this.load(tx, fileId);
      if (loaded === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      return { ...loaded.detail, duplicate: existing !== null && refused };
    });
  }

  private async findByHash(tx: Tx, contentHash: string): Promise<WeeklyFileDetail | null> {
    const found = await tx
      .select({ id: file.id })
      .from(file)
      .where(and(eq(file.source, SOURCE), eq(file.contentHash, contentHash)));
    const id = found[0]?.id;
    if (id === undefined) return null;
    return (await this.load(tx, id))?.detail ?? null;
  }

  /**
   * Links every row against the directory and the match guards (the shared linking of
   * @pb/validation), finds each linked row's prior among the Locked marks and the promoted weekly
   * values of its position, takes the variance and runs the weekly rules.
   */
  private async prepare(
    tx: Tx,
    rows: readonly WeeklyRow[],
    config: WeeklyRuleConfig,
    asOf: string,
  ): Promise<PreparedValue[]> {
    const directory = await investmentDirectory(tx);
    const guards = await matchGuards(tx);
    const linked: WeeklyLinkedRow[] = linkRows(rows, directory, guards);
    const investmentIds = [
      ...new Set(linked.flatMap((l) => (l.link.investment === null ? [] : [l.link.investment.id]))),
    ];
    const marks = await this.lockedMarks(tx, investmentIds);
    const weeklies = await this.promotedWeeklies(tx, investmentIds);
    return linked.map(({ row, link }) => {
      const reportDate = reportDateOf(row, config);
      const investmentId = link.investment?.id ?? null;
      const prior =
        reportDate === null || investmentId === null
          ? null
          : priorFor(reportDate, marks.get(investmentId) ?? [], weeklies.get(investmentId) ?? []);
      const findings = runRules(WEEKLY_RULES, { row, file: linked, link, prior, asOf, config });
      const fits = !findings.some((f) => f.ruleId === 'WK-TYPE-05');
      const decimal = reportedValueOf(row);
      const variance = weeklyVariance(row.reportedValue, prior);
      return {
        row,
        link,
        reportDate,
        // The typed column holds the value only as the record can hold it; otherwise the raw cell
        // is what the reviewer sees and nothing is rounded (CLAUDE.md rule 10).
        reportedValue: decimal !== null && fits ? decimal.toFixed() : null,
        prior,
        variancePct:
          variance !== null &&
          digitsOf(variance.toFixed(VARIANCE_SCALE)).integerDigits <= VARIANCE_INTEGER_DIGITS
            ? variance.toFixed(VARIANCE_SCALE)
            : null,
        flag: weeklyFlagOf(findings),
        findings,
        status: statusFromFindings(findings),
      };
    });
  }

  /** Locked marks per investment, as the prior rule reads them. */
  private async lockedMarks(
    tx: Tx,
    investmentIds: readonly string[],
  ): Promise<Map<string, Mark[]>> {
    const out = new Map<string, Mark[]>();
    if (investmentIds.length === 0) return out;
    const rows = await tx
      .select({
        investmentId: valuation.investmentId,
        periodEnd: valuation.periodEnd,
        fairValue: valuation.fairValue,
        version: valuation.version,
      })
      .from(valuation)
      .where(
        and(inArray(valuation.investmentId, [...investmentIds]), eq(valuation.state, 'Locked')),
      )
      .orderBy(asc(valuation.periodEnd), desc(valuation.version));
    for (const { investmentId, ...mark } of rows) {
      const list = out.get(investmentId);
      if (list === undefined) out.set(investmentId, [mark]);
      else list.push(mark);
    }
    return out;
  }

  /** Promoted weekly values per investment (a Draft valuation was created from them), in promotion order. */
  private async promotedWeeklies(
    tx: Tx,
    investmentIds: readonly string[],
  ): Promise<Map<string, PromotedWeekly[]>> {
    const out = new Map<string, PromotedWeekly[]>();
    if (investmentIds.length === 0) return out;
    const rows = await tx
      .select({
        investmentId: staged.investmentId,
        reportDate: staged.reportDate,
        reportedValue: staged.reportedValue,
      })
      .from(staged)
      .where(
        and(
          inArray(staged.investmentId, [...investmentIds]),
          eq(staged.status, 'promoted'),
          isNotNull(staged.valuationId),
          isNotNull(staged.reportDate),
          isNotNull(staged.reportedValue),
        ),
      )
      .orderBy(asc(staged.promotedAt), asc(staged.rowNo));
    for (const r of rows) {
      if (r.investmentId === null || r.reportDate === null || r.reportedValue === null) continue;
      const list = out.get(r.investmentId);
      const entry = { reportDate: r.reportDate, reportedValue: r.reportedValue };
      if (list === undefined) out.set(r.investmentId, [entry]);
      else list.push(entry);
    }
    return out;
  }

  /** Writes the staged values and the data exceptions they open (unresolved names). */
  private async insertRows(
    tx: Tx,
    fileId: string,
    prepared: readonly PreparedValue[],
  ): Promise<void> {
    const ids = new Map<number, string>();
    for (const batch of chunk(prepared, INSERT_CHUNK)) {
      // Ids are given here, not returned: a RETURNING clause reads the new rows through the select
      // policy, and the importer outside a wall may write the walled position's row but not read it.
      const values = batch.map((p) => ({
        id: randomUUID(),
        intakeFileId: fileId,
        rowNo: p.row.rowNo,
        reportDate: p.reportDate,
        investmentNumber: p.row.investmentNumber,
        companyName: p.row.companyName,
        investmentId: p.link.investment?.id ?? null,
        reportedValue: p.reportedValue,
        priorValue: p.prior?.value ?? null,
        priorSource: p.prior?.source ?? null,
        priorDate: p.prior?.date ?? null,
        variancePct: p.variancePct,
        flag: p.flag,
        matchStatus: p.link.status,
        link: linkOf(p.link),
        findings: p.findings,
        raw: p.row.raw,
        status: p.status,
      }));
      await tx.insert(staged).values(values);
      for (const r of values) ids.set(r.rowNo, r.id);
    }
    // Which exceptions a row opens, and what they carry (candidates by reason only, SEC-5.3), is
    // the shared rule in @pb/validation; the rule id carries this intake's prefix.
    const exceptions: (typeof schema.dataException.$inferInsert)[] = prepared.flatMap((p) => {
      const rowId = ids.get(p.row.rowNo);
      if (rowId === undefined) return [];
      return exceptionsOpenedBy(p).map((opened) => ({
        source: EXCEPTION_SOURCE,
        entity: ENTITY,
        entityId: rowId,
        severity: EXCEPTION_SEVERITY,
        state: 'open',
        ...opened,
        ruleId: `WK-${opened.ruleId}`,
      }));
    });
    for (const batch of chunk(exceptions, INSERT_CHUNK))
      await tx.insert(schema.dataException).values(batch);
  }

  /** The file with every staged value the caller may see; a file the caller cannot see is 404. The open is audited. */
  async detail(principal: Principal, requestId: string, fileId: string): Promise<WeeklyFileDetail> {
    requireUuid(fileId, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const loaded = await this.load(tx, fileId);
      if (loaded === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      await audit({ action: 'intake_file.read', entity: 'stg.intake_file', entityId: fileId });
      return loaded.detail;
    });
  }

  /**
   * approve: the rows named (or every validated row the caller sees) go validated > approved by
   * the caller, then approved > promoted by the system, in this one transaction; promotion creates
   * a Draft valuation per row and audits it. reject: the rows named (or every flagged row) are
   * rejected with the reason the machine requires. A command with nothing left to do answers the
   * unchanged file.
   */
  async command(
    principal: Principal,
    requestId: string,
    fileId: string,
    body: IntakeCommandBody,
  ): Promise<WeeklyFileDetail> {
    requireUuid(fileId, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      // Commands on one file run one at a time: the file row stays locked until this transaction
      // ends, so a second reviewer's command waits and then reads the rows as this one left them.
      await tx
        .select({ id: file.id })
        .from(file)
        .where(and(eq(file.id, fileId), eq(file.source, SOURCE)))
        .for('update');
      const loaded = await this.load(tx, fileId);
      if (loaded === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      const wanted: StagingState = body.command === 'approve' ? 'validated' : 'flagged';
      // The rows named must be rows of this file the caller sees, in the state the command needs
      // (the shared rule in @pb/validation); naming a hidden row is the same as naming a row of another file.
      const selected = selectTargets(loaded.visible, body.rowIds, wanted);
      if (!selected.ok)
        throw new ProblemError(400, 'validation', 'Invalid rowIds', [selected.refusal]);
      const targets = selected.rows;
      const at = new Date(this.adapters.clock.now());
      let valuations = 0;
      for (const target of targets) {
        if (body.command === 'approve') {
          await this.promote(tx, audit, principal, loaded.detail, target, body.reason, at);
          valuations += 1;
        } else await this.reject(tx, principal, target, body.reason, at);
      }
      if (targets.length > 0) await this.refreshStatus(tx, fileId);
      await audit({
        action: `intake.${body.command}`,
        entity: 'stg.intake_file',
        entityId: fileId,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        details: { fileName: loaded.detail.fileName, rows: targets.length, valuations },
      });
      const after = await this.load(tx, fileId);
      if (after === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      return after.detail;
    });
  }

  /**
   * One row's approval and promotion. The staging machine moves the row validated > approved by
   * the reviewer and approved > promoted by the system actor; promotion creates a Draft valuation
   * for the linked investment at the report date, the next version for that period, of method
   * weekly_report, with the reviewer as its preparer. The creation row of docs/18 section 1
   * ((new) > Draft, investment active) is applied here by the system actor on the reviewer's
   * behalf (decision 0010 as built): a deal team reviewer may approve a staged row, and the
   * Draft is the staging machine's promotion, not a valuation command of theirs. The audit event
   * carries the staged row, the prior and the value written (CLAUDE.md rule 6).
   */
  private async promote(
    tx: Tx,
    audit: (entry: AuditEntry) => Promise<void>,
    principal: Principal,
    detail: WeeklyFileDetail,
    target: StagedValue,
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
    const investmentId = target.investmentId;
    if (investmentId === null)
      throw precondition('staging: the row is not linked to an investment');
    if (target.reportDate === null)
      throw precondition('staging: the row has no report date to value at');
    if (target.reportedValue === null)
      throw precondition('staging: the row has no value the record can hold');
    const periodEnd = target.reportDate;
    const fairValue = target.reportedValue;
    const decision = reason ?? `weekly values ${detail.fileName}`;

    // (new) > Draft needs an active investment (docs/18 section 1), read under the reviewer's own
    // row-level security: a position they cannot open is not theirs to value.
    const investment = (
      await tx
        .select({ isActive: schema.investment.isActive })
        .from(schema.investment)
        .where(eq(schema.investment.id, investmentId))
        .limit(1)
    )[0];
    if (investment === undefined) throw precondition('valuation: the investment is not on record');
    if (!investment.isActive) throw precondition('valuation: the investment is not active');

    // The Draft is written by the system actor (the insert policy on mon.valuation admits
    // operations and the service, and the deal team may approve a staged row) with the reviewer
    // as its preparer; the version is the next one for the investment and period.
    const written = await asSystemActor(tx, async (stx) => {
      const [latest] = await stx
        .select({ version: sql<number>`coalesce(max(${valuation.version}), 0)::int` })
        .from(valuation)
        .where(and(eq(valuation.investmentId, investmentId), eq(valuation.periodEnd, periodEnd)));
      const version = (latest?.version ?? 0) + 1;
      const inserted = await stx
        .insert(valuation)
        .values({
          investmentId,
          periodEnd,
          version,
          method: METHOD,
          inputs: {
            source: SOURCE,
            intakeFileId: detail.id,
            rowId: target.id,
            reportDate: target.reportDate,
            priorValue: target.priorValue,
            priorSource: target.priorSource,
          },
          fairValue,
          currency: 'USD',
          state: 'Draft',
          preparedBy: principal.userId,
        })
        .returning();
      const result = inserted[0];
      if (result === undefined) throw precondition('valuation: the Draft was not written');
      return {
        id: result.id,
        version: result.version,
        fairValue: result.fairValue,
        state: result.state,
      };
    });
    // The value after is read back from the row written, never from the file's text (rule 6).
    await audit({
      action: 'valuation.create_from_weekly',
      entity: 'mon.valuation',
      entityId: written.id,
      reason: decision,
      details: {
        intakeFileId: detail.id,
        intakeRowId: target.id,
        fileName: detail.fileName,
        rowNo: target.rowNo,
        reportDate: target.reportDate,
        prior: {
          value: target.priorValue,
          source: target.priorSource,
          date: target.priorDate,
        },
        after: {
          fairValue: written.fairValue,
          version: written.version,
          method: METHOD,
          state: written.state,
        },
      },
    });
    // The row is claimed in the state the command read it in; another command that changed it
    // first makes this one a conflict (the whole batch rolls back).
    const claimed = await tx
      .update(staged)
      .set({
        status: 'promoted',
        decision,
        reviewerId: principal.userId,
        decidedAt: at,
        promotedAt: at,
        valuationId: written.id,
      })
      .where(and(eq(staged.id, target.id), eq(staged.status, 'validated')))
      .returning();
    if (claimed[0] === undefined) throw rowConflict();
  }

  private async reject(
    tx: Tx,
    principal: Principal,
    target: StagedValue,
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
      .update(staged)
      .set({
        status: 'rejected',
        decision: reason ?? null,
        reviewerId: principal.userId,
        decidedAt: at,
      })
      .where(and(eq(staged.id, target.id), eq(staged.status, 'flagged')))
      .returning();
    if (claimed[0] === undefined) throw rowConflict();
  }

  /** The file status recomputed from every row (the contract's rule), after a command changed some. */
  private async refreshStatus(tx: Tx, fileId: string): Promise<void> {
    await tx
      .update(file)
      .set({ status: fileStatusOf(await this.counts(tx, fileId)) })
      .where(eq(file.id, fileId));
  }

  /**
   * Row counts per status, counted as the system actor inside the caller's transaction so they
   * cover every row, walled ones included (the row policy of migration 0010 hides a walled row
   * from a reader outside its wall): a file's status and counts are facts of the file, the same
   * for every reader, and a number reveals nothing of a hidden row.
   */
  private async counts(tx: Tx, fileId: string): Promise<StagingCounts> {
    const rows = await asSystemActor(tx, async (stx) =>
      stx
        .select({ status: staged.status, n: sql<number>`count(*)::int` })
        .from(staged)
        .where(eq(staged.intakeFileId, fileId))
        .groupBy(staged.status),
    );
    const counts = emptyCounts();
    for (const r of rows) counts[r.status] += r.n;
    return counts;
  }

  /** Data exceptions the import opened on this file, counted as the system actor like the status counts. */
  private async exceptionCount(tx: Tx, fileId: string): Promise<number> {
    const rows = await asSystemActor(tx, async (stx) =>
      stx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.dataException)
        .innerJoin(staged, eq(staged.id, schema.dataException.entityId))
        .where(
          and(
            eq(schema.dataException.source, EXCEPTION_SOURCE),
            eq(schema.dataException.entity, ENTITY),
            eq(staged.intakeFileId, fileId),
          ),
        ),
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * The file with its rows in file order, as the caller may see them. A row linked to an
   * investment the caller cannot open (a walled deal for a non-member) is hidden by its row policy
   * (migration 0010) and, should a policy ever let one through, by the filter below; it is counted
   * as hidden. Rows with no link are shown to every reviewer. The counts come from the system
   * actor and cover every row, so the file reads the same for everyone.
   */
  private async load(tx: Tx, fileId: string): Promise<LoadedFile | null> {
    const found = await tx
      .select({
        id: file.id,
        source: file.source,
        fileName: file.fileName,
        contentHash: file.contentHash,
        receivedAt: file.receivedAt,
        receivedBy: receiver.displayName,
        rowCount: file.rowCount,
        status: file.status,
        findings: file.findings,
        templateSignature: file.templateSignature,
        rowVersion: file.rowVersion,
      })
      .from(file)
      .leftJoin(receiver, eq(receiver.id, file.receivedBy))
      .where(and(eq(file.id, fileId), eq(file.source, SOURCE)));
    const header = found[0];
    if (header === undefined) return null;
    const counts = await this.counts(tx, fileId);
    const exceptions = await this.exceptionCount(tx, fileId);
    const total = (Object.keys(counts) as (keyof StagingCounts)[]).reduce(
      (n, k) => n + counts[k],
      0,
    );
    const stored = await tx
      .select({
        id: staged.id,
        rowNo: staged.rowNo,
        investmentNumber: staged.investmentNumber,
        companyName: staged.companyName,
        investmentId: staged.investmentId,
        reportDate: staged.reportDate,
        reportedValue: staged.reportedValue,
        priorValue: staged.priorValue,
        priorSource: staged.priorSource,
        priorDate: staged.priorDate,
        variancePct: staged.variancePct,
        flag: staged.flag,
        status: staged.status,
        decision: staged.decision,
        decidedBy: reviewer.displayName,
        decidedAt: staged.decidedAt,
        valuationId: staged.valuationId,
        link: staged.link,
        findings: staged.findings,
        raw: staged.raw,
      })
      .from(staged)
      .leftJoin(reviewer, eq(reviewer.id, staged.reviewerId))
      .where(eq(staged.intakeFileId, fileId))
      .orderBy(asc(staged.rowNo));
    const rows: StagedValue[] = stored.map(({ link, findings, raw, ...rest }) => ({
      ...rest,
      link: intakeLink.parse(link),
      findings: findingList.parse(findings),
      raw: rawCells.parse(raw),
    }));
    // The investments the rows link to or name as candidates, as far as the caller may see them:
    // a row linked past the caller's walls is left out and counted, a candidate past them is
    // dropped from the link, so nothing here reveals a walled position exists (SEC-5.3).
    const linked = [
      ...new Set(rows.flatMap((r) => (r.investmentId === null ? [] : [r.investmentId]))),
    ];
    const named = [
      ...new Set(rows.flatMap((r) => r.link.candidates.map((c) => c.investmentNumber))),
    ];
    const seen =
      linked.length + named.length === 0
        ? []
        : await tx
            .select({
              id: schema.investment.id,
              investmentNumber: schema.investment.investmentNumber,
            })
            .from(schema.investment)
            .where(
              or(
                ...(linked.length > 0 ? [inArray(schema.investment.id, linked)] : []),
                ...(named.length > 0 ? [inArray(schema.investment.investmentNumber, named)] : []),
              ),
            );
    const visibleIds = new Set(seen.map((r) => r.id));
    const visibleNumbers = new Set(seen.map((r) => r.investmentNumber));
    const visible = rows.filter((r) => r.investmentId === null || visibleIds.has(r.investmentId));
    return {
      detail: {
        id: header.id,
        source: intakeSource.parse(header.source),
        templateSignature: header.templateSignature,
        fileName: header.fileName,
        contentHash: header.contentHash,
        receivedAt: header.receivedAt.toISOString(),
        receivedBy: header.receivedBy,
        rowCount: header.rowCount,
        status: header.status,
        counts,
        fileFindings: findingList.parse(header.findings),
        exceptions,
        rowVersion: header.rowVersion,
        rows: visible.map((r) => this.toRow(r, visibleNumbers)),
        hiddenRows: total - visible.length,
      },
      visible,
    };
  }

  /**
   * A staged value for the caller, with only the candidates among the investments they may see.
   * The report date and the value are the cells as the file wrote them (the typed columns stand
   * behind the prior, the variance and the Draft), so the reviewer sees what will be refused.
   */
  private toRow(r: StagedValue, visibleNumbers: ReadonlySet<string>): WeeklyRowOut {
    const cell = (column: string): string | null => {
      const text = (r.raw[column] ?? '').trim();
      return text === '' ? null : text;
    };
    return {
      id: r.id,
      rowNo: r.rowNo,
      investmentNumber: r.investmentNumber,
      companyName: r.companyName,
      reportDate: cell('ReportDate'),
      reportedValue: cell('ReportedValue'),
      priorValue: r.priorValue,
      priorSource: r.priorSource === null ? null : weeklyPriorSource.parse(r.priorSource),
      priorDate: r.priorDate,
      variancePct: r.variancePct,
      flag: r.flag === 'above_threshold' ? 'above_threshold' : null,
      link: {
        ...r.link,
        candidates: r.link.candidates.filter((c) => visibleNumbers.has(c.investmentNumber)),
      },
      findings: r.findings,
      status: r.status,
      decision: r.decision,
      decidedBy: r.decidedBy,
      decidedAt: r.decidedAt === null ? null : r.decidedAt.toISOString(),
      valuationId: r.valuationId,
    };
  }
}
