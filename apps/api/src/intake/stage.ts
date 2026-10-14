import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Principal } from '@pb/adapters';
import {
  intakeSource,
  intakeFinding,
  intakeLink,
  intakeRow as intakeRowSchema,
} from '@pb/contracts';
import type {
  IntakeFile,
  IntakeFileDetail,
  IntakeImportResult,
  IntakeRow,
  IntakeSource,
  StagingState,
  intakeCounts,
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
 * The staging every intake of accounting-shaped rows shares (docs/04 M2, SEC-9.1, decision 0010):
 * the accounting export and the operations workbook drop both read a file into the accounting
 * layout's rows, link, diff and check them as the system actor (decision 0009), and land the file,
 * its rows and the data exceptions they open in stg.* with one audit event that carries counts
 * only. Each intake keeps its own reader (a CSV, a workbook matched by template signature) and
 * hands it in as `read`; everything from the duplicate check to the staged file lives here once
 * (CLAUDE.md rule 7). The loaders below are shared with the commands and the list: a file reads
 * the same for every reviewer (counts by the system actor), each reader sees only the rows and the
 * candidates their row-level security admits.
 */

type IntakeCounts = z.infer<typeof intakeCounts>;

export const TARGET_ENTITY = 'quarterly_performance';
/** A rule error opens a high exception (core.taxonomy_term exception_severity): the row cannot be promoted until a person resolves it. */
export const EXCEPTION_SEVERITY = 'exception_severity.high';
export const NOT_FOUND = 'Intake file not found';

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

/**
 * What stg.intake_row.payload holds, written at staging and read back by the detail and the
 * commands: the row as the file said it, the quarter it reports for and how it was linked.
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
const findingList = z.array(intakeFinding);

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

const file = schema.intakeFile;
const row = schema.intakeRow;
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

/** What an intake's reader gives the staging: the file's rows and findings, and the template a workbook matched. */
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
  /** SHA-256 of the file's content, the idempotency key with the source (docs/04 M2). */
  contentHash: string;
  /**
   * Reads the file into the accounting layout's rows. Called only once the content is known not
   * to be staged already (a duplicate is answered without a read), and again for a file that was
   * refused before, so a corrected layout or template stages it.
   */
  read: () => Promise<ReadOutcome> | ReadOutcome;
  layout: AccountingLayout;
  settings: IntakeSettings;
  asOf: string;
}

/**
 * Stage a file of accounting-shaped rows. Idempotent by content: the same content answers the
 * file it created before with `duplicate` true and stages nothing (docs/04 M2); the answer is a
 * read of that file's figures and is audited as one. A file the reader refused (status new, no
 * rows) is the exception: the same content is read again, so a corrected layout or template
 * stages it under the file row the refusal left behind. Otherwise the file, its rows and the data
 * exceptions land in one transaction with one audit event that carries counts only.
 */
export async function stageFile(
  db: DbService,
  principal: Principal,
  requestId: string,
  input: StageInput,
): Promise<IntakeImportResult> {
  const existing = await db.run(principal, requestId, async (tx, audit) => {
    const found = await findByHash(tx, input.source, input.contentHash);
    if (found !== null && !restageable(found))
      await audit({ action: 'intake_file.read', entity: 'stg.intake_file', entityId: found.id });
    return found;
  });
  if (existing !== null && !restageable(existing)) return { ...existing, duplicate: true };

  const { file: read, templateSignature } = await input.read();
  // A file the reader refuses (an unknown or missing column, an unknown template, nothing to
  // read) holds no rows: a renamed column must never be guessed at.
  const refused = read.fileFindings.some((f) => f.severity === 'error');
  // The system actor links against the whole book (see the module comment); it reads only.
  const prepared = refused
    ? []
    : await db.runAsSystem((tx) => prepareFileRows(tx, read.rows, input.settings, input.asOf));

  return db.run(principal, requestId, async (tx, audit) => {
    const counts = countsOf(prepared.map((p) => p.status));
    const header = {
      rowCount: prepared.length,
      status: fileStatusOf(counts),
      findings: read.fileFindings,
      templateSignature,
    };
    // The same content landed from another request meanwhile: answer that file.
    const raced = async (): Promise<IntakeImportResult> => {
      const found = await findByHash(tx, input.source, input.contentHash);
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

    await insertRows(tx, fileId, prepared, input.layout, input.exceptionSource);
    await audit({
      action: 'intake.import',
      entity: 'stg.intake_file',
      entityId: fileId,
      details: {
        fileName: name,
        rowCount: prepared.length,
        counts,
        ...(templateSignature === null ? {} : { templateSignature }),
      },
    });
    const loaded = await loadFile(tx, fileId);
    if (loaded === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
    return { ...loaded.detail, duplicate: existing !== null && refused };
  });
}

/** The file staged before from the same content of the same source, or null. */
export async function findByHash(
  tx: Tx,
  source: IntakeSource,
  contentHash: string,
): Promise<IntakeFileDetail | null> {
  const found = await tx
    .select({ id: file.id })
    .from(file)
    .where(and(eq(file.source, source), eq(file.contentHash, contentHash)));
  const id = found[0]?.id;
  if (id === undefined) return null;
  return (await loadFile(tx, id))?.detail ?? null;
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

/** Writes the staged rows and the data exceptions they open (unresolved names, fair values that do not tie). */
async function insertRows(
  tx: Tx,
  fileId: string,
  prepared: readonly PreparedRow[],
  layout: AccountingLayout,
  exceptionSource: string,
): Promise<void> {
  const ids = new Map<number, string>();
  for (const batch of chunk(prepared, INSERT_CHUNK)) {
    // Ids are given here, not returned: a RETURNING clause reads the new rows through the select
    // policy, and the importer outside a wall may write the walled position's row but not read it.
    const values = batch.map((p) => ({
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
    await tx.insert(row).values(values);
    for (const r of values) ids.set(r.rowNo, r.id);
  }

  // Which exceptions a row opens, and what they carry (candidates by reason only, no values for
  // a fair value that does not tie: SEC-5.3), is the shared rule in @pb/validation.
  const exceptions: (typeof schema.dataException.$inferInsert)[] = prepared.flatMap((p) => {
    const rowId = ids.get(p.row.rowNo);
    if (rowId === undefined) return [];
    return exceptionsOpenedBy(p).map((opened) => ({
      source: exceptionSource,
      entity: 'stg.intake_row',
      entityId: rowId,
      severity: EXCEPTION_SEVERITY,
      state: 'open',
      ...opened,
    }));
  });
  for (const batch of chunk(exceptions, INSERT_CHUNK))
    await tx.insert(schema.dataException).values(batch);
}

/**
 * Row counts per status, counted as the system actor inside the caller's transaction so they
 * cover every row, walled ones included (the row policy of migration 0009 hides a walled row
 * from a reader outside its wall): a file's status and counts are facts of the file, the same
 * for every reader, and a number reveals nothing of a hidden row.
 */
export async function countsByFile(
  tx: Tx,
  fileIds: readonly string[],
): Promise<Map<string, IntakeCounts>> {
  const out = new Map<string, IntakeCounts>();
  if (fileIds.length === 0) return out;
  const rows = await asSystemActor(tx, async (stx) =>
    stx
      .select({
        fileId: row.intakeFileId,
        status: row.status,
        n: sql<number>`count(*)::int`,
      })
      .from(row)
      .where(inArray(row.intakeFileId, [...fileIds]))
      .groupBy(row.intakeFileId, row.status),
  );
  for (const r of rows) {
    const counts = out.get(r.fileId) ?? emptyCounts();
    counts[r.status] += r.n;
    out.set(r.fileId, counts);
  }
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

/**
 * Data exceptions opened about the rows of each file, whichever intake opened them, counted as the
 * system actor like the status counts, so the header reads the same for every reviewer: a row past
 * the reader's wall is hidden from them, not from the count (Data Health counts the same
 * exceptions for everyone).
 */
export async function exceptionsByFile(
  tx: Tx,
  fileIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (fileIds.length === 0) return out;
  const rows = await asSystemActor(tx, async (stx) =>
    stx
      .select({ fileId: row.intakeFileId, n: sql<number>`count(*)::int` })
      .from(schema.dataException)
      .innerJoin(row, eq(row.id, schema.dataException.entityId))
      .where(
        and(
          eq(schema.dataException.entity, 'stg.intake_row'),
          inArray(row.intakeFileId, [...fileIds]),
        ),
      )
      .groupBy(row.intakeFileId),
  );
  for (const r of rows) out.set(r.fileId, r.n);
  return out;
}

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

/**
 * The file with its rows in file order, as the caller may see them. A row linked to an
 * investment the caller cannot open (a walled deal for a non-member) is hidden by its row policy
 * (migration 0009) and, should a policy ever let one through, by the filter below; it is counted
 * as hidden. Rows with no link are shown to every reviewer. The counts come from the system actor
 * and cover every row, so the file reads the same for everyone.
 */
export async function loadFile(tx: Tx, fileId: string): Promise<LoadedFile | null> {
  const found = await tx
    .select(fileColumns)
    .from(file)
    .leftJoin(receiver, eq(receiver.id, file.receivedBy))
    .where(eq(file.id, fileId));
  const header = found[0];
  if (header === undefined) return null;
  const counts = (await countsByFile(tx, [fileId])).get(fileId) ?? emptyCounts();
  const exceptions = (await exceptionsByFile(tx, [fileId])).get(fileId) ?? 0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
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
      ...toFile(header, counts, exceptions),
      rows: visible.map((r) => toRow(r, visibleNumbers)),
      hiddenRows: total - visible.length,
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
