import type { Decimal, DecimalInput } from './decimal.js';
import { CalcError, D, ONE, RESULT_PLACES, ZERO } from './decimal.js';

/*
 * Deal fit measures (docs/08 section 8, decision 0018): how an opportunity sits against the
 * portfolio, as seven scores from 0 to 100 where higher is a better fit. Each is a plain rule
 * over recorded figures that a reader can check by hand. The thresholds are configuration, never
 * code, and a measure whose input is missing has no score and says why: it is never guessed.
 */

/** The measures, in the order they are answered and drawn. */
export const FIT_MEASURES = [
  'sponsor_relationship',
  'track_record',
  'fund_relationship',
  'sector_room',
  'sponsor_room',
  'geography_room',
  'size_fit',
] as const;
export type FitMeasureKey = (typeof FIT_MEASURES)[number];

/** Why a measure has no score. */
export type FitMissing =
  /** The sponsor's tier is not one configuration gives a score. */
  | 'tier_not_scored'
  /** No position with the sponsor has a calculable MOIC. */
  | 'no_track_record'
  /** No share to measure: nothing recorded on the deal, or no NAV held to take a share of. */
  | 'no_exposure_figure'
  /** The deal has no target commitment, or it is in another currency than the positions. */
  | 'no_target_commitment'
  /** No held position of the deal's type to compare its size with. */
  | 'no_comparable_position';

export interface FitMeasure {
  key: FitMeasureKey;
  /** 0 to 100 at the ten places a result travels with; null with a reason in `missing`. */
  score: Decimal | null;
  missing: FitMissing | null;
}

/** Whether the firm has a commitment to the deal's own sponsor fund, to another fund of the sponsor, or to none. */
export type FundCommitment = 'fund' | 'otherFund' | 'none';

export interface FitInputs {
  sponsorTier: string | null;
  /** Pooled gross MOIC of our positions with the sponsor (section 2). */
  sponsorMoic: DecimalInput | null;
  commitment: FundCommitment;
  /** Shares of held NAV already in the deal's sector, with its sponsor, in its geography. */
  sectorShare: DecimalInput | null;
  sponsorShare: DecimalInput | null;
  geographyShare: DecimalInput | null;
  targetCommitment: DecimalInput | null;
  /** Median invested capital of the held positions of the deal's type. */
  medianPosition: DecimalInput | null;
}

export interface FitThresholds {
  /** Score by sponsor tier code. */
  tierScores: Readonly<Record<string, DecimalInput>>;
  /** The MOIC that scores 0 and the MOIC that scores 100. */
  trackRecord: { zeroAtMoic: DecimalInput; fullAtMoic: DecimalInput };
  fundRelationship: Readonly<Record<FundCommitment, DecimalInput>>;
  /** The share of held NAV at which a sector, a sponsor or a geography has no room left. */
  caps: { sector: DecimalInput; sponsor: DecimalInput; geography: DecimalInput };
  /** Size as a multiple of the median position: 100 from low to high, 0 at nothing and at limit. */
  size: { low: DecimalInput; high: DecimalInput; limit: DecimalInput };
}

const HUNDRED = D('100');

const invalid = (message: string): CalcError => new CalcError(message, 'invalid_fit_thresholds');

const rounded = (score: Decimal): Decimal => score.toDecimalPlaces(RESULT_PLACES);

function clampUnit(value: Decimal): Decimal {
  // At or below zero is zero: a negative zero (nothing over a negative span) is not a score.
  if (value.lte(ZERO)) return ZERO;
  return value.gt(ONE) ? ONE : value;
}

/**
 * 100 x the share of the way from `zeroAt` to `fullAt`, held between 0 and 100. `fullAt` may lie
 * below `zeroAt`: the score then falls as the value rises.
 */
export function linearScore(
  value: DecimalInput,
  zeroAt: DecimalInput,
  fullAt: DecimalInput,
): Decimal {
  const zero = D(zeroAt);
  const span = D(fullAt).minus(zero);
  if (span.isZero()) throw invalid('a score needs two different ends');
  return rounded(clampUnit(D(value).minus(zero).div(span)).times(HUNDRED));
}

/**
 * Size against the median position: 100 for a ratio from `low` to `high`, rising in a straight
 * line from 0 at nothing, falling in a straight line to 0 at `limit`, and 0 beyond it.
 */
export function sizeScore(
  ratio: DecimalInput,
  low: DecimalInput,
  high: DecimalInput,
  limit: DecimalInput,
): Decimal {
  const [r, lo, hi, top] = [D(ratio), D(low), D(high), D(limit)];
  if (!(lo.gt(ZERO) && hi.gte(lo) && top.gt(hi)))
    throw invalid('the size band needs 0 < low <= high < limit');
  if (r.lt(lo)) return linearScore(r, ZERO, lo);
  if (r.lte(hi)) return HUNDRED;
  return linearScore(r, top, hi);
}

/** The middle of a list: the middle value, or the mean of the two middle values; null for none. */
export function median(values: readonly DecimalInput[]): Decimal | null {
  const sorted = values.map((v) => D(v)).sort((a, b) => a.comparedTo(b));
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return null;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1];
  return lower === undefined ? upper : lower.plus(upper).div(2);
}

/** A configured score: a number from 0 to 100. */
function configured(value: DecimalInput, what: string): Decimal {
  const score = D(value);
  if (score.lt(ZERO) || score.gt(HUNDRED)) throw invalid(`${what} must be from 0 to 100`);
  return rounded(score);
}

function positive(value: DecimalInput, what: string): Decimal {
  const cap = D(value);
  if (cap.lte(ZERO)) throw invalid(`${what} must be above zero`);
  return cap;
}

const scored = (key: FitMeasureKey, score: Decimal): FitMeasure => ({ key, score, missing: null });
const unscored = (key: FitMeasureKey, missing: FitMissing): FitMeasure => ({
  key,
  score: null,
  missing,
});

/** Room left under a cap: 100 with nothing held, 0 at the cap or over it. */
function room(key: FitMeasureKey, share: DecimalInput | null, cap: Decimal): FitMeasure {
  return share === null
    ? unscored(key, 'no_exposure_figure')
    : scored(key, linearScore(share, cap, ZERO));
}

/** The seven measures of one opportunity, in the order of FIT_MEASURES. */
export function dealFit(inputs: FitInputs, thresholds: FitThresholds): FitMeasure[] {
  // Every threshold is read before any is used, so a bad one is refused whatever the inputs.
  const tierScores = new Map(
    Object.entries(thresholds.tierScores).map(([tier, score]) => [
      tier,
      configured(score, `the score of ${tier}`),
    ]),
  );
  const commitmentScores: Record<FundCommitment, Decimal> = {
    fund: configured(thresholds.fundRelationship.fund, 'fundRelationship.fund'),
    otherFund: configured(thresholds.fundRelationship.otherFund, 'fundRelationship.otherFund'),
    none: configured(thresholds.fundRelationship.none, 'fundRelationship.none'),
  };
  const caps = {
    sector: positive(thresholds.caps.sector, 'caps.sector'),
    sponsor: positive(thresholds.caps.sponsor, 'caps.sponsor'),
    geography: positive(thresholds.caps.geography, 'caps.geography'),
  };
  const { zeroAtMoic, fullAtMoic } = thresholds.trackRecord;
  const { low, high, limit } = thresholds.size;
  // The two rules are run once on a harmless value, so a bad line or band is refused here too.
  linearScore(zeroAtMoic, zeroAtMoic, fullAtMoic);
  sizeScore(low, low, high, limit);

  const tierScore = inputs.sponsorTier === null ? undefined : tierScores.get(inputs.sponsorTier);
  const median = inputs.medianPosition === null ? null : D(inputs.medianPosition);

  let size: FitMeasure;
  if (inputs.targetCommitment === null) size = unscored('size_fit', 'no_target_commitment');
  else if (median === null || median.lte(ZERO))
    size = unscored('size_fit', 'no_comparable_position');
  else
    size = scored('size_fit', sizeScore(D(inputs.targetCommitment).div(median), low, high, limit));

  return [
    tierScore === undefined
      ? unscored('sponsor_relationship', 'tier_not_scored')
      : scored('sponsor_relationship', tierScore),
    inputs.sponsorMoic === null
      ? unscored('track_record', 'no_track_record')
      : scored('track_record', linearScore(inputs.sponsorMoic, zeroAtMoic, fullAtMoic)),
    scored('fund_relationship', commitmentScores[inputs.commitment]),
    room('sector_room', inputs.sectorShare, caps.sector),
    room('sponsor_room', inputs.sponsorShare, caps.sponsor),
    room('geography_room', inputs.geographyShare, caps.geography),
    size,
  ];
}
