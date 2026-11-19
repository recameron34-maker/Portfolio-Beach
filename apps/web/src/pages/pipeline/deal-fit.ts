import type { FitMeasure, FitMeasureKey, OpportunityFit } from '@pb/contracts';
import {
  formatMoic,
  formatMoneyM,
  formatMoneyMIn,
  formatMultiple,
  formatPct,
  joinList,
  labelOf,
  MISSING,
  plural,
} from '../../lib/format.js';

/*
 * What the "Portfolio fit" card says about each measure (docs/08 section 8, decision 0018). The
 * scores, the figures and the thresholds all come from the API; this file only words them, so a
 * reader can check a score against its rule by hand. No money is added, divided or compared here.
 */

/** What the wording needs from the deal itself; the fit answer carries codes and figures, not names. */
export interface FitDeal {
  sponsorName: string;
  fundName: string | null;
  dealType: string;
}

export interface FitRow {
  key: FitMeasureKey;
  /** Two short words, for the chart's axis. */
  axis: string;
  /** The name in the list beside the chart. */
  name: string;
  /** The score as a number, for drawing only; null when the measure has none. */
  value: number | null;
  /** The score as a reader sees it: a whole number, or the missing placeholder. */
  display: string;
  /** The recorded figure the score was worked out from, or why there is no score. */
  basis: string;
  /** The rule that turns the figure into a score, with its thresholds. */
  rule: string;
}

const NAMES: Record<FitMeasureKey, { axis: string; name: string }> = {
  sponsor_relationship: { axis: 'Sponsor tier', name: 'Sponsor relationship' },
  track_record: { axis: 'Track record', name: 'Track record with the sponsor' },
  fund_relationship: { axis: 'Fund commitment', name: 'Fund relationship' },
  sector_room: { axis: 'Sector room', name: 'Room in the sector' },
  sponsor_room: { axis: 'Sponsor room', name: 'Room with the sponsor' },
  geography_room: { axis: 'Geography room', name: 'Room in the geography' },
  size_fit: { axis: 'Deal size', name: 'Deal size' },
};

/** A score from 0 to 100 as a whole number; the missing placeholder for none. */
export function fitScore(score: string | null): string {
  if (score === null) return MISSING;
  const n = Number(score);
  return Number.isFinite(n) ? String(Math.round(n)) : MISSING;
}

/** "an Active", "a Core": the article a label takes. */
const withArticle = (label: string): string => `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`;

/** A threshold or a configured score as it is written: no trailing zeros, no rounding. */
const plain = (value: string): string => {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : value;
};

const NO_NAV = 'No held position has a NAV to take a share of.';

function basisOf(measure: FitMeasure, fit: OpportunityFit, deal: FitDeal): string {
  const i = fit.inputs;
  const sponsor = deal.sponsorName;
  switch (measure.key) {
    case 'sponsor_relationship':
      if (i.sponsorTier === null) return `No tier is recorded for ${sponsor}.`;
      return measure.score === null
        ? `${sponsor} is ${withArticle(labelOf(i.sponsorTier))} sponsor, a tier with no set score.`
        : `${sponsor} is ${withArticle(labelOf(i.sponsorTier))} sponsor.`;
    case 'track_record': {
      if (i.sponsorPositions === 0) return `We have no position with ${sponsor} to judge by.`;
      const ours = `Our ${plural(i.sponsorPositions, 'position')} with ${sponsor}`;
      const verb = i.sponsorPositions === 1 ? 'has' : 'have';
      return measure.score === null
        ? `${ours} ${verb} no calculable MOIC yet.`
        : `${ours} ${verb} a pooled gross MOIC of ${formatMoic(i.sponsorMoic)}.`;
    }
    case 'fund_relationship':
      if (i.commitment === 'fund')
        return deal.fundName === null
          ? "The firm has a commitment to the deal's own fund."
          : `The firm has a commitment to ${deal.fundName}, the fund this deal comes from.`;
      if (i.commitment === 'otherFund')
        return deal.fundName === null
          ? `The firm has a commitment to a fund of ${sponsor}; the deal names no fund.`
          : `The firm has a commitment to another fund of ${sponsor}, not to ${deal.fundName}.`;
      return `The firm has no commitment to a fund of ${sponsor}.`;
    case 'sector_room':
      if (i.sector === null) return 'No sector is recorded on the deal.';
      return i.sectorShare === null
        ? NO_NAV
        : `${labelOf(i.sector)} is ${formatPct(i.sectorShare)} of held NAV.`;
    case 'sponsor_room':
      return i.sponsorShare === null
        ? NO_NAV
        : `${sponsor} is ${formatPct(i.sponsorShare)} of held NAV.`;
    case 'geography_room':
      if (i.geography === null) return 'No geography is recorded on the deal.';
      return i.geographyShare === null
        ? NO_NAV
        : `${labelOf(i.geography)} is ${formatPct(i.geographyShare)} of held NAV.`;
    case 'size_fit': {
      if (i.targetCommitment === null) return 'No target commitment is recorded on the deal.';
      const target = formatMoneyMIn(i.targetCommitment, i.currency);
      if (measure.missing === 'no_target_commitment')
        return `The target of ${target} is not in the currency the positions are held in, and nothing is converted.`;
      const type = labelOf(deal.dealType);
      if (i.medianPosition === null || i.sizeRatio === null)
        return `No held ${type} position has invested capital to compare the target with.`;
      return `The target of ${target} is ${formatMoic(i.sizeRatio)} the median held ${type} position (${formatMoneyM(i.medianPosition)} across ${plural(i.comparablePositions, 'position')}).`;
    }
  }
}

function ruleOf(key: FitMeasureKey, fit: OpportunityFit): string {
  const t = fit.thresholds;
  const room = (cap: string): string =>
    `Nothing held scores 100; ${formatPct(cap)} of held NAV or more scores 0.`;
  switch (key) {
    case 'sponsor_relationship': {
      // Highest score first; equal scores keep the order they were configured in.
      const tiers = Object.entries(t.tierScores)
        .map(([tier, score]) => ({ tier, score }))
        .sort((a, b) => Number(b.score) - Number(a.score));
      return `Each tier has a set score: ${tiers.map((x) => `${labelOf(x.tier)} ${plain(x.score)}`).join(', ')}.`;
    }
    case 'track_record':
      return `${formatMoic(t.trackRecord.zeroAtMoic)} or less scores 0; ${formatMoic(t.trackRecord.fullAtMoic)} or more scores 100.`;
    case 'fund_relationship':
      return `A commitment to the deal's own fund scores ${plain(t.fundRelationship.fund)}, to another fund of the sponsor ${plain(t.fundRelationship.otherFund)}, to none ${plain(t.fundRelationship.none)}.`;
    case 'sector_room':
      return room(t.caps.sector);
    case 'sponsor_room':
      return room(t.caps.sponsor);
    case 'geography_room':
      return room(t.caps.geography);
    case 'size_fit':
      return `From ${formatMultiple(t.size.low)} to ${formatMultiple(t.size.high)} the median scores 100; nothing and ${formatMultiple(t.size.limit)} or more score 0.`;
  }
}

/** One row per measure, in the order the API answered them. */
export function fitRows(fit: OpportunityFit, deal: FitDeal): FitRow[] {
  return fit.measures.map((measure) => {
    const display = fitScore(measure.score);
    return {
      key: measure.key,
      ...NAMES[measure.key],
      value: display === MISSING ? null : Number(display),
      display,
      basis: basisOf(measure, fit, deal),
      rule: ruleOf(measure.key, fit),
    };
  });
}

/** The chart in a sentence: how many measures have a score, and where the deal is strongest and weakest. */
export function fitSummary(rows: readonly FitRow[]): string {
  const scored = rows.filter((r): r is FitRow & { value: number } => r.value !== null);
  const total = rows.length;
  if (scored.length === 0)
    return `None of the ${total} measures has a score: the figures they need are not recorded.`;
  const only = scored[0];
  if (scored.length === 1 && only !== undefined)
    return `1 of ${total} measures has a score: ${only.axis} (${only.display}).`;
  const count =
    scored.length === total ? `All ${total} measures` : `${scored.length} of ${total} measures`;
  const high = Math.max(...scored.map((r) => r.value));
  const low = Math.min(...scored.map((r) => r.value));
  if (high === low) return `${count} have a score, each of ${high}.`;
  const names = (value: number): string =>
    joinList(scored.filter((r) => r.value === value).map((r) => r.axis));
  return `${count} have a score. Strongest: ${names(high)} (${high}). Weakest: ${names(low)} (${low}).`;
}
