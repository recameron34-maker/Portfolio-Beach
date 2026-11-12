import definitions from '../../../../../config/definitions.json';
import { intakeCommandBody, weeklyImportBody } from '@pb/contracts';
import type {
  IntakeExportList,
  StagingState,
  WeeklyFileDetail,
  WeeklyImportResult,
  WeeklyRow as WeeklyRowOut,
} from '@pb/contracts';
import {
  WEEKLY_RULES,
  digitsOf,
  exceptionsOpenedBy,
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
  ExceptionSource,
  WeeklyLinkedRow,
  WeeklyPrior,
  WeeklyRuleConfig,
} from '@pb/validation';
import type { PreviewBook } from '../book.js';
import { sha256Hex } from '../hash.js';
import { jsonResponse, problem } from '../problems.js';
import type { SimActor, SimWeeklyFile, SimWeeklyRow } from '../state.js';
import {
  defineSimRoute,
  fileOf,
  noBook,
  openException,
  readerView,
  recordActivity,
  restageable,
} from './common.js';
import type { SimContext } from './common.js';
import {
  contentRefusal,
  importText,
  intakeSettings,
  rejectionRefusal,
  stagingRefusal,
} from './intake.js';
import { createDraft, readDetail } from './valuations.js';

/**
 * The weekly report values (docs/04 M2 weekly-report-intake, decision 0010, SEC-9.1) simulated
 * in the browser, the way apps/api/src/intake/weekly/weekly.service.ts serves them: the bundled
 * weekly samples are the drop folder; an import reads the four-column file, links every row to
 * the book as the system actor (decision 0009), compares it with its prior (the latest Locked
 * mark on or before the report date, from the book, or the weekly value an earlier simulated
 * import promoted after that mark) and runs the weekly rules of @pb/validation with the
 * thresholds of config/definitions.json. The file is keyed by the SHA-256 of its text with its
 * source. A weekly value never becomes a mark: approving a row creates a simulated Draft valuation
 * of method weekly_report that the valuations board and the one-pager show (the standing rule:
 * nothing simulated changes a recorded figure). A reader sees the rows and the candidates for the
 * positions their own recordings let them open; the rest are counted, never shown.
 */

const SOURCE = 'weekly';
const EXCEPTION_SOURCE = 'weekly_intake';
/** The valuation method of a Draft created from a weekly value (core.taxonomy_term, migration 0010). */
const METHOD = 'valuation_method.weekly_report';
/** A rule error opens a high exception: the row cannot be promoted until a person resolves it. */
const EXCEPTION_SEVERITY = 'exception_severity.high';
const NOT_FOUND = 'Weekly values file not found';
/** Digits before the point that stg.valuation.variance_pct (numeric 20,8) holds. */
const VARIANCE_INTEGER_DIGITS = 12;
const VARIANCE_SCALE = 8;

/** A file with every row (for counts) and the rows the caller may see (for the response). */
interface LoadedFile {
  detail: WeeklyFileDetail;
  visible: SimWeeklyRow[];
}

/** A Locked mark as the prior rule reads it; the book lists the highest version first within a period end. */
interface Mark {
  periodEnd: string;
  fairValue: string;
}

/** A promoted weekly value as the prior rule reads it. */
interface PromotedWeekly {
  reportDate: string;
  reportedValue: string;
}

const notFound = (instance: string): Response =>
  problem(404, 'not-found', NOT_FOUND, { instance, simulated: true });

const precondition = (detail: string, instance: string): Response =>
  problem(422, 'workflow-precondition', detail, { instance, simulated: true });

/**
 * The prior for a report date (decision 0010), as priorFor in the API's weekly service reads it:
 * the latest Locked mark on or before the report date (a mark locked for a later date did not
 * exist when the week was reported), or the latest promoted weekly value reported after that mark
 * and on or before this report date. Marks come highest version first within a period end, so
 * the first mark at the latest period end is the latest version's.
 */
export function priorFor(
  reportDate: string,
  marks: readonly Mark[],
  weeklies: readonly PromotedWeekly[],
): WeeklyPrior | null {
  let mark: Mark | null = null;
  for (const m of marks) {
    if (m.periodEnd > reportDate) continue;
    if (mark === null || m.periodEnd > mark.periodEnd) mark = m;
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

/** Promoted weekly values per investment (a Draft valuation was created from them), in promotion order. */
function promotedWeeklies(ctx: SimContext): Map<string, PromotedWeekly[]> {
  const out = new Map<string, PromotedWeekly[]>();
  const promoted = [...ctx.state.weeklyFiles.values()]
    .flatMap((f) => f.rows)
    .filter(
      (r) =>
        r.status === 'promoted' &&
        r.valuationId !== null &&
        r.investmentId !== null &&
        r.reportDate !== null &&
        r.reportedValue !== null,
    )
    .sort((a, b) =>
      a.promotedAt === b.promotedAt
        ? a.rowNo - b.rowNo
        : (a.promotedAt ?? '') < (b.promotedAt ?? '')
          ? -1
          : 1,
    );
  for (const r of promoted) {
    if (r.investmentId === null || r.reportDate === null || r.reportedValue === null) continue;
    const list = out.get(r.investmentId) ?? [];
    list.push({ reportDate: r.reportDate, reportedValue: r.reportedValue });
    out.set(r.investmentId, list);
  }
  return out;
}

/** A row of the file prepared for staging, with what the exception rule reads of it (the link as linked, not as summarized). */
interface PreparedValue {
  sim: SimWeeklyRow;
  source: ExceptionSource;
}

/**
 * Links every row against the book (the shared linking of @pb/validation), finds each linked
 * row's prior among the book's Locked marks and the weekly values promoted this session, takes
 * the variance and runs the weekly rules, as the API's weekly service prepares a file.
 */
function prepare(
  ctx: SimContext,
  book: PreviewBook,
  rows: ReturnType<typeof readWeeklyFile>['rows'],
  config: WeeklyRuleConfig,
): PreparedValue[] {
  const linked: WeeklyLinkedRow[] = linkRows(rows, book.investments, book.matchGuards);
  const weeklies = promotedWeeklies(ctx);
  return linked.map(({ row, link }) => {
    const reportDate = reportDateOf(row, config);
    const investmentId = link.investment?.id ?? null;
    const prior =
      reportDate === null || investmentId === null
        ? null
        : priorFor(
            reportDate,
            book.lockedMarks[investmentId] ?? [],
            weeklies.get(investmentId) ?? [],
          );
    const findings = runRules(WEEKLY_RULES, {
      row,
      file: linked,
      link,
      prior,
      asOf: book.asOf,
      config,
    });
    const fits = !findings.some((f) => f.ruleId === 'WK-TYPE-05');
    const decimal = reportedValueOf(row);
    const variance = weeklyVariance(row.reportedValue, prior);
    const sim: SimWeeklyRow = {
      id: ctx.env.newId(),
      rowNo: row.rowNo,
      investmentNumber: row.investmentNumber,
      companyName: row.companyName,
      investmentId,
      reportDate,
      // The typed column holds the value only as the record can hold it (at the record's scale,
      // as the numeric column reads back; WK-TYPE-05 refused anything that would round);
      // otherwise the raw cell is what the reviewer sees and nothing is rounded (CLAUDE.md rule 10).
      reportedValue: decimal !== null && fits ? decimal.toFixed(config.figureScale) : null,
      priorValue: prior?.value ?? null,
      priorSource: prior?.source ?? null,
      priorDate: prior?.date ?? null,
      variancePct:
        variance !== null &&
        digitsOf(variance.toFixed(VARIANCE_SCALE)).integerDigits <= VARIANCE_INTEGER_DIGITS
          ? variance.toFixed(VARIANCE_SCALE)
          : null,
      flag: weeklyFlagOf(findings),
      status: statusFromFindings(findings),
      decision: null,
      decidedBy: null,
      decidedAt: null,
      promotedAt: null,
      valuationId: null,
      link: linkOf(link),
      findings,
      raw: row.raw,
    };
    return { sim, source: { row, link, findings } };
  });
}

/**
 * A staged value for the caller, with only the candidates among the investments they may see.
 * The report date and the value are the cells as the file wrote them (the typed columns stand
 * behind the prior, the variance and the Draft), so the reviewer sees what will be refused.
 */
function toRow(
  r: SimWeeklyRow,
  linkFor: (link: SimWeeklyRow['link']) => SimWeeklyRow['link'],
): WeeklyRowOut {
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
    priorSource: r.priorSource,
    priorDate: r.priorDate,
    variancePct: r.variancePct,
    flag: r.flag,
    link: linkFor(r.link),
    findings: r.findings,
    status: r.status,
    decision: r.decision,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt,
    valuationId: r.valuationId,
  };
}

/** The file with its rows in file order as the credential may see them; counts cover every row (SEC-5.3). */
function load(ctx: SimContext, credential: string, sim: SimWeeklyFile): LoadedFile {
  const view = readerView(
    ctx,
    credential,
    sim.rows.map((r) => r.link),
  );
  const visible = sim.rows.filter((r) => view.rowVisible(r.investmentId));
  return {
    detail: {
      ...fileOf(ctx, sim, SOURCE, null),
      rows: visible.map((r) => toRow(r, view.linkFor)),
      hiddenRows: sim.rows.length - visible.length,
    },
    visible,
  };
}

/** GET /api/v1/intake/weekly/drops: the bundled weekly samples are the drop folder (operations only). */
export const weeklyDropsRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/intake/weekly/drops',
  what: 'drops',
  body: null,
  handle: (req, ctx) => {
    const book = ctx.book;
    if (book === null) return noBook(req.url.pathname);
    const list: IntakeExportList = {
      items: book.weeklySamples.map((s) => ({
        id: s.fileName,
        name: s.fileName,
        receivedAt: `${s.reportDate}T12:00:00Z`,
      })),
    };
    return jsonResponse(200, list, { simulated: true });
  },
});

/**
 * POST /api/v1/intake/weekly: stage a weekly values file, uploaded as text or named among the
 * bundled samples. Idempotent by content: the same text answers the file staged before with
 * duplicate true; a file whose header was refused (no rows) is read again.
 */
export const weeklyImportRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/intake/weekly',
  what: 'import',
  body: weeklyImportBody,
  handle: async (req, ctx) => {
    const instance = req.url.pathname;
    const book = ctx.book;
    if (book === null) return noBook(instance);
    const body = req.body;
    const source = await importText(
      ctx,
      'csv' in body
        ? body
        : { sampleName: book.weeklySamples.find((s) => s.fileName === body.dropId)?.fileName },
      instance,
      'Drop file not found',
    );
    if (source instanceof Response) return source;
    const settings = intakeSettings();
    const refusal = contentRefusal(source.text, settings.maxFileBytes, instance);
    if (refusal !== null) return refusal;
    const contentHash = await sha256Hex(source.text);
    const answer = (sim: SimWeeklyFile, duplicate: boolean): Response => {
      const result: WeeklyImportResult = { ...load(ctx, req.credential, sim).detail, duplicate };
      return jsonResponse(201, result, { simulated: true });
    };
    const existing = [...ctx.state.weeklyFiles.values()].find((f) => f.contentHash === contentHash);
    if (existing !== undefined && !restageable(existing)) return answer(existing, true);

    const read = readWeeklyFile(source.text, { maxRows: settings.maxRows });
    // A file the layout refuses (a column missing or added, nothing to read) holds no rows: a
    // renamed column must never be guessed at.
    const refused = read.fileFindings.some((f) => f.severity === 'error');
    if (existing !== undefined && refused) {
      existing.fileFindings = read.fileFindings;
      return answer(existing, true);
    }
    const prepared = refused
      ? []
      : prepare(ctx, book, read.rows, weeklyRuleConfigFrom(definitions));
    const rows = prepared.map((p) => p.sim);
    const sim: SimWeeklyFile = existing ?? {
      id: ctx.env.newId(),
      fileName: source.fileName,
      contentHash,
      receivedAt: ctx.env.now(),
      receivedBy: req.actor.displayName,
      rowCount: 0,
      fileFindings: [],
      rowVersion: 1,
      rows: [],
    };
    sim.receivedAt = ctx.env.now();
    sim.receivedBy = req.actor.displayName;
    sim.rowCount = rows.length;
    sim.fileFindings = read.fileFindings;
    sim.rows = rows;
    ctx.state.weeklyFiles.set(sim.id, sim);
    // Which exceptions a row opens is the shared rule in @pb/validation; the rule id carries this intake's prefix.
    for (const { sim: row, source } of prepared) {
      for (const opened of exceptionsOpenedBy(source)) {
        openException(ctx, {
          source: EXCEPTION_SOURCE,
          entity: 'stg.valuation',
          entityId: row.id,
          ruleId: `WK-${opened.ruleId}`,
          expected: opened.expected,
          actual: opened.actual,
          severity: EXCEPTION_SEVERITY,
          candidates: opened.candidates,
          file: sim,
          rowNo: row.rowNo,
          investmentId: row.investmentId,
        });
      }
    }
    const file = fileOf(ctx, sim, SOURCE, null);
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
  },
});

/** GET /api/v1/intake/weekly/files/{id}: the file with the values the credential may see; an unknown id is not found. */
export const weeklyFileRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/intake/weekly/files/{id}',
  what: 'file',
  body: null,
  handle: (req, ctx) => {
    const sim = ctx.state.weeklyFiles.get(req.params.id ?? '');
    if (sim === undefined) return notFound(req.url.pathname);
    return jsonResponse(200, load(ctx, req.credential, sim).detail, { simulated: true });
  },
});

/**
 * Why an approval would be refused before anything changes: the staging table's rows, then what
 * promotion needs of each row (a link, a report date, a value the record holds) and of its
 * investment ((new) > Draft needs an active investment the reviewer may open, docs/18 section 1).
 */
function approvalRefusal(
  ctx: SimContext,
  req: { actor: SimActor; credential: string },
  targets: readonly SimWeeklyRow[],
  instance: string,
): Response | null {
  const refusal = stagingRefusal(req.actor, instance);
  if (refusal !== null) return refusal;
  for (const target of targets) {
    if (target.investmentId === null)
      return precondition('staging: the row is not linked to an investment', instance);
    if (target.reportDate === null)
      return precondition('staging: the row has no report date to value at', instance);
    if (target.reportedValue === null)
      return precondition('staging: the row has no value the record can hold', instance);
    const investment = readDetail(ctx, req.credential, target.investmentId);
    if (investment === undefined)
      return precondition('valuation: the investment is not on record', instance);
    if (!investment.isActive)
      return precondition('valuation: the investment is not active', instance);
  }
  return null;
}

/**
 * One row's approval and promotion: validated > approved by the reviewer and approved > promoted
 * by the system actor, which creates a Draft valuation for the linked investment at the report
 * date, the next version for that period, of method weekly_report, with the reviewer as its
 * preparer (the API's promote). The Draft lives in the valuation sims only; no recorded figure
 * changes.
 */
function promote(
  ctx: SimContext,
  req: { actor: SimActor; credential: string },
  sim: SimWeeklyFile,
  target: SimWeeklyRow,
  reason: string | undefined,
  at: string,
): void {
  const decision = reason ?? `weekly values ${sim.fileName}`;
  const investment =
    target.investmentId === null ? undefined : readDetail(ctx, req.credential, target.investmentId);
  if (investment === undefined || target.reportDate === null || target.reportedValue === null)
    return;
  const draft = createDraft(ctx, req.credential, investment, {
    periodEnd: target.reportDate,
    method: METHOD,
    fairValue: target.reportedValue,
    preparedBy: req.actor,
  });
  recordActivity(ctx, req.actor, {
    action: 'valuation.create_from_weekly',
    entity: 'valuation',
    entityId: draft.id,
    reason: decision,
    from: null,
    to: draft.state,
    details: { rowNo: target.rowNo, version: draft.version },
  });
  target.status = 'promoted';
  target.decision = decision;
  target.decidedBy = req.actor.displayName;
  target.decidedAt = at;
  target.promotedAt = at;
  target.valuationId = draft.id;
}

function reject(
  target: SimWeeklyRow,
  actor: SimActor,
  reason: string | undefined,
  at: string,
): void {
  target.status = 'rejected';
  target.decision = reason ?? null;
  target.decidedBy = actor.displayName;
  target.decidedAt = at;
}

/**
 * POST /api/v1/intake/weekly/files/{id}/commands. approve: the rows named (or every validated
 * row the caller sees) are promoted, each into a Draft valuation; reject: the rows named (or every
 * flagged row the caller sees) are rejected with the reason the table requires. A command with
 * nothing left to do answers the unchanged file. Everything that can refuse comes before the first
 * change, as the API's transaction would roll back.
 */
export const weeklyCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/intake/weekly/files/{id}/commands',
  what: 'command',
  body: intakeCommandBody,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const sim = ctx.state.weeklyFiles.get(req.params.id ?? '');
    if (sim === undefined) return notFound(instance);
    const { command, reason, rowIds } = req.body;
    const wanted: StagingState = command === 'approve' ? 'validated' : 'flagged';
    const selected = selectTargets(load(ctx, req.credential, sim).visible, rowIds, wanted);
    if (!selected.ok)
      return problem(400, 'validation', 'Invalid rowIds', {
        instance,
        simulated: true,
        errors: [selected.refusal],
      });
    const targets = selected.rows;
    let valuations = 0;
    if (targets.length > 0) {
      const refusal =
        command === 'approve'
          ? approvalRefusal(ctx, req, targets, instance)
          : rejectionRefusal(req.actor, reason, instance);
      if (refusal !== null) return refusal;
      const at = ctx.env.now();
      for (const target of targets) {
        if (command === 'approve') {
          promote(ctx, req, sim, target, reason, at);
          valuations += 1;
        } else reject(target, req.actor, reason, at);
      }
      sim.rowVersion += 1;
    }
    recordActivity(ctx, req.actor, {
      action: `intake.${command}`,
      entity: 'intake_file',
      entityId: sim.id,
      reason: reason ?? null,
      from: null,
      to: fileOf(ctx, sim, SOURCE, null).status,
      details: { rows: targets.length, valuations },
    });
    return jsonResponse(200, load(ctx, req.credential, sim).detail, { simulated: true });
  },
});
