import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AdapterSet, Principal } from '@pb/adapters';
import { intakeFinding, intakeLink, weeklyPriorSource } from '@pb/contracts';
import type {
  IntakeCommandBody,
  IntakeExportList,
  StagingState,
  WeeklyFileDetail,
  WeeklyImportBody,
  WeeklyImportResult,
  WeeklyRow as WeeklyRowOut,
} from '@pb/contracts';
import { asSystemActor, SYSTEM_USER_ID, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { isUniqueViolation } from '../../common/pg-errors.js';
import {
  IntakeSettingsError,
  WEEKLY_RULES,
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
import {
  EXCEPTION_SEVERITY,
  contentHashOf,
  countsByFile,
  loadHeader,
  receiveFile,
  visibleRowsFor,
  writeStaged,
} from '../stage.js';
import type { ExceptionInsert } from '../stage.js';

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
 * link, and a command acts on the rows they see. The receipt of a file (the content hash, the
 * duplicate, the restage, the race, the audit event), the writes, the counts and the visibility
 * rule are the staging every intake shares (../stage.ts, CLAUDE.md rule 7).
 */

const SOURCE = 'weekly';
const EXCEPTION_SOURCE = 'weekly_intake';
const ENTITY = 'stg.valuation';
/** The valuation method of a Draft created from a weekly value (core.taxonomy_term, migration 0010). */
const METHOD = 'valuation_method.weekly_report';
const NOT_FOUND = 'Weekly values file not found';
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
const reviewer = alias(schema.appUser, 'reviewer');

/** The problem when a command finds a row already changed by another command. */
const rowConflict = (): ProblemError =>
  new ProblemError(
    409,
    'conflict',
    'staging: another command changed the row first; open the file again',
  );

/** The problem when another approval took the Draft's version first (the unique key of mon.valuation). */
const versionConflict = (): ProblemError =>
  new ProblemError(
    409,
    'conflict',
    'valuation: another approval wrote this position and period first; approve the file again',
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
   * Stage a weekly values file through the receipt every intake shares (stage.ts receiveFile):
   * idempotent by the SHA-256 of the text, a refused header re-stageable, one transaction for
   * the file, its rows and its exceptions with one audit event of counts only. The rows are
   * linked and compared with their priors as the system actor (see the module comment).
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
    const asOf = this.adapters.clock.today();
    return receiveFile<PreparedValue, WeeklyFileDetail>(this.db, principal, requestId, {
      source: SOURCE,
      fileName,
      contentHash: contentHashOf(text),
      action: 'intake.import',
      read: () => {
        const read = readWeeklyFile(text, { maxRows: settings.maxRows });
        return {
          fileFindings: read.fileFindings,
          templateSignature: null,
          prepare: (tx) => this.prepare(tx, read.rows, settings.rules, asOf),
        };
      },
      insertRows: async (tx, fileId, prepared) => {
        await this.insertRows(tx, fileId, prepared);
        return {};
      },
      load: async (tx, fileId) => (await this.load(tx, fileId))?.detail ?? null,
    });
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

  /** The staged values and the data exceptions they open (unresolved names), written by the shared staging. */
  private async insertRows(
    tx: Tx,
    fileId: string,
    prepared: readonly PreparedValue[],
  ): Promise<void> {
    const values = prepared.map((p) => ({
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
    // Which exceptions a row opens, and what they carry (candidates by reason only, SEC-5.3), is
    // the shared rule in @pb/validation; the rule id carries this intake's prefix.
    const exceptions: ExceptionInsert[] = values.flatMap((v, i) =>
      exceptionsOpenedBy(prepared[i]!).map((opened) => ({
        source: EXCEPTION_SOURCE,
        entity: ENTITY,
        entityId: v.id,
        severity: EXCEPTION_SEVERITY,
        state: 'open',
        ...opened,
        ruleId: `WK-${opened.ruleId}`,
      })),
    );
    await writeStaged(tx, staged, values, exceptions);
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
    // as its preparer; the version is the next one for the investment and period. Two approvals
    // of the same position and period at once would both read the same next version: the unique
    // key of mon.valuation (investment, period end, version) lets one through and the other is
    // answered as the conflict every race in staging gets, to be approved again.
    let written: { id: string; version: number; fairValue: string; state: string };
    try {
      written = await asSystemActor(tx, async (stx) => {
        const version = await this.nextVersion(stx, investmentId, periodEnd);
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
    } catch (error) {
      if (isUniqueViolation(error)) throw versionConflict();
      throw error;
    }
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

  /** The next version for the investment and period: one past the highest on record, 1 for the first. */
  private async nextVersion(stx: Tx, investmentId: string, periodEnd: string): Promise<number> {
    const [latest] = await stx
      .select({ version: sql<number>`coalesce(max(${valuation.version}), 0)::int` })
      .from(valuation)
      .where(and(eq(valuation.investmentId, investmentId), eq(valuation.periodEnd, periodEnd)));
    return (latest?.version ?? 0) + 1;
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
    const counts = (await countsByFile(tx, [fileId])).get(fileId) ?? emptyCounts();
    await tx
      .update(file)
      .set({ status: fileStatusOf(counts) })
      .where(eq(file.id, fileId));
  }

  /**
   * The weekly file with its values in file order, as the caller may see them: the header with
   * the counts and the exception total every reviewer reads the same (stage.ts loadHeader), then
   * the rows the caller's row-level security and the shared visibility rule admit
   * (visibleRowsFor). A file of another source is not a weekly file: null.
   */
  private async load(tx: Tx, fileId: string): Promise<LoadedFile | null> {
    const header = await loadHeader(tx, fileId, [SOURCE]);
    if (header === null) return null;
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
    // The typed investment column is the link the row policy reads; the candidates are in the link.
    const { visible, visibleNumbers } = await visibleRowsFor(tx, rows, (r) => ({
      investmentId: r.investmentId,
      candidates: r.link.candidates,
    }));
    return {
      detail: {
        ...header.file,
        rows: visible.map((r) => this.toRow(r, visibleNumbers)),
        hiddenRows: header.total - visible.length,
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
