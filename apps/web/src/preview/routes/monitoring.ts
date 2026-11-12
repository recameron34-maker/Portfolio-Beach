import definitions from '../../../../../config/definitions.json';
import { latestQuarterEndOnOrBefore } from '@pb/calc';
import {
  monitoringBoardQuery,
  realizationOutlookBody,
  realizationOutlookDetail,
} from '@pb/contracts';
import type {
  DocumentDefinitions,
  ExtractionRunState,
  MonitoringApproval,
  MonitoringBoard,
  MonitoringBoardRow,
  RealizationOutlookDetail,
} from '@pb/contracts';
import { toCsv } from '@pb/validation';
import type { BookInvestment, PreviewBook } from '../book.js';
import { getKey } from '../keys.js';
import { jsonResponse, problem, textResponse } from '../problems.js';
import { quarterKey, valuesOfRun } from '../state.js';
import type { SimOutlook, SimRun } from '../state.js';
import { canOpen, defineSimRoute, noBook, recordActivity } from './common.js';
import type { SimContext } from './common.js';
import {
  EXPECTED_DOC_TYPES,
  deriveExpected,
  documentSettings,
  heldOn,
  todayOf,
} from './documents.js';

/**
 * Portfolio monitoring (docs/04 M9, decision 0012) simulated in the browser, the way
 * apps/api/src/monitoring/ serves it. The board of a quarter has one row per investment of the
 * book held on the period end that the credential's own recordings let them open (the wall), with
 * the expected document that answers for it (the quarterly report of a deal type that reports
 * quarterly figures, else the capital account statement of its sponsor fund), judged on the as-of
 * day with the thresholds of config and never inventing a deadline; the latest simulated run of
 * the investment for the period with its undecided flags; and the approval the quarter reached:
 * approved when the run was approved, pending when the run succeeded unapproved (a revised report
 * waits in review even where the book holds an approved quarter for the period, FIN-5), approved
 * when the book holds one (approved without a time in the synthetic seed). The export is the
 * same rows as CSV. The realization outlook reads the row set this session, else the
 * credential's recorded answer (the seeded outlooks, the default, or the wall's 404); the edit is
 * the deal team's, guarded by config and recorded with before and after (SEC-11.1).
 */

export const INVESTMENT_NOT_FOUND = 'Investment not found';
/** The problem code when config switches the manual outlook edit off. */
export const OUTLOOK_GUARD_PROBLEM = 'realization-outlook-guard';
/** The config key the outlook edit is guarded by. */
export const OUTLOOK_GUARD_KEY = 'realizationFlagEditableOnlyManually';
/** The default every investment carries until somebody sets an outlook. */
export const DEFAULT_OUTLOOK = { outlook: 'none', horizonMonths: 18, note: null } as const;

/** The export's columns, in order: the row's fields by their contract names (apps/api/src/monitoring/board.ts). */
export const BOARD_CSV_COLUMNS: readonly (keyof MonitoringBoardRow)[] = [
  'investmentNumber',
  'companyName',
  'vehicleName',
  'sponsorFundName',
  'dealType',
  'periodEnd',
  'documentStatus',
  'dueDate',
  'ageDays',
  'runState',
  'flagsCount',
  'approval',
  'approvedAt',
  'investmentId',
  'expectedDocumentId',
  'documentId',
  'runId',
];

/** The board's rows as CSV: a header line and one line per row, cells quoted only when they need it; a null is an empty cell. */
export function boardCsv(rows: readonly MonitoringBoardRow[]): string {
  return toCsv(
    BOARD_CSV_COLUMNS,
    rows.map((row) =>
      BOARD_CSV_COLUMNS.map((column) => {
        const value = row[column];
        return value === null ? '' : String(value);
      }),
    ),
  );
}

/** The expected row that answers for the investment this quarter, with the day its document arrived. */
interface BoardExpected {
  id: string;
  dueDate: string;
  receivedDocumentId: string | null;
  receivedOn: string | null;
}

/** The latest run of the investment for the period, with its undecided flags counted. */
interface BoardRun {
  id: string;
  documentId: string;
  state: ExtractionRunState;
  approvedAt: string | null;
  flagsCount: number;
}

/**
 * approved when the latest run is approved; pending when the latest run succeeded and nobody
 * approved it yet, whatever the record holds (a revised report waits in review even where an
 * earlier approval stands, FIN-5); approved when the quarter's record was approved another way;
 * none otherwise. The run's approval time comes first because it is the lineage the record
 * carries; the record's own time answers for figures approved another way
 * (apps/api/src/monitoring/board.ts approvalOf).
 */
export function approvalOf(
  run: BoardRun | null,
  record: { approvedAt: string | null } | null,
): { approval: MonitoringApproval; approvedAt: string | null } {
  if (run !== null && run.approvedAt !== null)
    return { approval: 'approved', approvedAt: run.approvedAt };
  if (run !== null && run.state === 'Succeeded') return { approval: 'pending', approvedAt: null };
  if (record !== null) return { approval: 'approved', approvedAt: record.approvedAt };
  return { approval: 'none', approvedAt: null };
}

/** The expected row of the investment this quarter: by investment for a reporting deal type, else by its sponsor fund. */
function expectedOf(
  ctx: SimContext,
  book: PreviewBook,
  investment: BookInvestment,
  periodEnd: string,
): BoardExpected | null {
  const reports = book.expectedDocumentDefaults.reportingDealTypes.includes(investment.dealType);
  for (const row of ctx.state.expectedDocuments.values()) {
    if (row.periodEnd !== periodEnd) continue;
    const answers = reports
      ? row.docType === EXPECTED_DOC_TYPES.quarterlyFinancials && row.investmentId === investment.id
      : row.docType === EXPECTED_DOC_TYPES.capitalAccountStatement &&
        investment.sponsorFundId !== null &&
        row.sponsorFundId === investment.sponsorFundId;
    if (!answers) continue;
    const received =
      row.receivedDocumentId === null ? undefined : ctx.state.documents.get(row.receivedDocumentId);
    return {
      id: row.id,
      dueDate: row.dueDate,
      receivedDocumentId: row.receivedDocumentId,
      receivedOn: received === undefined ? null : received.receivedAt.slice(0, 10),
    };
  }
  return null;
}

/** The newest run of the investment for the period by (createdAt, id), with its undecided flagged and invalid rows counted. */
function runOf(ctx: SimContext, investmentId: string, periodEnd: string): BoardRun | null {
  let latest: SimRun | null = null;
  for (const run of ctx.state.runs.values()) {
    if (run.investmentId !== investmentId || run.periodEnd !== periodEnd) continue;
    if (
      latest === null ||
      run.createdAt > latest.createdAt ||
      (run.createdAt === latest.createdAt && run.id > latest.id)
    )
      latest = run;
  }
  if (latest === null) return null;
  const flagsCount = valuesOfRun(ctx.state, latest.id).filter(
    (v) =>
      v.decision === null && (v.validationState === 'flagged' || v.validationState === 'invalid'),
  ).length;
  return {
    id: latest.id,
    documentId: latest.documentId,
    state: latest.state,
    approvedAt: latest.approvedAt,
    flagsCount,
  };
}

/** The approved quarterly record of the investment for the period: the quarter promoted this session, else the book's. */
function recordOf(
  ctx: SimContext,
  book: PreviewBook,
  investmentId: string,
  periodEnd: string,
): { approvedAt: string | null } | null {
  const promoted = ctx.state.promotedQuarters.get(quarterKey(investmentId, periodEnd));
  if (promoted !== undefined) return { approvedAt: promoted.approvedAt };
  const onRecord = (book.quarters[investmentId] ?? []).find((q) => q.periodEnd === periodEnd);
  // The synthetic seed approves its quarters without a time.
  return onRecord === undefined ? null : { approvedAt: null };
}

function boardRowOf(
  ctx: SimContext,
  book: PreviewBook,
  investment: BookInvestment,
  periodEnd: string,
  asOf: string,
  settings: DocumentDefinitions,
): MonitoringBoardRow {
  const expected = expectedOf(ctx, book, investment, periodEnd);
  const run = runOf(ctx, investment.id, periodEnd);
  const record = recordOf(ctx, book, investment.id, periodEnd);
  const judged = expected === null ? null : deriveExpected(expected, asOf, settings);
  const fund = book.sponsorFunds.find((f) => f.id === investment.sponsorFundId);
  return {
    investmentId: investment.id,
    investmentNumber: investment.investmentNumber,
    companyName: investment.companyName,
    vehicleName: investment.vehicleName,
    sponsorFundName: fund?.name ?? null,
    dealType: investment.dealType,
    periodEnd,
    expectedDocumentId: expected?.id ?? null,
    documentStatus: judged?.status ?? 'expected',
    dueDate: expected?.dueDate ?? null,
    ageDays: judged?.ageDays ?? null,
    documentId: expected?.receivedDocumentId ?? run?.documentId ?? null,
    runId: run?.id ?? null,
    runState: run?.state ?? null,
    flagsCount: run?.flagsCount ?? 0,
    ...approvalOf(run, record),
  };
}

/** The board's totals: every row counted once by document status, and the rows awaiting or past approval. */
export function boardCounts(rows: readonly MonitoringBoardRow[]): MonitoringBoard['counts'] {
  const counts = { expected: 0, received: 0, late: 0, missing: 0, inReview: 0, approved: 0 };
  for (const row of rows) {
    counts[row.documentStatus] += 1;
    if (row.approval === 'pending') counts.inReview += 1;
    if (row.approval === 'approved') counts.approved += 1;
  }
  return counts;
}

/** The board as the credential sees it: one row per investment held on the period end they may open, by number. */
export function boardOf(
  ctx: SimContext,
  book: PreviewBook,
  credential: string,
  query: { periodEnd?: string | undefined; asOf?: string | undefined },
): MonitoringBoard {
  const settings = documentSettings();
  const asOf = query.asOf ?? todayOf(book);
  const periodEnd = query.periodEnd ?? latestQuarterEndOnOrBefore(asOf);
  const rows = book.investments
    .filter((i) => heldOn(i, periodEnd) && canOpen(ctx, credential, i.id))
    .sort((a, b) => (a.investmentNumber < b.investmentNumber ? -1 : 1))
    .map((i) => boardRowOf(ctx, book, i, periodEnd, asOf, settings));
  return { asOf, periodEnd, rows, counts: boardCounts(rows) };
}

/** GET /api/v1/monitoring/board: the board of a quarter (the latest quarter end on or before the as-of day when none is named). */
export const boardRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/monitoring/board',
  what: 'query',
  body: null,
  query: monitoringBoardQuery,
  handle: (req, ctx) => {
    const book = ctx.book;
    if (book === null) return noBook(req.url.pathname);
    return jsonResponse(200, boardOf(ctx, book, req.credential, req.query), { simulated: true });
  },
});

/** GET /api/v1/monitoring/board/export: the same rows as the board shows the caller, as CSV text with a header line. */
export const boardExportRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/monitoring/board/export',
  what: 'query',
  body: null,
  query: monitoringBoardQuery,
  handle: (req, ctx) => {
    const book = ctx.book;
    if (book === null) return noBook(req.url.pathname);
    const board = boardOf(ctx, book, req.credential, req.query);
    return textResponse(200, boardCsv(board.rows), {
      mediaType: 'text/csv',
      fileName: `monitoring-board-${board.periodEnd}.csv`,
      simulated: true,
    });
  },
});

function outlookDetail(
  investment: BookInvestment,
  row: SimOutlook | null,
): RealizationOutlookDetail {
  const names = {
    investmentId: investment.id,
    investmentNumber: investment.investmentNumber,
    companyName: investment.companyName,
  };
  if (row === null) return { ...names, ...DEFAULT_OUTLOOK, setBy: null, setAt: null };
  return {
    ...names,
    outlook: row.outlook,
    horizonMonths: row.horizonMonths,
    note: row.note,
    setBy: row.setBy,
    setAt: row.setAt,
  };
}

/**
 * GET /api/v1/monitoring/outlook/{investmentId}: the outlook set this session for an investment
 * the caller may open; else the credential's recorded answer (a seeded outlook, the default, or
 * the wall's 404), else the default from the book; 404 for one they cannot see.
 */
export const outlookRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/monitoring/outlook/{investmentId}',
  what: 'outlook',
  body: null,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const investmentId = req.params.investmentId ?? '';
    const notFound = (): Response =>
      problem(404, 'not-found', INVESTMENT_NOT_FOUND, { instance, simulated: true });
    const investment = ctx.book?.investments.find((i) => i.id === investmentId);
    if (investment === undefined || !canOpen(ctx, req.credential, investment.id)) return notFound();
    const set = ctx.state.outlooks.get(investment.id);
    if (set !== undefined)
      return jsonResponse(200, outlookDetail(investment, set), { simulated: true });
    const recorded = ctx.recordings.byKey(getKey(req.credential, instance));
    if (recorded !== undefined)
      return new Response(recorded.text, {
        status: recorded.status,
        headers: { 'content-type': recorded.contentType, 'x-request-id': 'preview' },
      });
    return jsonResponse(200, outlookDetail(investment, null), { simulated: true });
  },
});

/**
 * PUT /api/v1/monitoring/outlook/{investmentId} (deal team; a wall member for a walled
 * investment): one row per investment, created or replaced, with the person and the time it was
 * set; refused while config switches the manual edit off; recorded with the reason.
 */
export const setOutlookRoute = defineSimRoute({
  method: 'PUT',
  path: '/api/v1/monitoring/outlook/{investmentId}',
  what: 'outlook',
  body: realizationOutlookBody,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const book = ctx.book;
    if (book === null) return noBook(instance);
    const guard: unknown = (definitions as Record<string, unknown>)[OUTLOOK_GUARD_KEY];
    if (typeof guard !== 'boolean')
      return problem(
        500,
        'configuration',
        `config/definitions.json is missing a usable ${OUTLOOK_GUARD_KEY}`,
        { instance, simulated: true },
      );
    if (!guard)
      return problem(
        409,
        OUTLOOK_GUARD_PROBLEM,
        `The realization outlook is changed only by an explicit edit, and definitions.${OUTLOOK_GUARD_KEY} is off`,
        { instance, simulated: true },
      );
    const investmentId = req.params.investmentId ?? '';
    const investment = book.investments.find((i) => i.id === investmentId);
    if (investment === undefined || !canOpen(ctx, req.credential, investment.id))
      return problem(404, 'not-found', INVESTMENT_NOT_FOUND, { instance, simulated: true });
    const before =
      ctx.state.outlooks.get(investment.id) ??
      ctx.recordings.read(req.credential, instance, realizationOutlookDetail) ??
      null;
    const body = req.body;
    const row: SimOutlook = {
      investmentId: investment.id,
      outlook: body.outlook,
      horizonMonths: body.horizonMonths,
      note: body.note,
      setById: req.actor.userId,
      setBy: req.actor.displayName,
      setAt: ctx.env.now(),
      rowVersion: (ctx.state.outlooks.get(investment.id)?.rowVersion ?? 0) + 1,
    };
    ctx.state.outlooks.set(investment.id, row);
    recordActivity(ctx, req.actor, {
      action: 'realization_outlook.set',
      entity: 'realization_outlook',
      entityId: investment.id,
      reason: body.reason,
      from: before?.setAt === null || before === null ? null : before.outlook,
      to: body.outlook,
    });
    return jsonResponse(200, outlookDetail(investment, row), { simulated: true });
  },
});
