import { valuationSuggestionCommandBody, valuationSuggestionListQuery } from '@pb/contracts';
import type {
  ValuationSuggestionCommandBody,
  ValuationSuggestionPage,
  ValuationSuggestionRow,
} from '@pb/contracts';
import {
  SUGGESTIONS_OFF_REFUSAL,
  SUGGESTION_CHANGED_REFUSAL,
  attempt,
  suggestionCommandRecord,
  suggestionDraftKeys,
  suggestionReading,
  valuationSuggestionMachine,
  withSuggestionKeys,
} from '@pb/workflows';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import type { SimSuggestion } from '../state.js';
import {
  defineSimRoute,
  pageNewestFirst,
  personOf,
  recordActivity,
  staleIfMatch,
} from './common.js';
import type { SimContext, SimRequest } from './common.js';
import {
  gatherFor,
  previewSuggestionSettings,
  quarterVersions,
  refreshOne,
  runOutcomeOf,
  storedOf,
  suggestionVisible,
  suggestionsEnabled,
  toSuggestionRow,
} from './suggestionDerivation.js';
import type { Gathered } from './suggestionDerivation.js';
import { correctDraft, openDraft } from './valuations.js';
import type { Outcome } from './valuations.js';

/*
 * Valuation suggestions in the static preview (docs/04 M10, docs/18 section 14, decision 0023),
 * the way apps/api/src/suggestions/suggestions.service.ts serves them. Nothing is recorded: the
 * session holds the suggestions its own approvals derived (suggestionDerivation.ts), and a
 * preview nobody approved a statement or a report in lists none.
 *
 * The deal team, operations, approvers and auditors read them (the contract's role guard, which
 * the dispatcher applies); a suggestion carries its position's wall, so one the credential cannot
 * see is not listed and reads as 404. The stored figures are those of the approval that produced
 * the suggestion; the mark on record, the comparison, the checks, the other sources and the
 * badges are worked out at each read from the session as it then stands.
 *
 * Deciding one is operations' alone, through valuationSuggestionMachine. dismiss sets it aside
 * with a reason. accept opens a draft valuation at the suggested value and applyToDraft puts the
 * value and its method on the Draft open for the quarter, each through the valuation simulation's
 * own write, so a suggestion never writes a mark. Before either writes anything the suggestion is
 * derived again; one whose figures moved is replaced or closed, that stays, and the answer is
 * 409. Everything else that can refuse comes before the first change.
 */

/** The API's words for a suggestion the caller cannot see (apps/api/src/suggestions/rows.ts). */
const NOT_FOUND = 'Valuation suggestion not found';

const notFound = (instance: string): Response =>
  problem(404, 'not-found', NOT_FOUND, { instance, simulated: true });

/** 409 when a command finds the suggestion gone from under it, in the API's words. */
const conflict = (instance: string): Response =>
  problem(
    409,
    'conflict',
    'valuation_suggestion: another command changed the suggestion first; open it again',
    { instance, simulated: true },
  );

/** The suggestion of the id, when the credential may see it. */
function visibleSuggestion(
  ctx: SimContext,
  credential: string,
  id: string,
): SimSuggestion | undefined {
  const sim = ctx.state.suggestions.get(id);
  return sim !== undefined && suggestionVisible(ctx, credential, sim) ? sim : undefined;
}

/** The rows of a page: the sources of each position and quarter are gathered once. */
function toRows(ctx: SimContext, page: readonly SimSuggestion[]): ValuationSuggestionRow[] {
  const settings = previewSuggestionSettings();
  const gathered = new Map<string, Gathered>();
  const out: ValuationSuggestionRow[] = [];
  for (const sim of page) {
    // A statement-based suggestion is read with its own statement, so it is keyed by its run too.
    const key = `${sim.investmentId}|${sim.periodEnd}|${sim.basis === 'capital_account_balance' ? sim.extractionRunId : ''}`;
    let sources = gathered.get(key);
    if (sources === undefined) {
      sources = gatherFor(ctx, sim, settings);
      gathered.set(key, sources);
    }
    const row = toSuggestionRow(ctx, sim, sources, settings);
    if (row !== null) out.push(row);
  }
  return out;
}

/**
 * GET /api/v1/valuation-suggestions: newest first on (createdAt, id), Open unless a state is
 * given, filtered by position, quarter and the run that produced the suggestion. `openCount`
 * counts every Open suggestion the credential can see, whatever the filters. With a run id, the
 * answer also says what that approved run did to the suggestions of its position and quarter.
 */
export const valuationSuggestionsRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/valuation-suggestions',
  what: 'query',
  body: null,
  query: valuationSuggestionListQuery,
  handle: (req, ctx) => {
    const { query } = req;
    const visible = [...ctx.state.suggestions.values()].filter((sim) =>
      suggestionVisible(ctx, req.credential, sim),
    );
    const matching = visible.filter(
      (sim) =>
        (query.state === 'all' || sim.state === query.state) &&
        (query.investmentId === undefined || sim.investmentId === query.investmentId) &&
        (query.periodEnd === undefined || sim.periodEnd === query.periodEnd) &&
        (query.extractionRunId === undefined || sim.extractionRunId === query.extractionRunId),
    );
    const page = pageNewestFirst(matching, (sim) => ({ at: sim.createdAt, id: sim.id }), query);
    if (page === null)
      return problem(400, 'validation', 'Invalid cursor', {
        instance: req.url.pathname,
        simulated: true,
      });
    const body: ValuationSuggestionPage = {
      items: toRows(ctx, page.items),
      nextCursor: page.nextCursor,
      openCount: visible.filter((sim) => sim.state === 'Open').length,
      runOutcome:
        query.extractionRunId === undefined
          ? null
          : runOutcomeOf(ctx, req.credential, query.extractionRunId),
    };
    return jsonResponse(200, body, { simulated: true });
  },
});

/** GET /api/v1/valuation-suggestions/{id}: one suggestion with everything derived when read; 404 for one the credential cannot see. */
export const valuationSuggestionRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/valuation-suggestions/{id}',
  what: 'valuation suggestion',
  body: null,
  handle: (req, ctx) => {
    const sim = visibleSuggestion(ctx, req.credential, req.params.id ?? '');
    const row = sim === undefined ? null : toSuggestionRow(ctx, sim);
    if (row === null) return notFound(req.url.pathname);
    return jsonResponse(200, row, { simulated: true, etag: row.rowVersion });
  },
});

/** The one write of a person's decision: the decision columns, with its entry in the session's activity. */
function decide(
  ctx: SimContext,
  req: Pick<SimRequest<ValuationSuggestionCommandBody>, 'actor' | 'body'>,
  sim: SimSuggestion,
  patch: Pick<SimSuggestion, 'state'> &
    Partial<Pick<SimSuggestion, 'decisionReason' | 'valuationId'>>,
): SimSuggestion {
  const next: SimSuggestion = {
    ...sim,
    ...patch,
    decidedBy: personOf(req.actor),
    decidedAt: ctx.env.now(),
    rowVersion: sim.rowVersion + 1,
  };
  ctx.state.suggestions.set(next.id, next);
  recordActivity(ctx, req.actor, {
    action: `valuation_suggestion.${req.body.command}`,
    entity: 'valuation_suggestion',
    entityId: next.id,
    reason: patch.decisionReason ?? null,
    from: sim.state,
    to: next.state,
  });
  return next;
}

/** The suggestion as a row after a write; it was just written, so it reads. */
function answer(ctx: SimContext, sim: SimSuggestion, instance: string): Response {
  const row = toSuggestionRow(ctx, sim);
  if (row === null) return notFound(instance);
  return jsonResponse(200, row, { simulated: true, etag: row.rowVersion });
}

/**
 * POST /api/v1/valuation-suggestions/{id}/commands (operations, the contract's guard), in the
 * API's order: 404 for a suggestion the credential cannot see; 412 for a stale If-Match; 409 for
 * a command the state does not allow; with the switch off, 409 for accept and applyToDraft while
 * dismiss still works; 409 once the figures behind the suggestion have moved (it was replaced or
 * closed, and that stays); 422 for the machine's preconditions, in the valuation workflow's
 * words; then the valuation simulation's own write, which may still refuse and then changes
 * nothing.
 */
export const valuationSuggestionCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/valuation-suggestions/{id}/commands',
  what: 'command',
  body: valuationSuggestionCommandBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const { body, credential, actor } = req;
    const sim = visibleSuggestion(ctx, credential, req.params.id ?? '');
    if (sim === undefined) return notFound(instance);
    const stale = staleIfMatch(req.headers, sim.rowVersion, instance);
    if (stale !== null) return stale;
    const who = { actorId: actor.userId, actorRoles: actor.roles };

    if (body.command === 'dismiss') {
      const result = attempt(valuationSuggestionMachine, sim.state, 'dismiss', {
        ...who,
        reason: body.reason,
        record: {},
      });
      if (!result.ok) return workflowProblem(result, { instance, simulated: true });
      return answer(
        ctx,
        decide(ctx, req, sim, { state: result.to, decisionReason: body.reason }),
        instance,
      );
    }

    // The state and the role first: a decided suggestion is 409 whatever else is true.
    const gate = attempt(valuationSuggestionMachine, sim.state, body.command, {
      ...who,
      record: {},
    });
    if (!gate.ok && gate.code !== 'precondition')
      return workflowProblem(gate, { instance, simulated: true });
    if (!suggestionsEnabled(ctx, credential))
      return problem(409, 'kill-switch', SUGGESTIONS_OFF_REFUSAL, { instance, simulated: true });
    // The figures behind it, read again: a suggestion that no longer says what the sources give
    // is replaced or closed here, and that is what this command leaves behind.
    const derived = refreshOne(ctx, { credential, actor }, sim.investmentId, sim.periodEnd);
    if (derived.action !== 'none')
      return problem(409, 'conflict', SUGGESTION_CHANGED_REFUSAL, { instance, simulated: true });

    const settings = previewSuggestionSettings();
    const stored = storedOf(sim);
    const gathered = gatherFor(ctx, sim, settings);
    const chain = quarterVersions(
      gathered.versions,
      sim.periodEnd,
      settings.periodEndToleranceDays,
    );
    const result = attempt(valuationSuggestionMachine, sim.state, body.command, {
      ...who,
      record: { ...suggestionCommandRecord(sim.suggestedValue, chain) },
    });
    if (!result.ok) return workflowProblem(result, { instance, simulated: true });
    const value = sim.suggestedValue;
    if (value === null) return conflict(instance);
    const keys = suggestionDraftKeys({
      id: sim.id,
      basis: sim.basis,
      value,
      periodEnd: sim.periodEnd,
      documentId: sim.sourceDocumentId,
      page: sim.sourcePage,
      runId: sim.extractionRunId,
      inputs: sim.inputs,
      crossChecks: suggestionReading(stored, gathered.sources, settings).crossChecks,
    });
    let onto: Outcome;
    if (body.command === 'accept') {
      onto = openDraft(
        ctx,
        credential,
        actor,
        {
          investmentId: sim.investmentId,
          periodEnd: sim.periodEnd,
          method: sim.method,
          fairValue: value,
          inputs: keys,
        },
        instance,
      );
    } else {
      const draft = chain.find((version) => version.state === 'Draft');
      if (draft === undefined) return conflict(instance);
      onto = correctDraft(
        ctx,
        credential,
        actor,
        draft.id,
        (inputs) => ({
          method: sim.method,
          fairValue: value,
          inputs: withSuggestionKeys(inputs, keys),
        }),
        null,
        instance,
      );
    }
    if (!onto.ok) return onto.response;
    return answer(
      ctx,
      decide(ctx, req, sim, { state: result.to, valuationId: onto.row.id }),
      instance,
    );
  },
});
