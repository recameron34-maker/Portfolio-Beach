import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@pb/calc';
import { commitmentList, sponsorDetail, vehicleDetail } from '@pb/contracts';
import type { SponsorDetail } from '@pb/contracts';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';
import { NOTHING_POOLED } from './pools.js';

/** Decimal to the contract's decimal string, the same rendering the API uses. */
const str = (d: ReturnType<typeof D>): string => d.toFixed(10).replace(/\.?0+$/, '');

describe('sponsor 360 (M6): GET /api/v1/sponsors/{id}', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const sponsorNamed = (name: string): Harness['dataset']['sponsors'][number] => {
    const s = h.dataset.sponsors.find((x) => x.name === name);
    if (s === undefined) throw new Error(`no sponsor ${name}`);
    return s;
  };
  const fundsOf = (sponsorId: string): Harness['dataset']['sponsorFunds'] =>
    h.dataset.sponsorFunds.filter((f) => f.sponsorId === sponsorId);
  /** Commitment rows the seed holds for a sponsor's funds, as the caller would see them. */
  const commitmentsVisibleTo = (
    who: string,
    sponsorId: string,
  ): Harness['dataset']['commitments'] => {
    const user = h.dataset.users.find((u) => u.externalId === who)!;
    const seesAll = user.roles.some((r) => ['operations', 'approver', 'auditor'].includes(r));
    const fundIds = new Set(fundsOf(sponsorId).map((f) => f.id));
    return h.dataset.commitments.filter(
      (c) =>
        fundIds.has(c.sponsorFundId) &&
        (c.clientId === null || seesAll || user.clientIds.includes(c.clientId)),
    );
  };
  const detailFor = async (
    who: string,
    id: string,
    requestId = 'req-sponsor-detail',
    asOf = h.dataset.asOf,
  ): Promise<SponsorDetail> =>
    sponsorDetail.parse(
      (
        await h
          .http()
          .get(`/api/v1/sponsors/${id}?asOf=${asOf}`)
          .set('authorization', h.as(who))
          .set('x-request-id', requestId)
          .expect(200)
      ).body,
    );

  it('returns the sponsor with its funds, aliases, positions, commitments and pooled metrics', async () => {
    const kelpwood = sponsorNamed('Kelpwood Capital Partners');
    const d = await detailFor('deal.three', kelpwood.id, 'req-sponsor-kelpwood-1');
    expect(d.id).toBe(kelpwood.id);
    expect(d.name).toBe(kelpwood.name);
    expect(d.tier).toBe(kelpwood.tier);
    expect(d.hqGeography).toBe(kelpwood.hqGeography);
    expect(d.description).toBe(kelpwood.description);
    expect(d.calcVersion).toBe('0.1.0');

    // Positions: every investment with the sponsor, ordered by investment number, with metrics.
    const expectedNumbers = h.dataset.investments
      .filter((i) => i.sponsorId === kelpwood.id)
      .map((i) => i.investmentNumber)
      .sort();
    expect(d.positions.length).toBe(7);
    expect(d.positions.map((p) => p.investmentNumber)).toEqual(expectedNumbers);
    expect(d.positions.every((p) => p.sponsorName === kelpwood.name)).toBe(true);
    expect(d.positions.filter((p) => p.invested !== null).length).toBe(7);
    expect(d.activeInvestments).toBe(
      h.dataset.investments.filter((i) => i.sponsorId === kelpwood.id && i.isActive).length,
    );

    // Funds by vintage then name, with aliases, holdings and our position counts.
    expect(d.fundCount).toBe(2);
    expect(d.funds.map((f) => f.name)).toEqual(['Kelpwood Fund I', 'Kelpwood Fund III']);
    expect(d.funds.map((f) => f.vintage)).toEqual([2015, 2018]);
    expect(d.funds.map((f) => f.aliases)).toEqual([['KF I'], ['KF III']]);
    expect(d.funds.reduce((n, f) => n + f.ourPositions, 0)).toBe(7);
    for (const f of d.funds) {
      expect(f.holdings).toBe(
        h.dataset.fundHoldings.filter((x) => x.sponsorFundId === f.id).length,
      );
      expect(f.ourPositions).toBe(
        h.dataset.investments.filter((i) => i.sponsorFundId === f.id).length,
      );
      expect(f.currency).toBe('USD');
      expect(f.strategy).toMatch(/^strategy\./);
    }

    // Commitments: the two pooled primary-program commitments, called from approved flows to asOf.
    const seeded = commitmentsVisibleTo('deal.three', kelpwood.id);
    expect(seeded.length).toBe(2);
    expect(d.commitments.length).toBe(2);
    expect(d.commitments.map((c) => c.sponsorFundName)).toEqual([
      'Kelpwood Fund I',
      'Kelpwood Fund III',
    ]);
    for (const c of d.commitments) {
      const row = seeded.find((x) => x.id === c.id)!;
      expect(c.amount).toBe(row.amount);
      expect(c.commitmentDate).toBe(row.commitmentDate);
      expect(c.sponsorId).toBe(kelpwood.id);
      expect(c.sponsorName).toBe(kelpwood.name);
      expect(c.vehicleName).toBe('Beach Primary Program');
      expect(c.vehicleType).toBe('vehicle_type.primary_program');
      expect(c.clientName).toBeNull();
      const flows = h.dataset.cashFlows.filter(
        (f) =>
          f.commitmentId === c.id &&
          f.status === 'record_status.approved' &&
          f.flowDate <= h.dataset.asOf,
      );
      const sum = (types: string[]): string =>
        str(
          flows
            .filter((f) => types.includes(f.flowType))
            .reduce((acc, f) => acc.plus(D(f.amount).abs()), D('0')),
        );
      expect(c.called).toBe(sum(['flow_type.contribution']));
      expect(c.distributed).toBe(
        sum([
          'flow_type.distribution',
          'flow_type.interest',
          'flow_type.principal',
          'flow_type.recallable',
        ]),
      );
      expect(c.recallable).toBe(sum(['flow_type.recallable']));
      expect(c.unfunded).toBe(str(D(c.amount).minus(c.called!).plus(c.recallable!)));
      expect(D(c.called!).gt(0)).toBe(true);
    }
    expect(d.funds.map((f) => f.ourCommitment)).toEqual(['25000000', '22000000']);
    expect(d.totalCommitted).toBe('47000000');

    // Pooled metrics over the seven positions.
    expect(d.metrics.count).toBe(7);
    expect(d.metrics.invested).not.toBeNull();
    expect(
      D(d.metrics.invested!).eq(
        d.positions.reduce((acc, p) => acc.plus(p.invested ?? '0'), D('0')),
      ),
    ).toBe(true);
    expect(d.metrics.nav).not.toBeNull();
    expect(d.metrics.grossMoic).not.toBeNull();

    // The open is an audited sensitive read (tier and description are Restricted).
    const audit = await h.runtime.db.query<{ n: number }>(
      `select count(*)::int as n from audit.event where action = 'sponsor.read' and entity_id = '${kelpwood.id}' and request_id = 'req-sponsor-kelpwood-1'`,
    );
    expect(audit[0]?.n).toBe(1);
  });

  it('is byte-stable across calls (the preview records responses)', async () => {
    const kelpwood = sponsorNamed('Kelpwood Capital Partners');
    const get = async (): Promise<string> =>
      JSON.stringify(
        (
          await h
            .http()
            .get(`/api/v1/sponsors/${kelpwood.id}?asOf=${h.dataset.asOf}`)
            .set('authorization', h.as('viewer'))
            .expect(200)
        ).body,
      );
    expect(await get()).toBe(await get());
  });

  it('shows a sponsor with commitments but no positions without inventing a figure', async () => {
    const dunecrest = sponsorNamed('Dunecrest Private Equity');
    const d = await detailFor('viewer.one', dunecrest.id);
    expect(d.positions).toEqual([]);
    expect(d.activeInvestments).toBe(0);
    expect(d.fundCount).toBe(2);
    expect(d.funds.map((f) => f.name)).toEqual(['Dunecrest Growth Fund I', 'Dunecrest Fund IV']);
    expect(d.funds.map((f) => f.vintage)).toEqual([2012, 2015]);
    expect(d.funds.every((f) => f.ourPositions === 0)).toBe(true);
    // The seed commits to Dunecrest Fund IV only; the other fund carries no commitment, so null.
    const seeded = commitmentsVisibleTo('viewer.one', dunecrest.id);
    expect(d.commitments.length).toBe(seeded.length);
    expect(d.commitments.map((c) => c.id).sort()).toEqual(seeded.map((c) => c.id).sort());
    expect(d.funds.find((f) => f.name === 'Dunecrest Growth Fund I')?.ourCommitment).toBeNull();
    expect(d.funds.find((f) => f.name === 'Dunecrest Fund IV')?.ourCommitment).toBe('17000000');
    expect(d.funds.find((f) => f.name === 'Dunecrest Fund IV')?.aliases).toEqual(['DF IV']);
    expect(d.totalCommitted).toBe(str(seeded.reduce((acc, c) => acc.plus(c.amount), D('0'))));
    // Nothing to pool: every figure is null, NAV included, never 0 (docs/06 section 3).
    expect(d.metrics).toEqual(NOTHING_POOLED);
  });

  it('answers a sponsor without positions exactly as a vehicle without positions', async () => {
    const dunecrest = sponsorNamed('Dunecrest Private Equity');
    const primary = h.dataset.vehicles.find(
      (v) => v.vehicleType === 'vehicle_type.primary_program',
    );
    const vehicle = vehicleDetail.parse(
      (
        await h
          .http()
          .get(`/api/v1/vehicles/${primary!.id}?asOf=${h.dataset.asOf}`)
          .set('authorization', h.as('viewer.one'))
          .expect(200)
      ).body,
    );
    const sponsor = await detailFor('viewer.one', dunecrest.id, 'req-sponsor-empty-pool');
    expect(vehicle.positions).toEqual([]);
    expect(sponsor.metrics).toEqual(vehicle.metrics);
    expect(sponsor.metrics).toEqual(NOTHING_POOLED);
  });

  it('returns 404, never 403, for an unknown or malformed id', async () => {
    await h
      .http()
      .get('/api/v1/sponsors/00000000-0000-4000-8000-000000000000')
      .set('authorization', h.as('operations'))
      .expect(404);
    await h
      .http()
      .get('/api/v1/sponsors/not-a-uuid')
      .set('authorization', h.as('operations'))
      .expect(404);
    await h.http().get('/api/v1/sponsors/00000000-0000-4000-8000-000000000000').expect(401);
  });

  it('hides the walled position from a viewer and shows it to a wall member (SEC-5.3)', async () => {
    const stormglass = sponsorNamed('Stormglass Partners');
    const walledId = h.dataset.scenarios.walled_deal![0]!;
    expect(h.dataset.investments.find((i) => i.id === walledId)?.sponsorId).toBe(stormglass.id);

    const viewer = await detailFor('viewer.one', stormglass.id);
    const member = await detailFor('deal.three', stormglass.id);
    expect(viewer.positions.map((p) => p.id)).not.toContain(walledId);
    expect(member.positions.map((p) => p.id)).toContain(walledId);
    expect(viewer.positions.length).toBe(2);
    expect(member.positions.length).toBe(3);
    expect(viewer.activeInvestments).toBe(2);
    expect(member.activeInvestments).toBe(3);
    expect(viewer.funds[0]!.ourPositions).toBe(2);
    expect(member.funds[0]!.ourPositions).toBe(3);
    expect(viewer.metrics.count).toBe(2);
    expect(member.metrics.count).toBe(3);
    expect(D(member.metrics.invested!).gt(viewer.metrics.invested!)).toBe(true);
  });

  it('shows separate-account commitments only to roles entitled to the client (SEC-5.2)', async () => {
    const skerry = sponsorNamed('Skerry Partners');
    const viewer = await detailFor('viewer.one', skerry.id);
    const ops = await detailFor('ops.one', skerry.id);
    const gamma = await detailFor('ir.two', skerry.id);
    const alphaBeta = await detailFor('ir.one', skerry.id);

    expect(viewer.commitments.length).toBe(2);
    expect(viewer.commitments.every((c) => c.clientName === null)).toBe(true);
    expect(alphaBeta.commitments.length).toBe(2);
    expect(ops.commitments.length).toBe(4);
    expect(gamma.commitments.length).toBe(4);
    const sma = gamma.commitments.filter((c) => c.clientName !== null);
    expect(sma.length).toBe(2);
    expect(sma.every((c) => c.clientName === 'Client Gamma Insurance')).toBe(true);
    expect(sma.every((c) => c.vehicleType === 'vehicle_type.client_sma')).toBe(true);
    // The separate-account commitments have no cash flows yet: not calculable, never zero.
    for (const c of sma) {
      expect(c.called).toBeNull();
      expect(c.distributed).toBeNull();
      expect(c.recallable).toBeNull();
      expect(c.unfunded).toBeNull();
    }
    // The shared commitment loader's order: vehicle, sponsor, fund and client name, then id.
    expect(gamma.commitments.map((c) => [c.vehicleName, c.sponsorFundName])).toEqual([
      ['Beach Primary Program', 'Skerry Fund I'],
      ['Beach Primary Program', 'Skerry Growth Fund II'],
      ['Client Gamma Separate Account', 'Skerry Fund I'],
      ['Client Gamma Separate Account', 'Skerry Growth Fund II'],
    ]);
    // One loader: the sponsor's rows are exactly the commitments board rows for its funds.
    const board = commitmentList.parse(
      (
        await h
          .http()
          .get(`/api/v1/commitments?asOf=${h.dataset.asOf}`)
          .set('authorization', h.as('ir.two'))
          .expect(200)
      ).body,
    );
    expect(gamma.commitments).toEqual(board.items.filter((c) => c.sponsorId === skerry.id));
    // Totals follow the caller's view.
    expect(viewer.totalCommitted).toBe('71000000');
    expect(gamma.totalCommitted).toBe('93000000');
    expect(viewer.funds.map((f) => f.ourCommitment)).toEqual(['42000000', '29000000']);
    expect(gamma.funds.map((f) => f.ourCommitment)).toEqual(['50000000', '43000000']);
    // Everything else about the sponsor is the same for both.
    expect(viewer.positions).toEqual(gamma.positions);
    expect(viewer.metrics).toEqual(gamma.metrics);
  });

  it('respects the as-of date for metrics and commitment flows', async () => {
    const kelpwood = sponsorNamed('Kelpwood Capital Partners');
    // Before the primary program's first call (2014 vintage) and before every Kelpwood entry date.
    const early = await detailFor('viewer.one', kelpwood.id, 'req-sponsor-early', '2013-12-31');
    expect(early.positions.length).toBe(7);
    expect(early.positions.every((p) => p.invested === null && p.nav === null)).toBe(true);
    expect(early.metrics.invested).toBeNull();
    expect(early.metrics.nav).toBeNull();
    expect(early.metrics.grossIrr).toBeNull();
    expect(early.metrics.irrFlag).toBe('insufficient_flows');
    // Nothing called yet: not calculable rather than zero; the commitment amounts still show.
    expect(early.commitments.length).toBe(2);
    expect(early.commitments.every((c) => c.called === null && c.unfunded === null)).toBe(true);
    expect(early.totalCommitted).toBe('47000000');
    // At the as-of date the same commitments carry calls.
    const now = await detailFor('viewer.one', kelpwood.id, 'req-sponsor-now');
    expect(now.commitments.every((c) => c.called !== null)).toBe(true);
  });
});
