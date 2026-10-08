import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@pb/calc';
import { clientList, commitmentList, vehicleDetail, vehicleList } from '@pb/contracts';
import type { ClientList, CommitmentList, FundCommitmentRow, VehicleDetail } from '@pb/contracts';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

describe('vehicles, commitments and clients (M17, decision 0004)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const vehicleOfType = (vehicleType: string): string => {
    const v = h.dataset.vehicles.find((x) => x.vehicleType === vehicleType);
    if (v === undefined) throw new Error(`no vehicle of type ${vehicleType}`);
    return v.id;
  };
  const clientIdsOf = (externalId: string): string[] => {
    const u = h.dataset.users.find((x) => x.externalId === externalId);
    if (u === undefined) throw new Error(`no user ${externalId}`);
    return [...u.clientIds].sort();
  };
  const walledId = (): string => h.dataset.scenarios.walled_deal![0]!;
  /** The vehicle with a second closing (lp_second_closing tags the vehicle id). */
  const secondClosingVehicle = (): string => h.dataset.scenarios.lp_second_closing![0]!;
  const auditCount = async (action: string, requestId: string): Promise<number> => {
    const rows = await h.runtime.db.query<{ n: number }>(
      `select count(*)::int as n from audit.event where action = '${action}' and request_id = '${requestId}'`,
    );
    return rows[0]?.n ?? -1;
  };

  const detailFor = async (
    who: string,
    id: string,
    requestId = 'req-vehicle',
  ): Promise<VehicleDetail> =>
    vehicleDetail.parse(
      (
        await h
          .http()
          .get(`/api/v1/vehicles/${id}?asOf=${h.dataset.asOf}`)
          .set('authorization', h.as(who))
          .set('x-request-id', requestId)
          .expect(200)
      ).body,
    );
  const commitmentsFor = async (
    who: string,
    requestId = 'req-commitments',
  ): Promise<CommitmentList> =>
    commitmentList.parse(
      (
        await h
          .http()
          .get(`/api/v1/commitments?asOf=${h.dataset.asOf}`)
          .set('authorization', h.as(who))
          .set('x-request-id', requestId)
          .expect(200)
      ).body,
    );
  const clientsFor = async (who: string, requestId = 'req-clients'): Promise<ClientList> =>
    clientList.parse(
      (
        await h
          .http()
          .get(`/api/v1/clients?asOf=${h.dataset.asOf}`)
          .set('authorization', h.as(who))
          .set('x-request-id', requestId)
          .expect(200)
      ).body,
    );

  const sumOf = (values: readonly (string | null)[]): string | null => {
    const known = values.filter((v): v is string => v !== null);
    return known.length === 0 ? null : known.reduce((acc, v) => acc.plus(v), D('0')).toString();
  };
  const expectUnfundedIdentity = (r: FundCommitmentRow): void => {
    expect(r.called).not.toBeNull();
    expect(r.distributed).not.toBeNull();
    expect(r.recallable).not.toBeNull();
    expect(
      D(r.unfunded ?? '0').eq(
        D(r.amount)
          .minus(r.called ?? '0')
          .plus(r.recallable ?? '0'),
      ),
    ).toBe(true);
  };
  /** Rows are in non-decreasing order of their keys, compared field by field (nulls first). */
  const expectOrdered = <T>(
    rows: readonly T[],
    keysOf: (row: T) => readonly (string | number | null)[],
  ): void => {
    for (let i = 1; i < rows.length; i += 1) {
      const a = keysOf(rows[i - 1]!);
      const b = keysOf(rows[i]!);
      let cmp = 0;
      for (let k = 0; k < a.length && cmp === 0; k += 1) {
        const x = a[k] ?? '';
        const y = b[k] ?? '';
        cmp = x < y ? -1 : x > y ? 1 : 0;
      }
      expect(cmp, `row ${i} is out of order`).toBeLessThanOrEqual(0);
    }
  };

  describe('request handling (docs/17 section 3)', () => {
    it('requires authentication, defaults the as-of date to the clock and rejects unknown query keys', async () => {
      await h
        .http()
        .get(`/api/v1/vehicles/${vehicleOfType('vehicle_type.co_invest')}`)
        .expect(401);
      await h.http().get('/api/v1/commitments').expect(401);
      await h.http().get('/api/v1/clients').expect(401);
      const res = await h
        .http()
        .get(`/api/v1/vehicles/${vehicleOfType('vehicle_type.co_invest')}`)
        .set('authorization', h.as('viewer'))
        .expect(200);
      expect(vehicleDetail.parse(res.body).asOf).toBe(h.dataset.asOf);
      await h
        .http()
        .get('/api/v1/commitments?junk=1')
        .set('authorization', h.as('viewer'))
        .expect(400);
    });

    it('answers 404 for a malformed id and for a vehicle that does not exist', async () => {
      await h
        .http()
        .get('/api/v1/vehicles/not-a-uuid')
        .set('authorization', h.as('viewer'))
        .expect(404);
      await h
        .http()
        .get(`/api/v1/vehicles/${randomUUID()}`)
        .set('authorization', h.as('operations'))
        .expect(404);
    });
  });

  describe('GET /vehicles/{id}', () => {
    it('carries the list summary, pools the visible positions and keeps client data null for a viewer', async () => {
      const list = vehicleList.parse(
        (await h.http().get('/api/v1/vehicles').set('authorization', h.as('viewer')).expect(200))
          .body,
      );
      const id = vehicleOfType('vehicle_type.co_invest');
      const seeded = h.dataset.vehicles.find((v) => v.id === id)!;
      const listed = list.items.find((v) => v.id === id)!;
      const detail = await detailFor('viewer.one', id, 'req-vehicle-viewer-1');

      expect(detail.name).toBe(listed.name);
      expect(detail.vehicleType).toBe(listed.vehicleType);
      expect(detail.vintage).toBe(listed.vintage);
      expect(detail.activeInvestments).toBe(listed.activeInvestments);
      expect(detail.lpCommitmentsTotal).toBeNull();
      expect(detail.lpCommitments).toBeNull();
      expect(detail.currency).toBe('USD');
      expect(detail.closingCount).toBe(seeded.closingCount);
      expect(detail.finalCloseDate).toBe(seeded.finalCloseDate);
      expect(detail.calcVersion).toBe('0.1.0');

      const expected = h.dataset.investments.filter((i) => i.vehicleId === id);
      expect(detail.positions.length).toBe(expected.length);
      expect(detail.positions.every((p) => p.vehicleName === detail.name)).toBe(true);
      expect(detail.positions.map((p) => p.investmentNumber)).toEqual(
        expected.map((i) => i.investmentNumber).sort(),
      );
      expect(detail.activeInvestments).toBe(detail.positions.filter((p) => p.isActive).length);

      // Pooled flows reconcile to the positions' own figures.
      expect(detail.metrics.count).toBe(detail.positions.length);
      expect(detail.metrics.invested).not.toBeNull();
      expect(D(detail.metrics.invested!).eq(sumOf(detail.positions.map((p) => p.invested))!)).toBe(
        true,
      );
      expect(D(detail.metrics.nav!).eq(sumOf(detail.positions.map((p) => p.nav))!)).toBe(true);
      expect(detail.metrics.grossMoic).not.toBeNull();

      expect(detail.navSeries.length).toBeGreaterThan(0);
      expect(detail.navSeries.length).toBeLessThanOrEqual(8);
      for (let i = 1; i < detail.navSeries.length; i += 1)
        expect(detail.navSeries[i]!.periodEnd > detail.navSeries[i - 1]!.periodEnd).toBe(true);
      expect(detail.navSeries[detail.navSeries.length - 1]?.periodEnd).toBe(h.dataset.asOf);

      // No client data was opened, so nothing to audit.
      expect(await auditCount('vehicle.read', 'req-vehicle-viewer-1')).toBe(0);
    });

    it('returns LP commitments by entitlement and audits the open (SEC-5.2, SEC-11.1)', async () => {
      const id = secondClosingVehicle();
      const seededRows = h.dataset.lpCommitments.filter((l) => l.vehicleId === id);
      expect(seededRows.length).toBe(3);

      const gamma = clientIdsOf('ir.two');
      expect(gamma.length).toBe(1);
      const ir = await detailFor('ir.two', id, 'req-vehicle-ir-two-1');
      expect(ir.lpCommitments?.length).toBe(1);
      expect(ir.lpCommitments?.[0]?.clientId).toBe(gamma[0]);
      expect(ir.lpCommitments?.[0]?.closingNumber).toBe(2);
      expect(ir.lpCommitments?.[0]?.ownershipPct).not.toBeNull();
      expect(D(ir.lpCommitmentsTotal ?? '0').eq(ir.lpCommitments![0]!.amount)).toBe(true);
      expect(await auditCount('vehicle.read', 'req-vehicle-ir-two-1')).toBe(1);

      const ops = await detailFor('ops.one', id, 'req-vehicle-ops-1');
      expect(ops.lpCommitments?.length).toBe(3);
      const rows = ops.lpCommitments!;
      expectOrdered(rows, (r) => [r.closingNumber, r.clientName]);
      expect(rows.reduce((acc, r) => acc.plus(r.ownershipPct ?? '0'), D('0')).eq(1)).toBe(true);
      expect(D(ops.lpCommitmentsTotal ?? '0').eq(sumOf(rows.map((r) => r.amount))!)).toBe(true);
      expect(new Set(rows.map((r) => r.clientId)).size).toBe(3);
      expect(await auditCount('vehicle.read', 'req-vehicle-ops-1')).toBe(1);

      // ir.one is entitled to two clients: their rows, nobody else's.
      const irOne = await detailFor('ir.one', id);
      expect(irOne.lpCommitments?.map((r) => r.clientId).sort()).toEqual(clientIdsOf('ir.one'));

      // Entitled to a client with no commitment here: an empty list, not null, and no total.
      const elsewhere = vehicleOfType('vehicle_type.co_invest');
      const irElsewhere = await detailFor('ir.two', elsewhere);
      expect(irElsewhere.lpCommitments).toEqual([]);
      expect(irElsewhere.lpCommitmentsTotal).toBeNull();

      // A platform admin is not entitled to client data (SEC-5.4).
      const admin = await detailFor('admin.one', id);
      expect(admin.lpCommitments).toBeNull();
    });

    it('hides the walled position in the separate account from a viewer and shows it to a wall member (SEC-5.3)', async () => {
      const sma = vehicleOfType('vehicle_type.client_sma');
      const viewer = await detailFor('viewer.one', sma);
      const member = await detailFor('deal.three', sma);
      expect(viewer.positions.map((p) => p.id)).not.toContain(walledId());
      expect(member.positions.map((p) => p.id)).toContain(walledId());
      expect(member.positions.length).toBe(viewer.positions.length + 1);
      expect(member.metrics.count).toBe(viewer.metrics.count + 1);
      expect(member.activeInvestments).toBe(viewer.activeInvestments + 1);
      expect(D(member.metrics.nav ?? '0').gt(viewer.metrics.nav ?? '0')).toBe(true);

      // Client-directed fund commitments follow the entitlement; the account's have no flows yet.
      expect(viewer.fundCommitments).toEqual([]);
      const ir = await detailFor('ir.two', sma);
      expect(ir.fundCommitments.length).toBe(3);
      for (const r of ir.fundCommitments) {
        expect(r.vehicleId).toBe(sma);
        expect(r.clientName).not.toBeNull();
        expect(r.called).toBeNull();
        expect(r.distributed).toBeNull();
        expect(r.recallable).toBeNull();
        expect(r.unfunded).toBeNull();
      }
    });

    it('shows the primary program as fund commitments with called, distributed and unfunded, and no pooled figures (G8)', async () => {
      const primary = vehicleOfType('vehicle_type.primary_program');
      const detail = await detailFor('viewer.one', primary);
      expect(detail.positions).toEqual([]);
      expect(detail.metrics.count).toBe(0);
      expect(detail.metrics.invested).toBeNull();
      expect(detail.metrics.nav).toBeNull();
      expect(detail.metrics.grossMoic).toBeNull();
      expect(detail.navSeries).toEqual([]);

      const pooledSeed = h.dataset.commitments.filter(
        (c) => c.vehicleId === primary && c.clientId === null,
      );
      expect(detail.fundCommitments.length).toBe(pooledSeed.length);
      expect(detail.fundCommitments.length).toBe(11);
      for (const r of detail.fundCommitments) {
        expect(r.vehicleId).toBe(primary);
        expect(r.clientName).toBeNull();
        expect(r.commitmentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expectUnfundedIdentity(r);
      }
      expectOrdered(detail.fundCommitments, (r) => [r.sponsorName, r.sponsorFundName]);

      // The equalization scenario books its call and recallable to the program's first commitment,
      // which therefore reads as over-called; the numbers are shown as they are (G6).
      const first = h.dataset.commitments.find((c) => c.vehicleId === primary)!;
      const overCalled = detail.fundCommitments.find((r) => r.id === first.id)!;
      expect(D(overCalled.called!).gt(overCalled.amount)).toBe(true);
      expect(D(overCalled.recallable!).eq('1000000')).toBe(true);
      expect(D(overCalled.unfunded!).lt(0)).toBe(true);
    });
  });

  describe('GET /commitments', () => {
    it('lists pooled rows for everyone and a separate account only to entitled callers', async () => {
      const viewer = await commitmentsFor('viewer.one', 'req-commitments-viewer-1');
      expect(viewer.items.length).toBe(11);
      expect(viewer.items.every((r) => r.clientName === null)).toBe(true);
      expect(viewer.asOf).toBe(h.dataset.asOf);
      expect(viewer.calcVersion).toBe('0.1.0');
      expect(await auditCount('commitment.read', 'req-commitments-viewer-1')).toBe(0);

      const ops = await commitmentsFor('ops.one', 'req-commitments-ops-1');
      expect(ops.items.length).toBe(14);
      const directed = ops.items.filter((r) => r.clientName !== null);
      expect(directed.length).toBe(3);
      expect(new Set(directed.map((r) => r.clientName)).size).toBe(1);
      expect(await auditCount('commitment.read', 'req-commitments-ops-1')).toBe(1);

      const irTwo = await commitmentsFor('ir.two');
      expect(irTwo.items.map((r) => r.id).sort()).toEqual(ops.items.map((r) => r.id).sort());
      const irOne = await commitmentsFor('ir.one');
      expect(irOne.items.length).toBe(11);

      // One sponsor fund is held both through the program and the separate account.
      const shared = h.dataset.scenarios.two_clients_one_fund![0]!;
      expect(ops.items.filter((r) => r.sponsorFundId === shared).length).toBe(2);
      expect(viewer.items.filter((r) => r.sponsorFundId === shared).length).toBe(1);
    });

    it('computes called, distributed and unfunded from approved flows and totals the calculable rows', async () => {
      const ops = await commitmentsFor('ops.one');
      for (const r of ops.items) {
        expect(r.vintage === null || Number.isInteger(r.vintage)).toBe(true);
        if (r.clientName === null) expectUnfundedIdentity(r);
        else expect(r.called).toBeNull();
      }
      expect(ops.totals.amount).toBe(sumOf(ops.items.map((r) => r.amount)));
      expect(ops.totals.called).toBe(sumOf(ops.items.map((r) => r.called)));
      expect(ops.totals.distributed).toBe(sumOf(ops.items.map((r) => r.distributed)));
      expect(ops.totals.unfunded).toBe(sumOf(ops.items.map((r) => r.unfunded)));

      const viewer = await commitmentsFor('viewer.one');
      expect(D(viewer.totals.amount!).eq('310000000')).toBe(true);
      expect(D(ops.totals.amount!).eq('338000000')).toBe(true);
      expect(viewer.totals.called).toBe(ops.totals.called);

      // Ordered by vehicle, sponsor, fund and client name (pooled rows ahead of client-directed).
      expectOrdered(ops.items, (r) => [
        r.vehicleName,
        r.sponsorName,
        r.sponsorFundName,
        r.clientName,
      ]);
    });

    it('reports a commitment with no approved flow by the as-of date as not calculable, never zero', async () => {
      // Before the primary program's first call: the amounts show, the flow figures do not.
      const early = commitmentList.parse(
        (
          await h
            .http()
            .get('/api/v1/commitments?asOf=2013-12-31')
            .set('authorization', h.as('ops.one'))
            .expect(200)
        ).body,
      );
      expect(early.items.length).toBe(14);
      for (const r of early.items) {
        expect(r.called).toBeNull();
        expect(r.distributed).toBeNull();
        expect(r.recallable).toBeNull();
        expect(r.unfunded).toBeNull();
      }
      expect(D(early.totals.amount!).eq('338000000')).toBe(true);
      expect(early.totals.called).toBeNull();
      expect(early.totals.unfunded).toBeNull();
    });
  });

  describe('GET /clients', () => {
    it('gives callers without client data an empty list, not 403, and audits without values', async () => {
      const viewer = await clientsFor('viewer.one', 'req-clients-viewer-1');
      expect(viewer.items).toEqual([]);
      expect(viewer.asOf).toBe(h.dataset.asOf);
      expect((await clientsFor('deal.three')).items).toEqual([]);
      expect((await clientsFor('admin.one')).items).toEqual([]);
      const audit = await h.runtime.db.query<{ n: number; details: string }>(
        "select count(*)::int as n, min(details::text) as details from audit.event where action = 'client.read' and request_id = 'req-clients-viewer-1'",
      );
      expect(audit[0]?.n).toBe(1);
      expect(audit[0]?.details).toBe('{}');
    });

    it('shows investor relations users their entitled clients only (SEC-5.2)', async () => {
      const irOne = await clientsFor('ir.one');
      expect(irOne.items.map((c) => c.id).sort()).toEqual(clientIdsOf('ir.one'));
      expect(irOne.items.map((c) => c.name)).toEqual([...irOne.items.map((c) => c.name)].sort());
      const irTwo = await clientsFor('ir.two');
      expect(irTwo.items.map((c) => c.id)).toEqual(clientIdsOf('ir.two'));
      for (const c of [...irOne.items, ...irTwo.items]) {
        const seeded = h.dataset.lpCommitments.filter((l) => l.clientId === c.id);
        expect(c.vehicles.length).toBe(seeded.length);
        expect(c.reportingBases.length).toBeGreaterThan(0);
        const names = c.vehicles.map((v) => v.vehicleName);
        expect(names).toEqual([...names].sort());
        expect(D(c.totals.commitment!).eq(sumOf(c.vehicles.map((v) => v.commitment))!)).toBe(true);
      }
      // The separate account is wholly the client's: its share is the account's pooled NAV.
      const sma = vehicleOfType('vehicle_type.client_sma');
      const share = irTwo.items[0]!.vehicles.find((v) => v.vehicleId === sma)!;
      const account = await detailFor('ir.two', sma);
      expect(D(share.ownershipPct!).eq(1)).toBe(true);
      expect(share.nav).toBe(account.metrics.nav);
      expect(share.invested).toBe(account.metrics.invested);
      expect(share.grossMoic).toBe(account.metrics.grossMoic);
    });

    it('computes every share as the vehicle position times ownership, pooled once per vehicle', async () => {
      const ops = await clientsFor('ops.one', 'req-clients-ops-1');
      expect(ops.items.length).toBe(3);
      expect(ops.calcVersion).toBe('0.1.0');
      expect(await auditCount('client.read', 'req-clients-ops-1')).toBe(1);

      const fund = vehicleOfType('vehicle_type.co_invest');
      const vehicle = await detailFor('ops.one', fund);
      expect(vehicle.metrics.nav).not.toBeNull();
      const shares = ops.items
        .map((c) => c.vehicles.find((v) => v.vehicleId === fund))
        .filter((v) => v !== undefined);
      expect(shares.length).toBe(2);
      expect(shares.some((v) => D(v.ownershipPct!).eq('0.6'))).toBe(true);
      for (const v of shares) {
        const pct = D(v.ownershipPct!);
        expect(D(v.nav!).eq(D(vehicle.metrics.nav!).times(pct))).toBe(true);
        expect(D(v.invested!).eq(D(vehicle.metrics.invested!).times(pct))).toBe(true);
        expect(D(v.distributions!).eq(D(vehicle.metrics.distributions!).times(pct))).toBe(true);
        expect(D(v.grossMoic!).minus(vehicle.metrics.grossMoic!).abs().lte('1e-9')).toBe(true);
      }
      expect(shares.reduce((acc, v) => acc.plus(v.nav!), D('0')).eq(vehicle.metrics.nav!)).toBe(
        true,
      );

      // The primary program holds commitments, not positions: its share is not calculable (G8).
      const primary = vehicleOfType('vehicle_type.primary_program');
      for (const c of ops.items) {
        const p = c.vehicles.find((v) => v.vehicleId === primary);
        if (p === undefined) continue;
        expect(D(p.commitment).gt(0)).toBe(true);
        expect(p.invested).toBeNull();
        expect(p.nav).toBeNull();
        expect(p.grossMoic).toBeNull();
      }

      // Totals sum the calculable shares and derive the MOIC from them.
      for (const c of ops.items) {
        expect(c.totals.invested).toBe(sumOf(c.vehicles.map((v) => v.invested)));
        expect(c.totals.nav).toBe(sumOf(c.vehicles.map((v) => v.nav)));
        expect(c.totals.distributions).toBe(sumOf(c.vehicles.map((v) => v.distributions)));
        const expectedMoic = D(c.totals.distributions!).plus(c.totals.nav!).div(c.totals.invested!);
        expect(D(c.totals.grossMoic!).minus(expectedMoic).abs().lte('1e-9')).toBe(true);
      }
    });
  });
});
