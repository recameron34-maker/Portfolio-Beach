import {
  CALC_VERSION,
  CalcError,
  D,
  ZERO,
  dealFit,
  linearScore,
  median,
  sizeScore,
  toDecimalString,
} from '@pb/calc';
import type { Decimal, FundCommitment } from '@pb/calc';
import type { FitThresholds, OpportunityFit } from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { eq } from 'drizzle-orm';
import { configDecimal, configError } from '../common/definitions.js';
import { loadCommitmentRows } from '../portfolio/commitments.js';
import { loadInvestmentsWithMetrics } from '../portfolio/loaders.js';
import { pooledPositionMetrics } from '../portfolio/metrics.js';

/*
 * Deal fit (docs/08 section 8, decision 0018): the figures of one opportunity against the book
 * the caller may see, and the seven scores @pb/calc makes of them. Every figure here is one
 * another page already reports the same way: shares of held NAV as the Exposure tab has them,
 * the sponsor's pooled MOIC and commitments as the sponsor page has them.
 */

/** The currency the positions are held in; a target in another is never converted, so it is not compared. */
const BOOK_CURRENCY = 'USD';

type Raw = Record<string, unknown>;

const groupOf = (raw: Raw, key: string): Raw => {
  const value = raw[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw configError(`dealFit.${key}`);
  return value as Raw;
};

const decimalOf = (group: Raw, name: string, key: string): Decimal =>
  configDecimal(group[name], `dealFit.${key}`);

/** A configured score: from 0 to 100. */
function scoreOf(group: Raw, name: string, key: string): string {
  const score = decimalOf(group, name, key);
  if (score.lt(ZERO) || score.gt(D('100'))) throw configError(`dealFit.${key}`);
  return score.toString();
}

/**
 * `dealFit` of config/definitions.json as the thresholds the calculation takes, every one checked
 * here so a bad one names its key; never a default in code (rules 9 and 10).
 */
export function fitThresholdsOf(definitions: { dealFit?: unknown }): FitThresholds {
  const raw = (definitions.dealFit ?? {}) as Raw;

  const tiers = groupOf(raw, 'tierScores');
  if (Object.keys(tiers).length === 0) throw configError('dealFit.tierScores');
  const tierScores = Object.fromEntries(
    Object.keys(tiers).map((tier) => [tier, scoreOf(tiers, tier, 'tierScores')]),
  );

  const record = groupOf(raw, 'trackRecord');
  const trackRecord = {
    zeroAtMoic: decimalOf(record, 'zeroAtMoic', 'trackRecord').toString(),
    fullAtMoic: decimalOf(record, 'fullAtMoic', 'trackRecord').toString(),
  };

  const relationship = groupOf(raw, 'fundRelationship');
  const fundRelationship = {
    fund: scoreOf(relationship, 'fund', 'fundRelationship'),
    otherFund: scoreOf(relationship, 'otherFund', 'fundRelationship'),
    none: scoreOf(relationship, 'none', 'fundRelationship'),
  };

  const capGroup = groupOf(raw, 'caps');
  const cap = (name: string): string => {
    const value = decimalOf(capGroup, name, 'caps');
    if (value.lte(ZERO)) throw configError('dealFit.caps');
    return value.toString();
  };
  const caps = { sector: cap('sector'), sponsor: cap('sponsor'), geography: cap('geography') };

  const sizeGroup = groupOf(raw, 'size');
  const size = {
    low: decimalOf(sizeGroup, 'low', 'size').toString(),
    high: decimalOf(sizeGroup, 'high', 'size').toString(),
    limit: decimalOf(sizeGroup, 'limit', 'size').toString(),
  };

  // The line and the band are tried once, so thresholds that make neither are refused by name.
  const tried = (key: string, run: () => unknown): void => {
    try {
      run();
    } catch (error) {
      if (error instanceof CalcError) throw configError(`dealFit.${key}`);
      throw error;
    }
  };
  tried('trackRecord', () =>
    linearScore(trackRecord.zeroAtMoic, trackRecord.zeroAtMoic, trackRecord.fullAtMoic),
  );
  tried('size', () => sizeScore(size.low, size.low, size.high, size.limit));

  return { tierScores, trackRecord, fundRelationship, caps, size };
}

/** The opportunity fields the fit reads (the row rows.ts loads carries them). */
export interface FitDeal {
  id: string;
  sponsorId: string;
  sponsorFundId: string | null;
  dealType: string;
  sector: string | null;
  geography: string | null;
  targetCommitment: string | null;
  currency: string;
}

/** The fit of one opportunity the caller can already see, as of a date. */
export async function loadOpportunityFit(
  tx: Tx,
  deal: FitDeal,
  asOf: string,
  thresholds: FitThresholds,
): Promise<OpportunityFit> {
  const positions = await loadInvestmentsWithMetrics(tx, asOf);
  const held = positions.filter((p) => p.row.isActive);

  // Shares of held NAV, as the Exposure tab takes them: over the positions with a Locked mark.
  const marked = held.filter((p) => p.summary.nav !== null);
  const navOf = (rows: typeof marked): Decimal =>
    rows.reduce((sum, p) => sum.plus(p.summary.nav ?? '0'), ZERO);
  const totalNav = marked.length === 0 ? null : navOf(marked);
  const shareOf = (belongs: (p: (typeof marked)[number]) => boolean): string | null =>
    totalNav === null || totalNav.isZero()
      ? null
      : toDecimalString(navOf(marked.filter(belongs)).div(totalNav));

  // The sponsor, as the sponsor page has it: every position with it, pooled, and its commitments.
  const sponsor = (
    await tx
      .select({ tier: schema.sponsor.tier })
      .from(schema.sponsor)
      .where(eq(schema.sponsor.id, deal.sponsorId))
  )[0];
  const withSponsor = positions.filter((p) => p.row.sponsorId === deal.sponsorId);
  const sponsorMoic = pooledPositionMetrics(
    withSponsor.map((p) => ({
      flows: p.flows,
      valuations: p.valuations,
      isActive: p.row.isActive,
    })),
    asOf,
  ).grossMoic;
  const funds = new Set(
    (await loadCommitmentRows(tx, asOf, eq(schema.sponsor.id, deal.sponsorId))).map(
      (c) => c.sponsorFundId,
    ),
  );
  let commitment: FundCommitment = 'none';
  if (deal.sponsorFundId !== null && funds.has(deal.sponsorFundId)) commitment = 'fund';
  else if (funds.size > 0) commitment = 'otherFund';

  // Size against the held positions of the deal's own type.
  const sizes = held
    .filter((p) => p.row.dealType === deal.dealType && p.summary.invested !== null)
    .map((p) => p.summary.invested ?? '0');
  const typical = median(sizes);
  const medianPosition = toDecimalString(typical);
  const comparable = deal.currency === BOOK_CURRENCY ? deal.targetCommitment : null;
  const sizeRatio =
    comparable === null || typical === null || typical.lte(ZERO)
      ? null
      : toDecimalString(D(comparable).div(typical));

  const inputs: OpportunityFit['inputs'] = {
    sponsorTier: sponsor?.tier ?? null,
    sponsorPositions: withSponsor.length,
    sponsorMoic,
    commitment,
    sector: deal.sector,
    sectorShare: deal.sector === null ? null : shareOf((p) => p.row.sector === deal.sector),
    sponsorShare: shareOf((p) => p.row.sponsorId === deal.sponsorId),
    geography: deal.geography,
    geographyShare:
      deal.geography === null ? null : shareOf((p) => p.row.geography === deal.geography),
    targetCommitment: deal.targetCommitment,
    currency: deal.currency,
    comparablePositions: sizes.length,
    medianPosition,
    sizeRatio,
  };

  const measures = dealFit(
    {
      sponsorTier: inputs.sponsorTier,
      sponsorMoic: inputs.sponsorMoic,
      commitment: inputs.commitment,
      sectorShare: inputs.sectorShare,
      sponsorShare: inputs.sponsorShare,
      geographyShare: inputs.geographyShare,
      targetCommitment: comparable,
      medianPosition,
    },
    thresholds,
  );

  return {
    opportunityId: deal.id,
    asOf,
    measures: measures.map((m) => ({
      key: m.key,
      score: toDecimalString(m.score),
      missing: m.missing,
    })),
    inputs,
    thresholds,
    calcVersion: CALC_VERSION,
  };
}
