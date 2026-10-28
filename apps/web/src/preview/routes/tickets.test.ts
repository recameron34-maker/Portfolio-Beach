import { beforeEach, describe, expect, it } from 'vitest';
import { tradeTicketPage, tradeTicketRow } from '@pb/contracts';
import { createPreviewFetch } from '../shim.js';
import { createPreviewState } from '../state.js';
import { IDS, USERS, buildWorld, send } from '../test-fixtures.js';

/**
 * The simulated trade tickets (docs/04 M16, SEC-12.3): the list and the detail follow the
 * notice's wall and carry the release check judged for the reader.
 */

const never: typeof fetch = () => Promise.reject(new Error('no network in the preview'));
const LIST = '/api/v1/trade-tickets?limit=200';
const path = (id: string): string => `/api/v1/trade-tickets/${id}`;

function setup(): typeof fetch {
  return createPreviewFetch(buildWorld().fixtures, never, { state: createPreviewState() });
}

beforeEach(() => {
  window.__pbPreviewMisses = [];
});

describe('the simulated trade tickets', () => {
  it('lists the tickets the caller may see, latest funding date first, with the release judged for the reader', async () => {
    const f = setup();
    const ops = tradeTicketPage.parse((await send(f, USERS.ops.externalId, 'GET', LIST)).json);
    expect(ops.items.map((t) => t.id)).toEqual([IDS.ticket.drafted, IDS.ticket.funded]);
    expect(ops.items[0]?.release).toEqual({
      allowed: false,
      blockers: ['changed_within_hold', 'same_person'],
    });
    expect(ops.items[1]).toMatchObject({
      state: 'Funded',
      release: { allowed: false, blockers: [] },
      approvedBy: { id: USERS.head.userId },
      wireInstruction: { id: IDS.wire.verifiedFund2, version: 1, state: 'Verified' },
    });
    const head = tradeTicketPage.parse((await send(f, USERS.head.externalId, 'GET', LIST)).json);
    expect(head.items[0]?.release).toEqual({ allowed: false, blockers: ['changed_within_hold'] });
    // The walled notice's ticket is listed for a wall member only.
    const member = tradeTicketPage.parse(
      (await send(f, USERS.dealWall.externalId, 'GET', LIST)).json,
    );
    expect(member.items.map((t) => t.id)).toContain(IDS.ticket.walled);
    expect(JSON.stringify(member)).not.toMatch(/accountNumber|routingCode/);
    // Filters and paging.
    const funded = tradeTicketPage.parse(
      (await send(f, USERS.ops.externalId, 'GET', `${LIST}&state=Funded`)).json,
    );
    expect(funded.items.map((t) => t.id)).toEqual([IDS.ticket.funded]);
    const first = tradeTicketPage.parse(
      (await send(f, USERS.ops.externalId, 'GET', '/api/v1/trade-tickets?limit=1')).json,
    );
    expect(first.items.map((t) => t.id)).toEqual([IDS.ticket.drafted]);
    expect(first.nextCursor).not.toBeNull();
    const second = tradeTicketPage.parse(
      (
        await send(
          f,
          USERS.ops.externalId,
          'GET',
          `/api/v1/trade-tickets?limit=1&cursor=${first.nextCursor ?? ''}`,
        )
      ).json,
    );
    expect(second.items.map((t) => t.id)).toEqual([IDS.ticket.funded]);
    expect(second.nextCursor).toBeNull();
    expect(
      (await send(f, USERS.ops.externalId, 'GET', '/api/v1/trade-tickets?cursor=garbage')).status,
    ).toBe(400);
  });

  it('serves one ticket to its roles, 404 outside the notice wall, 403 to roles without tickets', async () => {
    const f = setup();
    const row = await send(f, USERS.head.externalId, 'GET', path(IDS.ticket.drafted));
    expect(row.status).toBe(200);
    expect(row.headers.get('x-pb-simulated')).toBe('true');
    expect(tradeTicketRow.parse(row.json)).toMatchObject({
      capitalNoticeId: IDS.notice.wireChange,
      release: { allowed: false, blockers: ['changed_within_hold'] },
    });
    expect((await send(f, USERS.ops.externalId, 'GET', path(IDS.ticket.walled))).status).toBe(404);
    expect((await send(f, USERS.dealWall.externalId, 'GET', path(IDS.ticket.walled))).status).toBe(
      200,
    );
    for (const who of [USERS.viewer, USERS.admin]) {
      expect((await send(f, who.externalId, 'GET', LIST)).status).toBe(403);
      expect((await send(f, who.externalId, 'GET', path(IDS.ticket.drafted))).status).toBe(403);
    }
    expect(window.__pbPreviewMisses).toEqual([]);
  });
});
