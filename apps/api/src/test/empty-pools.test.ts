import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  analyticsSummary,
  clientList,
  sponsorDetail,
  vehicleDetail,
  weeklyReport,
} from '@pb/contracts';
import type { z } from 'zod';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';
import { NOTHING_POOLED } from './pools.js';

/**
 * A reader behind every wall (SEC-5.3): a wall nobody belongs to covers every investment, so
 * viewer.one can open no position at all. Every view that pools positions must then answer with
 * null figures, never 0 (docs/06 section 3), and the report must not write a NAV it does not have.
 */
describe('pooled views over a set with no visible position', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    const wall = '7e000000-0000-4000-8000-000000000001';
    await h.runtime.db.query(
      `insert into core.wall (id, name, description) values ('${wall}', 'Project Undertow', 'Covers every position')`,
    );
    for (const i of h.dataset.investments) {
      await h.runtime.db.query(
        `insert into core.walled_record (wall_id, entity, entity_id) values ('${wall}', 'investment', '${i.id}')`,
      );
    }
  });
  afterAll(async () => {
    await h.close();
  });

  const read = async <S extends z.ZodTypeAny>(
    schema: S,
    who: string,
    path: string,
  ): Promise<z.infer<S>> =>
    schema.parse(
      (
        await h
          .http()
          .get(`${path}?asOf=${h.dataset.asOf}`)
          .set('authorization', h.as(who))
          .expect(200)
      ).body,
    );

  it('pools nothing in the analytics summary: every set is not calculable', async () => {
    const s = await read(analyticsSummary, 'viewer.one', '/api/v1/analytics/summary');
    expect(s.activeInvestments).toBe(0);
    expect(s.realizedInvestments).toBe(0);
    expect(s.totals).toEqual(NOTHING_POOLED);
    expect(s.active).toEqual(NOTHING_POOLED);
    expect(s.realized).toEqual(NOTHING_POOLED);
    expect(Object.values(s.exposures).every((buckets) => buckets.length === 0)).toBe(true);
    expect(s.navSeries).toEqual([]);
    expect(s.flowsByYear).toEqual([]);
    expect(s.topPositions).toEqual([]);
  });

  it('writes the weekly report without a NAV it does not have', async () => {
    const r = await read(weeklyReport, 'viewer.one', '/api/v1/reports/weekly');
    expect(r.summary).toEqual({ ...NOTHING_POOLED, activeInvestments: 0 });
    expect(r.byVehicle).toEqual([]);
    expect(r.movers).toEqual([]);
    expect(r.staleValuations).toEqual([]);
    const [first, vehicles] = r.commentary.paragraphs;
    expect(first).toMatch(
      /^As of [A-Z][a-z]{2} \d{1,2}, \d{4} the portfolio holds 0 active positions\.$/,
    );
    expect(vehicles).toBe('No vehicle holds an active position.');
    expect(r.commentary.paragraphs.join(' ')).not.toContain('$');
    expect(r.footnotes).toContain('The portfolio gross IRR is shown as NM (too few cash flows).');
  });

  it('gives a sponsor and a vehicle whose positions are all walled the same null figures', async () => {
    const sponsorId = h.dataset.investments[0]!.sponsorId;
    const vehicleId = h.dataset.investments[0]!.vehicleId;
    const sponsor = await read(sponsorDetail, 'viewer.one', `/api/v1/sponsors/${sponsorId}`);
    const vehicle = await read(vehicleDetail, 'viewer.one', `/api/v1/vehicles/${vehicleId}`);
    expect(sponsor.positions).toEqual([]);
    expect(vehicle.positions).toEqual([]);
    expect(sponsor.metrics).toEqual(NOTHING_POOLED);
    expect(vehicle.metrics).toEqual(NOTHING_POOLED);
  });

  it("leaves a client's share of a vehicle with nothing pooled not calculable", async () => {
    const list = await read(clientList, 'ir.two', '/api/v1/clients');
    const shares = list.items.flatMap((c) => c.vehicles);
    expect(shares.length).toBeGreaterThan(0);
    for (const v of shares) {
      expect([v.invested, v.distributions, v.nav, v.grossMoic]).toEqual([null, null, null, null]);
    }
    for (const c of list.items) {
      expect(c.totals.commitment).not.toBeNull();
      expect([c.totals.invested, c.totals.nav, c.totals.grossMoic]).toEqual([null, null, null]);
    }
  });
});
