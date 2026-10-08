import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@pb/calc';
import { investmentPerformance } from '@pb/contracts';
import type { InvestmentPerformance } from '@pb/contracts';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

/** A rendered decimal string against a full-precision expectation (the API renders 10 decimals). */
const close = (rendered: string, expected: ReturnType<typeof D>): boolean =>
  D(rendered).minus(expected).abs().lt('1e-9');

describe('investment performance (M9): GET /api/v1/investments/{id}/performance', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const idOf = (investmentNumber: string): string => {
    const inv = h.dataset.investments.find((i) => i.investmentNumber === investmentNumber);
    if (inv === undefined) throw new Error(`no investment ${investmentNumber}`);
    return inv.id;
  };
  const performanceFor = async (
    who: string,
    id: string,
    requestId = 'req-performance',
    asOf = h.dataset.asOf,
  ): Promise<InvestmentPerformance> =>
    investmentPerformance.parse(
      (
        await h
          .http()
          .get(`/api/v1/investments/${id}/performance?asOf=${asOf}`)
          .set('authorization', h.as(who))
          .set('x-request-id', requestId)
          .expect(200)
      ).body,
    );

  it('returns every quarter with ratios and null year-on-year growth where the prior year is missing', async () => {
    const id = h.dataset.scenarios.missing_prior_year![0]!;
    expect(id).toBe(idOf('INV-0001'));
    const p = await performanceFor('viewer.one', id, 'req-performance-0001');
    expect(p.investmentId).toBe(id);
    expect(p.asOf).toBe(h.dataset.asOf);
    expect(p.calcVersion).toBe('0.1.0');

    const seeded = h.dataset.quarterlyPerformance.filter((q) => q.investmentId === id);
    expect(p.quarters.length).toBe(seeded.filter((q) => !q.isEntrySnapshot).length);
    expect(p.quarters.every((q) => !q.isEntrySnapshot)).toBe(true);
    expect(p.quarters.every((q) => q.status === 'record_status.approved')).toBe(true);
    const ends = p.quarters.map((q) => q.periodEnd);
    expect(ends).toEqual([...ends].sort());
    expect(ends).not.toContain('2024-06-30');

    // 2025-06-30 has no 2024-06-30 twin, so year-on-year is not calculable; 2025-03-31 has one.
    const latest = p.quarters.find((q) => q.periodEnd === '2025-06-30')!;
    expect(latest.revenueYoy).toBeNull();
    expect(latest.ebitdaYoy).toBeNull();
    expect(latest.evToEbitda).not.toBeNull();
    expect(latest.netDebtToEbitda).not.toBeNull();
    expect(latest.ebitdaMargin).not.toBeNull();
    expect(latest.highlights.length).toBe(3);
    const q1 = p.quarters.find((q) => q.periodEnd === '2025-03-31')!;
    const prior = seeded.find((q) => q.periodEnd === '2024-03-31')!;
    expect(q1.revenueYoy).not.toBeNull();
    expect(
      D(q1.revenueYoy!)
        .minus(D(q1.revenueLtm!).div(prior.revenueLtm!).minus(1))
        .abs()
        .lt('0.0000000001'),
    ).toBe(true);
    expect(close(latest.evToEbitda!, D(latest.ev!).div(latest.ebitdaLtm!))).toBe(true);
    expect(close(latest.netDebtToEbitda!, D(latest.netDebt!).div(latest.ebitdaLtm!))).toBe(true);
    expect(close(latest.ebitdaMargin!, D(latest.ebitdaLtm!).div(latest.revenueLtm!))).toBe(true);

    // The entry snapshot is separate, with no year-on-year columns and no highlights.
    const snapshot = seeded.find((q) => q.isEntrySnapshot)!;
    expect(p.entry).not.toBeNull();
    expect(p.entry!.periodEnd).toBe(snapshot.periodEnd);
    expect(p.entry!.isEntrySnapshot).toBe(true);
    expect(p.entry!.revenueYoy).toBeNull();
    expect(p.entry!.ebitdaYoy).toBeNull();
    expect(p.entry!.highlights).toEqual([]);
    expect(p.entry!.evToEbitda).not.toBeNull();

    // Since entry: the latest approved quarter against the snapshot.
    expect(p.sinceEntry).not.toBeNull();
    expect(p.sinceEntry!.periodEnd).toBe('2025-06-30');
    expect(p.sinceEntry!.evToEbitdaAtEntry).toBe(p.entry!.evToEbitda);
    expect(p.sinceEntry!.netDebtToEbitdaAtEntry).toBe(p.entry!.netDebtToEbitda);
    expect(
      close(p.sinceEntry!.revenueGrowth!, D(latest.revenueLtm!).div(snapshot.revenueLtm!).minus(1)),
    ).toBe(true);
    expect(
      close(p.sinceEntry!.ebitdaGrowth!, D(latest.ebitdaLtm!).div(snapshot.ebitdaLtm!).minus(1)),
    ).toBe(true);
    expect(
      close(p.sinceEntry!.multipleDelta!, D(latest.evToEbitda!).minus(p.entry!.evToEbitda!)),
    ).toBe(true);

    // An equity position has no credit block; this one has no realization outlook.
    expect(p.credit).toBeNull();
    expect(p.realizationOutlook).toBeNull();

    const audit = await h.runtime.db.query<{ n: number }>(
      `select count(*)::int as n from audit.event where action = 'investment.performance.read' and entity_id = '${id}' and request_id = 'req-performance-0001'`,
    );
    expect(audit[0]?.n).toBe(1);
  });

  it('shows null multiples on negative EBITDA, never a misleading number', async () => {
    const id = h.dataset.scenarios.negative_ebitda![0]!;
    expect(id).toBe(idOf('INV-0004'));
    const p = await performanceFor('operations', id);
    const latest = p.quarters[p.quarters.length - 1]!;
    expect(latest.periodEnd).toBe('2025-06-30');
    expect(D(latest.ebitdaLtm!).lt(0)).toBe(true);
    expect(latest.evToEbitda).toBeNull();
    expect(latest.netDebtToEbitda).toBeNull();
    // Margin stays calculable (revenue is positive) and is negative.
    expect(latest.ebitdaMargin).not.toBeNull();
    expect(D(latest.ebitdaMargin!).lt(0)).toBe(true);
    expect(p.sinceEntry).not.toBeNull();
    expect(p.sinceEntry!.multipleDelta).toBeNull();
    expect(p.sinceEntry!.evToEbitdaAtEntry).not.toBeNull();
    expect(p.sinceEntry!.ebitdaGrowth).not.toBeNull();
    expect(D(p.sinceEntry!.ebitdaGrowth!).lt(-1)).toBe(true);
    // Earlier quarters with positive EBITDA keep their multiples.
    expect(p.quarters[0]!.evToEbitda).not.toBeNull();
  });

  it('returns a forward-dated entry snapshot as entry but no since-entry comparison', async () => {
    const id = h.dataset.scenarios.forward_entry_snapshot![0]!;
    expect(id).toBe(idOf('INV-0003'));
    const p = await performanceFor('viewer.one', id);
    expect(p.entry).not.toBeNull();
    expect(p.entry!.periodEnd).toBe('2025-12-31');
    expect(p.entry!.periodEnd > p.asOf).toBe(true);
    expect(p.quarters.map((q) => q.periodEnd)).not.toContain('2025-12-31');
    expect(p.quarters.length).toBe(8);
    // The snapshot is not a basis for a comparison as of an earlier date.
    expect(p.sinceEntry).toBeNull();
    // As of a date after the snapshot the comparison becomes calculable again.
    const later = await performanceFor('viewer.one', id, 'req-performance-later', '2026-03-31');
    expect(later.sinceEntry).not.toBeNull();
    expect(later.sinceEntry!.periodEnd).toBe('2025-06-30');
  });

  it('returns credit terms, schedules, yields and the credit series for a credit position', async () => {
    const id = idOf('INV-0009');
    expect(h.dataset.scenarios.credit_amortization).toContain(id);
    const p = await performanceFor('viewer.one', id);
    // No operating series on a credit position.
    expect(p.entry).toBeNull();
    expect(p.quarters).toEqual([]);
    expect(p.sinceEntry).toBeNull();

    expect(p.credit).not.toBeNull();
    const terms = p.credit!.terms;
    const seeded = h.dataset.creditTerms.find((t) => t.investmentId === id)!;
    expect(terms.facilityType).toBe(seeded.facilityType);
    expect(terms.seniorityRank).toBe(seeded.seniorityRank);
    expect(terms.baseRate).toBe('base_rate.sofr');
    expect(terms.maturityDate).toBe(seeded.maturityDate);
    expect(terms.paymentFrequency).toBe('quarterly');
    expect(terms.effectiveDate).toBe(seeded.effectiveDate);
    expect(D(terms.spread).eq(seeded.spread)).toBe(true);
    expect(D(terms.cashCoupon).eq(seeded.cashCoupon)).toBe(true);
    expect(D(terms.pikCoupon).eq(seeded.pikCoupon)).toBe(true);
    expect(D(terms.floor!).eq(seeded.floor!)).toBe(true);
    expect(D(terms.oid!).eq(seeded.oid)).toBe(true);
    expect(D(terms.upfrontFee!).eq(seeded.upfrontFee)).toBe(true);
    expect(D(terms.commitmentAmount!).eq(seeded.commitmentAmount)).toBe(true);
    expect(terms.amortization.length).toBe(3);
    expect(terms.amortization).toEqual(seeded.amortization);
    expect(terms.callProtection).toEqual(seeded.callProtection);
    expect(terms.covenants).toEqual(seeded.covenants);
    expect(terms.covenants.map((c) => c.level)).toEqual(['2.00', '6.00']);
    // No base rate in config, so the all-in coupon is not calculable; never an assumed rate.
    expect(terms.allInCoupon).toBeNull();
    expect(terms.pastMaturity).toBe(false);
    expect(terms.yieldToMaturity).not.toBeNull();
    const ytm = D(terms.yieldToMaturity!);
    // A facility bought near par with a 11.41% cash coupon and 3% PIK yields in that range.
    expect(ytm.gt('0.05') && ytm.lt('0.30')).toBe(true);

    const quarters = p.credit!.quarters;
    const seededRows = h.dataset.creditPerformance.filter((r) => r.investmentId === id);
    expect(quarters.length).toBe(seededRows.length);
    expect(quarters.map((q) => q.periodEnd)).toEqual(seededRows.map((r) => r.periodEnd).sort());
    const latest = quarters[quarters.length - 1]!;
    expect(latest.periodEnd).toBe('2025-06-30');
    expect(latest.parValue).not.toBeNull();
    expect(latest.fairValue).not.toBeNull();
    expect(
      close(
        latest.currentYield!,
        D(terms.cashCoupon).times(latest.parValue!).div(latest.fairValue!),
      ),
    ).toBe(true);
    const seededLatest = seededRows.find((r) => r.periodEnd === latest.periodEnd)!;
    expect(
      close(
        latest.interestCoverage!,
        D(seededLatest.ebitdaLtm!).div(seededLatest.cashInterestExpenseLtm!),
      ),
    ).toBe(true);
    expect(
      close(latest.loanToValue!, D(seededLatest.netDebtThroughTranche!).div(seededLatest.ev!)),
    ).toBe(true);
    expect(latest.interestCoverage).not.toBeNull();
    expect(latest.leverageThroughTranche).not.toBeNull();
    expect(latest.loanToValue).not.toBeNull();
    expect(latest.covenantStatus).toBe('covenant_status.compliant');
    expect(latest.paymentStatus).toBe('payment_status.current');
    expect(latest.principalRepaidLtm).not.toBeNull();
    expect(D(latest.principalRepaidLtm!).gt(0)).toBe(true);
    expect(p.realizationOutlook).toBeNull();
  });

  it('marks a facility past maturity and leaves its yield to maturity not calculable', async () => {
    const id = idOf('INV-0013');
    expect(h.dataset.scenarios.covenant_breach).toContain(id);
    const p = await performanceFor('viewer.one', id);
    expect(p.credit).not.toBeNull();
    expect(p.credit!.terms.maturityDate < p.asOf).toBe(true);
    expect(p.credit!.terms.pastMaturity).toBe(true);
    expect(p.credit!.terms.yieldToMaturity).toBeNull();
    expect(p.credit!.terms.amortization).toEqual([]);
    expect(p.credit!.terms.callProtection).toEqual([]);
    const statuses = p.credit!.quarters.map((q) => q.covenantStatus);
    expect(statuses[statuses.length - 2]).toBe('covenant_status.breach');
    expect(statuses[statuses.length - 1]).toBe('covenant_status.waiver');
    // Yields on each row still compute from that row's figures.
    expect(p.credit!.quarters.every((q) => q.currentYield !== null)).toBe(true);
    // As of a date before maturity the yield is calculable.
    const before = await performanceFor('viewer.one', id, 'req-performance-before', '2024-06-30');
    expect(before.credit!.terms.pastMaturity).toBe(false);
    expect(before.credit!.terms.yieldToMaturity).not.toBeNull();
  });

  it('returns the realization outlook when one is set, never an invented one', async () => {
    const p = await performanceFor('viewer.one', idOf('INV-0011'));
    expect(p.realizationOutlook).toEqual({
      horizonMonths: 18,
      outlook: 'realization_outlook.full',
      note: 'Sponsor has engaged advisors.',
      setAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string,
    });
    const none = await performanceFor('viewer.one', idOf('INV-0014'));
    expect(none.realizationOutlook).toBeNull();
  });

  it('returns 404, never 403, for a walled, unknown or malformed id and audits a member open', async () => {
    const walledId = h.dataset.scenarios.walled_deal![0]!;
    expect(walledId).toBe(idOf('INV-0010'));
    await h
      .http()
      .get(`/api/v1/investments/${walledId}/performance`)
      .set('authorization', h.as('viewer.one'))
      .expect(404);
    await h
      .http()
      .get('/api/v1/investments/00000000-0000-4000-8000-000000000000/performance')
      .set('authorization', h.as('viewer.one'))
      .expect(404);
    await h
      .http()
      .get('/api/v1/investments/not-a-uuid/performance')
      .set('authorization', h.as('viewer.one'))
      .expect(404);
    await h.http().get(`/api/v1/investments/${walledId}/performance`).expect(401);
    const member = await performanceFor('deal.three', walledId, 'req-performance-walled');
    expect(member.investmentId).toBe(walledId);
    expect(member.quarters.length).toBeGreaterThan(0);
    const audit = await h.runtime.db.query<{ n: number }>(
      `select count(*)::int as n from audit.event where action = 'investment.performance.read' and entity_id = '${walledId}'`,
    );
    expect(audit[0]?.n).toBe(1);
    const viewerAudit = await h.runtime.db.query<{ n: number }>(
      `select count(*)::int as n from audit.event where action = 'investment.performance.read' and request_id = 'req-performance-walled'`,
    );
    expect(viewerAudit[0]?.n).toBe(1);
  });

  it('defaults the as-of date to the clock, rejects unknown query keys and is byte-stable', async () => {
    const id = idOf('INV-0001');
    const res = await h
      .http()
      .get(`/api/v1/investments/${id}/performance`)
      .set('authorization', h.as('viewer'))
      .expect(200);
    expect(investmentPerformance.parse(res.body).asOf).toBe(h.dataset.asOf);
    await h
      .http()
      .get(`/api/v1/investments/${id}/performance?junk=1`)
      .set('authorization', h.as('viewer'))
      .expect(400);
    const again = await h
      .http()
      .get(`/api/v1/investments/${id}/performance`)
      .set('authorization', h.as('viewer'))
      .expect(200);
    expect(JSON.stringify(again.body)).toBe(JSON.stringify(res.body));
  });
});
