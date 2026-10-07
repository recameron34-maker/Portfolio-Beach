import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditPage, problemDetails } from '@pb/contracts';
import { schema, withUserContext } from '@pb/db';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const EVENT_KEYS = [
  'action',
  'actorName',
  'actorType',
  'at',
  'entity',
  'entityId',
  'id',
  'reason',
  'requestId',
];

describe('audit trail (SEC-11)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const open = async (who: string, investmentId: string, requestId: string): Promise<void> => {
    await h
      .http()
      .get(`/api/v1/investments/${investmentId}`)
      .set('authorization', h.as(who))
      .set('x-request-id', requestId)
      .expect(200);
  };

  it('returns 403 from the role guard for roles outside the audit readers', async () => {
    for (const who of ['viewer', 'deal_team', 'investor_relations']) {
      const res = await h
        .http()
        .get('/api/v1/audit/events')
        .set('authorization', h.as(who))
        .expect(403);
      expect(problemDetails.parse(res.body).status).toBe(403);
    }
  });

  it('row-level security hides every event from a viewer even without the guard', async () => {
    const walled = h.dataset.scenarios.walled_deal![0]!;
    await open('deal.three', walled, 'req-audit-rls-1');
    const viewer = h.dataset.users.find((u) => u.externalId === 'viewer.one')!;
    const rows = await withUserContext(
      h.runtime.db.db,
      { userId: viewer.id, roles: ['viewer'], clientIds: [] },
      (tx) => tx.select({ id: schema.auditEvent.id }).from(schema.auditEvent),
    );
    expect(rows).toEqual([]);
    const owner = await h.runtime.db.query<{ n: number }>(
      "select count(*)::int as n from audit.event where request_id = 'req-audit-rls-1'",
    );
    expect(owner[0]?.n).toBe(1);
  });

  it('shows operations the investment.read event of a one-pager open, never details or hashes', async () => {
    const walled = h.dataset.scenarios.walled_deal![0]!;
    await open('deal.three', walled, 'req-audit-open-1');
    const res = await h
      .http()
      .get(`/api/v1/audit/events?action=investment.read&entityId=${walled}`)
      .set('authorization', h.as('operations'))
      .expect(200);
    const page = auditPage.parse(res.body);
    const event = page.items.find((e) => e.requestId === 'req-audit-open-1');
    expect(event).toBeDefined();
    const opener = h.dataset.users.find((u) => u.externalId === 'deal.three')!;
    expect(event!.actorName).toBe(opener.displayName);
    expect(event!.actorType).toBe('user');
    expect(event!.action).toBe('investment.read');
    expect(event!.entity).toBe('core.investment');
    expect(event!.entityId).toBe(walled);
    expect(event!.reason).toBeNull();
    expect(event!.id).toMatch(/^\d+$/);
    expect(event!.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const raw = res.body as { items: Record<string, unknown>[] };
    for (const item of raw.items) expect(Object.keys(item).sort()).toEqual(EVENT_KEYS);
    expect(JSON.stringify(res.body)).not.toMatch(
      /details|before_hash|after_hash|beforeHash|afterHash/,
    );
    for (const who of ['approver', 'auditor', 'platform_admin']) {
      const other = auditPage.parse(
        (
          await h
            .http()
            .get('/api/v1/audit/events?action=investment.read')
            .set('authorization', h.as(who))
            .expect(200)
        ).body,
      );
      expect(other.items.some((e) => e.requestId === 'req-audit-open-1')).toBe(true);
    }
  });

  it('pages newest first with an opaque cursor, filters by equality and rejects a bad cursor', async () => {
    const visible = h.dataset.investments
      .filter((i) => !(h.dataset.scenarios.walled_deal ?? []).includes(i.id))
      .slice(0, 3);
    for (const [n, inv] of visible.entries())
      await open('operations', inv.id, `req-audit-page-${n}`);
    const first = auditPage.parse(
      (
        await h
          .http()
          .get('/api/v1/audit/events?limit=2')
          .set('authorization', h.as('auditor'))
          .expect(200)
      ).body,
    );
    expect(first.items.length).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    expect(BigInt(first.items[0]!.id) > BigInt(first.items[1]!.id)).toBe(true);
    expect(first.items[0]!.requestId).toBe('req-audit-page-2');
    const second = auditPage.parse(
      (
        await h
          .http()
          .get(`/api/v1/audit/events?limit=2&cursor=${first.nextCursor}`)
          .set('authorization', h.as('auditor'))
          .expect(200)
      ).body,
    );
    expect(second.items.length).toBeGreaterThan(0);
    const firstIds = new Set(first.items.map((e) => e.id));
    for (const e of second.items) {
      expect(firstIds.has(e.id)).toBe(false);
      expect(BigInt(e.id) < BigInt(first.items[1]!.id)).toBe(true);
    }
    await h
      .http()
      .get('/api/v1/audit/events?cursor=%%%')
      .set('authorization', h.as('auditor'))
      .expect(400);
    const byEntity = auditPage.parse(
      (
        await h
          .http()
          .get(`/api/v1/audit/events?entity=core.investment&entityId=${visible[1]!.id}`)
          .set('authorization', h.as('auditor'))
          .expect(200)
      ).body,
    );
    expect(byEntity.items.length).toBe(1);
    expect(byEntity.items[0]!.requestId).toBe('req-audit-page-1');
    await h
      .http()
      .get('/api/v1/audit/events?entityId=not-a-uuid')
      .set('authorization', h.as('auditor'))
      .expect(400);
  });
});
