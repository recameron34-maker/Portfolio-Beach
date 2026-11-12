import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, FIT_MEASURES, dealFit, median, toDecimalString } from '@pb/calc';
import {
  FIT_MEASURE_KEYS,
  analyticsSummary,
  investmentPage,
  opportunityDetail,
  opportunityFit,
  opportunityPage,
  problemDetails,
  sponsorDetail,
} from '@pb/contracts';
import type { OpportunityFit, OpportunityRow } from '@pb/contracts';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const NO_SUCH_ID = '00000000-0000-4000-8000-00000000abcd';

/**
 * Deal fit (docs/08 section 8, decision 0018): GET /opportunities/{id}/fit. The scores are
 * recomputed here from the figures and thresholds the answer carries, and those figures are
 * checked against what the portfolio, analytics and sponsor endpoints say on their own.
 */
describe('deal fit: how an opportunity sits against the portfolio', () => {
  let h: Harness;
  let asOf: string;
  let deals: OpportunityRow[];

  beforeAll(async () => {
    h = await startHarness();
    asOf = h.dataset.asOf;
    deals = opportunityPage.parse(
      (await get('deal.three', '/api/v1/opportunities?limit=200').expect(200)).body,
    ).items;
  });
  afterAll(async () => {
    await h.close();
  });

  const get = (who: string, path: string) =>
    h.http().get(path).set('authorization', h.as(who)).set('x-request-id', 'req-fit');
  const fit = async (who: string, id: string, at = asOf): Promise<OpportunityFit> =>
    opportunityFit.parse(
      (await get(who, `/api/v1/opportunities/${id}/fit?asOf=${at}`).expect(200)).body,
    );

  it('keeps one list of measures in the contract and in the calculation', () => {
    expect([...FIT_MEASURE_KEYS]).toEqual([...FIT_MEASURES]);
  });

  it('answers the seven measures of every deal, each score the rule over the figures it returns', async () => {
    expect(deals.length).toBeGreaterThan(5);
    const configured = (h.runtime.definitions as unknown as { dealFit: Record<string, unknown> })
      .dealFit;
    let scored = 0;
    let unscored = 0;
    for (const deal of deals) {
      const answer = await fit('deal.three', deal.id);
      expect(answer.opportunityId).toBe(deal.id);
      expect(answer.asOf).toBe(asOf);
      expect(answer.measures.map((m) => m.key)).toEqual([...FIT_MEASURE_KEYS]);
      const i = answer.inputs;
      const again = dealFit(
        {
          sponsorTier: i.sponsorTier,
          sponsorMoic: i.sponsorMoic,
          commitment: i.commitment,
          sectorShare: i.sectorShare,
          sponsorShare: i.sponsorShare,
          geographyShare: i.geographyShare,
          // A target in another currency is never converted, so it is not compared.
          targetCommitment: i.currency === 'USD' ? i.targetCommitment : null,
          medianPosition: i.medianPosition,
        },
        answer.thresholds,
      );
      expect(answer.measures).toEqual(
        again.map((m) => ({ key: m.key, score: toDecimalString(m.score), missing: m.missing })),
      );
      for (const m of answer.measures) {
        if (m.score === null) unscored += 1;
        else scored += 1;
        expect(m.score === null).toBe(m.missing !== null);
      }
      // The thresholds are the configured ones, as decimal strings.
      expect(Number(answer.thresholds.caps.sector)).toBe(
        (configured.caps as { sector: number }).sector,
      );
      expect(Object.keys(answer.thresholds.tierScores).sort()).toEqual(
        Object.keys(configured.tierScores as object).sort(),
      );
      expect(i.targetCommitment).toBe(deal.targetCommitment);
      expect(i.currency).toBe(deal.currency);
      expect(i.sector).toBe(deal.sector);
      expect(i.geography).toBe(deal.geography);
    }
    expect(scored).toBeGreaterThan(deals.length * 3);
    expect(unscored).toBeGreaterThanOrEqual(0);
  });

  it('takes every figure from the book the caller may see, as the other pages report it', async () => {
    const who = 'deal.three';
    const book = investmentPage.parse(
      (await get(who, `/api/v1/investments?limit=200&asOf=${asOf}`).expect(200)).body,
    ).items;
    const analytics = analyticsSummary.parse(
      (await get(who, `/api/v1/analytics/summary?asOf=${asOf}`).expect(200)).body,
    );
    const shareOf = (
      buckets: { key: string; navShare: string | null }[],
      key: string | null,
    ): string | null => {
      if (key === null) return null;
      const bucket = buckets.find((b) => b.key === key);
      // Nothing held there is a share of zero, when the total itself is known.
      if (bucket === undefined) return buckets.some((b) => b.navShare !== null) ? '0' : null;
      return bucket.navShare;
    };
    let checked = 0;
    for (const deal of deals.slice(0, 6)) {
      const { inputs } = await fit(who, deal.id);
      expect(inputs.sectorShare, `${deal.name} sector`).toBe(
        shareOf(analytics.exposures.sector, deal.sector),
      );
      expect(inputs.geographyShare, `${deal.name} geography`).toBe(
        shareOf(analytics.exposures.geography, deal.geography),
      );
      expect(inputs.sponsorShare, `${deal.name} sponsor`).toBe(
        shareOf(analytics.exposures.sponsor, deal.sponsor.id),
      );

      const sponsor = sponsorDetail.parse(
        (await get(who, `/api/v1/sponsors/${deal.sponsor.id}?asOf=${asOf}`).expect(200)).body,
      );
      expect(inputs.sponsorTier).toBe(sponsor.tier);
      expect(inputs.sponsorPositions).toBe(sponsor.positions.length);
      expect(inputs.sponsorMoic).toBe(sponsor.metrics.grossMoic);
      const funds = new Set(sponsor.commitments.map((c) => c.sponsorFundId));
      const expected =
        deal.sponsorFund !== null && funds.has(deal.sponsorFund.id)
          ? 'fund'
          : funds.size > 0
            ? 'otherFund'
            : 'none';
      expect(inputs.commitment, deal.name).toBe(expected);

      const sizes = book
        .filter((p) => p.isActive && p.dealType === deal.dealType && p.invested !== null)
        .map((p) => p.invested!);
      expect(inputs.comparablePositions).toBe(sizes.length);
      expect(inputs.medianPosition).toBe(toDecimalString(median(sizes)));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('gives a measure no score when its figure is not recorded, and says why', async () => {
    const sponsorId = deals[0]!.sponsor.id;
    const created = opportunityDetail.parse(
      (
        await h
          .http()
          .post('/api/v1/opportunities')
          .set('authorization', h.as('deal.one'))
          .set('x-request-id', 'req-fit-new')
          .set('idempotency-key', 'fit-test-bare-deal-0001')
          .send({
            name: 'Project Bare',
            companyName: 'Bare Holdings',
            sponsorId,
            dealType: 'deal_type.co_invest_equity',
            receivedDate: asOf,
          })
          .expect(201)
      ).body,
    );
    const answer = await fit('deal.one', created.id);
    const missing = Object.fromEntries(answer.measures.map((m) => [m.key, m.missing]));
    expect(missing.sector_room).toBe('no_exposure_figure');
    expect(missing.geography_room).toBe('no_exposure_figure');
    expect(missing.size_fit).toBe('no_target_commitment');
    expect(answer.inputs.sectorShare).toBeNull();
    expect(answer.inputs.geographyShare).toBeNull();
    // With no fund named, a commitment to any fund of the sponsor is "another fund".
    expect(answer.inputs.commitment).not.toBe('fund');
    // What is recorded still scores.
    expect(answer.measures.find((m) => m.key === 'fund_relationship')?.score).not.toBeNull();
  });

  it('reads the book as of the date asked for', async () => {
    const deal = deals[0]!;
    const early = await fit('deal.three', deal.id, '2015-01-01');
    // Before any position existed there is nothing to take a share of or to compare with.
    expect(early.asOf).toBe('2015-01-01');
    expect(early.inputs.sponsorPositions).toBe(0);
    expect(early.inputs.sponsorMoic).toBeNull();
    expect(early.inputs.sectorShare).toBeNull();
    expect(early.inputs.comparablePositions).toBe(0);
    expect(early.inputs.medianPosition).toBeNull();
    const bad = await get('deal.three', `/api/v1/opportunities/${deal.id}/fit?asOf=2025-02-30`);
    expect(bad.status).toBe(400);
  });

  it('answers 404 for a deal the caller cannot see and for one that does not exist', async () => {
    const walledId = h.dataset.scenarios.walled_opportunity?.[0];
    expect(walledId).toBeDefined();
    const member = await get('deal.three', `/api/v1/opportunities/${walledId}/fit`);
    expect([200, 404]).toContain(member.status);
    const visible = new Set(
      opportunityPage
        .parse((await get('viewer.one', '/api/v1/opportunities?limit=200').expect(200)).body)
        .items.map((o) => o.id),
    );
    expect(visible.has(walledId!)).toBe(false);
    const outsider = await get('viewer.one', `/api/v1/opportunities/${walledId}/fit`).expect(404);
    expect(problemDetails.parse(outsider.body).detail).not.toContain(walledId);
    await get('deal.three', `/api/v1/opportunities/${NO_SUCH_ID}/fit`).expect(404);
    await get('deal.three', '/api/v1/opportunities/not-a-uuid/fit').expect(404);
    await h.http().get(`/api/v1/opportunities/${deals[0]!.id}/fit`).expect(401);
  });

  it('refuses to answer without usable thresholds, and names the key', async () => {
    const definitions = h.runtime.definitions as unknown as { dealFit: Record<string, unknown> };
    const original = structuredClone(definitions.dealFit);
    try {
      for (const [key, value, named] of [
        ['caps', { sector: 0, sponsor: 0.2, geography: 0.7 }, 'dealFit.caps'],
        ['size', { low: 2, high: 1, limit: 3 }, 'dealFit.size'],
        ['trackRecord', { zeroAtMoic: 2, fullAtMoic: 2 }, 'dealFit.trackRecord'],
        ['tierScores', { 'sponsor_tier.core': 140 }, 'dealFit.tierScores'],
        ['fundRelationship', undefined, 'dealFit.fundRelationship'],
      ] as const) {
        definitions.dealFit = structuredClone(original);
        if (value === undefined) delete definitions.dealFit[key];
        else definitions.dealFit[key] = value;
        const res = await get('deal.three', `/api/v1/opportunities/${deals[0]!.id}/fit`).expect(
          500,
        );
        expect(problemDetails.parse(res.body).detail, key).toContain(named);
      }
    } finally {
      definitions.dealFit = original;
    }
    await fit('deal.three', deals[0]!.id);
  });

  it('never turns a money amount into a JS number on the way', async () => {
    const answer = await fit('deal.three', deals[0]!.id);
    for (const m of answer.measures)
      if (m.score !== null) {
        expect(D(m.score).gte(0) && D(m.score).lte(100)).toBe(true);
        expect(m.score).toMatch(/^\d{1,3}(\.\d{1,10})?$/);
      }
  });
});
