import { afterEach, describe, expect, it } from 'vitest';
import { dealFit, toDecimalString } from '@pb/calc';
import { FIT_MEASURE_KEYS } from '@pb/contracts';
import { clearTaxonomyLabels, MISSING, registerTaxonomyLabels } from '../../lib/format.js';
import { opportunityFitFixture } from '../../test/fixtures-pipeline.js';
import { fitRows, fitScore, fitSummary } from './deal-fit.js';
import type { FitDeal } from './deal-fit.js';

const DEAL: FitDeal = {
  sponsorName: 'Kelpwood Capital Partners',
  fundName: 'Kelpwood Fund I',
  dealType: 'deal_type.co_invest_equity',
};

const row = (rows: ReturnType<typeof fitRows>, key: string) => {
  const found = rows.find((r) => r.key === key);
  if (found === undefined) throw new Error(`no row ${key}`);
  return found;
};

describe('deal fit: what the card says about each measure', () => {
  afterEach(() => clearTaxonomyLabels());

  it('keeps the fixture honest: every score is the rule over the figures beside it', () => {
    const fit = opportunityFitFixture();
    const i = fit.inputs;
    const again = dealFit(
      {
        sponsorTier: i.sponsorTier,
        sponsorMoic: i.sponsorMoic,
        commitment: i.commitment,
        sectorShare: i.sectorShare,
        sponsorShare: i.sponsorShare,
        geographyShare: i.geographyShare,
        targetCommitment: i.targetCommitment,
        medianPosition: i.medianPosition,
      },
      fit.thresholds,
    );
    expect(fit.measures).toEqual(
      again.map((m) => ({ key: m.key, score: toDecimalString(m.score), missing: m.missing })),
    );
  });

  it('shows a score as a whole number and no score as the missing placeholder', () => {
    expect(fitScore('70')).toBe('70');
    expect(fitScore('66.6666666667')).toBe('67');
    expect(fitScore('0.4')).toBe('0');
    expect(fitScore('99.5')).toBe('100');
    expect(fitScore('100')).toBe('100');
    expect(fitScore(null)).toBe(MISSING);
  });

  it('names every measure in order, with the figure it was worked out from and the rule', () => {
    registerTaxonomyLabels([
      { code: 'sponsor_tier.core', label: 'Core' },
      { code: 'sponsor_tier.active', label: 'Active' },
      { code: 'sponsor_tier.new', label: 'New' },
      { code: 'sponsor_tier.watch', label: 'Watch' },
      { code: 'sector.industrials', label: 'Industrials' },
      { code: 'geography.north_america', label: 'North America' },
      { code: 'deal_type.co_invest_equity', label: 'Co-investment (equity)' },
    ]);
    const rows = fitRows(opportunityFitFixture(), DEAL);
    expect(rows.map((r) => r.key)).toEqual([...FIT_MEASURE_KEYS]);
    expect(rows.map((r) => r.value)).toEqual([70, 40, 100, 20, 75, 50, 100]);
    expect(rows.map((r) => r.display)).toEqual(['70', '40', '100', '20', '75', '50', '100']);
    expect(rows.map((r) => r.axis)).toEqual([
      'Sponsor tier',
      'Track record',
      'Fund commitment',
      'Sector room',
      'Sponsor room',
      'Geography room',
      'Deal size',
    ]);

    expect(row(rows, 'sponsor_relationship').basis).toBe(
      'Kelpwood Capital Partners is an Active sponsor.',
    );
    expect(row(rows, 'sponsor_relationship').rule).toBe(
      'Each tier has a set score: Core 100, Active 70, New 40, Watch 15.',
    );
    expect(row(rows, 'track_record').basis).toBe(
      'Our 3 positions with Kelpwood Capital Partners have a pooled gross MOIC of 1.60x.',
    );
    expect(row(rows, 'track_record').rule).toBe(
      '1.00x or less scores 0; 2.50x or more scores 100.',
    );
    expect(row(rows, 'fund_relationship').basis).toBe(
      'The firm has a commitment to Kelpwood Fund I, the fund this deal comes from.',
    );
    expect(row(rows, 'fund_relationship').rule).toBe(
      "A commitment to the deal's own fund scores 100, to another fund of the sponsor 60, to none 0.",
    );
    expect(row(rows, 'sector_room').basis).toBe('Industrials is 20.0% of held NAV.');
    expect(row(rows, 'sector_room').rule).toBe(
      'Nothing held scores 100; 25.0% of held NAV or more scores 0.',
    );
    expect(row(rows, 'sponsor_room').basis).toBe('Kelpwood Capital Partners is 5.0% of held NAV.');
    expect(row(rows, 'sponsor_room').rule).toContain('20.0%');
    expect(row(rows, 'geography_room').basis).toBe('North America is 35.0% of held NAV.');
    expect(row(rows, 'geography_room').rule).toContain('70.0%');
    expect(row(rows, 'size_fit').basis).toBe(
      'The target of $15.0M is 1.25x the median held Co-investment (equity) position ($12.0M across 12 positions).',
    );
    expect(row(rows, 'size_fit').rule).toBe(
      'From 0.5x to 1.5x the median scores 100; nothing and 3.0x or more score 0.',
    );
  });

  it('says why a measure has no score, from what is and is not recorded', () => {
    const none = (key: (typeof FIT_MEASURE_KEYS)[number], missing: string) =>
      opportunityFitFixture().measures.map((m) =>
        m.key === key ? { key, score: null, missing: missing as never } : m,
      );

    const noTier = fitRows(
      opportunityFitFixture({
        measures: none('sponsor_relationship', 'tier_not_scored'),
        inputs: { sponsorTier: null },
      }),
      DEAL,
    );
    expect(row(noTier, 'sponsor_relationship').value).toBeNull();
    expect(row(noTier, 'sponsor_relationship').display).toBe(MISSING);
    expect(row(noTier, 'sponsor_relationship').basis).toBe(
      'No tier is recorded for Kelpwood Capital Partners.',
    );
    const oddTier = fitRows(
      opportunityFitFixture({
        measures: none('sponsor_relationship', 'tier_not_scored'),
        inputs: { sponsorTier: 'sponsor_tier.dormant' },
      }),
      DEAL,
    );
    expect(row(oddTier, 'sponsor_relationship').basis).toBe(
      'Kelpwood Capital Partners is a Dormant sponsor, a tier with no set score.',
    );

    const noRecord = (sponsorPositions: number) =>
      row(
        fitRows(
          opportunityFitFixture({
            measures: none('track_record', 'no_track_record'),
            inputs: { sponsorPositions, sponsorMoic: null },
          }),
          DEAL,
        ),
        'track_record',
      ).basis;
    expect(noRecord(0)).toBe('We have no position with Kelpwood Capital Partners to judge by.');
    expect(noRecord(1)).toBe(
      'Our 1 position with Kelpwood Capital Partners has no calculable MOIC yet.',
    );
    expect(noRecord(2)).toBe(
      'Our 2 positions with Kelpwood Capital Partners have no calculable MOIC yet.',
    );

    const noSector = fitRows(
      opportunityFitFixture({
        measures: none('sector_room', 'no_exposure_figure'),
        inputs: { sector: null, sectorShare: null },
      }),
      DEAL,
    );
    expect(row(noSector, 'sector_room').basis).toBe('No sector is recorded on the deal.');
    const noNav = fitRows(
      opportunityFitFixture({
        measures: [
          ...none('sector_room', 'no_exposure_figure').slice(0, 4),
          { key: 'sponsor_room', score: null, missing: 'no_exposure_figure' },
          { key: 'geography_room', score: null, missing: 'no_exposure_figure' },
          { key: 'size_fit', score: '100', missing: null },
        ],
        inputs: { sectorShare: null, sponsorShare: null, geographyShare: null },
      }),
      DEAL,
    );
    for (const key of ['sector_room', 'sponsor_room', 'geography_room'])
      expect(row(noNav, key).basis).toBe('No held position has a NAV to take a share of.');
    const noGeography = fitRows(
      opportunityFitFixture({
        measures: none('geography_room', 'no_exposure_figure'),
        inputs: { geography: null, geographyShare: null },
      }),
      DEAL,
    );
    expect(row(noGeography, 'geography_room').basis).toBe('No geography is recorded on the deal.');

    const noTarget = fitRows(
      opportunityFitFixture({
        measures: none('size_fit', 'no_target_commitment'),
        inputs: { targetCommitment: null, sizeRatio: null },
      }),
      DEAL,
    );
    expect(row(noTarget, 'size_fit').basis).toBe('No target commitment is recorded on the deal.');
    const otherCurrency = fitRows(
      opportunityFitFixture({
        measures: none('size_fit', 'no_target_commitment'),
        inputs: { currency: 'EUR', sizeRatio: null },
      }),
      DEAL,
    );
    expect(row(otherCurrency, 'size_fit').basis).toBe(
      'The target of EUR 15.0M is not in the currency the positions are held in, and nothing is converted.',
    );
    const noPeers = fitRows(
      opportunityFitFixture({
        measures: none('size_fit', 'no_comparable_position'),
        inputs: { comparablePositions: 0, medianPosition: null, sizeRatio: null },
      }),
      DEAL,
    );
    expect(row(noPeers, 'size_fit').basis).toBe(
      'No held Co invest equity position has invested capital to compare the target with.',
    );
  });

  it('words the fund relationship by what the firm is committed to', () => {
    const basis = (commitment: 'fund' | 'otherFund' | 'none', fundName: string | null) =>
      row(
        fitRows(opportunityFitFixture({ inputs: { commitment } }), { ...DEAL, fundName }),
        'fund_relationship',
      ).basis;
    expect(basis('otherFund', 'Kelpwood Fund I')).toBe(
      'The firm has a commitment to another fund of Kelpwood Capital Partners, not to Kelpwood Fund I.',
    );
    expect(basis('otherFund', null)).toBe(
      'The firm has a commitment to a fund of Kelpwood Capital Partners; the deal names no fund.',
    );
    expect(basis('none', null)).toBe(
      'The firm has no commitment to a fund of Kelpwood Capital Partners.',
    );
    expect(basis('fund', null)).toBe("The firm has a commitment to the deal's own fund.");
  });

  it('sums the chart up in a sentence: how many scored, the strongest and the weakest', () => {
    const fit = opportunityFitFixture();
    const rows = fitRows(fit, DEAL);
    expect(fitSummary(rows)).toBe(
      'All 7 measures have a score. Strongest: Fund commitment and Deal size (100). Weakest: Sector room (20).',
    );
    const some = rows.map((r, i) => (i < 5 ? { ...r, value: null, display: MISSING } : r));
    expect(fitSummary(some)).toBe(
      '2 of 7 measures have a score. Strongest: Deal size (100). Weakest: Geography room (50).',
    );
    const one = rows.map((r, i) => (i < 6 ? { ...r, value: null, display: MISSING } : r));
    expect(fitSummary(one)).toBe('1 of 7 measures has a score: Deal size (100).');
    const level = rows.map((r) => ({ ...r, value: 60, display: '60' }));
    expect(fitSummary(level)).toBe('All 7 measures have a score, each of 60.');
    const nothing = rows.map((r) => ({ ...r, value: null, display: MISSING }));
    expect(fitSummary(nothing)).toBe(
      'None of the 7 measures has a score: the figures they need are not recorded.',
    );
  });
});
