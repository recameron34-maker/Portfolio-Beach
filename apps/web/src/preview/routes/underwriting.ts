import definitions from '../../../../../config/definitions.json';
import {
  CALC_VERSION,
  D,
  flowKindOf,
  latestPeriod,
  toDecimalString,
  toSignedFlows,
  underwritingComparison,
  valueCreationBridge,
} from '@pb/calc';
import type { UnderwritingInputs } from '@pb/calc';
import {
  UNDERWRITING_REFUSALS,
  entryCaseOf,
  investmentDetail,
  investmentPerformance,
  investmentValueCreation,
  isCaseDateAllowed,
  isComparableVersion,
  underwritingBodyIssues,
  underwritingCaseBody,
  underwritingCommandBody,
  underwritingKindOf,
  underwritingQuery,
  underwritingRead,
} from '@pb/contracts';
import type {
  InvestmentDetail,
  InvestmentPerformance,
  UnderwritingCaseBody,
  UnderwritingCaseVersion,
  UnderwritingRead,
  UnderwritingRevenueBounds,
  ValueCreationPosition,
} from '@pb/contracts';
import { attempt, underwritingCaseMachine } from '@pb/workflows';
import type { z } from 'zod';
import { getKey } from '../keys.js';
import { overlayRecordedBody } from '../overlay.js';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import { ensureUnderwritingCases } from '../state.js';
import {
  byText,
  canOpen,
  defineSimRoute,
  documentVisible,
  personOf,
  recordActivity,
  staleIfMatch,
} from './common.js';
import type { SimContext } from './common.js';

/*
 * A position's underwritten base case in the static preview (docs/04 M9, docs/08 section 11,
 * docs/18 section 13, decision 0022), the way apps/api/src/underwriting/ serves it.
 *
 * The versions are the recorded ones with this session's laid over them: a Draft the deal team
 * recorded, an edit, a confirmation by a second person (underwritingCaseMachine, the table the
 * API runs), the supersession of the case a correction replaces, a withdrawal, a retirement.
 *
 * The read is always worked out here, by underwritingComparison of @pb/calc over the version
 * compared, so a version the reader picks and a case confirmed this session need no recording.
 * Its inputs are the credential's own other answers, as the page reads them (the recordings with
 * the session's overlays): the entry snapshot and the approved quarters from the position's
 * performance; our flows, invested capital, distributions, gross MOIC and gross IRR from its
 * one-pager; the company's bridge from its value creation answer. Nothing but the comparison is
 * worked out again, with one exception: a quarter approved this session moves the current
 * quarter, and the recorded bridge would then stand beside a quarter it does not describe (rule
 * 10), so it is derived again from the two quarters by the calculation library's own bridge.
 * The recorded read fixes what no other answer carries: whether the position holds a base case
 * at all, the as-of date and the tolerances. A wall stays a wall: a credential whose recorded
 * read answered 404 gets that answer, and no write finds the position or its case.
 */

const INVESTMENT_NOT_FOUND = 'Investment not found';
const CASE_NOT_FOUND = 'Base case not found';
const VERSION_NOT_FOUND = 'Base case version not found';
const APPROVED = 'record_status.approved';

const readPath = (investmentId: string): string =>
  `/api/v1/investments/${encodeURIComponent(investmentId)}/underwriting`;

/** A request the recordings cannot answer: another as-of date, or a position nothing was recorded for. */
const outside = (instance: string): Response =>
  problem(404, 'not-found', 'This request is outside the recorded preview', { instance });

/** A credential's recorded answer for a path with the session's changes laid over it, as the shim serves it. */
function readNow<T>(
  ctx: SimContext,
  credential: string,
  path: string,
  schema: z.ZodType<T>,
): T | undefined {
  const recorded = ctx.recordings.byKey(getKey(credential, path));
  if (recorded?.status !== 200) return undefined;
  const text = overlayRecordedBody(new URL(path, 'http://preview.invalid'), recorded.text, {
    credential,
    recordings: ctx.recordings,
    state: ctx.state,
  });
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Every version of a position's base case as it stands in this session, oldest first, each with its kind. */
export function versionsOf(ctx: SimContext, investmentId: string): UnderwritingCaseVersion[] {
  const rows = [...ensureUnderwritingCases(ctx.state, ctx.recordings).values()]
    .filter((v) => v.investmentId === investmentId)
    .sort((a, b) => a.version - b.version);
  return rows.map((v) => ({ ...v, kind: underwritingKindOf(v, rows) }));
}

type Quarter = InvestmentPerformance['quarters'][number];
type BridgeInput = Pick<UnderwritingInputs, 'bridge' | 'bridgeNotCalculable'>;
type BridgeEnd = Pick<Quarter, 'periodEnd' | 'ebitdaLtm' | 'ev' | 'netDebt'> | null;

/** The same amount, however each answer writes it ("40000000" and "40000000.00"), or both missing. */
const sameFigure = (a: string | null, b: string | null): boolean =>
  a === null || b === null ? a === b : D(a).eq(b);

/** Whether two ends of a bridge are the same quarter with the same three figures. */
const sameEnd = (a: BridgeEnd, b: BridgeEnd): boolean =>
  a === null || b === null
    ? a === b
    : a.periodEnd === b.periodEnd &&
      sameFigure(a.ebitdaLtm, b.ebitdaLtm) &&
      sameFigure(a.ev, b.ev) &&
      sameFigure(a.netDebt, b.netDebt);

/**
 * The company's bridge from the entry snapshot to the current quarter. The recorded value
 * creation answer carries it, and it is used as it is while it describes these two quarters. When
 * the session moved one of them (an approved extraction run promoted a quarter), it is derived
 * again as apps/api/src/analytics/value-creation.ts (bridgeOf) derives it.
 */
function bridgeOf(
  entry: Quarter | null,
  current: Quarter | null,
  forwardDated: boolean,
  recorded: ValueCreationPosition | null | undefined,
): BridgeInput {
  if (
    recorded !== undefined &&
    recorded !== null &&
    sameEnd(recorded.entry, entry) &&
    sameEnd(recorded.current, current)
  ) {
    const b = recorded.bridge;
    return {
      bridge:
        b === null
          ? null
          : {
              ebitdaGrowth: b.ebitdaGrowth,
              multipleExpansion: b.multipleExpansion,
              debtPaydown: b.debtPaydown,
              total: b.total,
            },
      bridgeNotCalculable: recorded.notCalculable,
    };
  }
  const none = (reason: BridgeInput['bridgeNotCalculable']): BridgeInput => ({
    bridge: null,
    bridgeNotCalculable: reason,
  });
  if (entry === null)
    return none(forwardDated ? 'entry_snapshot_forward_dated' : 'no_entry_snapshot');
  if (current === null) return none('no_current_quarter');
  if (
    entry.ebitdaLtm === null ||
    entry.ev === null ||
    entry.netDebt === null ||
    current.ebitdaLtm === null ||
    current.ev === null ||
    current.netDebt === null
  )
    return none('missing_figures');
  const result = valueCreationBridge(
    { ebitda: entry.ebitdaLtm, ev: entry.ev, netDebt: entry.netDebt, revenue: entry.revenueLtm },
    {
      ebitda: current.ebitdaLtm,
      ev: current.ev,
      netDebt: current.netDebt,
      revenue: current.revenueLtm,
    },
  );
  if (result.value === null) return none(result.reason);
  const str = (value: Parameters<typeof toDecimalString>[0]): string =>
    toDecimalString(value) ?? '0';
  return {
    bridge: {
      ebitdaGrowth: str(result.value.ebitdaGrowth),
      multipleExpansion: str(result.value.multipleExpansion),
      debtPaydown: str(result.value.debtPaydown),
      total: str(result.value.total),
    },
    bridgeNotCalculable: null,
  };
}

const figuresOf = (q: Quarter): UnderwritingInputs['quarters'][number] => ({
  periodEnd: q.periodEnd,
  revenueLtm: q.revenueLtm,
  ebitdaLtm: q.ebitdaLtm,
  netDebt: q.netDebt,
});

/**
 * What the comparison is worked out from, as apps/api/src/underwriting/comparison.ts builds it
 * (comparisonInputs) from the same rows. The entry snapshot counts once approved and dated on or
 * before the as-of date; the current quarter is the latest approved one on or before that date,
 * or before the exit of a position realized by then; our flows are the approved ones on or
 * before the date, signed from our side, by date and then by amount.
 */
export function comparisonInputs(
  asOf: string,
  detail: InvestmentDetail,
  perf: InvestmentPerformance,
  recordedPosition: ValueCreationPosition | null | undefined,
): UnderwritingInputs {
  const snapshot = perf.entry !== null && perf.entry.status === APPROVED ? perf.entry : null;
  const forwardDated = snapshot !== null && snapshot.periodEnd > asOf;
  const entry = forwardDated ? null : snapshot;
  const cutoff = detail.exitDate !== null && detail.exitDate < asOf ? detail.exitDate : asOf;
  const approved = perf.quarters.filter((q) => !q.isEntrySnapshot && q.status === APPROVED);
  // latestPeriod reads the status word of @pb/calc ('approved'); every row here is approved.
  const latest = latestPeriod(
    approved.map((q) => ({ ...q, status: 'approved' })),
    cutoff,
  );
  const current =
    latest === null ? null : (approved.find((q) => q.periodEnd === latest.periodEnd) ?? null);
  const flows = toSignedFlows(
    detail.cashFlows
      .filter((f) => f.date <= asOf)
      .map((f) => ({
        date: f.date,
        kind: flowKindOf(f.flowType),
        amount: f.amount,
      })),
  )
    .map((f) => ({ date: f.date, amount: D(f.amount) }))
    .sort((a, b) => byText(a.date, b.date) || a.amount.comparedTo(b.amount))
    .map((f) => ({ date: f.date, amount: toDecimalString(f.amount) ?? '0' }));
  return {
    asOf,
    isActive: detail.isActive,
    entry:
      entry === null
        ? null
        : {
            periodEnd: entry.periodEnd,
            ebitdaLtm: entry.ebitdaLtm,
            ev: entry.ev,
            netDebt: entry.netDebt,
          },
    current: current === null ? null : figuresOf(current),
    quarters: approved.filter((q) => q.periodEnd <= asOf).map(figuresOf),
    ...bridgeOf(entry, current, forwardDated, recordedPosition),
    flows,
    invested: detail.invested,
    distributions: detail.distributions,
    grossMoic: detail.grossMoic,
    grossIrr: detail.grossIrr,
    irrFlag: detail.irrFlag,
    // A loan's yield to maturity travels with its credit terms; an equity position has none.
    yieldToMaturity: perf.credit?.terms.yieldToMaturity ?? null,
  };
}

/**
 * GET /api/v1/investments/{id}/underwriting: every version as it stands in this session and the
 * comparison with the entry case, or with the version named when it stands or stood as the plan
 * (404 otherwise). What the credential's own recording answered that is not a 200 is replayed (a
 * wall's 404), and so is the answer of a position that holds no base case. Another as-of date
 * than the recorded one was never recorded, so it is outside the preview.
 */
export const underwritingReadRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/investments/{id}/underwriting',
  what: 'query',
  body: null,
  query: underwritingQuery,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const id = req.params.id ?? '';
    const recorded = ctx.recordings.byKey(getKey(req.credential, instance));
    if (recorded === undefined) return outside(instance);
    const replay = (): Response =>
      new Response(recorded.text, {
        status: recorded.status,
        headers: { 'content-type': recorded.contentType, 'x-request-id': 'preview' },
      });
    if (recorded.status !== 200) return replay();
    const base = ctx.recordings.read(req.credential, instance, underwritingRead);
    if (base === undefined) return replay();
    const { asOf, version } = req.query;
    if (asOf !== undefined && asOf !== base.asOf) return outside(instance);
    const notFound = (): Response =>
      problem(404, 'not-found', VERSION_NOT_FOUND, { instance, simulated: true });
    if (base.form === null) return version === undefined ? replay() : notFound();

    const versions = versionsOf(ctx, id);
    const compared =
      version === undefined
        ? entryCaseOf(versions)
        : (versions.find((v) => v.version === version && isComparableVersion(v)) ?? null);
    if (version !== undefined && compared === null) return notFound();
    const answer = {
      asOf: base.asOf,
      form: base.form,
      versions,
      thresholds: base.thresholds,
      calcVersion: CALC_VERSION,
    };
    if (compared === null) {
      const none: UnderwritingRead = {
        ...answer,
        comparedVersion: null,
        comparison: null,
        notCalculable: versions.some((v) => v.state === 'Draft') ? 'draft_only' : 'no_case',
      };
      return jsonResponse(200, none, { simulated: true });
    }
    const position = `/api/v1/investments/${encodeURIComponent(id)}`;
    const detail = readNow(ctx, req.credential, position, investmentDetail);
    const perf = readNow(ctx, req.credential, `${position}/performance`, investmentPerformance);
    if (detail === undefined || perf === undefined) return outside(instance);
    const recordedPosition = ctx.recordings.read(
      req.credential,
      `${position}/value-creation`,
      investmentValueCreation,
    )?.position;
    const read: UnderwritingRead = {
      ...answer,
      comparedVersion: compared.version,
      comparison: underwritingComparison(
        {
          form: compared.form,
          plannedExitDate: compared.plannedExitDate,
          exitMultiple: compared.exitMultiple,
          grossMoic: compared.grossMoic,
          grossIrr: compared.grossIrr,
          points: compared.points,
        },
        comparisonInputs(base.asOf, detail, perf, recordedPosition),
        base.thresholds,
      ),
      notCalculable: null,
    };
    return jsonResponse(200, read, { simulated: true });
  },
});

/* ---- The writes (docs/18 section 13) ---- */

const refusalOf = (instance: string) => ({ instance, simulated: true }) as const;

/** A refusal on a precondition that is not the machine's (422), in the machine's wording. */
const precondition = (detail: string, instance: string): Response =>
  problem(422, 'workflow-precondition', detail, refusalOf(instance));

/** A refusal because of where the record stands (409). */
const transition = (detail: string, instance: string): Response =>
  problem(409, 'workflow-transition', detail, refusalOf(instance));

/** `unitSanityBoundsUsd`: the revenue a plan point may hold; a missing one is the API's configuration problem. */
function revenueBounds(instance: string): UnderwritingRevenueBounds | Response {
  const bounds: unknown = (definitions as Record<string, unknown>).unitSanityBoundsUsd;
  const read = (name: 'revenueMin' | 'revenueMax'): number | null => {
    const value: unknown =
      typeof bounds === 'object' && bounds !== null
        ? (bounds as Record<string, unknown>)[name]
        : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const revenueMin = read('revenueMin');
  const revenueMax = read('revenueMax');
  const missing = revenueMin === null ? 'revenueMin' : revenueMax === null ? 'revenueMax' : null;
  if (revenueMin === null || revenueMax === null)
    return problem(
      500,
      'configuration',
      `config/definitions.json is missing a usable unitSanityBoundsUsd.${missing ?? ''}`,
      refusalOf(instance),
    );
  return { revenueMin: String(revenueMin), revenueMax: String(revenueMax) };
}

/**
 * A figure as its column answers it (migration 0021): the contract admits no more decimals than
 * the column keeps, so this adds zeros and never rounds, and 11 sent as an exit multiple reads
 * back as 11.000000 the way the API reads it back from the row written.
 */
const stored = (value: string, places: number): string => D(value).toFixed(places);
const MONEY_PLACES = 2;
const MULTIPLE_PLACES = 6;
const RATE_PLACES = 8;

/** The columns a body sets for its form: what the other form holds is null, never a leftover. */
function columnsOf(
  form: UnderwritingCaseVersion['form'],
  body: UnderwritingCaseBody,
  documentName: string | null,
): Pick<
  UnderwritingCaseVersion,
  | 'caseDate'
  | 'plannedExitDate'
  | 'exitMultiple'
  | 'grossMoic'
  | 'grossIrr'
  | 'underwrittenYield'
  | 'annualLossRate'
  | 'note'
  | 'source'
  | 'points'
> {
  const money = (value: string | null): string | null =>
    value === null ? null : stored(value, MONEY_PLACES);
  const rate = (value: string | undefined): string | null =>
    form === 'credit' && value !== undefined ? stored(value, RATE_PLACES) : null;
  return {
    caseDate: body.caseDate,
    plannedExitDate: body.plannedExitDate,
    exitMultiple:
      form === 'equity' && body.exitMultiple !== undefined
        ? stored(body.exitMultiple, MULTIPLE_PLACES)
        : null,
    grossMoic: stored(body.grossMoic, MULTIPLE_PLACES),
    grossIrr: stored(body.grossIrr, RATE_PLACES),
    underwrittenYield: rate(body.underwrittenYield),
    annualLossRate: rate(body.annualLossRate),
    note: body.note ?? null,
    source: {
      document:
        body.sourceDocumentId === undefined || documentName === null
          ? null
          : { id: body.sourceDocumentId, name: documentName },
      page: body.sourcePage ?? null,
      locator: body.sourceLocator ?? null,
      note: body.sourceNote ?? null,
    },
    points: (body.points ?? []).map((p) => ({
      periodEnd: p.periodEnd,
      revenueLtm: money(p.revenueLtm),
      ebitdaLtm: money(p.ebitdaLtm),
      netDebt: money(p.netDebt),
    })),
  };
}

/**
 * What a create and an edit refuse alike once the form of the case is known, in the API's order:
 * what the body lacks for the form (400), a currency other than US dollars (422), a revision
 * without its reason (422), a case date that neither corrects a Confirmed case nor follows them
 * all (422), a source document that is not one of the position's that the caller can see (422,
 * one sentence for both). Null when the body may be written, with the name of its source document.
 */
function refusedBody(
  ctx: SimContext,
  credential: string,
  instance: string,
  input: {
    investmentId: string;
    form: UnderwritingCaseVersion['form'];
    version: number;
    body: UnderwritingCaseBody;
    others: readonly UnderwritingCaseVersion[];
    bounds: UnderwritingRevenueBounds;
    /** A create refuses a second Draft between the currency and the reason. */
    draftExists: boolean;
  },
): { refused: Response } | { refused: null; documentName: string | null } {
  const { body } = input;
  const issues = underwritingBodyIssues(input.form, body, input.bounds);
  if (issues.length > 0)
    return {
      refused: problem(400, 'validation', 'Invalid body', {
        ...refusalOf(instance),
        errors: issues,
      }),
    };
  if (body.currency !== undefined && body.currency !== 'USD')
    return { refused: precondition(UNDERWRITING_REFUSALS.currency, instance) };
  if (input.draftExists)
    return { refused: transition(UNDERWRITING_REFUSALS.draftExists, instance) };
  if (input.version > 1 && body.revisionReason === undefined)
    return { refused: precondition(UNDERWRITING_REFUSALS.reasonRequired, instance) };
  if (!isCaseDateAllowed(body.caseDate, input.others))
    return { refused: precondition(UNDERWRITING_REFUSALS.caseDate, instance) };
  if (body.sourceDocumentId === undefined) return { refused: null, documentName: null };
  const document = ctx.state.documents.get(body.sourceDocumentId);
  if (
    document?.investmentId !== input.investmentId ||
    !documentVisible(ctx, credential, document.id)
  )
    return { refused: precondition(UNDERWRITING_REFUSALS.sourceDocument, instance) };
  return { refused: null, documentName: document.title };
}

/**
 * POST /api/v1/investments/{id}/underwriting (deal team, the contract's guard): the "(new) to
 * Draft" row. The position must be one the credential can open (404 otherwise, never a hint
 * that it exists) and of a kind that holds a base case (422); one Draft per position (409). The
 * Draft names the caller as the person who entered it, and so cannot be confirmed by them.
 */
export const createUnderwritingCaseRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/investments/{id}/underwriting',
  what: 'body',
  body: underwritingCaseBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const investmentId = req.params.id ?? '';
    const bounds = revenueBounds(instance);
    if (bounds instanceof Response) return bounds;
    if (!canOpen(ctx, req.credential, investmentId))
      return problem(404, 'not-found', INVESTMENT_NOT_FOUND, refusalOf(instance));
    // The form is the position's, as the API answered this credential's read of it.
    const recorded = ctx.recordings.read(req.credential, readPath(investmentId), underwritingRead);
    if (recorded === undefined) return outside(instance);
    if (recorded.form === null) return precondition(UNDERWRITING_REFUSALS.noBaseCase, instance);
    const others = versionsOf(ctx, investmentId);
    const version = others.reduce((highest, v) => Math.max(highest, v.version), 0) + 1;
    const checked = refusedBody(ctx, req.credential, instance, {
      investmentId,
      form: recorded.form,
      version,
      body: req.body,
      others,
      bounds,
      draftExists: others.some((v) => v.state === 'Draft'),
    });
    if (checked.refused !== null) return checked.refused;

    const row: UnderwritingCaseVersion = {
      id: ctx.env.newId(),
      investmentId,
      version,
      form: recorded.form,
      state: 'Draft',
      kind: 'entry',
      ...columnsOf(recorded.form, req.body, checked.documentName),
      currency: 'USD',
      revisionReason: version === 1 ? null : (req.body.revisionReason ?? null),
      withdrawnReason: null,
      enteredBy: personOf(req.actor),
      enteredAt: ctx.env.now(),
      confirmedBy: null,
      confirmedAt: null,
      rowVersion: 1,
    };
    ensureUnderwritingCases(ctx.state, ctx.recordings).set(row.id, row);
    recordActivity(ctx, req.actor, {
      action: 'underwriting_case.create',
      entity: 'underwriting_case',
      entityId: row.id,
      reason: row.revisionReason,
      from: null,
      to: row.state,
      details: { version, points: row.points.length },
    });
    return answered(ctx, row, 201);
  },
});

/** The version as the API answers a write: among the versions of its position now, with its ETag. */
function answered(ctx: SimContext, row: UnderwritingCaseVersion, status: 200 | 201): Response {
  const now = versionsOf(ctx, row.investmentId).find((v) => v.id === row.id) ?? row;
  return jsonResponse(status, now, { simulated: true, etag: now.rowVersion });
}

/** The case a credential may act on: one of a position it can open, else nothing (no existence leak). */
function visibleCase(
  ctx: SimContext,
  credential: string,
  id: string,
): UnderwritingCaseVersion | undefined {
  const row = ensureUnderwritingCases(ctx.state, ctx.recordings).get(id);
  return row !== undefined && canOpen(ctx, credential, row.investmentId) ? row : undefined;
}

/**
 * PATCH /api/v1/underwriting-cases/{id} (deal team): the body replaces a Draft and its plan
 * points whole, and its sender becomes the person who last changed the figures. In the API's
 * order: a case the credential cannot see is 404, a stale If-Match is 412, any state but Draft
 * is 409 and keeps every value, then the refusals a create shares. The row version goes up by
 * one on every edit.
 */
export const editUnderwritingCaseRoute = defineSimRoute({
  method: 'PATCH',
  path: '/api/v1/underwriting-cases/{id}',
  what: 'body',
  body: underwritingCaseBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const bounds = revenueBounds(instance);
    if (bounds instanceof Response) return bounds;
    const row = visibleCase(ctx, req.credential, req.params.id ?? '');
    if (row === undefined) return problem(404, 'not-found', CASE_NOT_FOUND, refusalOf(instance));
    const stale = staleIfMatch(req.headers, row.rowVersion, instance);
    if (stale !== null) return stale;
    if (row.state !== 'Draft')
      return transition(UNDERWRITING_REFUSALS.notDraft(row.state), instance);
    const checked = refusedBody(ctx, req.credential, instance, {
      investmentId: row.investmentId,
      form: row.form,
      version: row.version,
      body: req.body,
      others: versionsOf(ctx, row.investmentId).filter((v) => v.version !== row.version),
      bounds,
      draftExists: false,
    });
    if (checked.refused !== null) return checked.refused;

    const next: UnderwritingCaseVersion = {
      ...row,
      ...columnsOf(row.form, req.body, checked.documentName),
      revisionReason: row.version === 1 ? null : (req.body.revisionReason ?? null),
      enteredBy: personOf(req.actor),
      enteredAt: ctx.env.now(),
      rowVersion: row.rowVersion + 1,
    };
    ensureUnderwritingCases(ctx.state, ctx.recordings).set(next.id, next);
    recordActivity(ctx, req.actor, {
      action: 'underwriting_case.edit',
      entity: 'underwriting_case',
      entityId: next.id,
      reason: null,
      from: row.state,
      to: next.state,
      details: { version: next.version, points: next.points.length },
    });
    return answered(ctx, next, 200);
  },
});

/** Whether a case names where its figures come from: a document, or a note with words in it. */
const hasSource = (row: UnderwritingCaseVersion): boolean =>
  row.source.document !== null || (row.source.note ?? '').trim().length > 0;

/**
 * POST /api/v1/underwriting-cases/{id}/commands (deal team, approver): confirm, withdraw and
 * retire through underwritingCaseMachine. A confirmation names the caller, who is never the
 * person who last changed the figures, needs the plan of an equity case, and first supersedes
 * the Confirmed case with the same case date: the system's row of the table, taken here as the
 * API takes it and never sent by anybody. Everything that can refuse comes before the first
 * change, so a refused command leaves every version as it was.
 */
export const underwritingCaseCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/underwriting-cases/{id}/commands',
  what: 'command',
  body: underwritingCommandBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const refusal = refusalOf(instance);
    const row = visibleCase(ctx, req.credential, req.params.id ?? '');
    if (row === undefined) return problem(404, 'not-found', CASE_NOT_FOUND, refusal);
    const stale = staleIfMatch(req.headers, row.rowVersion, instance);
    if (stale !== null) return stale;
    const body = req.body;
    const result = attempt(underwritingCaseMachine, row.state, body.command, {
      actorId: req.actor.userId,
      actorRoles: req.actor.roles,
      ...(body.command === 'confirm' ? {} : { reason: body.reason }),
      record: { enteredBy: row.enteredBy.id, hasSource: hasSource(row) },
    });
    if (!result.ok) return workflowProblem(result, refusal);
    const cases = ensureUnderwritingCases(ctx.state, ctx.recordings);

    if (body.command !== 'confirm') {
      const next: UnderwritingCaseVersion = {
        ...row,
        state: result.to,
        withdrawnReason: body.reason,
        rowVersion: row.rowVersion + 1,
      };
      cases.set(next.id, next);
      recordActivity(ctx, req.actor, {
        action: `underwriting_case.${body.command}`,
        entity: 'underwriting_case',
        entityId: next.id,
        reason: body.reason,
        from: row.state,
        to: next.state,
        details: { version: next.version },
      });
      return answered(ctx, next, 200);
    }

    if (
      row.form === 'equity' &&
      (row.points.length < 2 ||
        row.points[row.points.length - 1]?.periodEnd !== row.plannedExitDate)
    )
      return precondition(UNDERWRITING_REFUSALS.planRequired, instance);
    const corrected = [...cases.values()].filter(
      (v) =>
        v.investmentId === row.investmentId &&
        v.caseDate === row.caseDate &&
        v.state === 'Confirmed',
    );
    const superseded: UnderwritingCaseVersion[] = [];
    for (const old of corrected) {
      const step = attempt(underwritingCaseMachine, old.state, 'supersede', {
        actorId: req.actor.userId,
        actorRoles: ['service'],
        record: { correctedBySameDate: old.caseDate === row.caseDate },
      });
      if (!step.ok) return workflowProblem(step, refusal);
      superseded.push({ ...old, state: step.to, rowVersion: old.rowVersion + 1 });
    }
    for (const old of superseded) {
      cases.set(old.id, old);
      recordActivity(ctx, req.actor, {
        action: 'underwriting_case.supersede',
        entity: 'underwriting_case',
        entityId: old.id,
        reason: null,
        from: 'Confirmed',
        to: old.state,
        details: { version: old.version, supersededBy: row.version },
      });
    }
    const next: UnderwritingCaseVersion = {
      ...row,
      state: result.to,
      confirmedBy: personOf(req.actor),
      confirmedAt: ctx.env.now(),
      rowVersion: row.rowVersion + 1,
    };
    cases.set(next.id, next);
    recordActivity(ctx, req.actor, {
      action: 'underwriting_case.confirm',
      entity: 'underwriting_case',
      entityId: next.id,
      reason: null,
      from: row.state,
      to: next.state,
      details: { version: next.version, superseded: superseded.length },
    });
    return answered(ctx, next, 200);
  },
});
