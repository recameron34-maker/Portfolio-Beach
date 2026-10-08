import { capitalNoticeCommandBody, capitalNoticeDetail } from '@pb/contracts';
import type { CapitalNoticeRow } from '@pb/contracts';
import { attempt, capitalNoticeMachine } from '@pb/workflows';
import { jsonResponse, problem, workflowProblem } from '../problems.js';
import { ensureNotices } from '../state.js';
import { defineSimRoute, recordActivity, staleIfMatch } from './common.js';

/**
 * Capital notices through docs/18 section 3. The prototype has no wire register, so a wire is
 * never verified and ticket approval is always refused: with the SEC-12.3 message when the
 * ticket's drafter tries, the SEC-12.2 message for anyone else. There is deliberately no command
 * that verifies a wire. Bank fields are never extracted (SEC-12.1); the hold window comes from the
 * credential's recorded notice detail.
 */
export const capitalNoticeCommandRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/capital-notices/{id}/commands',
  what: 'command',
  body: capitalNoticeCommandBody,
  idempotent: true,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const notices = ensureNotices(ctx.state, ctx.recordings);
    const id = req.params.id ?? '';
    const sim = notices.get(id);
    // A notice the credential cannot open is not found, never forbidden (no existence leak).
    const detail =
      sim === undefined
        ? undefined
        : ctx.recordings.read(
            req.credential,
            `/api/v1/capital-notices/${encodeURIComponent(id)}`,
            capitalNoticeDetail,
          );
    if (sim === undefined || detail === undefined)
      return problem(404, 'not-found', 'Capital notice not found', { instance, simulated: true });
    const stale = staleIfMatch(req.headers, sim.row.rowVersion, instance);
    if (stale !== null) return stale;

    const { row } = sim;
    const { command, reason } = req.body;
    const result = attempt(capitalNoticeMachine, row.state, command, {
      actorId: req.actor.userId,
      actorRoles: req.actor.roles,
      ...(reason !== undefined ? { reason } : {}),
      record: {
        documentIndexed: true,
        bankFieldsExtracted: false,
        ticketPreparedBy: sim.ticketPreparedBy,
        wireVerified: false,
        wireChangedWithinHold: detail.wireChangeHold !== null,
      },
    });
    if (!result.ok) return workflowProblem(result, { instance, simulated: true });

    const next: CapitalNoticeRow = { ...row, state: result.to, rowVersion: row.rowVersion + 1 };
    notices.set(id, {
      row: next,
      changed: true,
      ticketPreparedBy: command === 'draftTicket' ? req.actor.userId : sim.ticketPreparedBy,
    });
    recordActivity(ctx, req.actor, {
      action: `capital_notice.${command}`,
      entity: 'capital_notice',
      entityId: id,
      reason: reason ?? null,
      from: row.state,
      to: next.state,
    });
    return jsonResponse(200, next, { simulated: true, etag: next.rowVersion });
  },
});
