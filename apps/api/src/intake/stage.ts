import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PgInsertValue, PgTable } from 'drizzle-orm/pg-core';
import type { Principal } from '@pb/adapters';
import {
  intakeSource,
  intakeFinding,
  intakeLink,
  intakeRow as intakeRowSchema,
} from '@pb/contracts';
import type {
  IntakeCounts,
  IntakeFile,
  IntakeFileDetail,
  IntakeImportResult,
  IntakeRow,
  IntakeSource,
  StagingState,
} from '@pb/contracts';
import { asSystemActor, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import {
  IntakeSettingsError,
  accountingLayout,
  countsOf,
  emptyCounts,
  exceptionsOpenedBy,
  fileStatusOf,
  intakeSettingsFrom,
  linkOf,
  linkRows,
  naturalKeyOf,
  prepareRows,
} from '@pb/validation';
import type {
  AccountingFile,
  AccountingLayout,
  AccountingRow,
  Finding,
  IntakeSettings,
  LockedMark,
  PreparedRow,
  RecordQuarter,
} from '@pb/validation';
import { z } from 'zod';
import { configError } from '../common/definitions.js';
import { ProblemError } from '../common/problem.js';
import type { DbService } from '../db/db.service.js';
import { investmentDirectory, matchGuards } from './directory.js';

/*
 * What every intake shares (docs/04 M2, SEC-9.1, decision 0010, CLAUDE.md rule 7). Each intake
 * keeps its own reader and its own rows (the accounting export and the operations workbook drop
 * stage accounting-shaped rows in stg.intake_row, the weekly values stage in stg.valuation, a
 * look-through run stages its comparison in stg.intake_row with its own payload); everything
 * around them lives here once:
 *
 * - receiveFile: a file is idempotent by its content hash with its source, a refused file (no
 *   rows) may be staged again, two requests racing on the same content answer the one file, and
 *   the file, its rows and its data exceptions land in one transaction with one audit event that
 *   carries counts only. The rows are prepared as the system actor (decision 0009), the one actor
 *   that sees every position on record, walled ones included.
 * - writeStaged: the chunked writes of the rows and their exceptions, ids given and never read back.
 * - loadHeader, countsByFile, exceptionsByFile: a file reads the same for every reviewer, its
 *   counts and exception total taken by the system actor over every row, hidden ones included.
 * - visibleRowsFor: each reader sees only the rows and the candidates their row-level security
 *   admits (SEC-5.3).
 *
 * The accounting-shaped staging (stageFile, loadFile) sits below the shared pieces and is what
 * the accounting import and the ops drop call.
 */

export const TARGET_ENTITY = 'quarterly_performance';
/** A rule error opens a high exception (core.taxonomy_term exception_severity): the row cannot be promoted until a person resolves it. */
export const EXCEPTION_SEVERITY = 'exception_severity.high';
export const NOT_FOUND = 'Intake file not found';
/**
 * The sources whose rows are staged in stg.intake_row with the accounting payload (rowPayload):
 * the accounting export and the operations workbook drop. The accounting file pages and commands
 * answer these and no other source; a weekly file or a look-through run is not found there.
 */
export const ACCOUNTING_SOURCES: readonly IntakeSource[] = ['accounting', 'ops_drop'];

/** The words the approval reason and the audit trail use for an import of each source. */
const IMPORT_LABEL: Readonly<Record<IntakeSource, string>> = {
  accounting: 'accounting import',
  ops_drop: 'ops drop import',
  weekly: 'weekly import',
  lookthrough: 'look-through reconcile',
};

/** "accounting import <file>" or "ops drop import <file>": the default reason a promotion records. */
export function importLabel(file: Pick<IntakeFile, 'source' | 'fileName'>): string {
  return `${IMPORT_LABEL[file.source]} ${file.fileName}`;
}

/** SHA-256 of a file's content, the idempotency key with the source (docs/04 M2). */
export const contentHashOf = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

/**
 * Every threshold through the one strict reader the preview shares (CLAUDE.md rules 9 and 10):
 * a missing key is a 500 naming it, never a default.
 */
export function intakeSettingsOf(definitions: unknown): IntakeSettings {
  try {
    return intakeSettingsFrom(definitions);
  } catch (error) {
    if (error instanceof IntakeSettingsError) throw configError(error.key);
    throw error;
  }
}

/** config/accounting_layout.json checked against the layout schema; anything else is a configuration problem. */
export function accountingLayoutOf(raw: unknown): AccountingLayout {
  const parsed = accountingLayout.safeParse(raw);
  if (!parsed.success)
    throw new ProblemError(
      500,
      'configuration',
      'config/accounting_layout.json is not a usable accounting layout',
    );
  return parsed.data;
}

const file = schema.intakeFile;
const row = schema.intakeRow;
const value = schema.stagedValuation;
const quarter = schema.quarterlyPerformance;
/** The user who received the file, joined by the list and the detail. */
export const receiver = alias(schema.appUser, 'receiver');
const reviewer = alias(schema.appUser, 'reviewer');
const INSERT_CHUNK = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A refused file (the reader rejected it, so it holds no rows) may be staged again once the cause is corrected. */
export const restageable = (f: Pick<IntakeFile, 'status' | 'rowCount'>): boolean =>
  f.status === 'new' && f.rowCount === 0;

/* ---- Receiving a file: the hash, the duplicate, the restage, the race, the audit event ---- */

/** What an intake's reader gives the receipt: the file findings and how to prepare its rows. */
export interface ReadResult<P> {
  fileFindings: Finding[];
  /** The ops-drop template the workbook matched (config/ops_drop_templates.json); null for every other source. */
  templateSignature: string | null;
  /** Links, compares and checks the rows as the system actor; not called for a refused file. */
  prepare: (tx: Tx) => Promise<P[]>;
}

export interface ReceiveInput<P extends { status: StagingState }, D extends IntakeFile> {
  source: IntakeSource;
  fileName: string;
  /** SHA-256 of the file's content (contentHashOf), the idempotency key with the source. */
  contentHash: string;
  /** The audit action of the staging: intake.import for a file, intake.reconcile for a run. */
  action: 'intake.import' | 'intake.reconcile';
  /** The date the file reports for when its rows do not carry it (a look-through run's as-of date). */
  asOf?: string;
  /**
   * Reads the content. Called only once the content is known not to be staged already (a
   * duplicate is answered without a read), and again for a file that was refused before, so a
   * corrected layout or template stages it.
   */
  read: () => Promise<ReadResult<P>> | ReadResult<P>;
  /** Writes the staged rows and the exceptions they open (writeStaged); answers what the audit event carries beyond the counts. */
  insertRows: (tx: Tx, fileId: string, prepared: readonly P[]) => Promise<Record<string, unknown>>;
  /** The file by id as this intake's detail, or null when there is no such file of this intake. */
  load: (tx: Tx, fileId: string) => Promise<D | null>;
}

/**
 * Stage a file. Idempotent by content: the same content answers the file it created before with
 * `duplicate` true and stages nothing (docs/04 M2); the answer is a read of that file and is
 * audited as one. A file the reader refused (status new, no rows) is the exception: the same
 * content is read again, so a corrected layout or template stages it under the file row the
 * refusal left behind. Otherwise the file, its rows and the data exceptions land in one
 * transaction with one audit event that carries counts only (never a cell).
 */
export async function receiveFile<P extends { status: StagingState }, D extends IntakeFile>(
  db: DbService,
  principal: Principal,
  requestId: string,
  input: ReceiveInput<P, D>,
): Promise<D & { duplicate: boolean }> {
  const existing = await db.run(principal, requestId, async (tx, audit) => {
    const found = await findByHash(tx, input.source, input.contentHash, input.load);
    if (found !== null && !restageable(found))
      await audit({ action: 'intake_file.read', entity: 'stg.intake_file', entityId: found.id });
    return found;
  });
  if (existing !== null && !restageable(existing)) return { ...existing, duplicate: true };

  const read = await input.read();
  // A file the reader refuses (an unknown or missing column, an unknown template, nothing to
  // read) holds no rows: a renamed column must never be guessed at.
  const refused = read.fileFindings.some((f) => f.severity === 'error');
  // The system actor links against the whole book (see the module comment); it reads only.
  const prepared = refused ? [] : await db.runAsSystem((tx) => read.prepare(tx));

  return db.run(principal, requestId, async (tx, audit) => {
    const counts = countsOf(prepared.map((p) => p.status));
    const header = {
      rowCount: prepared.length,
      status: fileStatusOf(counts),
      findings: read.fileFindings,
      templateSignature: read.templateSignature,
    };
    // The same content landed from another request meanwhile: answer that file.
    const raced = async (): Promise<D & { duplicate: boolean }> => {
      const found = await findByHash(tx, input.source, input.contentHash, input.load);
      if (found === null) throw new ProblemError(409, 'conflict', 'The import did not complete');
      return { ...found, duplicate: true };
    };
    let fileId: string;
    let name: string;
    if (existing === null) {
      const inserted = await tx
        .insert(file)
        .values({
          source: input.source,
          fileName: input.fileName,
          contentHash: input.contentHash,
          receivedBy: principal.userId,
          ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
          ...header,
        })
        .onConflictDoNothing({ target: [file.source, file.contentHash] })
        .returning();
      const id = inserted[0]?.id;
      if (id === undefined) return raced();
      fileId = id;
      name = input.fileName;
    } else {
      // A refused file staged again: the row the refusal left behind is reused (the content hash
      // is its key), with this receipt and the findings of this reading. Refused again, it keeps
      // its name, its receipt and the earlier answer (duplicate), with the findings brought up
      // to date. The guard on status and row count keeps two re-imports from both staging it.
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

    const written = await input.insertRows(tx, fileId, prepared);
    await audit({
      action: input.action,
      entity: 'stg.intake_file',
      entityId: fileId,
      details: {
        ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
        fileName: name,
        rowCount: prepared.length,
        counts,
        ...(read.templateSignature === null ? {} : { templateSignature: read.templateSignature }),
        ...written,
      },
    });
    const loaded = await input.load(tx, fileId);
    if (loaded === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
    return { ...loaded, duplicate: existing !== null && refused };
  });
}

/** The file staged before from the same content of the same source, as its intake loads it, or null. */
async function findByHash<D>(
  tx: Tx,
  source: IntakeSource,
  contentHash: string,
  load: (tx: Tx, fileId: string) => Promise<D | null>,
): Promise<D | null> {
  const found = await tx
    .select({ id: file.id })
    .from(file)
    .where(and(eq(file.source, source), eq(file.contentHash, contentHash)));
  const id = found[0]?.id;
  return id === undefined ? null : load(tx, id);
}

/* ---- Writing staged rows ---- */

export type ExceptionInsert = typeof schema.dataException.$inferInsert;

/**
 * Writes the staged rows of a file and the data exceptions they open, in chunks. The rows carry
 * their ids (randomUUID) rather than returning them: a RETURNING clause reads the new rows
 * through the select policy, and an importer outside a wall may write the walled position's row
 * but not read it. Which exceptions a row opens, and what they carry (candidates by reason only,
 * no values for a fair value that does not tie: SEC-5.3), is each intake's rule in @pb/validation.
 */
export async function writeStaged<T extends PgTable>(
  tx: Tx,
  table: T,
  values: readonly PgInsertValue<T>[],
  exceptions: readonly ExceptionInsert[],
): Promise<void> {
  for (const batch of chunk(values, INSERT_CHUNK)) await tx.insert(table).values(batch);
  for (const batch of chunk(exceptions, INSERT_CHUNK))
    await tx.insert(schema.dataException).values(batch);
}

/* ---- Loading, shared by the list and every detail ---- */

/**
 * Row counts per status, counted as the system actor inside the caller's transaction so they
 * cover every row, walled ones included (the row policies of migrations 0009 and 0010 hide a
 * walled row from a reader outside its wall): a file's status and counts are facts of the file,
 * the same for every reader, and a number reveals nothing of a hidden row. A file's rows are in
 * stg.intake_row or in stg.valuation (the weekly values); both are counted.
 */
export async function countsByFile(
  tx: Tx,
  fileIds: readonly string[],
): Promise<Map<string, IntakeCounts>> {
  const out = new Map<string, IntakeCounts>();
  if (fileIds.length === 0) return out;
  const ids = [...fileIds];
  const n = sql<number>`count(*)::int`;
  const rows = await asSystemActor(tx, async (stx) => [
    ...(await stx
      .select({ fileId: row.intakeFileId, status: row.status, n })
      .from(row)
      .where(inArray(row.intakeFileId, ids))
      .groupBy(row.intakeFileId, row.status)),
    ...(await stx
      .select({ fileId: value.intakeFileId, status: value.status, n })
      .from(value)
      .where(inArray(value.intakeFileId, ids))
      .groupBy(value.intakeFileId, value.status)),
  ]);
  for (const r of rows) {
    if (r.fileId === null) continue;
    const counts = out.get(r.fileId) ?? emptyCounts();
    counts[r.status] += r.n;
    out.set(r.fileId, counts);
  }
  return out;
}

/**
 * Data exceptions opened about the rows of each file, in stg.intake_row or stg.valuation and
 * whichever intake opened them, counted as the system actor like the status counts, so the
 * header reads the same for every reviewer: a row past the reader's wall is hidden from them,
 * not from the count (Data Health counts the same exceptions for everyone).
 */
export async function exceptionsByFile(
  tx: Tx,
  fileIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (fileIds.length === 0) return out;
  const x = schema.dataException;
  const ofFile = sql<string>`coalesce(${row.intakeFileId}, ${value.intakeFileId})`;
  const rows = await asSystemActor(tx, async (stx) =>
    stx
      .select({ fileId: ofFile, n: sql<number>`count(*)::int` })
      .from(x)
      .leftJoin(row, and(eq(x.entity, 'stg.intake_row'), eq(row.id, x.entityId)))
      .leftJoin(value, and(eq(x.entity, 'stg.valuation'), eq(value.id, x.entityId)))
      .where(inArray(ofFile, [...fileIds]))
      .groupBy(ofFile),
  );
  for (const r of rows) out.set(r.fileId, r.n);
  return out;
}

/** The columns of a file header as the list and the detail select them (the receiver joined). */
export const fileColumns = {
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
};

const findingList = z.array(intakeFinding);

export function toFile(
  r: {
    id: string;
    source: string;
    fileName: string;
    contentHash: string;
    receivedAt: Date;
    receivedBy: string | null;
    rowCount: number;
    status: StagingState;
    findings: unknown;
    templateSignature: string | null;
    rowVersion: number;
  },
  counts: IntakeCounts,
  exceptions: number,
): IntakeFile {
  return {
    id: r.id,
    source: intakeSource.parse(r.source),
    templateSignature: r.templateSignature,
    fileName: r.fileName,
    contentHash: r.contentHash,
    receivedAt: r.receivedAt.toISOString(),
    receivedBy: r.receivedBy,
    rowCount: r.rowCount,
    status: r.status,
    counts,
    fileFindings: findingList.parse(r.findings),
    exceptions,
    rowVersion: r.rowVersion,
  };
}

/** A file's header as the caller may see it, with the facts of the file the system actor counts. */
export interface FileHeader {
  file: IntakeFile;
  asOf: string | null;
  /** Every row of the file, the ones hidden from the caller included. */
  total: number;
}

/**
 * The header of a file of one of the sources given, under the caller's own row-level security
 * (a file they cannot see is null, and so is a file of another intake), with its counts and its
 * exception total from the system actor, so the file reads the same for everyone.
 */
export async function loadHeader(
  tx: Tx,
  fileId: string,
  sources: readonly IntakeSource[],
): Promise<FileHeader | null> {
  const found = await tx
    .select({ ...fileColumns, asOf: file.asOf })
    .from(file)
    .leftJoin(receiver, eq(receiver.id, file.receivedBy))
    .where(and(eq(file.id, fileId), inArray(file.source, [...sources])));
  const header = found[0];
  if (header === undefined) return null;
  const counts = (await countsByFile(tx, [fileId])).get(fileId) ?? emptyCounts();
  const exceptions = (await exceptionsByFile(tx, [fileId])).get(fileId) ?? 0;
  return {
    file: toFile(header, counts, exceptions),
    asOf: header.asOf,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
  };
}

/** What the visibility rule reads of a staged row's link: the position it linked to and the ones it names. */
export interface RowLink {
  investmentId: string | null;
  candidates: readonly { investmentNumber: string }[];
}

/**
 * The rows of a file as the caller may see them. A row linked to an investment the caller cannot
 * open (a walled deal for a non-member) is hidden by its row policy (migrations 0009 and 0010)
 * and, should a policy ever let one through, by this filter; the caller counts it as hidden. A
 * candidate the caller cannot open is for them to drop from the link (visibleNumbers), so nothing
 * reveals a walled position exists (SEC-5.3). Rows with no link are shown to every reviewer.
 */
export async function visibleRowsFor<R>(
  tx: Tx,
  rows: readonly R[],
  link: (r: R) => RowLink,
): Promise<{ visible: R[]; visibleNumbers: ReadonlySet<string> }> {
  const linked = [
    ...new Set(
      rows.flatMap((r) => {
        const id = link(r).investmentId;
        return id === null ? [] : [id];
      }),
    ),
  ];
  const named = [
    ...new Set(rows.flatMap((r) => link(r).candidates.map((c) => c.investmentNumber))),
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
  return {
    visible: rows.filter((r) => {
      const id = link(r).investmentId;
      return id === null || visibleIds.has(id);
    }),
    visibleNumbers: new Set(seen.map((r) => r.investmentNumber)),
  };
}

/* ---- The accounting-shaped staging: the accounting export and the ops drop ---- */

/**
 * What stg.intake_row.payload holds for an accounting-shaped row, written at staging and read
 * back by the detail and the commands: the row as the file said it, the quarter it reports for
 * and how it was linked.
 */
export const rowPayload = z.object({
  investmentNumber: z.string().nullable(),
  companyName: z.string().nullable(),
  periodEnd: z.string().nullable(),
  /** The calendar quarter end the row reports for (alignedQuarterEnd), when the period end is a real date. */
  quarterEnd: z.string().nullable(),
  figures: intakeRowSchema.shape.figures,
  raw: z.record(z.string(), z.string()),
  link: intakeLink,
});
export type RowPayload = z.infer<typeof rowPayload>;
const rowDiff = intakeRowSchema.shape.diff;

/** One staged row as the database holds it, with its jsonb columns parsed. */
export interface StagedRow {
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
export interface LoadedFile {
  detail: IntakeFileDetail;
  visible: StagedRow[];
}

/** The staged row as the file said it, for the diff to be taken again at promotion. */
export function fileRowOf(target: StagedRow): AccountingRow {
  return {
    rowNo: target.rowNo,
    investmentNumber: target.payload.investmentNumber,
    companyName: target.payload.companyName,
    periodEnd: target.payload.periodEnd,
    figures: target.payload.figures,
    raw: target.payload.raw,
  };
}

/** What an accounting-shaped reader gives the staging: the file's rows and findings, and the template a workbook matched. */
export interface ReadOutcome {
  file: AccountingFile;
  /** The ops-drop template the workbook matched (config/ops_drop_templates.json); null for every other source. */
  templateSignature: string | null;
}

export interface StageInput {
  source: IntakeSource;
  /** ops.data_exception.source of the exceptions this intake opens. */
  exceptionSource: string;
  fileName: string;
  /** SHA-256 of the file's content (contentHashOf), the idempotency key with the source (docs/04 M2). */
  contentHash: string;
  /** Reads the file into the accounting layout's rows; called as receiveFile calls a reader. */
  read: () => Promise<ReadOutcome> | ReadOutcome;
  layout: AccountingLayout;
  settings: IntakeSettings;
  asOf: string;
}

/**
 * Stage a file of accounting-shaped rows through receiveFile: the rows are linked, diffed and
 * checked as the system actor through the preparation shared with the preview, then written to
 * stg.intake_row with the exceptions they open; the answer is the file as the caller sees it.
 */
export async function stageFile(
  db: DbService,
  principal: Principal,
  requestId: string,
  input: StageInput,
): Promise<IntakeImportResult> {
  return receiveFile<PreparedRow, IntakeFileDetail>(db, principal, requestId, {
    source: input.source,
    fileName: input.fileName,
    contentHash: input.contentHash,
    action: 'intake.import',
    read: async () => {
      const { file: read, templateSignature } = await input.read();
      return {
        fileFindings: read.fileFindings,
        templateSignature,
        prepare: (tx) => prepareFileRows(tx, read.rows, input.settings, input.asOf),
      };
    },
    insertRows: async (tx, fileId, prepared) => {
      await insertAccountingRows(tx, fileId, prepared, input.layout, input.exceptionSource);
      return {};
    },
    load: async (tx, fileId) => (await loadFile(tx, fileId))?.detail ?? null,
  });
}

/**
 * Links, diffs and checks every row of the file against the book as the system actor sees it,
 * through the preparation shared with the preview (@pb/validation prepare.ts). This side reads
 * the investment directory (number, names, aliases; none are on record yet), the match guards,
 * then the approved quarters and the Locked marks of the investments the rows linked to.
 */
async function prepareFileRows(
  tx: Tx,
  rows: readonly AccountingRow[],
  settings: IntakeSettings,
  asOf: string,
): Promise<PreparedRow[]> {
  const directory = await investmentDirectory(tx);
  const guards = await matchGuards(tx);
  const linked = linkRows(rows, directory, guards);
  const investmentIds = [
    ...new Set(linked.flatMap((l) => (l.link.investment === null ? [] : [l.link.investment.id]))),
  ];
  const quarters = await approvedQuarters(tx, investmentIds);
  const marks = await lockedMarks(tx, investmentIds);
  return prepareRows(
    linked,
    {
      quartersOf: (id) => quarters.get(id) ?? [],
      marksOf: (id) => marks.get(id) ?? [],
    },
    settings,
    asOf,
  );
}

/** Approved quarters per investment, oldest first, as the rules and the diff read them. */
async function approvedQuarters(
  tx: Tx,
  investmentIds: readonly string[],
): Promise<Map<string, RecordQuarter[]>> {
  const out = new Map<string, RecordQuarter[]>();
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

/** Locked marks per investment, highest version first within a period end, so lockedNear() keeps the latest version. */
async function lockedMarks(
  tx: Tx,
  investmentIds: readonly string[],
): Promise<Map<string, LockedMark[]>> {
  const out = new Map<string, LockedMark[]>();
  if (investmentIds.length === 0) return out;
  const v = schema.valuation;
  const rows = await tx
    .select({
      investmentId: v.investmentId,
      periodEnd: v.periodEnd,
      fairValue: v.fairValue,
      state: v.state,
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

/** The staged rows with the accounting payload and the exceptions they open (unresolved names, fair values that do not tie). */
async function insertAccountingRows(
  tx: Tx,
  fileId: string,
  prepared: readonly PreparedRow[],
  layout: AccountingLayout,
  exceptionSource: string,
): Promise<void> {
  const values = prepared.map((p) => ({
    id: randomUUID(),
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
  }));
  const exceptions: ExceptionInsert[] = values.flatMap((v, i) =>
    exceptionsOpenedBy(prepared[i]!).map((opened) => ({
      source: exceptionSource,
      entity: 'stg.intake_row',
      entityId: v.id,
      severity: EXCEPTION_SEVERITY,
      state: 'open',
      ...opened,
    })),
  );
  await writeStaged(tx, row, values, exceptions);
}

/**
 * The accounting-shaped file with its rows in file order, as the caller may see them
 * (visibleRowsFor). Only the accounting sources are answered: the rows of any other source do
 * not carry the accounting payload.
 */
export async function loadFile(tx: Tx, fileId: string): Promise<LoadedFile | null> {
  const header = await loadHeader(tx, fileId, ACCOUNTING_SOURCES);
  if (header === null) return null;
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
  const { visible, visibleNumbers } = await visibleRowsFor(tx, rows, (r) => r.payload.link);
  return {
    detail: {
      ...header.file,
      rows: visible.map((r) => toRow(r, visibleNumbers)),
      hiddenRows: header.total - visible.length,
    },
    visible,
  };
}

/** A staged row for the caller, with only the candidates among the investments they may see. */
function toRow(r: StagedRow, visibleNumbers: ReadonlySet<string>): IntakeRow {
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
