import type { InvestmentSummary, SponsorSummary } from '@pb/contracts';
import type { BarDatum } from '../../components/charts/index.js';
import type { Tone } from '../../components/ui.js';
import { formatMoneyM, MISSING } from '../../lib/format.js';

/** Tier chips: a core relationship in the brand tone, a sponsor on watch in the watch tone, the rest neutral. */
const TIER_TONES: Readonly<Record<string, Tone>> = {
  'sponsor_tier.core': 'brand',
  'sponsor_tier.watch': 'watch',
};

export function tierTone(tier: string): Tone {
  return TIER_TONES[tier] ?? 'neutral';
}

/**
 * Fund sizes are in the fund's own currency. formatMoneyM writes US dollars, so a fund in another
 * currency shows its code in place of the dollar sign ("EUR 500.0M"); the figure is never converted.
 */
export function fundSizeLabel(value: string | null, currency: string): string {
  const label = formatMoneyM(value);
  if (label === MISSING || currency === 'USD') return label;
  return label.replace('$', `${currency} `);
}

/** Sponsors whose name contains the search text, ignoring case and surrounding spaces. */
export function filterSponsors(items: readonly SponsorSummary[], search: string): SponsorSummary[] {
  const needle = search.trim().toLowerCase();
  return needle === '' ? [...items] : items.filter((s) => s.name.toLowerCase().includes(needle));
}

export function sponsorCountLabel(shown: number, total: number): string {
  const noun = total === 1 ? 'sponsor' : 'sponsors';
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
}

export interface NavBars {
  bars: BarDatum[];
  /** Active positions left out because they have no Locked valuation. */
  withoutNav: number;
}

/**
 * NAV per active position, largest first, for the bar chart. Number is used for bar geometry
 * only; each label is the API's figure formatted. A company held twice gets its investment
 * number in the label so every bar stays distinct.
 */
export function navByPosition(positions: readonly InvestmentSummary[]): NavBars {
  const active = positions.filter((p) => p.isActive);
  const withNav = active.filter((p): p is InvestmentSummary & { nav: string } => p.nav !== null);
  const names = new Map<string, number>();
  for (const p of withNav) names.set(p.companyName, (names.get(p.companyName) ?? 0) + 1);
  const bars = withNav
    .map((p) => ({
      label:
        (names.get(p.companyName) ?? 0) > 1
          ? `${p.companyName} (${p.investmentNumber})`
          : p.companyName,
      value: Number(p.nav),
      display: formatMoneyM(p.nav),
    }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  return { bars, withoutNav: active.length - withNav.length };
}
