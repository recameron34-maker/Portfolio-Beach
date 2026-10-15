import definitions from '../../../../../config/definitions.json';
import mappingJson from '../../../../../config/lookthrough_mapping.json';
import { D, toDecimalString } from '@pb/calc';
import { lookthroughMapping, lookthroughReconcileBody } from '@pb/contracts';
import type {
  LookthroughReconcileResult,
  LookthroughRow,
  LookthroughRunDetail,
} from '@pb/contracts';
import {
  linkLookthroughRows,
  linkOf,
  lookthroughExceptionsOpenedBy,
  lookthroughRuleConfigFrom,
  prepareLookthroughRows,
} from '@pb/validation';
import type { Finding, LookthroughRecord } from '@pb/validation';
import { z } from 'zod';
import { samplePath } from '../../pages/intake/intake.js';
import type { PreviewBook } from '../book.js';
import { sha256Hex } from '../hash.js';
import { jsonResponse, problem } from '../problems.js';
import type { SimLookthroughRow, SimLookthroughRun } from '../state.js';
import {
  defineSimRoute,
  fileOf,
  noBook,
  openException,
  readerView,
  recordActivity,
} from './common.js';
import type { SimContext } from './common.js';
import { hashRefusal } from './intake.js';

/**
 * The look-through reconcile (docs/04 M2 lookthrough-reconcile, decision 0010) simulated in the
 * browser, the way apps/api/src/intake/lookthrough/lookthrough.service.ts serves it: the bundled
 * extracts are the look-through folder, one per as-of date; a reconcile reads the extract for the
 * date (none: a run with no rows and a file finding, so the attempt is on record), links every
 * row to the book as the system actor (decision 0009), maps its labels through
 * config/lookthrough_mapping.json and compares its exposures with the record: the company's
 * taxonomy codes, the latest Locked mark on or before the date and the invested cost as the API
 * computes it, all from the book. The rules and the exceptions are the shared @pb/validation
 * module. The run is keyed by the SHA-256 of the date and the rows; nothing on record changes
 * (docs/04 M1: outside sources are mapped to the taxonomy and never override it). A reader sees
 * the rows and the candidates for the positions their own recordings let them open.
 */

const SOURCE = 'lookthrough';
const EXCEPTION_SOURCE = 'lookthrough_reconcile';
const NOT_FOUND = 'Reconcile run not found';
/** The file-level finding of a run for a date the folder holds no extract for. */
const NO_EXTRACT_RULE = 'LT-FILE-01';

/** A provider row as the folder adapter reads an extract file (packages/adapters ExposureRow). */
const exposureRow = z.object({
  investmentNumber: z.string().nullable(),
  companyName: z.string(),
  sector: z.string(),
  geography: z.string(),
  exposureAtCost: z.string(),
  exposureAtNav: z.string(),
  asOf: z.string(),
});
const extractFile = z.array(exposureRow);
type ExposureRow = z.infer<typeof exposureRow>;

const notFound = (instance: string): Response =>
  problem(404, 'not-found', NOT_FOUND, { instance, simulated: true });

/**
 * What is on record for a position as of the run's date, as the API reads it through
 * positionMetrics: the company's taxonomy codes, the NAV (the latest Locked mark on or before the
 * date while the position is held; 0 once exited; none while held without a mark, never 0) and
 * the invested cost the book carries for the date. Null for a position the book lacks.
 */
export function recordAt(
  book: PreviewBook,
  investmentId: string,
  asOf: string,
): LookthroughRecord | null {
  const investment = book.investments.find((i) => i.id === investmentId);
  if (investment === undefined) return null;
  // Held on the as-of date: not exited by it (apps/api/src/portfolio/loaders.ts asOfStatus).
  const heldOnAsOf = investment.exitDate === null || investment.exitDate > asOf;
  let mark: { periodEnd: string; fairValue: string } | null = null;
  for (const m of book.lockedMarks[investmentId] ?? []) {
    if (m.periodEnd > asOf) continue;
    if (mark === null || m.periodEnd > mark.periodEnd) mark = m;
  }
  const nav = heldOnAsOf
    ? mark === null
      ? null
      : toDecimalString(D(mark.fairValue))
    : toDecimalString(D('0'));
  return {
    sector: investment.sector,
    geography: investment.geography,
    exposureAtCost: book.investedCost[asOf]?.[investmentId] ?? null,
    exposureAtNav: nav,
  };
}

/** The content hash of a run: the as-of date, then the rows as JSON (the API's reconcileContentHash). */
export function reconcileContentHash(asOf: string, rows: readonly ExposureRow[]): Promise<string> {
  return sha256Hex(`${asOf}\n${JSON.stringify(rows)}`);
}

/** The rows of the bundled extract for the date, as the folder adapter would read them; none for a date without one. */
async function extractFor(
  ctx: SimContext,
  book: PreviewBook,
  asOf: string,
  instance: string,
): Promise<ExposureRow[] | Response> {
  const sample = book.lookthroughSamples.find((s) => s.asOf === asOf);
  if (sample === undefined) return [];
  const unreadable = (): Response =>
    problem(503, 'upstream', 'The look-through extract for this date could not be read', {
      instance,
      simulated: true,
    });
  const asset = await ctx.fetchAsset(samplePath(sample.fileName));
  if (!asset.ok) return unreadable();
  let json: unknown;
  try {
    json = await asset.json();
  } catch {
    return unreadable();
  }
  const parsed = extractFile.safeParse(json);
  return parsed.success ? parsed.data : unreadable();
}

/** The exceptions opened about one row of a run. */
function exceptionsOfRow(ctx: SimContext, rowId: string): number {
  let n = 0;
  for (const x of ctx.state.exceptions.values()) if (x.entityId === rowId) n += 1;
  return n;
}

/** A reconciled row for the caller, with only the candidates among the positions they may see. */
function toRow(
  ctx: SimContext,
  r: SimLookthroughRow,
  linkFor: (link: SimLookthroughRow['link']) => SimLookthroughRow['link'],
): LookthroughRow {
  const { provider, mapped, record, differences, link } = r;
  return {
    id: r.id,
    rowNo: r.rowNo,
    investmentNumber: provider.investmentNumber,
    companyName: provider.companyName,
    asOf: provider.asOf,
    provider: {
      sector: provider.sector,
      geography: provider.geography,
      exposureAtCost: provider.exposureAtCost,
      exposureAtNav: provider.exposureAtNav,
    },
    mapped,
    approved: {
      exposureAtCost: record?.exposureAtCost ?? null,
      exposureAtNav: record?.exposureAtNav ?? null,
    },
    differences,
    link: linkFor(link),
    findings: r.findings,
    status: r.status,
    exceptions: exceptionsOfRow(ctx, r.id),
  };
}

/** The run with its rows in file order as the credential may see them; counts and the exception total cover every row (SEC-5.3). */
function load(ctx: SimContext, credential: string, sim: SimLookthroughRun): LookthroughRunDetail {
  const view = readerView(
    ctx,
    credential,
    sim.rows.map((r) => r.link),
  );
  const visible = sim.rows.filter((r) => view.rowVisible(r.link.investmentId));
  return {
    ...fileOf(ctx, sim, SOURCE, null),
    asOf: sim.asOf,
    rows: visible.map((r) => toRow(ctx, r, view.linkFor)),
    hiddenRows: sim.rows.length - visible.length,
  };
}

/**
 * POST /api/v1/intake/lookthrough/reconcile: reconcile the extract for an as-of date. Idempotent
 * by content: the same date and rows answer the run made before with duplicate true and stage
 * nothing. Otherwise the run, its rows and the data exceptions they open land together, with one
 * activity entry that carries counts only.
 */
export const lookthroughReconcileRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/intake/lookthrough/reconcile',
  what: 'reconcile',
  body: lookthroughReconcileBody,
  handle: async (req, ctx) => {
    const instance = req.url.pathname;
    const book = ctx.book;
    if (book === null) return noBook(instance);
    const { asOf } = req.body;
    // The record is read as of the run's date; for a date after today there is nothing on record
    // to compare with, and a reconcile for it would tie against marks that do not exist yet.
    if (asOf > ctx.recordings.asOf)
      return problem(400, 'validation', 'Invalid reconcile', {
        instance,
        simulated: true,
        errors: [{ path: 'asOf', message: 'The as-of date must be today or earlier' }],
      });
    const refusal = hashRefusal(instance);
    if (refusal !== null) return refusal;
    const rows = await extractFor(ctx, book, asOf, instance);
    if (rows instanceof Response) return rows;
    const contentHash = await reconcileContentHash(asOf, rows);
    const answer = (sim: SimLookthroughRun, duplicate: boolean): Response => {
      const result: LookthroughReconcileResult = { ...load(ctx, req.credential, sim), duplicate };
      return jsonResponse(201, result, { simulated: true });
    };
    const existing = [...ctx.state.lookthroughRuns.values()].find(
      (r) => r.contentHash === contentHash,
    );
    if (existing !== undefined) return answer(existing, true);

    const config = lookthroughRuleConfigFrom(definitions);
    const mapping = lookthroughMapping.parse(mappingJson);
    const linked = linkLookthroughRows(
      rows.map((r, i) => ({ ...r, rowNo: i + 1 })),
      book.investments,
      book.matchGuards,
    );
    const prepared = prepareLookthroughRows(
      linked,
      { mapping, recordOf: (id) => recordAt(book, id, asOf) },
      asOf,
      config,
    );
    const fileFindings: Finding[] =
      rows.length === 0
        ? [
            {
              ruleId: NO_EXTRACT_RULE,
              severity: 'error',
              message: `No extract for ${asOf}: the look-through folder holds no rows for this date`,
              field: null,
              expected: `${asOf}.json`,
              actual: null,
            },
          ]
        : [];
    const sim: SimLookthroughRun = {
      id: ctx.env.newId(),
      fileName: `lookthrough-${asOf}.json`,
      contentHash,
      asOf,
      receivedAt: ctx.env.now(),
      receivedBy: req.actor.displayName,
      rowCount: prepared.length,
      fileFindings,
      rowVersion: 1,
      rows: prepared.map((p) => {
        const { rowNo: _rowNo, ...provider } = p.row;
        return {
          id: ctx.env.newId(),
          rowNo: p.row.rowNo,
          status: p.status,
          provider,
          mapped: p.mapped,
          record:
            p.record === null
              ? null
              : { exposureAtCost: p.record.exposureAtCost, exposureAtNav: p.record.exposureAtNav },
          differences: p.differences,
          link: linkOf(p.link),
          findings: p.findings,
        };
      }),
    };
    ctx.state.lookthroughRuns.set(sim.id, sim);
    // Which exceptions a row opens, their tier and what they carry is the shared rule in @pb/validation.
    let exceptions = 0;
    for (const [i, p] of prepared.entries()) {
      const row = sim.rows[i];
      if (row === undefined) continue;
      for (const { tier, ...opened } of lookthroughExceptionsOpenedBy(p)) {
        openException(ctx, {
          source: EXCEPTION_SOURCE,
          entity: 'stg.intake_row',
          entityId: row.id,
          ruleId: opened.ruleId,
          expected: opened.expected,
          actual: opened.actual,
          severity: `exception_severity.${tier}`,
          candidates: opened.candidates,
          file: sim,
          rowNo: row.rowNo,
          investmentId: row.link.investmentId,
        });
        exceptions += 1;
      }
    }
    const file = fileOf(ctx, sim, SOURCE, null);
    recordActivity(ctx, req.actor, {
      action: 'intake.reconcile',
      entity: 'intake_file',
      entityId: sim.id,
      reason: null,
      from: null,
      to: file.status,
      details: {
        rowCount: sim.rowCount,
        ...file.counts,
        differences: prepared.reduce((n, p) => n + p.differences.length, 0),
        exceptions,
      },
    });
    return answer(sim, false);
  },
});

/** GET /api/v1/intake/lookthrough/runs/{id}: the run with the rows the credential may see; an unknown id is not found. */
export const lookthroughRunRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/intake/lookthrough/runs/{id}',
  what: 'run',
  body: null,
  handle: (req, ctx) => {
    const sim = ctx.state.lookthroughRuns.get(req.params.id ?? '');
    if (sim === undefined) return notFound(req.url.pathname);
    return jsonResponse(200, load(ctx, req.credential, sim), { simulated: true });
  },
});
