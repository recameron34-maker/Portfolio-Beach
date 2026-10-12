import definitions from '../../../../../config/definitions.json';
import layoutJson from '../../../../../config/accounting_layout.json';
import { intakeCommandBody, intakeFileListQuery, intakeImportBody } from '@pb/contracts';
import type {
  IntakeExportList,
  IntakeFile,
  IntakeFileDetail,
  IntakeFilePage,
  IntakeImportResult,
  IntakeRow,
  StagingState,
} from '@pb/contracts';
import {
  accountingLayout,
  countsOf,
  exceptionsOpenedBy,
  fileStatusOf,
  intakeSettingsFrom,
  linkOf,
  linkRows,
  naturalKeyOf,
  prepareRows,
  readAccountingFile,
  selectTargets,
} from '@pb/validation';
import type { RecordLookups } from '@pb/validation';
import { attempt, stagingMachine } from '@pb/workflows';
import { samplePath } from '../../pages/intake/intake.js';
import type { PreviewBook } from '../book.js';
import { sha256Hex, subtleCrypto } from '../hash.js';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import type { SimActor, SimIntakeFile, SimIntakeRow } from '../state.js';
import { defineSimRoute, recordActivity } from './common.js';
import type { SimContext } from './common.js';

/**
 * The accounting intake (docs/04 M2, SEC-9.1) simulated in the browser, the way
 * apps/api/src/intake/intake.service.ts serves it: the three bundled sample exports are the drop
 * folder; an import reads the file against config/accounting_layout.json, then links, diffs and
 * checks every row through the preparation shared with the API (@pb/validation prepare.ts) against
 * the book as the system actor sees it (preview/book.json, decision 0009), with the thresholds of
 * config/definitions.json through the same reader as the API; the file is keyed by the SHA-256 of
 * its text, so the same text answers the file staged
 * before with duplicate true. A reader sees the rows and the candidates for the positions their own
 * recordings let them open; the rest are counted, never shown. Approve and reject run through the
 * staging transition table. The preview's standing rule: promotion changes the staged rows and the
 * simulated records only, never the recorded production figures, so the book and every recorded
 * response stay as they were.
 */

const SOURCE = 'accounting';
const TARGET_ENTITY = 'quarterly_performance';
const NOT_FOUND = 'Intake file not found';
/**
 * The system actor that promotes approved rows: the same id as SYSTEM_USER_ID in @pb/db (not
 * browser code) with the service role, never a sign-in role (decision 0009).
 */
const SYSTEM_ACTOR = {
  actorId: '00000000-0000-0000-0000-000000000001',
  actorRoles: ['service'],
} as const;
/** A cursor decodes to "receivedAt|id" of the last file listed. */
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\|([0-9a-f-]{36})$/;

/** A file with the rows the credential may see (for the response and the commands). */
interface LoadedFile {
  detail: IntakeFileDetail;
  visible: SimIntakeRow[];
}

const noBook = (instance: string): Response =>
  problem(503, 'unavailable', 'This preview carries no book to check an import against', {
    instance,
    simulated: true,
  });

const notFound = (instance: string): Response =>
  problem(404, 'not-found', NOT_FOUND, { instance, simulated: true });

/** Whether the credential may open the investment: its own recorded detail answered 200, so a wall still hides what it hid. */
function canOpen(ctx: SimContext, credential: string, investmentId: string): boolean {
  return (
    ctx.recordings.status(credential, `/api/v1/investments/${encodeURIComponent(investmentId)}`) ===
    200
  );
}

/** What is on record in the book, as the shared preparation reads it (the API reads the same from the database). */
const bookLookups = (book: PreviewBook): RecordLookups => ({
  quartersOf: (investmentId) => book.quarters[investmentId] ?? [],
  marksOf: (investmentId) => book.lockedMarks[investmentId] ?? [],
});

function toFile(sim: SimIntakeFile): IntakeFile {
  const counts = countsOf(sim.rows.map((r) => r.status));
  return {
    id: sim.id,
    source: SOURCE,
    fileName: sim.fileName,
    contentHash: sim.contentHash,
    receivedAt: sim.receivedAt,
    receivedBy: sim.receivedBy,
    rowCount: sim.rowCount,
    status: fileStatusOf(counts),
    counts,
    fileFindings: sim.fileFindings,
    exceptions: sim.exceptions,
    rowVersion: sim.rowVersion,
  };
}

/** A staged row for the caller, with only the candidates among the investments they may see. */
function toRow(row: SimIntakeRow, visibleNumbers: ReadonlySet<string>): IntakeRow {
  return {
    id: row.id,
    rowNo: row.rowNo,
    naturalKey: row.naturalKey,
    targetEntity: TARGET_ENTITY,
    targetId: row.targetId,
    investmentNumber: row.investmentNumber,
    companyName: row.companyName,
    periodEnd: row.periodEnd,
    figures: row.figures,
    link: {
      ...row.link,
      candidates: row.link.candidates.filter((c) => visibleNumbers.has(c.investmentNumber)),
    },
    diff: row.diff,
    findings: row.findings,
    status: row.status,
    decision: row.decision,
    decidedBy: row.decidedBy,
    promotedAt: row.promotedAt,
  };
}

/**
 * The file with its rows in file order as the credential may see them: a row linked to an
 * investment they cannot open is left out and counted, a candidate they cannot open is dropped
 * from the link, so nothing here reveals a walled position exists (SEC-5.3). Counts cover every
 * row, so the file reads the same for everyone.
 */
function load(ctx: SimContext, credential: string, sim: SimIntakeFile): LoadedFile {
  const idOf = new Map((ctx.book?.investments ?? []).map((i) => [i.investmentNumber, i.id]));
  const visible = sim.rows.filter(
    (r) => r.link.investmentId === null || canOpen(ctx, credential, r.link.investmentId),
  );
  const visibleNumbers = new Set<string>();
  for (const row of sim.rows) {
    for (const candidate of row.link.candidates) {
      const id = idOf.get(candidate.investmentNumber);
      if (id !== undefined && canOpen(ctx, credential, id))
        visibleNumbers.add(candidate.investmentNumber);
    }
  }
  return {
    detail: {
      ...toFile(sim),
      rows: visible.map((r) => toRow(r, visibleNumbers)),
      hiddenRows: sim.rows.length - visible.length,
    },
    visible,
  };
}

function fileStatus(sim: SimIntakeFile): StagingState {
  return fileStatusOf(countsOf(sim.rows.map((r) => r.status)));
}

/** GET /api/v1/intake/accounting/exports: the bundled samples are the drop folder (operations only, the contract's guard). */
export const intakeExportsRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/intake/accounting/exports',
  what: 'exports',
  body: null,
  handle: (req, ctx) => {
    const book = ctx.book;
    if (book === null) return noBook(req.url.pathname);
    const list: IntakeExportList = {
      items: book.samples.map((s) => ({
        id: s.fileName,
        name: s.fileName,
        receivedAt: `${book.asOf}T12:00:00Z`,
      })),
    };
    return jsonResponse(200, list, { simulated: true });
  },
});

/**
 * POST /api/v1/intake/accounting: stage an export, uploaded as text or named among the bundled
 * samples (fetched as a static asset beside the page, never through the shim). Idempotent by
 * content: the same text answers the file staged before with duplicate true.
 */
export const intakeImportRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/intake/accounting',
  what: 'import',
  body: intakeImportBody,
  handle: async (req, ctx) => {
    const instance = req.url.pathname;
    const book = ctx.book;
    if (book === null) return noBook(instance);
    const body = req.body;
    let fileName: string;
    let text: string;
    if ('csv' in body) {
      fileName = body.fileName;
      text = body.csv;
    } else {
      const sample = book.samples.find((s) => s.fileName === body.exportId);
      if (sample === undefined)
        return problem(404, 'not-found', 'Export not found', { instance, simulated: true });
      const asset = await ctx.fetchAsset(samplePath(sample.fileName));
      if (!asset.ok)
        return problem(503, 'unavailable', 'The sample export is missing from this preview', {
          instance,
          simulated: true,
        });
      fileName = sample.fileName;
      text = await asset.text();
    }
    const settings = intakeSettingsFrom(definitions);
    if (new TextEncoder().encode(text).length > settings.maxFileBytes)
      return problem(400, 'validation', 'The file is larger than one import accepts', {
        instance,
        simulated: true,
      });
    if (subtleCrypto() === undefined)
      return problem(
        503,
        'unavailable',
        'This browser offers SHA-256 only on secure (https) pages, so an import cannot be keyed by its content here.',
        { instance, simulated: true },
      );
    const contentHash = await sha256Hex(text);
    const existing = [...ctx.state.intakeFiles.values()].find((f) => f.contentHash === contentHash);
    if (existing !== undefined) {
      const duplicate: IntakeImportResult = {
        ...load(ctx, req.credential, existing).detail,
        duplicate: true,
      };
      return jsonResponse(201, duplicate, { simulated: true });
    }

    const layout = accountingLayout.parse(layoutJson);
    const read = readAccountingFile(text, layout, { maxRows: settings.maxRows });
    // A file the layout refuses (an unknown or missing column, nothing to read) holds no rows:
    // a renamed column must never be guessed at.
    const refused = read.fileFindings.some((f) => f.severity === 'error');
    const prepared = refused
      ? []
      : prepareRows(
          linkRows(read.rows, book.investments, book.matchGuards),
          bookLookups(book),
          settings,
          book.asOf,
        );
    const sim: SimIntakeFile = {
      id: ctx.env.newId(),
      fileName,
      contentHash,
      receivedAt: ctx.env.now(),
      receivedBy: req.actor.displayName,
      rowCount: prepared.length,
      fileFindings: read.fileFindings,
      // The data exceptions the API opens, counted by the rule it shares with the preview.
      exceptions: prepared.flatMap(exceptionsOpenedBy).length,
      rowVersion: 1,
      rows: prepared.map((p) => ({
        id: ctx.env.newId(),
        rowNo: p.row.rowNo,
        naturalKey: naturalKeyOf(p.row, layout),
        targetId: p.targetId,
        status: p.status,
        decision: null,
        decidedBy: null,
        promotedAt: null,
        investmentNumber: p.row.investmentNumber,
        companyName: p.row.companyName,
        periodEnd: p.row.periodEnd,
        quarterEnd: p.quarterEnd,
        figures: p.row.figures,
        link: linkOf(p.link),
        diff: p.diff,
        findings: p.findings,
      })),
    };
    ctx.state.intakeFiles.set(sim.id, sim);
    const counts = countsOf(sim.rows.map((r) => r.status));
    recordActivity(ctx, req.actor, {
      action: 'intake.import',
      entity: 'intake_file',
      entityId: sim.id,
      reason: null,
      from: null,
      to: fileStatusOf(counts),
      details: { rowCount: sim.rowCount, ...counts },
    });
    const result: IntakeImportResult = {
      ...load(ctx, req.credential, sim).detail,
      duplicate: false,
    };
    return jsonResponse(201, result, { simulated: true });
  },
});

const encodeCursor = (file: IntakeFile): string =>
  btoa(`${file.receivedAt}|${file.id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function decodeCursor(cursor: string): { receivedAt: string; id: string } | null {
  let text: string;
  try {
    text = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  const match = CURSOR.exec(text);
  if (match === null) return null;
  return { receivedAt: match[1] ?? '', id: match[2] ?? '' };
}

/** Newest first, by receipt time then id, the API's order. */
const newestFirst = (a: IntakeFile, b: IntakeFile): number =>
  a.receivedAt === b.receivedAt
    ? a.id < b.id
      ? 1
      : a.id > b.id
        ? -1
        : 0
    : a.receivedAt < b.receivedAt
      ? 1
      : -1;

/** GET /api/v1/intake/files: the files staged this session, newest first, with a status filter and cursor paging. */
export const intakeFilesRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/intake/files',
  what: 'query',
  body: null,
  query: intakeFileListQuery,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const after = req.query.cursor === undefined ? null : decodeCursor(req.query.cursor);
    if (req.query.cursor !== undefined && after === null)
      return problem(400, 'validation', 'Invalid cursor', { instance, simulated: true });
    const status = req.query.status;
    const files = [...ctx.state.intakeFiles.values()]
      .map(toFile)
      .sort(newestFirst)
      .filter(
        (f) =>
          (status === undefined || f.status === status) &&
          (after === null ||
            f.receivedAt < after.receivedAt ||
            (f.receivedAt === after.receivedAt && f.id < after.id)),
      );
    const items = files.slice(0, req.query.limit);
    const last = items[items.length - 1];
    const page: IntakeFilePage = {
      items,
      nextCursor: files.length > req.query.limit && last !== undefined ? encodeCursor(last) : null,
    };
    return jsonResponse(200, page, { simulated: true });
  },
});

/** GET /api/v1/intake/files/{id}: the file with the rows the credential may see; an unknown id is not found. */
export const intakeFileRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/intake/files/{id}',
  what: 'file',
  body: null,
  handle: (req, ctx) => {
    const sim = ctx.state.intakeFiles.get(req.params.id ?? '');
    if (sim === undefined) return notFound(req.url.pathname);
    return jsonResponse(200, load(ctx, req.credential, sim).detail, { simulated: true });
  },
});

/** Why an approval would be refused before anything changes: the table's rows, then the preconditions promotion needs. */
function approvalRefusal(
  actor: SimActor,
  targets: readonly SimIntakeRow[],
  instance: string,
): Response | null {
  const approved = attempt(stagingMachine, 'validated', 'approve', {
    actorId: actor.userId,
    actorRoles: actor.roles,
    record: {},
  });
  if (!approved.ok) return workflowProblem(approved, { instance, simulated: true });
  const promoted = attempt(stagingMachine, 'approved', 'promote', { ...SYSTEM_ACTOR, record: {} });
  if (!promoted.ok) return workflowProblem(promoted, { instance, simulated: true });
  for (const target of targets) {
    if (target.link.investmentId === null)
      return problem(
        422,
        'workflow-precondition',
        'staging: the row is not linked to an investment',
        { instance, simulated: true },
      );
    if (target.quarterEnd === null)
      return problem(
        422,
        'workflow-precondition',
        'staging: the row has no period end to promote to',
        { instance, simulated: true },
      );
  }
  return null;
}

function rejectionRefusal(
  actor: SimActor,
  reason: string | undefined,
  instance: string,
): Response | null {
  const result = attempt(stagingMachine, 'flagged', 'reject', {
    actorId: actor.userId,
    actorRoles: actor.roles,
    ...(reason !== undefined ? { reason } : {}),
    record: {},
  });
  return result.ok ? null : workflowProblem(result, { instance, simulated: true });
}

/**
 * One row's approval and promotion. Where the API writes the approved quarter to
 * mon.quarterly_performance with its lineage, the preview's standing rule applies: promotion
 * changes the staged row and the simulated records only, never the recorded figures, so the book
 * and every recorded response stay as they were. The row keeps the lineage the API would give it:
 * the quarter it replaced, or a new id for the quarter it created.
 */
function promote(
  ctx: SimContext,
  actor: SimActor,
  sim: SimIntakeFile,
  target: SimIntakeRow,
  reason: string | undefined,
  at: string,
): void {
  const decision = reason ?? `accounting import ${sim.fileName}`;
  const entityId = target.targetId ?? ctx.env.newId();
  target.status = 'promoted';
  target.decision = decision;
  target.decidedBy = actor.displayName;
  target.promotedAt = at;
  target.targetId = entityId;
  recordActivity(ctx, actor, {
    action: 'quarterly_performance.promote',
    entity: 'quarterly_performance',
    entityId,
    reason: decision,
    from: 'validated',
    to: 'promoted',
    details: { rowNo: target.rowNo },
  });
}

function reject(target: SimIntakeRow, actor: SimActor, reason: string | undefined): void {
  target.status = 'rejected';
  target.decision = reason ?? null;
  target.decidedBy = actor.displayName;
}

/**
 * POST /api/v1/intake/files/{id}/commands. approve: the rows named (or every validated row the
 * caller sees) go validated > approved by the caller, then approved > promoted by the system
 * actor, through the staging table. reject: the rows named (or every flagged row the caller sees)
 * are rejected with the reason the table requires. A command with nothing left to do answers the
 * unchanged file. Everything that can refuse comes before the first change, as the API's
 * transaction would roll back.
 */
export const intakeCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/intake/files/{id}/commands',
  what: 'command',
  body: intakeCommandBody,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const sim = ctx.state.intakeFiles.get(req.params.id ?? '');
    if (sim === undefined) return notFound(instance);
    const { command, reason, rowIds } = req.body;
    const wanted: StagingState = command === 'approve' ? 'validated' : 'flagged';
    // The rows named must be rows of this file the credential sees, in the state the command
    // needs (the rule shared with the API); naming a hidden row is the same as naming a row of another file.
    const selected = selectTargets(load(ctx, req.credential, sim).visible, rowIds, wanted);
    if (!selected.ok)
      return problem(400, 'validation', 'Invalid rowIds', {
        instance,
        simulated: true,
        errors: [selected.refusal],
      });
    const targets = selected.rows;
    if (targets.length > 0) {
      const refusal =
        command === 'approve'
          ? approvalRefusal(req.actor, targets, instance)
          : rejectionRefusal(req.actor, reason, instance);
      if (refusal !== null) return refusal;
      const at = ctx.env.now();
      for (const target of targets) {
        if (command === 'approve') promote(ctx, req.actor, sim, target, reason, at);
        else reject(target, req.actor, reason);
      }
      sim.rowVersion += 1;
    }
    recordActivity(ctx, req.actor, {
      action: `intake.${command}`,
      entity: 'intake_file',
      entityId: sim.id,
      reason: reason ?? null,
      from: null,
      to: fileStatus(sim),
      details: { rows: targets.length },
    });
    return jsonResponse(200, load(ctx, req.credential, sim).detail, { simulated: true });
  },
});
