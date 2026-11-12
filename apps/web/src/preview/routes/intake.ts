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
  IntakeSource,
  StagingState,
} from '@pb/contracts';
import {
  accountingLayout,
  exceptionsOpenedBy,
  intakeSettingsFrom,
  linkOf,
  linkRows,
  naturalKeyOf,
  prepareRows,
  readAccountingFile,
  selectTargets,
} from '@pb/validation';
import type {
  AccountingFile,
  AccountingLayout,
  IntakeSettings,
  RecordLookups,
} from '@pb/validation';
import { attempt, stagingMachine } from '@pb/workflows';
import { samplePath } from '../../pages/intake/intake.js';
import type { PreviewBook } from '../book.js';
import { sha256Hex, subtleCrypto } from '../hash.js';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import type { SimActor, SimIntakeFile, SimIntakeRow } from '../state.js';
import {
  EXCEPTION_SEVERITY,
  SYSTEM_ACTOR,
  defineSimRoute,
  fileOf,
  noBook,
  openException,
  pageNewestFirst,
  readerView,
  recordActivity,
  restageable,
} from './common.js';
import type { SimContext } from './common.js';

/**
 * The accounting intake (docs/04 M2, SEC-9.1) simulated in the browser, the way
 * apps/api/src/intake/intake.service.ts serves it: the three bundled sample exports are the drop
 * folder; an import reads the file against config/accounting_layout.json, then links, diffs and
 * checks every row through the preparation shared with the API (@pb/validation prepare.ts) against
 * the book as the system actor sees it (preview/book.json, decision 0009), with the thresholds of
 * config/definitions.json through the same reader as the API; the file is keyed by the SHA-256 of
 * its text, so the same text answers the file staged before with duplicate true. The staging
 * itself (stageAccountingFile) is shared with the operations workbook drop, as apps/api/src/intake/stage.ts
 * is shared there (CLAUDE.md rule 7): each intake keeps its own reader and hands it in. A reader
 * sees the rows and the candidates for the positions their own recordings let them open; the rest
 * are counted, never shown. Approve and reject run through the staging transition table. The
 * preview's standing rule: promotion changes the staged rows and the simulated records only, never
 * the recorded production figures, so the book and every recorded response stay as they were.
 */

const TARGET_ENTITY = 'quarterly_performance';
const NOT_FOUND = 'Intake file not found';

/** The words the approval reason uses for an import of each source (apps/api/src/intake/stage.ts importLabel). */
const IMPORT_LABEL: Readonly<Record<SimIntakeFile['source'], string>> = {
  accounting: 'accounting import',
  ops_drop: 'ops drop import',
};

/** A file with the rows the credential may see (for the response and the commands). */
interface LoadedFile {
  detail: IntakeFileDetail;
  visible: SimIntakeRow[];
}

const notFound = (instance: string): Response =>
  problem(404, 'not-found', NOT_FOUND, { instance, simulated: true });

/** What is on record in the book, as the shared preparation reads it (the API reads the same from the database). */
const bookLookups = (book: PreviewBook): RecordLookups => ({
  quartersOf: (investmentId) => book.quarters[investmentId] ?? [],
  marksOf: (investmentId) => book.lockedMarks[investmentId] ?? [],
});

/** Every threshold through the one strict reader the API shares (CLAUDE.md rules 9 and 10). */
export function intakeSettings(): IntakeSettings {
  return intakeSettingsFrom(definitions);
}

/** config/accounting_layout.json checked against the layout schema, as the API checks it. */
export function accountingLayoutOf(): AccountingLayout {
  return accountingLayout.parse(layoutJson);
}

function toFile(ctx: SimContext, sim: SimIntakeFile): IntakeFile {
  return fileOf(ctx, sim, sim.source, sim.templateSignature);
}

/** A staged row for the caller, with only the candidates among the investments they may see. */
function toRow(
  row: SimIntakeRow,
  linkFor: (link: SimIntakeRow['link']) => IntakeRow['link'],
): IntakeRow {
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
    link: linkFor(row.link),
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
  const view = readerView(
    ctx,
    credential,
    sim.rows.map((r) => r.link),
  );
  const visible = sim.rows.filter((r) => view.rowVisible(r.link.investmentId));
  return {
    detail: {
      ...toFile(ctx, sim),
      rows: visible.map((r) => toRow(r, view.linkFor)),
      hiddenRows: sim.rows.length - visible.length,
    },
    visible,
  };
}

function fileStatus(ctx: SimContext, sim: SimIntakeFile): StagingState {
  return toFile(ctx, sim).status;
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

/** What an intake's reader gives the staging: the file's rows and findings, and the template a workbook matched. */
export interface AccountingRead {
  file: AccountingFile;
  /** The ops-drop template the workbook matched (config/ops_drop_templates.json); null for the accounting export. */
  templateSignature: string | null;
}

export interface StageInput {
  source: SimIntakeFile['source'];
  /** ops.data_exception.source of the exceptions this intake opens. */
  exceptionSource: string;
  fileName: string;
  /** SHA-256 of the file's content, the idempotency key with the source (docs/04 M2). */
  contentHash: string;
  /**
   * Reads the file into the accounting layout's rows, or answers the problem that refuses the
   * read (a workbook the parser refuses). Called only once the content is known not to be staged
   * already, and again for a file that was refused before, so a corrected layout or template
   * stages it.
   */
  read: () => Promise<AccountingRead | Response> | AccountingRead | Response;
}

/**
 * Stage a file of accounting-shaped rows, as apps/api/src/intake/stage.ts does for the accounting
 * export and the ops drop. Idempotent by content: the same content answers the file staged before
 * with duplicate true and stages nothing. A file the reader refused (no rows) is the exception:
 * the same content is read again, so a corrected layout or template stages it under the file the
 * refusal left behind; refused again, it keeps its name and receipt, with the findings brought up
 * to date, and answers duplicate. Otherwise the file, its rows and the data exceptions they open
 * land together, with one activity entry that carries counts only.
 */
export async function stageAccountingFile(
  ctx: SimContext,
  req: { actor: SimActor; credential: string },
  input: StageInput,
  instance: string,
): Promise<Response> {
  const book = ctx.book;
  if (book === null) return noBook(instance);
  const existing = [...ctx.state.intakeFiles.values()].find(
    (f) => f.source === input.source && f.contentHash === input.contentHash,
  );
  const answer = (sim: SimIntakeFile, duplicate: boolean): Response => {
    const result: IntakeImportResult = { ...load(ctx, req.credential, sim).detail, duplicate };
    return jsonResponse(201, result, { simulated: true });
  };
  if (existing !== undefined && !restageable(existing)) return answer(existing, true);

  const read = await input.read();
  if (read instanceof Response) return read;
  // A file the reader refuses (an unknown or missing column, an unknown template, nothing to
  // read) holds no rows: a renamed column must never be guessed at.
  const refused = read.file.fileFindings.some((f) => f.severity === 'error');
  if (existing !== undefined && refused) {
    existing.fileFindings = read.file.fileFindings;
    return answer(existing, true);
  }
  const settings = intakeSettings();
  const layout = accountingLayoutOf();
  const prepared = refused
    ? []
    : prepareRows(
        linkRows(read.file.rows, book.investments, book.matchGuards),
        bookLookups(book),
        settings,
        book.asOf,
      );
  const rows: SimIntakeRow[] = prepared.map((p) => ({
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
  }));
  const sim: SimIntakeFile = existing ?? {
    id: ctx.env.newId(),
    source: input.source,
    templateSignature: null,
    fileName: input.fileName,
    contentHash: input.contentHash,
    receivedAt: ctx.env.now(),
    receivedBy: req.actor.displayName,
    rowCount: 0,
    fileFindings: [],
    rowVersion: 1,
    rows: [],
  };
  // A refused file staged again takes this receipt and this reading (the API's update).
  sim.receivedAt = ctx.env.now();
  sim.receivedBy = req.actor.displayName;
  sim.rowCount = prepared.length;
  sim.fileFindings = read.file.fileFindings;
  sim.templateSignature = read.templateSignature;
  sim.rows = rows;
  ctx.state.intakeFiles.set(sim.id, sim);
  // Which exceptions a row opens, and what they carry (candidates by reason only, SEC-5.3), is
  // the shared rule in @pb/validation; the API inserts the same rows.
  for (const [i, p] of prepared.entries()) {
    const row = rows[i];
    if (row === undefined) continue;
    for (const opened of exceptionsOpenedBy(p)) {
      openException(ctx, {
        source: input.exceptionSource,
        entity: 'stg.intake_row',
        entityId: row.id,
        ruleId: opened.ruleId,
        expected: opened.expected,
        actual: opened.actual,
        severity: EXCEPTION_SEVERITY,
        candidates: opened.candidates,
        file: sim,
        rowNo: row.rowNo,
        investmentId: row.link.investmentId,
      });
    }
  }
  const file = toFile(ctx, sim);
  recordActivity(ctx, req.actor, {
    action: 'intake.import',
    entity: 'intake_file',
    entityId: sim.id,
    reason: null,
    from: null,
    to: file.status,
    details: { rowCount: sim.rowCount, ...file.counts },
  });
  return answer(sim, false);
}

/** The text of an import body: as uploaded, or a bundled sample fetched as a static asset beside the page. */
export async function importText(
  ctx: SimContext,
  body: { fileName: string; csv: string } | { sampleName: string | undefined },
  instance: string,
  missing: string,
): Promise<{ fileName: string; text: string } | Response> {
  if ('csv' in body) return { fileName: body.fileName, text: body.csv };
  if (body.sampleName === undefined)
    return problem(404, 'not-found', missing, { instance, simulated: true });
  const asset = await ctx.fetchAsset(samplePath(body.sampleName));
  if (!asset.ok)
    return problem(503, 'unavailable', 'The sample file is missing from this preview', {
      instance,
      simulated: true,
    });
  return { fileName: body.sampleName, text: await asset.text() };
}

/** The refusals every content-keyed import shares: the byte limit, and a browser without SHA-256. */
export function contentRefusal(
  text: string,
  maxFileBytes: number,
  instance: string,
): Response | null {
  if (new TextEncoder().encode(text).length > maxFileBytes)
    return problem(400, 'validation', 'The file is larger than one import accepts', {
      instance,
      simulated: true,
    });
  return hashRefusal(instance);
}

/** 503 where the browser offers no SHA-256 (an insecure page), since an import is keyed by its content. */
export function hashRefusal(instance: string): Response | null {
  if (subtleCrypto() !== undefined) return null;
  return problem(
    503,
    'unavailable',
    'This browser offers SHA-256 only on secure (https) pages, so an import cannot be keyed by its content here.',
    { instance, simulated: true },
  );
}

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
    const source = await importText(
      ctx,
      'csv' in body
        ? body
        : { sampleName: book.samples.find((s) => s.fileName === body.exportId)?.fileName },
      instance,
      'Export not found',
    );
    if (source instanceof Response) return source;
    const settings = intakeSettings();
    const refusal = contentRefusal(source.text, settings.maxFileBytes, instance);
    if (refusal !== null) return refusal;
    return stageAccountingFile(
      ctx,
      req,
      {
        source: 'accounting',
        exceptionSource: 'accounting_import',
        fileName: source.fileName,
        contentHash: await sha256Hex(source.text),
        read: () => ({
          file: readAccountingFile(source.text, accountingLayoutOf(), {
            maxRows: settings.maxRows,
          }),
          templateSignature: null,
        }),
      },
      instance,
    );
  },
});

/** Every simulated file of every source as the list carries it (the API lists stg.intake_file whole). */
export function allFiles(ctx: SimContext): IntakeFile[] {
  const sourced = <S extends IntakeSource>(
    sims: Iterable<Parameters<typeof fileOf>[1]>,
    source: S,
  ): IntakeFile[] => [...sims].map((sim) => fileOf(ctx, sim, source, null));
  return [
    ...[...ctx.state.intakeFiles.values()].map((sim) => toFile(ctx, sim)),
    ...sourced(ctx.state.weeklyFiles.values(), 'weekly'),
    ...sourced(ctx.state.lookthroughRuns.values(), 'lookthrough'),
  ];
}

/** GET /api/v1/intake/files: every file staged this session, of every source, newest first, with the status and source filters and cursor paging. */
export const intakeFilesRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/intake/files',
  what: 'query',
  body: null,
  query: intakeFileListQuery,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const { status, source } = req.query;
    const page = pageNewestFirst(
      allFiles(ctx).filter(
        (f) =>
          (status === undefined || f.status === status) &&
          (source === undefined || f.source === source),
      ),
      (f) => ({ at: f.receivedAt, id: f.id }),
      req.query,
    );
    if (page === null)
      return problem(400, 'validation', 'Invalid cursor', { instance, simulated: true });
    const body: IntakeFilePage = page;
    return jsonResponse(200, body, { simulated: true });
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
  const refusal = stagingRefusal(actor, instance);
  if (refusal !== null) return refusal;
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

/** The staging table's answer to an approval: validated > approved by the actor, then approved > promoted by the system actor. */
export function stagingRefusal(actor: SimActor, instance: string): Response | null {
  const approved = attempt(stagingMachine, 'validated', 'approve', {
    actorId: actor.userId,
    actorRoles: actor.roles,
    record: {},
  });
  if (!approved.ok) return workflowProblem(approved, { instance, simulated: true });
  const promoted = attempt(stagingMachine, 'approved', 'promote', { ...SYSTEM_ACTOR, record: {} });
  if (!promoted.ok) return workflowProblem(promoted, { instance, simulated: true });
  return null;
}

/** The staging table's answer to a rejection: flagged > rejected, with the reason it requires. */
export function rejectionRefusal(
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
  const decision = reason ?? `${IMPORT_LABEL[sim.source]} ${sim.fileName}`;
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
      to: fileStatus(ctx, sim),
      details: { rows: targets.length },
    });
    return jsonResponse(200, load(ctx, req.credential, sim).detail, { simulated: true });
  },
});
