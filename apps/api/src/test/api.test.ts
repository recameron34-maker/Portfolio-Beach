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
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { CONTROLLERS } from '../app.module.js';
import { IS_PUBLIC, ROLES } from '../auth/principal.js';
import { listImplementedRoutes } from '../routes.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

interface HandlerGuard {
  /** "METHOD /path/{param}", the contract's notation. */
  key: string;
  /** Where the guard is written, for a failure message a person can act on. */
  handler: string;
  /** What AuthGuard reads: the handler's metadata, else the controller's. */
  roles: string[];
  isPublic: boolean;
}

/**
 * The guard metadata of every handler, read the way AuthGuard reads it (the handler first, then
 * its controller; no @Roles means any authenticated user). The route key is built as
 * listImplementedRoutes builds it, and the parity test below holds the two together.
 */
function handlerGuards(
  controllers: readonly (abstract new (...args: never[]) => unknown)[],
): HandlerGuard[] {
  const out: HandlerGuard[] = [];
  for (const controller of controllers) {
    const base = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (path === undefined || method === undefined) continue;
      const full = `/${[base, path].filter((p) => p.length > 0 && p !== '/').join('/')}`
        .replace(/\/+/g, '/')
        .replace(/:(\w+)/g, '{$1}');
      const read = <T>(key: string): T | undefined =>
        (Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, controller)) as
          T | undefined;
      out.push({
        key: `${RequestMethod[method] ?? String(method)} ${full}`,
        handler: `${controller.name}.${name}`,
        roles: [...(read<string[]>(ROLES) ?? [])].sort(),
        isPublic: read<boolean>(IS_PUBLIC) ?? false,
      });
    }
  }
  return out;
}

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

    it('guards every handler with exactly the roles and the sign-in its contract route names (D7-5)', () => {
      const guards = handlerGuards(CONTROLLERS);
      expect(guards.map((g) => g.key).sort()).toEqual(
        listImplementedRoutes(CONTROLLERS)
          .map((r) => `${r.method} ${r.path}`)
          .sort(),
      );
      const mismatches: string[] = [];
      for (const route of ROUTES) {
        const key = `${route.method} ${route.path}`;
        const guard = guards.find((g) => g.key === key);
        if (guard === undefined) {
          mismatches.push(`${key}: no handler`);
          continue;
        }
        const contracted = [...route.roles].sort();
        if (JSON.stringify(guard.roles) !== JSON.stringify(contracted))
          mismatches.push(
            `${key} (${guard.handler}): @Roles [${guard.roles.join(', ')}], contract [${contracted.join(', ')}]`,
          );
        if (guard.isPublic === route.auth)
          mismatches.push(
            `${key} (${guard.handler}): ${guard.isPublic ? '@Public' : 'signed in'}, contract auth ${String(route.auth)}`,
          );
      }
      expect(mismatches).toEqual([]);
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
    it('answers a body that is not JSON with a fixed message, never the text that was sent (SEC-11.4)', async () => {
      const res = await h
        .http()
        .post('/api/v1/valuations')
        .set('authorization', h.as('operations'))
        .set('content-type', 'application/json')
        .send('VALUE-9931 and more')
        .expect(400);
      const body = problemDetails.parse(res.body);
      expect(body.type).toBe('https://portfolio-beach.example/problems/validation');
      expect(body.detail).toBe('Invalid body');
      expect(body.errors).toEqual([{ path: '(root)', message: 'The body is not valid JSON' }]);
      expect(JSON.stringify(res.body)).not.toContain('VALUE-9931');
      expect(JSON.stringify(res.body)).not.toContain('Unexpected token');
      // The request has its id like every other answer, although it is refused before sign-in.
      expect(body.request_id).toMatch(/^[0-9a-f-]{8,}$/);
      expect(res.headers['x-request-id']).toBe(body.request_id);
      // A body over the size limit is named as that, with nothing of its content either.
      const big = await h
        .http()
        .post('/api/v1/valuations')
        .set('authorization', h.as('operations'))
        .set('content-type', 'application/json')
        .send(JSON.stringify({ note: 'x'.repeat(9_000_000) }));
      expect(big.status).toBe(413);
      expect(problemDetails.parse(big.body).detail).toBe('The request body is too large');
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

    it('gives each position its company head office, whole or null, as the company records it', async () => {
      const page = investmentPage.parse(
        (
          await h
            .http()
            .get('/api/v1/investments?limit=200')
            .set('authorization', h.as('deal.three'))
            .expect(200)
        ).body,
      );
      const companyOf = new Map(h.dataset.portfolioCompanies.map((c) => [c.id, c]));
      let placed = 0;
      for (const item of page.items) {
        const inv = h.dataset.investments.find((i) => i.id === item.id)!;
        const company = companyOf.get(inv.portfolioCompanyId)!;
        if (company.hqCity === null) {
          expect(item.hq, item.companyName).toBeNull();
          continue;
        }
        expect(item.hq, item.companyName).toEqual({
          city: company.hqCity,
          country: company.hqCountry,
          latitude: Number(company.hqLatitude),
          longitude: Number(company.hqLongitude),
        });
        placed += 1;
      }
      // Both cases are in the seeded book: most positions placed, some with nothing recorded.
      expect(placed).toBeGreaterThan(0);
      expect(placed).toBeLessThan(page.items.length);
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
      // A control character in a filter is refused at the boundary, never passed to the database.
      await h
        .http()
        .get('/api/v1/investments?dealType=deal_type.private_credit%00')
        .set('authorization', h.as('operations'))
        .expect(400);
    });

    it('reports the holding period from the first contribution, to the exit once realized', async () => {
      const realized = investmentPage.parse(
        (
          await h
            .http()
            .get(`/api/v1/investments?active=false&limit=200&asOf=${h.dataset.asOf}`)
            .set('authorization', h.as('operations'))
            .expect(200)
        ).body,
      );
      expect(realized.items.length).toBeGreaterThan(0);
      for (const row of realized.items) {
        const contributions = h.dataset.cashFlows
          .filter(
            (f) =>
              f.investmentId === row.id &&
              f.flowType === 'flow_type.contribution' &&
              f.status === 'record_status.approved' &&
              f.flowDate <= h.dataset.asOf,
          )
          .map((f) => f.flowDate)
          .sort();
        const first = contributions[0];
        if (first === undefined) {
          expect(row.holdingPeriodYears, row.investmentNumber).toBeNull();
          continue;
        }
        const days = (Date.parse(row.exitDate ?? '') - Date.parse(first)) / 86_400_000;
        expect(Number(row.holdingPeriodYears), row.investmentNumber).toBeCloseTo(days / 365, 9);
      }
      // A position still held is measured to the as-of date, so an earlier as-of shortens it.
      const held = investmentPage.parse(
        (
          await h
            .http()
            .get(`/api/v1/investments?active=true&limit=1&asOf=${h.dataset.asOf}`)
            .set('authorization', h.as('operations'))
            .expect(200)
        ).body,
      ).items[0]!;
      const earlier = investmentDetail.parse(
        (
          await h
            .http()
            .get(`/api/v1/investments/${held.id}?asOf=2024-12-31`)
            .set('authorization', h.as('operations'))
            .expect(200)
        ).body,
      );
      if (held.holdingPeriodYears !== null && earlier.holdingPeriodYears !== null)
        expect(Number(earlier.holdingPeriodYears)).toBeLessThan(Number(held.holdingPeriodYears));
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
      expect(detail.operating?.priorYear).toBeNull();
      expect(detail.operating?.evToEbitda).not.toBeNull();
      // Where the prior year is on record, its figures travel with the growth derived from them.
      let compared = 0;
      for (const inv of h.dataset.investments.slice(0, 12)) {
        if (inv.id === missing) continue;
        const res = await h
          .http()
          .get(`/api/v1/investments/${inv.id}?asOf=${h.dataset.asOf}`)
          .set('authorization', h.as('operations'));
        if (res.status !== 200) continue;
        const op = investmentDetail.parse(res.body).operating;
        const prior = op?.priorYear ?? null;
        if (op === null || prior === null) continue;
        compared += 1;
        const daysApart = (Date.parse(op.periodEnd) - Date.parse(prior.periodEnd)) / 86_400_000;
        expect(daysApart).toBeGreaterThanOrEqual(358);
        expect(daysApart).toBeLessThanOrEqual(372);
        if (op.revenueLtm !== null && prior.revenueLtm !== null && op.revenueYoy !== null)
          expect(
            Math.abs(
              Number(op.revenueYoy) - (Number(op.revenueLtm) / Number(prior.revenueLtm) - 1),
            ),
          ).toBeLessThan(1e-9);
        if (prior.ev !== null && prior.ebitdaLtm !== null) expect(prior.evToEbitda).not.toBeNull();
      }
      expect(compared).toBeGreaterThan(0);
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
      const nulCursor = Buffer.from(`Kelp${String.fromCharCode(0)}`).toString('base64url');
      await h
        .http()
        .get(`/api/v1/sponsors?cursor=${nulCursor}`)
        .set('authorization', h.as('viewer'))
        .expect(400);
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

    it('reads status as of the date from entry and exit dates, not from today', async () => {
      // A position exited since, with a Locked mark from when it was still held.
      const exited = h.dataset.investments.find(
        (i) =>
          i.exitDate !== null &&
          i.id !== walledId() &&
          h.dataset.valuations.some(
            (v) => v.investmentId === i.id && v.state === 'Locked' && v.periodEnd < i.exitDate!,
          ),
      )!;
      const asOf = h.dataset.valuations
        .filter((v) => v.investmentId === exited.id && v.state === 'Locked')
        .map((v) => v.periodEnd)
        .filter((d) => d < exited.exitDate!)
        .sort()
        .at(-1)!;
      const page = investmentPage.parse(
        (
          await h
            .http()
            .get(`/api/v1/investments?limit=200&asOf=${asOf}`)
            .set('authorization', h.as('operations'))
            .expect(200)
        ).body,
      );
      const row = page.items.find((i) => i.id === exited.id)!;
      expect(row.isActive).toBe(true);
      expect(row.navDate).toBe(asOf);
      expect(row.nav).not.toBe('0');
      // Positions entered after the date did not exist as of it.
      expect(page.items.every((i) => i.entryDate <= asOf)).toBe(true);
      const later = h.dataset.investments.filter((i) => i.entryDate > asOf && i.id !== walledId());
      expect(later.length).toBeGreaterThan(0);
      await h
        .http()
        .get(`/api/v1/investments/${later[0]!.id}?asOf=${asOf}`)
        .set('authorization', h.as('operations'))
        .expect(404);
      // The active filter follows the same dates.
      const held = investmentPage.parse(
        (
          await h
            .http()
            .get(`/api/v1/investments?limit=200&asOf=${asOf}&active=true`)
            .set('authorization', h.as('operations'))
            .expect(200)
        ).body,
      );
      expect(held.items.map((i) => i.id)).toContain(exited.id);
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
