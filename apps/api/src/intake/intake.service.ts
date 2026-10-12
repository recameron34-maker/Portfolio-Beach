import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AdapterSet, Principal } from '@pb/adapters';
import { alignedQuarterEnd } from '@pb/calc';
import {
  intakeCounts,
  intakeExportList,
  intakeFinding,
  intakeLink,
  intakeRow as intakeRowSchema,
  isCalendarDate,
} from '@pb/contracts';
import type {
  IntakeCommandBody,
  IntakeFile,
  IntakeFileDetail,
  IntakeFilePage,
  IntakeImportBody,
  IntakeImportResult,
  IntakeRow,
  StagingState,
  intakeFileListQuery,
} from '@pb/contracts';
import { SYSTEM_USER_ID, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import {
  ACCOUNTING_RULES,
  IntakeSettingsError,
  accountingLayout,
  countsOf,
  diffRow,
  emptyCounts,
  fileStatusOf,
  intakeSettingsFrom,
  linkInvestment,
  naturalKeyOf,
  readAccountingFile,
  runRules,
  statusFromFindings,
} from '@pb/validation';
import type {
  AccountingLayout,
  AccountingRow,
  CurrentQuarter,
  Finding,
  IntakeSettings,
  InvestmentDirectoryEntry,
  LinkResult,
  MatchGuardPair,
} from '@pb/validation';
import { attempt, stagingMachine } from '@pb/workflows';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import { configError } from '../common/definitions.js';
import { ProblemError, workflowProblem } from '../common/problem.js';
import { ACCOUNTING_LAYOUT, ADAPTERS, DEFINITIONS } from '../common/tokens.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import type { AuditEntry } from '../db/db.service.js';

/*
 * The accounting import (docs/04 M2, SEC-9.1): a file is read against config/accounting_layout.json,
 * every row is linked to an investment (docs/03 section 5), diffed against the approved quarter on
 * record and run through the validation rules, then staged in stg.* with its findings. Nothing
 * reaches mon.quarterly_performance until a reviewer approves, and promotion happens in the same
 * transaction as the approval with an audit event per row (docs/18 section 2). Linking, the diff and
 * the rules run as the system actor (DbService.runAsSystem), the one actor that sees every position
 * on record, walled ones included: an export covers the whole book, and a walled position must link
 * rather than read as "no match". Everything a caller reads or writes runs under their own
 * row-level security through DbService.run: a staged row linked to a position they cannot open is
 * left out and counted, a candidate they cannot open is dropped from the link, and promotion writes
 * only what they may see.
 */

export type IntakeListOptions = z.infer<typeof intakeFileListQuery>;
type IntakeCounts = z.infer<typeof intakeCounts>;
export type IntakeExportList = z.infer<typeof intakeExportList>;

const SOURCE = 'accounting';
const EXCEPTION_SOURCE = 'accounting_import';
const TARGET_ENTITY = 'quarterly_performance';
/** A rule error opens a high exception (core.taxonomy_term exception_severity): the row cannot be promoted until a person resolves it. */
const EXCEPTION_SEVERITY = 'exception_severity.high';
const NOT_FOUND = 'Intake file not found';
/** The four figures the import writes; the fair value only ties to the Locked mark (TIE-01) and is never written. */
type PromotedFigures = Record<'revenueLtm' | 'ebitdaLtm' | 'ev' | 'netDebt', string | null>;

/**
 * What stg.intake_row.payload holds, written by stageFile and read back by the detail and the
 * commands: the row as the file said it, the quarter it reports for and how it was linked.
 */
const rowPayload = z.object({
  investmentNumber: z.string().nullable(),
  companyName: z.string().nullable(),
  periodEnd: z.string().nullable(),
  /** The calendar quarter end the row reports for (alignedQuarterEnd), when the period end is a real date. */
  quarterEnd: z.string().nullable(),
  figures: intakeRowSchema.shape.figures,
  raw: z.record(z.string(), z.string()),
  link: intakeLink,
});
type RowPayload = z.infer<typeof rowPayload>;
const rowDiff = intakeRowSchema.shape.diff;
const findingList = z.array(intakeFinding);

/** One staged row as the database holds it, with its jsonb columns parsed. */
interface StagedRow {
  id: string;
  rowNo: number;
  naturalKey: string;
  targetId: string | null;
  status: StagingState;
  decision: string | null;
  decidedBy: string | null;
  promotedAt: Date | null;
  payload: RowPayload;
  diff: z.infer<typeof rowDiff>;
  findings: Finding[];
}

/** A file with every row (for counts) and the rows the caller may see (for the response). */
interface LoadedFile {
  detail: IntakeFileDetail;
  visible: StagedRow[];
}

/** The outcome of reading and checking one row before anything is written. */
interface PreparedRow {
  row: AccountingRow;
  link: LinkResult;
  quarterEnd: string | null;
  targetId: string | null;
  diff: z.infer<typeof rowDiff>;
  findings: Finding[];
  status: 'validated' | 'flagged';
}

const file = schema.intakeFile;
const row = schema.intakeRow;
const quarter = schema.quarterlyPerformance;
const receiver = alias(schema.appUser, 'receiver');
const reviewer = alias(schema.appUser, 'reviewer');
const OUTER_FILE_ID = sql.raw('"stg"."intake_file"."id"');
/** Data exceptions the import opened for the file in the outer select; RLS applies inside as everywhere. */
const exceptionCount = sql<number>`(select count(*)::int from ops.data_exception x where x.source = ${EXCEPTION_SOURCE} and x.entity = 'stg.intake_row' and x.entity_id in (select r.id from stg.intake_row r where r.intake_file_id = ${OUTER_FILE_ID}))`;

/** The cursor is "receivedAt|id" of the last file: the receipt time to the microsecond and the file id. */
const CURSOR =
  /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6})Z\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const EXACT_AT_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const INSERT_CHUNK = 500;

/** The link of a row no directory entry answers; links[i] always exists, this only satisfies the index check. */
const NO_LINK: LinkResult = { status: 'unmatched', by: null, investment: null, candidates: [] };

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The link for the contract: ids and names of the matched investment, candidates otherwise. */
function linkOf(link: LinkResult): RowPayload['link'] {
  return {
    status: link.status,
    investmentId: link.investment?.id ?? null,
    investmentNumber: link.investment?.investmentNumber ?? null,
    companyName: link.investment?.companyName ?? null,
    candidates: link.candidates,
  };
}

@Injectable()
export class IntakeService {
  constructor(
    private readonly db: DbService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(DEFINITIONS) private readonly definitions: unknown,
    @Inject(ACCOUNTING_LAYOUT) private readonly rawLayout: unknown,
  ) {}

  /**
   * Every threshold through the one strict reader the preview shares (CLAUDE.md rules 9 and 10):
   * a missing key is a 500 naming it, never a default.
   */
  private settings(): IntakeSettings {
    try {
      return intakeSettingsFrom(this.definitions);
    } catch (error) {
      if (error instanceof IntakeSettingsError) throw configError(error.key);
      throw error;
    }
  }

  /** config/accounting_layout.json checked against the layout schema; anything else is a configuration problem. */
  private layout(): AccountingLayout {
    const parsed = accountingLayout.safeParse(this.rawLayout);
    if (!parsed.success)
      throw new ProblemError(
        500,
        'configuration',
        'config/accounting_layout.json is not a usable accounting layout',
      );
    return parsed.data;
  }

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
   * Stage an accounting export. Idempotent by content: the same text answers the file it created
   * before with `duplicate` true and stages nothing (docs/04 M2). Otherwise the file, its rows and
   * the data exceptions land in one transaction with one audit event that carries counts only.
   */
  async import(
    principal: Principal,
    requestId: string,
    body: IntakeImportBody,
  ): Promise<IntakeImportResult> {
    const settings = this.settings();
    const layout = this.layout();
    const { fileName, text } = await this.fileText(body);
    if (Buffer.byteLength(text, 'utf8') > settings.maxFileBytes)
      throw new ProblemError(400, 'validation', 'The file is larger than one import accepts');
    const contentHash = createHash('sha256').update(text).digest('hex');
    const asOf = this.adapters.clock.today();

    const existing = await this.db.run(principal, requestId, (tx) =>
      this.findByHash(tx, contentHash),
    );
    if (existing !== null) return { ...existing, duplicate: true };

    const read = readAccountingFile(text, layout, { maxRows: settings.maxRows });
    // A file the layout refuses (an unknown or missing column, nothing to read) holds no rows:
    // a renamed column must never be guessed at.
    const refused = read.fileFindings.some((f) => f.severity === 'error');
    // The system actor links against the whole book (see the module comment); it reads only.
    const prepared = refused
      ? []
      : await this.db.runAsSystem((tx) => this.prepareRows(tx, read.rows, settings, asOf));

    return this.db.run(principal, requestId, async (tx, audit) => {
      const counts = countsOf(prepared.map((p) => p.status));
      const inserted = await tx
        .insert(file)
        .values({
          source: SOURCE,
          fileName,
          contentHash,
          receivedBy: principal.userId,
          rowCount: prepared.length,
          status: fileStatusOf(counts),
          findings: read.fileFindings,
        })
        .onConflictDoNothing({ target: [file.source, file.contentHash] })
        .returning();
      const fileId = inserted[0]?.id;
      if (fileId === undefined) {
        // The same content landed from another request meanwhile: answer that file.
        const raced = await this.findByHash(tx, contentHash);
        if (raced === null) throw new ProblemError(409, 'conflict', 'The import did not complete');
        return { ...raced, duplicate: true };
      }

      await this.insertRows(tx, fileId, prepared, layout);
      await audit({
        action: 'intake.import',
        entity: 'stg.intake_file',
        entityId: fileId,
        details: { fileName, rowCount: prepared.length, counts },
      });
      const loaded = await this.load(tx, fileId);
      if (loaded === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      return { ...loaded.detail, duplicate: false };
    });
  }

  private async findByHash(tx: Tx, contentHash: string): Promise<IntakeFileDetail | null> {
    const found = await tx
      .select({ id: file.id })
      .from(file)
      .where(and(eq(file.source, SOURCE), eq(file.contentHash, contentHash)));
    const id = found[0]?.id;
    if (id === undefined) return null;
    return (await this.load(tx, id))?.detail ?? null;
  }

  /**
   * Links, diffs and checks every row of the file against the book as the system actor sees it:
   * the investment directory (number, names, aliases; none are on record yet), the match guards,
   * the approved quarters of each linked investment and its Locked mark for the row's quarter.
   */
  private async prepareRows(
    tx: Tx,
    rows: readonly AccountingRow[],
    settings: IntakeSettings,
    asOf: string,
  ): Promise<PreparedRow[]> {
    const directory = await this.directory(tx);
    const guards: MatchGuardPair[] = await tx
      .select({ nameA: schema.matchGuard.nameA, nameB: schema.matchGuard.nameB })
      .from(schema.matchGuard);
    const links = rows.map((r) => linkInvestment(r, directory, guards));
    const linked = [
      ...new Set(links.flatMap((l) => (l.investment === null ? [] : [l.investment.id]))),
    ];
    const quarters = await this.approvedQuarters(tx, linked);
    const marks = await this.lockedMarks(tx, linked);
    const tolerance = settings.toleranceDays;

    return rows.map((r, i) => {
      const link = links[i] ?? NO_LINK;
      const period = r.periodEnd !== null && isCalendarDate(r.periodEnd) ? r.periodEnd : null;
      const quarterEnd = period === null ? null : alignedQuarterEnd(period, tolerance);
      const investmentId = link.investment?.id ?? null;
      const onRecord = investmentId === null ? [] : (quarters.get(investmentId) ?? []);
      // The approved quarter the row would replace: the one at the quarter end, or one that reports
      // for the same quarter a few days off it (a sponsor closing its books early).
      const current =
        quarterEnd === null
          ? null
          : (onRecord.find((q) => q.periodEnd === quarterEnd) ??
            onRecord.find((q) => alignedQuarterEnd(q.periodEnd, tolerance) === quarterEnd) ??
            null);
      const locked =
        quarterEnd === null || investmentId === null
          ? null
          : (marks.get(investmentId)?.find((m) => m.periodEnd === quarterEnd) ?? null);
      const findings = runRules(ACCOUNTING_RULES, {
        row: r,
        file: rows,
        link,
        current: {
          quarters: onRecord,
          lockedFairValue:
            locked === null ? null : { periodEnd: locked.periodEnd, fairValue: locked.fairValue },
        },
        asOf,
        config: settings.rules,
      });
      return {
        row: r,
        link,
        quarterEnd,
        targetId: current?.id ?? null,
        diff: diffRow(r, current),
        findings,
        status: statusFromFindings(findings),
      };
    });
  }

  /** Visible investments with their company names; aliases are not on record yet, so each entry carries none. */
  private async directory(tx: Tx): Promise<InvestmentDirectoryEntry[]> {
    const rows = await tx
      .select({
        id: schema.investment.id,
        investmentNumber: schema.investment.investmentNumber,
        companyName: schema.portfolioCompany.name,
        canonicalName: schema.portfolioCompany.canonicalName,
        dealType: schema.investment.dealType,
        entryDate: schema.investment.entryDate,
        exitDate: schema.investment.exitDate,
        isActive: schema.investment.isActive,
      })
      .from(schema.investment)
      .innerJoin(
        schema.portfolioCompany,
        eq(schema.portfolioCompany.id, schema.investment.portfolioCompanyId),
      );
    return rows.map((r) => ({ ...r, aliases: [] }));
  }

  /** Approved quarters per investment, oldest first, as the rules and the diff read them. */
  private async approvedQuarters(
    tx: Tx,
    investmentIds: readonly string[],
  ): Promise<Map<string, (CurrentQuarter & { id: string; isEntrySnapshot: boolean })[]>> {
    const out = new Map<string, (CurrentQuarter & { id: string; isEntrySnapshot: boolean })[]>();
    if (investmentIds.length === 0) return out;
    const rows = await tx
      .select({
        id: quarter.id,
        investmentId: quarter.investmentId,
        periodEnd: quarter.periodEnd,
        revenueLtm: quarter.revenueLtm,
        ebitdaLtm: quarter.ebitdaLtm,
        ev: quarter.ev,
        netDebt: quarter.netDebt,
        isEntrySnapshot: quarter.isEntrySnapshot,
      })
      .from(quarter)
      .where(
        and(
          inArray(quarter.investmentId, [...investmentIds]),
          eq(quarter.status, 'record_status.approved'),
        ),
      )
      .orderBy(asc(quarter.periodEnd), asc(quarter.id));
    for (const { investmentId, ...q } of rows) {
      const list = out.get(investmentId);
      if (list === undefined) out.set(investmentId, [q]);
      else list.push(q);
    }
    return out;
  }

  /** Locked marks per investment, highest version first within a period end, so find() keeps the latest version. */
  private async lockedMarks(
    tx: Tx,
    investmentIds: readonly string[],
  ): Promise<Map<string, { periodEnd: string; fairValue: string }[]>> {
    const out = new Map<string, { periodEnd: string; fairValue: string }[]>();
    if (investmentIds.length === 0) return out;
    const v = schema.valuation;
    const rows = await tx
      .select({
        investmentId: v.investmentId,
        periodEnd: v.periodEnd,
        fairValue: v.fairValue,
      })
      .from(v)
      .where(and(inArray(v.investmentId, [...investmentIds]), eq(v.state, 'Locked')))
      .orderBy(asc(v.periodEnd), desc(v.version));
    for (const { investmentId, ...mark } of rows) {
      const list = out.get(investmentId);
      if (list === undefined) out.set(investmentId, [mark]);
      else list.push(mark);
    }
    return out;
  }

  /** Writes the staged rows and the data exceptions they open (unresolved names, fair values that do not tie). */
  private async insertRows(
    tx: Tx,
    fileId: string,
    prepared: readonly PreparedRow[],
    layout: AccountingLayout,
  ): Promise<void> {
    const ids = new Map<number, string>();
    for (const batch of chunk(prepared, INSERT_CHUNK)) {
      const inserted = await tx
        .insert(row)
        .values(
          batch.map((p) => ({
            intakeFileId: fileId,
            rowNo: p.row.rowNo,
            naturalKey: naturalKeyOf(p.row, layout),
            targetEntity: TARGET_ENTITY,
            targetId: p.targetId,
            payload: {
              investmentNumber: p.row.investmentNumber,
              companyName: p.row.companyName,
              periodEnd: p.row.periodEnd,
              quarterEnd: p.quarterEnd,
              figures: p.row.figures,
              raw: p.row.raw,
              link: linkOf(p.link),
            } satisfies RowPayload,
            diff: p.diff,
            validation: p.findings,
            status: p.status,
          })),
        )
        .returning();
      for (const r of inserted) ids.set(r.rowNo, r.id);
    }

    const exceptions: (typeof schema.dataException.$inferInsert)[] = [];
    for (const p of prepared) {
      const rowId = ids.get(p.row.rowNo);
      if (rowId === undefined) continue;
      const base = {
        source: EXCEPTION_SOURCE,
        entity: 'stg.intake_row',
        entityId: rowId,
        severity: EXCEPTION_SEVERITY,
        state: 'open',
      };
      if (p.link.status !== 'matched') {
        const ruleId = { unmatched: 'XREF-01', guarded: 'XREF-02', ambiguous: 'XREF-03' }[
          p.link.status
        ];
        const finding = p.findings.find((f) => f.ruleId === ruleId);
        // Every authenticated user may read exceptions, so a candidate travels as its number and
        // reason only; the names are on the staged row, shown to those who may see them.
        exceptions.push({
          ...base,
          ruleId,
          expected: finding?.expected ?? 'an investment on record',
          actual: finding?.actual ?? p.row.investmentNumber ?? p.row.companyName ?? '',
          candidates: p.link.candidates.map((c) => ({
            investmentNumber: c.investmentNumber,
            reason: c.reason,
          })),
        });
      }
      for (const finding of p.findings.filter((f) => f.ruleId === 'TIE-01')) {
        exceptions.push({
          ...base,
          ruleId: finding.ruleId,
          expected: finding.expected,
          actual: finding.actual,
          candidates: [],
        });
      }
    }
    for (const batch of chunk(exceptions, INSERT_CHUNK))
      await tx.insert(schema.dataException).values(batch);
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
      const conditions: (SQL | undefined)[] = [eq(file.source, SOURCE)];
      if (opts.cursor !== undefined) {
        const [date = '', time = '', id = ''] = decodeCursor(opts.cursor, CURSOR, [1]);
        const at = sql`${`${date}T${time}Z`}::timestamptz`;
        conditions.push(
          or(lt(file.receivedAt, at), and(eq(file.receivedAt, at), lt(file.id, sql`${id}::uuid`))),
        );
      }
      if (opts.status !== undefined) conditions.push(eq(file.status, opts.status));
      const rows = await tx
        .select({
          ...this.fileSelect(),
          exactAt: sql<string>`to_char(${file.receivedAt} at time zone 'UTC', ${EXACT_AT_FORMAT})`,
        })
        .from(file)
        .leftJoin(receiver, eq(receiver.id, file.receivedBy))
        .where(and(...conditions))
        .orderBy(desc(file.receivedAt), desc(file.id))
        .limit(opts.limit + 1);
      const page = rows.slice(0, opts.limit);
      const counts = await this.countsByFile(
        tx,
        page.map((r) => r.id),
      );
      const last = page[page.length - 1];
      return {
        items: page.map((r) => this.toFile(r, counts.get(r.id) ?? emptyCounts())),
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
      const loaded = await this.load(tx, fileId);
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
      const loaded = await this.load(tx, fileId);
      if (loaded === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      const wanted: StagingState = body.command === 'approve' ? 'validated' : 'flagged';
      const targets = this.targets(loaded, body.rowIds, wanted);
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
      const after = await this.load(tx, fileId);
      if (after === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      return after.detail;
    });
  }

  /** The rows a command acts on: the ones named, each of this file and in the state the command needs, or every such row the caller sees. */
  private targets(
    loaded: LoadedFile,
    rowIds: readonly string[] | undefined,
    wanted: StagingState,
  ): StagedRow[] {
    if (rowIds === undefined) return loaded.visible.filter((r) => r.status === wanted);
    const byId = new Map(loaded.visible.map((r) => [r.id, r]));
    const out: StagedRow[] = [];
    for (const id of new Set(rowIds)) {
      const found = byId.get(id);
      if (found?.status !== wanted)
        throw new ProblemError(400, 'validation', 'Invalid rowIds', [
          { path: 'rowIds', message: `Every row must belong to this file and be ${wanted}` },
        ]);
      out.push(found);
    }
    return out;
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
    const after: PromotedFigures = {
      revenueLtm: target.payload.figures.revenueLtm,
      ebitdaLtm: target.payload.figures.ebitdaLtm,
      ev: target.payload.figures.ev,
      netDebt: target.payload.figures.netDebt,
    };
    const approval = {
      status: 'record_status.approved',
      approvedBy: principal.userId,
      approvedAt: at,
      approvalReason: reason ?? `accounting import ${detail.fileName}`,
      sourceLocator: `intake_file:${detail.id}/row:${target.rowNo}`,
    };

    // The quarter on record: the one the diff was made against, or any row at the period end
    // (docs/04 M2 asks for an upsert), each visible to the caller under row-level security.
    const existing = (
      await tx
        .select({
          id: quarter.id,
          revenueLtm: quarter.revenueLtm,
          ebitdaLtm: quarter.ebitdaLtm,
          ev: quarter.ev,
          netDebt: quarter.netDebt,
        })
        .from(quarter)
        .where(
          target.targetId !== null
            ? eq(quarter.id, target.targetId)
            : and(eq(quarter.investmentId, investmentId), eq(quarter.periodEnd, periodEnd)),
        )
        .limit(1)
    )[0];
    let entityId: string;
    let before: PromotedFigures;
    if (existing !== undefined) {
      const updated = await tx
        .update(quarter)
        .set({ ...after, ...approval })
        .where(eq(quarter.id, existing.id))
        .returning();
      const id = updated[0]?.id;
      if (id === undefined)
        throw new ProblemError(
          422,
          'workflow-precondition',
          'staging: the quarter on record cannot be updated by this caller',
        );
      entityId = id;
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
          ...after,
          ...approval,
          isEntrySnapshot: false,
          currency: 'USD',
          highlights: [],
          commentary: null,
        })
        .returning();
      const id = inserted[0]?.id;
      if (id === undefined)
        throw new ProblemError(
          422,
          'workflow-precondition',
          'staging: the quarter was not written',
        );
      entityId = id;
      before = { revenueLtm: null, ebitdaLtm: null, ev: null, netDebt: null };
    }
    await audit({
      action: 'quarterly_performance.promote',
      entity: 'mon.quarterly_performance',
      entityId,
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
    await tx
      .update(row)
      .set({
        status: 'promoted',
        decision: approval.approvalReason,
        reviewerId: principal.userId,
        decidedAt: at,
        promotedAt: at,
        targetId: entityId,
      })
      .where(eq(row.id, target.id));
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
    await tx
      .update(row)
      .set({
        status: 'rejected',
        decision: reason ?? null,
        reviewerId: principal.userId,
        decidedAt: at,
      })
      .where(eq(row.id, target.id));
  }

  /** The file status recomputed from every row (the contract's rule), after a command changed some. */
  private async refreshStatus(tx: Tx, fileId: string): Promise<void> {
    const counts = (await this.countsByFile(tx, [fileId])).get(fileId) ?? emptyCounts();
    await tx
      .update(file)
      .set({ status: fileStatusOf(counts) })
      .where(eq(file.id, fileId));
  }

  private async countsByFile(
    tx: Tx,
    fileIds: readonly string[],
  ): Promise<Map<string, IntakeCounts>> {
    const out = new Map<string, IntakeCounts>();
    if (fileIds.length === 0) return out;
    const rows = await tx
      .select({
        fileId: row.intakeFileId,
        status: row.status,
        n: sql<number>`count(*)::int`,
      })
      .from(row)
      .where(inArray(row.intakeFileId, [...fileIds]))
      .groupBy(row.intakeFileId, row.status);
    for (const r of rows) {
      const counts = out.get(r.fileId) ?? emptyCounts();
      counts[r.status] += r.n;
      out.set(r.fileId, counts);
    }
    return out;
  }

  private fileSelect() {
    return {
      id: file.id,
      source: file.source,
      fileName: file.fileName,
      contentHash: file.contentHash,
      receivedAt: file.receivedAt,
      receivedBy: receiver.displayName,
      rowCount: file.rowCount,
      status: file.status,
      findings: file.findings,
      exceptions: exceptionCount,
      rowVersion: file.rowVersion,
    };
  }

  private toFile(
    r: {
      id: string;
      fileName: string;
      contentHash: string;
      receivedAt: Date;
      receivedBy: string | null;
      rowCount: number;
      status: StagingState;
      findings: unknown;
      exceptions: number;
      rowVersion: number;
    },
    counts: IntakeCounts,
  ): IntakeFile {
    return {
      id: r.id,
      source: SOURCE,
      fileName: r.fileName,
      contentHash: r.contentHash,
      receivedAt: r.receivedAt.toISOString(),
      receivedBy: r.receivedBy,
      rowCount: r.rowCount,
      status: r.status,
      counts,
      fileFindings: findingList.parse(r.findings),
      exceptions: r.exceptions,
      rowVersion: r.rowVersion,
    };
  }

  /**
   * The file with its rows in file order. Rows linked to an investment the caller cannot open
   * (a walled deal for a non-member) are left out and counted; rows with no link are shown to
   * every reviewer. Counts cover every row, so the file reads the same for everyone.
   */
  private async load(tx: Tx, fileId: string): Promise<LoadedFile | null> {
    const found = await tx
      .select(this.fileSelect())
      .from(file)
      .leftJoin(receiver, eq(receiver.id, file.receivedBy))
      .where(eq(file.id, fileId));
    const header = found[0];
    if (header === undefined) return null;
    const stored = await tx
      .select({
        id: row.id,
        rowNo: row.rowNo,
        naturalKey: row.naturalKey,
        targetId: row.targetId,
        status: row.status,
        decision: row.decision,
        decidedBy: reviewer.displayName,
        promotedAt: row.promotedAt,
        payload: row.payload,
        diff: row.diff,
        validation: row.validation,
      })
      .from(row)
      .leftJoin(reviewer, eq(reviewer.id, row.reviewerId))
      .where(eq(row.intakeFileId, fileId))
      .orderBy(asc(row.rowNo));
    const rows: StagedRow[] = stored.map(({ payload, diff, validation, ...rest }) => ({
      ...rest,
      payload: rowPayload.parse(payload),
      diff: rowDiff.parse(diff),
      findings: findingList.parse(validation),
    }));
    // The investments the rows link to or name as candidates, as far as the caller may see them:
    // a row linked past the caller's walls is left out and counted, a candidate past them is
    // dropped from the link, so nothing here reveals a walled position exists (SEC-5.3).
    const linked = [
      ...new Set(
        rows.flatMap((r) =>
          r.payload.link.investmentId === null ? [] : [r.payload.link.investmentId],
        ),
      ),
    ];
    const named = [
      ...new Set(rows.flatMap((r) => r.payload.link.candidates.map((c) => c.investmentNumber))),
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
    const visible = rows.filter(
      (r) => r.payload.link.investmentId === null || visibleIds.has(r.payload.link.investmentId),
    );
    return {
      detail: {
        ...this.toFile(header, countsOf(rows.map((r) => r.status))),
        rows: visible.map((r) => this.toRow(r, visibleNumbers)),
        hiddenRows: rows.length - visible.length,
      },
      visible,
    };
  }

  /** A staged row for the caller, with only the candidates among the investments they may see. */
  private toRow(r: StagedRow, visibleNumbers: ReadonlySet<string>): IntakeRow {
    return {
      id: r.id,
      rowNo: r.rowNo,
      naturalKey: r.naturalKey,
      targetEntity: TARGET_ENTITY,
      targetId: r.targetId,
      investmentNumber: r.payload.investmentNumber,
      companyName: r.payload.companyName,
      periodEnd: r.payload.periodEnd,
      figures: r.payload.figures,
      link: {
        ...r.payload.link,
        candidates: r.payload.link.candidates.filter((c) => visibleNumbers.has(c.investmentNumber)),
      },
      diff: r.diff,
      findings: r.findings,
      status: r.status,
      decision: r.decision,
      decidedBy: r.decidedBy,
      promotedAt: r.promotedAt === null ? null : r.promotedAt.toISOString(),
    };
  }
}
