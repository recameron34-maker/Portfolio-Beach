import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTES } from '@pb/contracts';
import {
  investmentDetail,
  investmentPage,
  dataHealth as dataHealthSchema,
  healthReady,
  principal as principalSchema,
  problemDetails,
  sponsorPage,
  vehicleList,
  featureFlagList,
} from '@pb/contracts';
import { CONTROLLERS } from '../app.module.js';
import { listImplementedRoutes } from '../routes.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

describe('Portfolio Beach API', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  describe('contract parity', () => {
    it('implements exactly the routes in the shared contract table', () => {
      const implemented = listImplementedRoutes(CONTROLLERS)
        .map((r) => `${r.method} ${r.path}`)
        .sort();
      const contracted = ROUTES.map((r) => `${r.method} ${r.path}`).sort();
      expect(implemented).toEqual(contracted);
    });
  });

  describe('health', () => {
    it('liveness and readiness are public and typed', async () => {
      const live = await h.http().get('/health/live').expect(200);
      expect(live.body).toEqual({ status: 'ok', version: '0.1.0' });
      const ready = await h.http().get('/health/ready').expect(200);
      const parsed = healthReady.parse(ready.body);
      expect(parsed.status).toBe('ok');
      expect(parsed.checks.database?.ok).toBe(true);
      expect(ready.headers['x-request-id']).toBeDefined();
    });
  });

  describe('authentication and problem details (docs/17 section 3)', () => {
    it('rejects anonymous calls with a problem+json body carrying the request id', async () => {
      const res = await h
        .http()
        .get('/api/v1/investments')
        .set('x-request-id', 'req-anon-00001')
        .expect(401);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      const problem = problemDetails.parse(res.body);
      expect(problem.request_id).toBe('req-anon-00001');
      expect(problem.type).toMatch(/unauthenticated$/);
      expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts/);
    });
    it('ignores an unknown credential', async () => {
      await h.http().get('/api/v1/auth/me').set('authorization', 'Bearer nobody').expect(401);
    });
    it('returns the principal with the mock identity marker', async () => {
      const res = await h
        .http()
        .get('/api/v1/auth/me')
        .set('authorization', h.as('viewer'))
        .expect(200);
      const p = principalSchema.parse(res.body);
      expect(p.roles).toEqual(['viewer']);
      expect(p.mockIdentity).toBe(true);
    });
    it('lists mock users for the role switcher outside production', async () => {
      const res = await h.http().get('/api/v1/auth/mock-users').expect(200);
      expect(res.body.users.length).toBe(h.dataset.users.length);
    });
    it('rejects bad query input with path-only errors', async () => {
      const res = await h
        .http()
        .get('/api/v1/investments?limit=500&junk=1')
        .set('authorization', h.as('viewer'))
        .expect(400);
      const problem = problemDetails.parse(res.body);
      expect(problem.errors?.map((e) => e.path).sort()).toEqual(['(root)', 'limit']);
      expect(JSON.stringify(problem)).not.toContain('500');
    });
    it('answers an impossible calendar date with a 400 validation problem, never a 500', async () => {
      const sponsorId = h.dataset.sponsors[0]!.id;
      const vehicleId = h.dataset.vehicles[0]!.id;
      const cases: [string, string][] = [
        ['/api/v1/analytics/summary?asOf=2025-02-30', 'asOf'],
        ['/api/v1/valuations?periodEnd=2025-02-30', 'periodEnd'],
        ['/api/v1/capital-notices?dueFrom=2025-13-01', 'dueFrom'],
        ['/api/v1/capital-notices?dueTo=2023-02-29', 'dueTo'],
        [`/api/v1/sponsors/${sponsorId}?asOf=2025-04-31`, 'asOf'],
        [`/api/v1/vehicles/${vehicleId}?asOf=2025-06-31`, 'asOf'],
        ['/api/v1/investments?asOf=2025-02-29', 'asOf'],
      ];
      for (const [path, field] of cases) {
        const res = await h.http().get(path).set('authorization', h.as('viewer')).expect(400);
        const problem = problemDetails.parse(res.body);
        expect(problem.type, path).toBe('https://portfolio-beach.example/problems/validation');
        expect(problem.errors, path).toEqual([
          { path: field, message: 'Not a real calendar date' },
        ]);
      }
      // A real leap day is a date like any other.
      await h
        .http()
        .get('/api/v1/analytics/summary?asOf=2024-02-29')
        .set('authorization', h.as('viewer'))
        .expect(200);
    });
    it('sets security headers', async () => {
      const res = await h.http().get('/health/live').expect(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    });
  });

  describe('portfolio (M1, M9) with row-level security (SEC-5)', () => {
    const walledId = (): string => h.dataset.scenarios.walled_deal![0]!;

    it('hides the walled investment from a viewer and shows it to a wall member', async () => {
      const viewer = investmentPage.parse(
        (
          await h
            .http()
            .get('/api/v1/investments?limit=200')
            .set('authorization', h.as('viewer'))
            .expect(200)
        ).body,
      );
      expect(viewer.items.map((i) => i.id)).not.toContain(walledId());
      expect(viewer.items.length).toBe(h.dataset.investments.length - 1);
      const member = investmentPage.parse(
        (
          await h
            .http()
            .get('/api/v1/investments?limit=200')
            .set('authorization', h.as('deal.three'))
            .expect(200)
        ).body,
      );
      expect(member.items.map((i) => i.id)).toContain(walledId());
      expect(member.items.length).toBe(h.dataset.investments.length);
    });

    it('returns 404, not 403, for a record the caller cannot see, and audits a successful open', async () => {
      await h
        .http()
        .get(`/api/v1/investments/${walledId()}`)
        .set('authorization', h.as('viewer'))
        .expect(404);
      await h
        .http()
        .get('/api/v1/investments/not-a-uuid')
        .set('authorization', h.as('viewer'))
        .expect(404);
      const res = await h
        .http()
        .get(`/api/v1/investments/${walledId()}`)
        .set('authorization', h.as('deal.three'))
        .set('x-request-id', 'req-open-walled-1')
        .expect(200);
      const detail = investmentDetail.parse(res.body);
      expect(detail.id).toBe(walledId());
      const audit = await h.runtime.db.query<{ n: number }>(
        `select count(*)::int as n from audit.event where action = 'investment.read' and entity_id = '${walledId()}' and request_id = 'req-open-walled-1'`,
      );
      expect(audit[0]?.n).toBe(1);
    });

    it("carries each position's vehicle and sponsor ids on the grid row and the detail alike", async () => {
      const page = investmentPage.parse(
        (
          await h
            .http()
            .get('/api/v1/investments?limit=200')
            .set('authorization', h.as('operations'))
            .expect(200)
        ).body,
      );
      expect(page.items.length).toBe(h.dataset.investments.length - 1);
      for (const row of page.items) {
        const seeded = h.dataset.investments.find((i) => i.id === row.id)!;
        expect([row.vehicleId, row.sponsorId]).toEqual([seeded.vehicleId, seeded.sponsorId]);
        expect(h.dataset.vehicles.find((v) => v.id === row.vehicleId)?.name).toBe(row.vehicleName);
        expect(h.dataset.sponsors.find((s) => s.id === row.sponsorId)?.name).toBe(row.sponsorName);
      }
      // The detail inherits the summary row, ids included: one source for both.
      const first = page.items[0]!;
      const detail = investmentDetail.parse(
        (
          await h
            .http()
            .get(`/api/v1/investments/${first.id}`)
            .set('authorization', h.as('operations'))
            .expect(200)
        ).body,
      );
      expect([detail.vehicleId, detail.sponsorId]).toEqual([first.vehicleId, first.sponsorId]);
    });

    it('computes metrics with the calc library and flags multiple-root IRRs', async () => {
      const page = investmentPage.parse(
        (
          await h
            .http()
            .get(`/api/v1/investments?limit=200&asOf=${h.dataset.asOf}`)
            .set('authorization', h.as('operations'))
            .expect(200)
        ).body,
      );
      const withMetrics = page.items.filter(
        (i) => i.isActive && i.grossMoic !== null && i.grossIrr !== null,
      );
      expect(withMetrics.length).toBeGreaterThan(5);
      for (const i of withMetrics) expect(Number(i.grossMoic)).toBeGreaterThan(0);
      const multi = page.items.find((i) => i.id === h.dataset.scenarios.multiple_irr![0]);
      expect(multi?.grossIrr).toBeNull();
      expect(multi?.irrFlag).toBe('multiple_irr');
      expect(page.items.every((i) => i.calcVersion === '0.1.0')).toBe(true);
    });

    it('pages with cursors without overlap', async () => {
      const first = investmentPage.parse(
        (
          await h
            .http()
            .get('/api/v1/investments?limit=7')
            .set('authorization', h.as('operations'))
            .expect(200)
        ).body,
      );
      expect(first.items.length).toBe(7);
      expect(first.nextCursor).not.toBeNull();
      const second = investmentPage.parse(
        (
          await h
            .http()
            .get(`/api/v1/investments?limit=7&cursor=${first.nextCursor}`)
            .set('authorization', h.as('operations'))
            .expect(200)
        ).body,
      );
      const ids = new Set(first.items.map((i) => i.id));
      expect(second.items.some((i) => ids.has(i.id))).toBe(false);
      expect(second.items[0]!.investmentNumber > first.items[6]!.investmentNumber).toBe(true);
      await h
        .http()
        .get('/api/v1/investments?cursor=%%%')
        .set('authorization', h.as('operations'))
        .expect(400);
    });

    it('filters by deal type and shows credit metrics on a credit position', async () => {
      const credit = investmentPage.parse(
        (
          await h
            .http()
            .get('/api/v1/investments?dealType=deal_type.private_credit&limit=200')
            .set('authorization', h.as('operations'))
            .expect(200)
        ).body,
      );
      expect(credit.items.length).toBeGreaterThan(0);
      const detail = investmentDetail.parse(
        (
          await h
            .http()
            .get(`/api/v1/investments/${credit.items[0]!.id}?asOf=${h.dataset.asOf}`)
            .set('authorization', h.as('operations'))
            .expect(200)
        ).body,
      );
      expect(detail.credit).not.toBeNull();
      expect(detail.credit?.latest?.currentYield).not.toBeNull();
      expect(detail.operating).toBeNull();
    });

    it('shows operating ratios and prior-year comparisons, with null where the prior year is missing', async () => {
      const missing = h.dataset.scenarios.missing_prior_year![0]!;
      const detail = investmentDetail.parse(
        (
          await h
            .http()
            .get(`/api/v1/investments/${missing}?asOf=${h.dataset.asOf}`)
            .set('authorization', h.as('operations'))
            .expect(200)
        ).body,
      );
      expect(detail.operating).not.toBeNull();
      expect(detail.operating?.revenueYoy).toBeNull();
      expect(detail.operating?.priorYearPeriodEnd).toBeNull();
      expect(detail.operating?.evToEbitda).not.toBeNull();
      const negative = h.dataset.scenarios.negative_ebitda![0]!;
      const neg = investmentDetail.parse(
        (
          await h
            .http()
            .get(`/api/v1/investments/${negative}?asOf=${h.dataset.asOf}`)
            .set('authorization', h.as('operations'))
            .expect(200)
        ).body,
      );
      expect(neg.operating?.evToEbitda).toBeNull();
      expect(neg.operating?.netDebtToEbitda).toBeNull();
    });

    it('lists sponsors and vehicles; LP commitment totals are null for roles without client data', async () => {
      const sponsors = sponsorPage.parse(
        (
          await h
            .http()
            .get('/api/v1/sponsors?limit=3')
            .set('authorization', h.as('viewer'))
            .expect(200)
        ).body,
      );
      expect(sponsors.items.length).toBe(3);
      expect(sponsors.nextCursor).not.toBeNull();
      const viewerVehicles = vehicleList.parse(
        (await h.http().get('/api/v1/vehicles').set('authorization', h.as('viewer')).expect(200))
          .body,
      );
      expect(viewerVehicles.items.every((v) => v.lpCommitmentsTotal === null)).toBe(true);
      const opsVehicles = vehicleList.parse(
        (
          await h
            .http()
            .get('/api/v1/vehicles')
            .set('authorization', h.as('operations'))
            .expect(200)
        ).body,
      );
      expect(opsVehicles.items.some((v) => v.lpCommitmentsTotal !== null)).toBe(true);
      const irVehicles = vehicleList.parse(
        (await h.http().get('/api/v1/vehicles').set('authorization', h.as('ir.two')).expect(200))
          .body,
      );
      // ir.two is entitled to one client only, so totals cover that client's commitments alone.
      const sma = irVehicles.items.find((v) => v.vehicleType === 'vehicle_type.client_sma');
      expect(sma?.lpCommitmentsTotal).toBe('150000000.00');
    });
  });

  describe('data pages (M1)', () => {
    it('reports data health on the seeded portfolio', async () => {
      const res = await h
        .http()
        .get(`/api/v1/data-health?asOf=${h.dataset.asOf}`)
        .set('authorization', h.as('operations'))
        .expect(200);
      const health = dataHealthSchema.parse(res.body);
      expect(health.orphanInvestments).toBe(0);
      // Operations is not on the wall, so the walled deal is outside its view of the portfolio.
      const walled = new Set(h.dataset.scenarios.walled_deal ?? []);
      expect(health.activeInvestments).toBe(
        h.dataset.investments.filter((i) => i.isActive && !walled.has(i.id)).length,
      );
      expect(health.vehiclesWithOwnershipGap).toEqual([]);
      expect(health.lockedValuationsLatestQuarter).toBeGreaterThan(0);
    });
    it('renders the data dictionary from config', async () => {
      const res = await h
        .http()
        .get('/api/v1/data-dictionary')
        .set('authorization', h.as('viewer'))
        .expect(200);
      expect(res.body.source).toBe('config/definitions.json');
      expect(res.body.definitions.priorYear).toBe('same fiscal quarter one year earlier only');
    });
  });

  describe('feature flags and kill switches', () => {
    it('lists flags for any user and lets only platform admins change them, with an audit event', async () => {
      const list = featureFlagList.parse(
        (await h.http().get('/api/v1/flags').set('authorization', h.as('viewer')).expect(200)).body,
      );
      expect(list.flags.find((f) => f.key === 'ai.extraction')?.enabled).toBe(false);
      await h
        .http()
        .patch('/api/v1/flags/ai.extraction')
        .set('authorization', h.as('operations'))
        .send({ enabled: true, reason: 'test' })
        .expect(403);
      await h
        .http()
        .patch('/api/v1/flags/ai.extraction')
        .set('authorization', h.as('platform_admin'))
        .send({ enabled: true })
        .expect(400);
      const ok = await h
        .http()
        .patch('/api/v1/flags/ai.extraction')
        .set('authorization', h.as('platform_admin'))
        .send({ enabled: true, reason: 'enable for the demo' })
        .expect(200);
      expect(ok.body.enabled).toBe(true);
      await h
        .http()
        .patch('/api/v1/flags/does.not.exist')
        .set('authorization', h.as('platform_admin'))
        .send({ enabled: true, reason: 'no such flag' })
        .expect(404);
      const audit = await h.runtime.db.query<{ n: number }>(
        "select count(*)::int as n from audit.event where action = 'feature_flag.set'",
      );
      expect(audit[0]?.n).toBe(1);
    });
  });
});
