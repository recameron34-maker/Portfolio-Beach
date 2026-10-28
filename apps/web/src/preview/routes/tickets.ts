import { tradeTicketListQuery } from '@pb/contracts';
import type { TradeTicketPage, TradeTicketRow } from '@pb/contracts';
import { jsonResponse, problem } from '../problems.js';
import { ensureNotices, ensureTickets, ensureWires } from '../state.js';
import type { SimTicket } from '../state.js';
import { decodeCursor, defineSimRoute, encodeCursor } from './common.js';
import type { SimContext } from './common.js';
import { counterpartyOfNotice, readerIdOf, registerOf, ticketRowOf } from './register.js';

/**
 * Trade tickets (docs/04 M16, SEC-12.3) simulated the way apps/api/src/capital/tickets.ts serves
 * them: one per capital notice, read by the contract's roles, each following its notice's wall
 * (a ticket on a notice the credential cannot open is absent from the list and not found on its
 * own), with the release check computed for the reader from the same register the notice
 * commands judge approveTicket on, so what the ticket shows is what the command will say.
 */

const NOT_FOUND = 'Trade ticket not found';

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The list order: latest funding date first, then id ascending (the cursor key). */
const ticketOrder = (a: TradeTicketRow, b: TradeTicketRow): number =>
  byText(b.fundingDate, a.fundingDate) || byText(a.id, b.id);

/** Whether the credential may see the ticket: its own recorded notice detail answered 200. */
function visibleTo(ctx: SimContext, credential: string, sim: SimTicket): boolean {
  return (
    ctx.recordings.status(
      credential,
      `/api/v1/capital-notices/${encodeURIComponent(sim.capitalNoticeId)}`,
    ) === 200
  );
}

/** The ticket as the contract serves it to this credential, judged on the as-of date. */
function rowFor(ctx: SimContext, credential: string, sim: SimTicket): TradeTicketRow {
  const wires = ensureWires(ctx.state, ctx.recordings);
  const notice = ensureNotices(ctx.state, ctx.recordings).get(sim.capitalNoticeId);
  const keys =
    notice === undefined
      ? { investmentId: null, sponsorFundId: null }
      : counterpartyOfNotice(ctx.recordings, notice.row);
  return ticketRowOf(
    sim,
    wires,
    registerOf(wires.values(), keys),
    readerIdOf(ctx.recordings, credential),
    ctx.recordings.asOf,
  );
}

/** GET /api/v1/trade-tickets: the tickets the credential can see, latest funding date first, filtered by state. */
export const tradeTicketsRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/trade-tickets',
  what: 'query',
  body: null,
  query: tradeTicketListQuery,
  handle: (req, ctx) => {
    const instance = req.url.pathname;
    const { state, limit, cursor } = req.query;
    const rows = [...ensureTickets(ctx.state, ctx.recordings).values()]
      .filter(
        (t) => (state === undefined || t.state === state) && visibleTo(ctx, req.credential, t),
      )
      .map((t) => rowFor(ctx, req.credential, t))
      .sort(ticketOrder);
    let start = 0;
    if (cursor !== undefined) {
      const key = decodeCursor(cursor);
      const at = key === null ? -1 : rows.findIndex((r) => r.id === key.id);
      if (key === null || at < 0)
        return problem(400, 'validation', 'Invalid cursor', { instance, simulated: true });
      start = at + 1;
    }
    const page = rows.slice(start, start + limit);
    const last = page[page.length - 1];
    const body: TradeTicketPage = {
      items: page,
      nextCursor:
        rows.length > start + limit && last !== undefined
          ? encodeCursor({ at: `${last.fundingDate}T00:00:00Z`, id: last.id })
          : null,
    };
    return jsonResponse(200, body, { simulated: true });
  },
});

/** GET /api/v1/trade-tickets/{id}: one ticket; one on a notice the credential cannot open is not found. */
export const tradeTicketRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/trade-tickets/{id}',
  what: 'ticket',
  body: null,
  handle: (req, ctx) => {
    const sim = ensureTickets(ctx.state, ctx.recordings).get(req.params.id ?? '');
    if (sim === undefined || !visibleTo(ctx, req.credential, sim))
      return problem(404, 'not-found', NOT_FOUND, { instance: req.url.pathname, simulated: true });
    return jsonResponse(200, rowFor(ctx, req.credential, sim), {
      simulated: true,
      etag: sim.rowVersion,
    });
  },
});
