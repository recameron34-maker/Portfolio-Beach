import definitions from '../../../../../config/definitions.json';
import { isQuarterEnd } from '@pb/calc';
import {
  canonicalJson,
  clientList,
  investmentDetail,
  reportPackageCommandBody,
  reportPackageContent,
  reportPackageCreateBody,
  seesAllClients,
} from '@pb/contracts';
import type {
  QaFindingRow,
  ReportPackageDetail,
  ReportPackageList,
  ReportPackageRow,
} from '@pb/contracts';
import { buildPackageSnapshot, qaPassed, runReportQa, snapshotRequestOf } from '@pb/report-engine';
import type { PositionSource, QaSettings } from '@pb/report-engine';
import { attempt, reportingPackageMachine } from '@pb/workflows';
import { sha256Hex, subtleCrypto } from '../hash.js';
import { versionsNow } from '../overlay.js';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import { ensureValuations } from '../state.js';
import type { SimActor, SimReportPackage } from '../state.js';
import {
  SYSTEM_ACTOR,
  byText,
  canOpen,
  defineSimRoute,
  personOf,
  recordActivity,
  staleIfMatch,
} from './common.js';
import type { SimContext, SimRequest } from './common.js';

/*
 * Reporting packages in the static preview (docs/04 M14, docs/18 section 5, docs/08 section 7,
 * decision 0024), the way apps/api/src/packages/packages.service.ts serves them. Nothing is
 * recorded: the synthetic book seeds no package, so the session holds only the packages investor
 * relations start in it, and a reload or a reset forgets them.
 *
 * A package is client data. The roles of the contract read it (the dispatcher's guard), each
 * within the clients it reads: the roles that read every client, and investor relations
 * entitled to the client. Anything else is 404, never 403, so nothing says a package exists.
 *
 * Generating builds the snapshot the API builds, by the same shared rule (snapshotRequestOf and
 * buildPackageSnapshot of @pb/report-engine), from what the acting credential's own recordings
 * hold: the client's commitments in its recorded client list, and the one-pager of every
 * position it may open. The marks are the versions as they stand in this session, so a mark
 * locked here counts and one reopened here no longer does; the flows are the recorded ones. The
 * QA rules then run over the snapshot and the system step states the outcome (qaPass or qaFail),
 * never the caller. Every command runs through reportingPackageMachine, and everything that can
 * refuse comes before the first change.
 */

const NOT_FOUND = 'Reporting package not found';
const CLIENT_NOT_FOUND = 'Client not found';
const EXPLANATION_NOT_HELD = 'An explanation names a position the package does not hold';
const CLIENTS_PATH = '/api/v1/clients';

const notFound = (instance: string): Response =>
  problem(404, 'not-found', NOT_FOUND, { instance, simulated: true });

let settingsCache: QaSettings | null = null;
/**
 * The QA settings of config/definitions.json, the two keys the API reads (rule 9): the
 * roll-forward tolerance in dollars and how many movers a package lists. A missing or
 * malformed key throws, naming it; no default stands in for it.
 */
export function previewQaSettings(): QaSettings {
  if (settingsCache !== null) return settingsCache;
  const config = definitions as {
    rollForwardToleranceUsd?: unknown;
    reporting?: { weeklyMoversCount?: unknown };
  };
  const tolerance = config.rollForwardToleranceUsd;
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance))
    throw new Error('config/definitions.json: rollForwardToleranceUsd is missing or not a number');
  const movers = config.reporting?.weeklyMoversCount;
  if (typeof movers !== 'number' || !Number.isInteger(movers) || movers < 0)
    throw new Error(
      'config/definitions.json: reporting.weeklyMoversCount is missing or not a whole number',
    );
  settingsCache = { toleranceUsd: String(tolerance), moversCount: movers };
  return settingsCache;
}

/** Whether the actor is entitled to the client; a reader whose entitlements are not known is entitled to none. */
const entitled = (actor: SimActor, clientId: string): boolean =>
  (actor.clientIds ?? []).includes(clientId);

/** Who reads a package (the select policy of rpt.package): the roles that read every client, and whoever is entitled to its client. */
const visibleTo = (actor: SimActor, sim: SimReportPackage): boolean =>
  seesAllClients(actor.roles) || entitled(actor, sim.client.id);

/**
 * Who may move a package (its update policy): investor relations entitled to its client, and
 * approvers and operations, who read every client. The machine then names the role each step
 * needs. For a person with one role this is the same as reading it; it differs only for
 * investor relations who read a client through a second role without being entitled to it.
 */
const movableBy = (actor: SimActor, sim: SimReportPackage): boolean =>
  (actor.roles.includes('investor_relations') && entitled(actor, sim.client.id)) ||
  actor.roles.includes('approver') ||
  actor.roles.includes('operations');

/** The counts of the latest QA run, read from its findings. */
function qaOf(sim: SimReportPackage): ReportPackageRow['qa'] {
  return {
    runNo: sim.findings[0]?.runNo ?? null,
    findings: sim.findings.length,
    failed: sim.findings.filter((f) => !f.passed).length,
    overridden: sim.findings.filter((f) => f.override !== null).length,
  };
}

const detailOf = (sim: SimReportPackage): ReportPackageDetail => ({ ...sim, qa: qaOf(sim) });

/** The list row: the package without what only its detail carries. */
function rowOf(sim: SimReportPackage): ReportPackageRow {
  return {
    id: sim.id,
    client: sim.client,
    periodEnd: sim.periodEnd,
    asOf: sim.asOf,
    basis: sim.basis,
    label: sim.label,
    version: sim.version,
    state: sim.state,
    preparedBy: sim.preparedBy,
    reviewer: sim.reviewer,
    approvedAt: sim.approvedAt,
    releasedAt: sim.releasedAt,
    qa: qaOf(sim),
    rowVersion: sim.rowVersion,
  };
}

const answer = (sim: SimReportPackage, status = 200): Response =>
  jsonResponse(status, detailOf(sim), { simulated: true, etag: sim.rowVersion });

/** GET /api/v1/report-packages: the packages of the clients the caller reads, newest period first, then by client, basis and version. */
export const reportPackagesRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/report-packages',
  what: 'query',
  body: null,
  handle: (req, ctx) => {
    const items = [...ctx.state.reportPackages.values()]
      .filter((sim) => visibleTo(req.actor, sim))
      .sort(
        (a, b) =>
          byText(b.periodEnd, a.periodEnd) ||
          byText(a.client.name, b.client.name) ||
          byText(a.basis, b.basis) ||
          b.version - a.version,
      )
      .map(rowOf);
    const body: ReportPackageList = { items };
    return jsonResponse(200, body, { simulated: true });
  },
});

/** GET /api/v1/report-packages/{id}: one package with its snapshot, the findings of its latest run and its change log. */
export const reportPackageRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/report-packages/{id}',
  what: 'package',
  body: null,
  handle: (req, ctx) => {
    const sim = ctx.state.reportPackages.get(req.params.id ?? '');
    if (sim === undefined || !visibleTo(req.actor, sim)) return notFound(req.url.pathname);
    return answer(sim);
  },
});

/**
 * POST /api/v1/report-packages (investor relations): a Draft for a client the caller is entitled
 * to, a quarter and a basis. One is in progress at a time for the three; once that one is
 * Released the next is a new version and needs a reason. The as-of date is the body's, else the
 * date of the recordings, which is the preview's own date as the API's clock is its own; one
 * after that date is refused.
 */
export const createReportPackageRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/report-packages',
  what: 'body',
  body: reportPackageCreateBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const body = req.body;
    const refusal = { instance, simulated: true } as const;
    const today = ctx.recordings.asOf;
    const asOf = body.asOf ?? today;
    if (!isQuarterEnd(body.periodEnd))
      return problem(400, 'validation', 'Invalid body', {
        ...refusal,
        errors: [{ path: 'periodEnd', message: 'A package period is a calendar quarter end' }],
      });
    if (asOf < body.periodEnd)
      return problem(400, 'validation', 'Invalid body', {
        ...refusal,
        errors: [{ path: 'asOf', message: 'The as-of date is on or after the period end' }],
      });
    // The record cannot be read as of a day that has not come, so a quarter that has not ended
    // is never packaged, whatever as-of date the caller names.
    if (asOf > today)
      return problem(400, 'validation', 'Invalid body', {
        ...refusal,
        errors: [{ path: 'asOf', message: 'The as-of date is not after today' }],
      });
    // A client the caller is not entitled to does not exist for it (SEC-5.2). The database lets
    // investor relations prepare a package only for a client they are entitled to, whatever a
    // second role lets them read, so the entitlement is asked for here and not the read alone.
    const client = entitled(req.actor, body.clientId)
      ? ctx.recordings
          .read(req.credential, CLIENTS_PATH, clientList)
          ?.items.find((c) => c.id === body.clientId)
      : undefined;
    if (client === undefined) return problem(404, 'not-found', CLIENT_NOT_FOUND, refusal);

    const packages = ctx.state.reportPackages;
    let latest: SimReportPackage | undefined;
    for (const sim of packages.values()) {
      if (
        sim.client.id === body.clientId &&
        sim.periodEnd === body.periodEnd &&
        sim.basis === body.basis &&
        (latest === undefined || sim.version > latest.version)
      )
        latest = sim;
    }
    if (latest !== undefined && latest.state !== 'Released')
      return problem(
        409,
        'workflow-transition',
        'A package for this client, period and basis is already in progress',
        refusal,
      );
    if (latest !== undefined && body.correctionReason === undefined)
      return problem(
        422,
        'workflow-precondition',
        'A package for this client, period and basis was released; a new version needs a reason',
        refusal,
      );
    const version = latest === undefined ? 1 : latest.version + 1;
    const correctionReason = version === 1 ? null : (body.correctionReason ?? null);
    const sim: SimReportPackage = {
      id: ctx.env.newId(),
      client: { id: client.id, name: client.name },
      periodEnd: body.periodEnd,
      asOf,
      basis: body.basis,
      label: body.label,
      version,
      state: 'Draft',
      preparedBy: personOf(req.actor),
      reviewer: null,
      approvedAt: null,
      releasedAt: null,
      rowVersion: 1,
      correctionReason,
      contentHash: null,
      releasedBy: null,
      content: null,
      findings: [],
      tieOutExplanations: {},
      changeLog: [],
    };
    packages.set(sim.id, sim);
    recordActivity(ctx, req.actor, {
      action: 'report_package.create',
      entity: 'report_package',
      entityId: sim.id,
      reason: correctionReason,
      from: null,
      to: 'Draft',
      details: { version },
    });
    return answer(sim, 201);
  },
});

/** The answer of a generate while the preview carries nothing to build the package from. */
const unavailable = (instance: string, detail: string): Response =>
  problem(503, 'unavailable', detail, { instance, simulated: true });

/**
 * The positions the credential may open, as its own recordings hold them: every position the
 * book names and every one a simulated close created, with the one-pager the credential reads
 * (a walled position it cannot open is not there at all), the versions of its marks as they
 * stand in this session and its recorded approved flows. The book gives the ids only.
 */
function positionsOf(
  ctx: SimContext,
  credential: string,
  bookIds: readonly string[],
): PositionSource[] {
  const sims = ensureValuations(ctx.state, ctx.recordings);
  const out: PositionSource[] = [];
  for (const id of new Set([...bookIds, ...ctx.state.investments.keys()])) {
    if (!canOpen(ctx, credential, id)) continue;
    const detail =
      ctx.state.investments.get(id)?.detail ??
      ctx.recordings.read(
        credential,
        `/api/v1/investments/${encodeURIComponent(id)}`,
        investmentDetail,
      );
    if (detail === undefined) continue;
    out.push({
      ref: detail.investmentNumber,
      vehicleRef: detail.vehicleId,
      entryDate: detail.entryDate,
      exitDate: detail.exitDate,
      valuations: versionsNow(
        { credential, recordings: ctx.recordings, state: ctx.state },
        sims,
        id,
      ),
      flows: detail.cashFlows,
    });
  }
  return out;
}

/**
 * generate and regenerate: the snapshot from the record as the caller reads it, the QA rules
 * over it, and the outcome stated by the system step. Two writes in the API (the snapshot as
 * the preparer, the outcome as the system), so the row version moves by two.
 */
function generate(
  ctx: SimContext,
  req: SimRequest<unknown>,
  sim: SimReportPackage,
  command: 'generate' | 'regenerate',
  explanations: Readonly<Record<string, string>>,
): Response {
  const instance = req.url.pathname;
  const client = ctx.recordings
    .read(req.credential, CLIENTS_PATH, clientList)
    ?.items.find((c) => c.id === sim.client.id);
  if (client === undefined)
    return unavailable(instance, "This preview carries no record of the client's commitments");
  if (ctx.book === null)
    return unavailable(instance, 'This preview carries no book to build a package from');
  const kept = { ...sim.tieOutExplanations, ...explanations };

  const snapshot = buildPackageSnapshot(
    snapshotRequestOf({
      clientRef: sim.client.id,
      periodEnd: sim.periodEnd,
      asOf: sim.asOf,
      label: sim.label,
      basis: sim.basis,
      commitments: client.vehicles.map((v) => ({
        vehicleRef: v.vehicleId,
        ownershipPct: v.ownershipPct,
      })),
      positions: positionsOf(
        ctx,
        req.credential,
        ctx.book.investments.map((i) => i.id),
      ),
      // The packages released in this session to the client on the basis: nothing is recorded,
      // so a release made here is the prior release of the next one until a reload or a reset.
      released: [...ctx.state.reportPackages.values()]
        .filter(
          (p) => p.client.id === sim.client.id && p.basis === sim.basis && p.state === 'Released',
        )
        .map((p) => ({
          periodEnd: p.periodEnd,
          version: p.version,
          lines: p.content?.lines ?? null,
        })),
      explanations: kept,
      moversCount: previewQaSettings().moversCount,
    }),
  );
  // An explanation is for a position of this package: one for any other number is refused
  // before anything changes, in the API's words.
  const held = new Set(snapshot.lines.map((line) => line.ref));
  if (Object.keys(explanations).some((ref) => !held.has(ref)))
    return problem(400, 'validation', 'Invalid body', {
      instance,
      simulated: true,
      errors: [{ path: 'explanations', message: EXPLANATION_NOT_HELD }],
    });
  const found = runReportQa(snapshot, previewQaSettings());
  const failed = found.filter((f) => !f.passed).length;
  const runNo = (sim.findings[0]?.runNo ?? 0) + 1;

  // The QA step: the system states what the rules found, through the machine as the API does.
  const step = attempt(
    reportingPackageMachine,
    'Generated',
    qaPassed(found) ? 'qaPass' : 'qaFail',
    {
      actorId: SYSTEM_ACTOR.actorId,
      actorRoles: [...SYSTEM_ACTOR.actorRoles],
      record: {},
    },
  );
  if (!step.ok) return workflowProblem(step, { instance, simulated: true });

  const from = sim.state;
  const findings: QaFindingRow[] = found
    .map((f) => ({ id: ctx.env.newId(), runNo, ...f, override: null }))
    // Failed first, then by rule and by what the finding is about: the API's order.
    .sort(
      (a, b) =>
        Number(a.passed) - Number(b.passed) ||
        byText(a.rule, b.rule) ||
        byText(a.entityRef, b.entityRef),
    );
  sim.state = step.to;
  // Read through the contract, as the API reads the stored snapshot back.
  sim.content = reportPackageContent.parse(snapshot);
  sim.findings = findings;
  sim.tieOutExplanations = kept;
  sim.changeLog = [
    ...sim.changeLog,
    {
      at: ctx.env.now(),
      by: personOf(req.actor),
      runNo,
      lines: snapshot.lines.length,
      findings: found.length,
      failed,
    },
  ];
  sim.rowVersion += 2;
  recordActivity(ctx, req.actor, {
    action: `report_package.${command}`,
    entity: 'report_package',
    entityId: sim.id,
    reason: null,
    from,
    to: step.to,
    details: { runNo, findings: found.length, failed },
  });
  return answer(sim);
}

/**
 * POST /api/v1/report-packages/{id}/commands (investor relations, approver, operations), in the
 * API's order: 404 for a package the caller cannot see or move, 412 for a stale If-Match, the
 * machine (403 role, 409 transition, 422 a missing reason or the preparer approving), then the
 * write. overrideQa stamps the reason, the approver and the time on every failed finding of the
 * latest run. approve locks the content with SHA-256 over its canonical JSON, the text the API
 * hashes; where the browser offers no SHA-256 the answer is 503 and nothing changes.
 */
export const reportPackageCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/report-packages/{id}/commands',
  what: 'command',
  body: reportPackageCommandBody,
  idempotent: true,
  handle: async (req, ctx) => {
    const instance = req.url.pathname;
    const body = req.body;
    const sim = ctx.state.reportPackages.get(req.params.id ?? '');
    if (sim === undefined || !visibleTo(req.actor, sim) || !movableBy(req.actor, sim))
      return notFound(instance);
    const stale = staleIfMatch(req.headers, sim.rowVersion, instance);
    if (stale !== null) return stale;

    const from = sim.state;
    const result = attempt(reportingPackageMachine, from, body.command, {
      actorId: req.actor.userId,
      actorRoles: req.actor.roles,
      ...(body.command === 'overrideQa' ? { reason: body.reason } : {}),
      record: { preparedBy: sim.preparedBy.id },
    });
    if (!result.ok) return workflowProblem(result, { instance, simulated: true });

    if (body.command === 'generate' || body.command === 'regenerate')
      return generate(ctx, req, sim, body.command, body.explanations ?? {});

    const now = ctx.env.now();
    let reason: string | null = null;
    let details: Record<string, number> | undefined;
    if (body.command === 'overrideQa') {
      const override = { reason: body.reason, approver: personOf(req.actor), at: now };
      let overridden = 0;
      sim.findings = sim.findings.map((f) => {
        if (f.passed || f.override !== null) return f;
        overridden += 1;
        return { ...f, override };
      });
      reason = body.reason;
      details = { overridden };
    } else if (body.command === 'approve') {
      if (subtleCrypto() === undefined)
        return unavailable(
          instance,
          'This browser offers SHA-256 only on secure (https) pages, so the content hash cannot be computed here.',
        );
      sim.contentHash = await sha256Hex(canonicalJson(sim.content));
      sim.reviewer = personOf(req.actor);
      sim.approvedAt = now;
    } else if (body.command === 'release') {
      sim.releasedAt = now;
      sim.releasedBy = personOf(req.actor);
    }
    sim.state = result.to;
    sim.rowVersion += 1;
    recordActivity(ctx, req.actor, {
      action: `report_package.${body.command}`,
      entity: 'report_package',
      entityId: sim.id,
      reason,
      from,
      to: result.to,
      ...(details === undefined ? {} : { details }),
    });
    return answer(sim);
  },
});
