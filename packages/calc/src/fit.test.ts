import { describe, expect, it } from 'vitest';
import { CalcError, D, FIT_MEASURES, dealFit, linearScore, median, sizeScore } from './index.js';
import type { FitInputs, FitThresholds } from './index.js';

const THRESHOLDS: FitThresholds = {
  tierScores: { 'sponsor_tier.core': '100', 'sponsor_tier.active': '70' },
  trackRecord: { zeroAtMoic: '1.0', fullAtMoic: '2.5' },
  fundRelationship: { fund: '100', otherFund: '60', none: '0' },
  caps: { sector: '0.25', sponsor: '0.20', geography: '0.70' },
  size: { low: '0.5', high: '1.5', limit: '3' },
};

const INPUTS: FitInputs = {
  sponsorTier: 'sponsor_tier.core',
  sponsorMoic: '1.6',
  commitment: 'fund',
  sectorShare: '0.1',
  sponsorShare: '0.1',
  geographyShare: '0.3',
  targetCommitment: '10000000',
  medianPosition: '10000000',
};

/** A small deterministic stream, so the property runs the same every time. */
function stream(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('deal fit (docs/08 section 8)', () => {
  it('answers the seven measures in one fixed order, each with a score or a reason', () => {
    const measures = dealFit(INPUTS, THRESHOLDS);
    expect(measures.map((m) => m.key)).toEqual(FIT_MEASURES);
    expect(FIT_MEASURES).toEqual([
      'sponsor_relationship',
      'track_record',
      'fund_relationship',
      'sector_room',
      'sponsor_room',
      'geography_room',
      'size_fit',
    ]);
    for (const m of measures) expect(m.missing).toBeNull();
  });

  it('says why a measure has no score, and never guesses one', () => {
    const blank = dealFit(
      {
        sponsorTier: 'sponsor_tier.unscored',
        sponsorMoic: null,
        commitment: 'none',
        sectorShare: null,
        sponsorShare: null,
        geographyShare: null,
        targetCommitment: null,
        medianPosition: null,
      },
      THRESHOLDS,
    );
    expect(
      Object.fromEntries(blank.map((m) => [m.key, [m.score?.toString() ?? null, m.missing]])),
    ).toEqual({
      sponsor_relationship: [null, 'tier_not_scored'],
      track_record: [null, 'no_track_record'],
      fund_relationship: ['0', null],
      sector_room: [null, 'no_exposure_figure'],
      sponsor_room: [null, 'no_exposure_figure'],
      geography_room: [null, 'no_exposure_figure'],
      size_fit: [null, 'no_target_commitment'],
    });
    const noPeers = dealFit({ ...INPUTS, medianPosition: null }, THRESHOLDS);
    expect(noPeers.find((m) => m.key === 'size_fit')?.missing).toBe('no_comparable_position');
    const noTier = dealFit({ ...INPUTS, sponsorTier: null }, THRESHOLDS);
    expect(noTier.find((m) => m.key === 'sponsor_relationship')?.missing).toBe('tier_not_scored');
  });

  it('keeps every score between 0 and 100, whatever the inputs', () => {
    const next = stream(42);
    const amount = (): string => (next() * 5).toFixed(4);
    for (let i = 0; i < 300; i += 1) {
      const measures = dealFit(
        {
          sponsorTier: next() < 0.5 ? 'sponsor_tier.core' : 'sponsor_tier.active',
          sponsorMoic: next() < 0.1 ? null : amount(),
          commitment: (['fund', 'otherFund', 'none'] as const)[Math.floor(next() * 3)]!,
          sectorShare: next() < 0.1 ? null : (next() * 1.2).toFixed(4),
          sponsorShare: next() < 0.1 ? null : (next() * 1.2).toFixed(4),
          geographyShare: next() < 0.1 ? null : (next() * 1.2).toFixed(4),
          targetCommitment: next() < 0.1 ? null : (next() * 90_000_000).toFixed(2),
          medianPosition: next() < 0.1 ? null : (1 + next() * 30_000_000).toFixed(2),
        },
        THRESHOLDS,
      );
      for (const m of measures) {
        if (m.score === null) continue;
        expect(m.score.gte(0) && m.score.lte(100), `${m.key} ${m.score.toString()}`).toBe(true);
        expect(m.score.decimalPlaces()).toBeLessThanOrEqual(10);
      }
    }
  });

  it('moves the right way: more room, a better record and a nearer size never score lower', () => {
    const score = (inputs: Partial<FitInputs>, key: string): number =>
      Number(dealFit({ ...INPUTS, ...inputs }, THRESHOLDS).find((m) => m.key === key)!.score);
    let last = Infinity;
    for (const share of ['0', '0.05', '0.1', '0.2', '0.25', '0.4']) {
      const now = score({ sectorShare: share }, 'sector_room');
      expect(now).toBeLessThanOrEqual(last);
      last = now;
    }
    last = -Infinity;
    for (const moic of ['0.5', '1', '1.2', '1.9', '2.5', '4']) {
      const now = score({ sponsorMoic: moic }, 'track_record');
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
    // Size rises to the band, holds across it and falls after it.
    const sizes = [
      '0',
      '2500000',
      '5000000',
      '10000000',
      '15000000',
      '22500000',
      '30000000',
      '90000000',
    ];
    expect(sizes.map((target) => score({ targetCommitment: target }, 'size_fit'))).toEqual([
      0, 50, 100, 100, 100, 50, 0, 0,
    ]);
  });

  it('scores on a straight line between its two ends, either way round', () => {
    expect(linearScore('1.75', '1', '2.5').toString()).toBe('50');
    expect(linearScore('0.1', '0.25', '0').toString()).toBe('60');
    expect(linearScore('9', '1', '2.5').toString()).toBe('100');
    expect(linearScore('-3', '1', '2.5').toString()).toBe('0');
    expect(sizeScore('1', '0.5', '1.5', '3').toString()).toBe('100');
    expect(sizeScore('2.25', '0.5', '1.5', '3').toString()).toBe('50');
  });

  it('refuses thresholds that make no line or no band', () => {
    const refuse = (thresholds: FitThresholds): void => {
      expect(() => dealFit(INPUTS, thresholds)).toThrow(CalcError);
      try {
        dealFit(INPUTS, thresholds);
      } catch (error) {
        expect((error as CalcError).code).toBe('invalid_fit_thresholds');
      }
    };
    refuse({ ...THRESHOLDS, trackRecord: { zeroAtMoic: '2', fullAtMoic: '2' } });
    refuse({ ...THRESHOLDS, caps: { ...THRESHOLDS.caps, sector: '0' } });
    refuse({ ...THRESHOLDS, size: { low: '1.5', high: '0.5', limit: '3' } });
    refuse({ ...THRESHOLDS, size: { low: '0.5', high: '1.5', limit: '1.5' } });
    refuse({ ...THRESHOLDS, tierScores: { 'sponsor_tier.core': '140' } });
    refuse({ ...THRESHOLDS, fundRelationship: { fund: '100', otherFund: '-1', none: '0' } });
  });

  it('takes the middle of a list as its median', () => {
    expect(median(['3', '1', '2'])?.toString()).toBe('2');
    expect(median([D('4'), D('1'), D('3'), D('2')])?.toString()).toBe('2.5');
    expect(median([])).toBeNull();
  });
});
