import type { DOCUMENT_SET_SCENARIOS } from './documents.js';

/** Volumes per profile (docs/14 section 2). `small` keeps unit tests fast. */
export interface Profile {
  name: string;
  sponsors: number;
  fundsPerSponsorMax: number;
  activeInvestments: number;
  realizedInvestments: number;
  quartersPerInvestment: number;
  clients: number;
}

export const PROFILES: Record<string, Profile> = {
  small: {
    name: 'small',
    sponsors: 8,
    fundsPerSponsorMax: 2,
    activeInvestments: 16,
    realizedInvestments: 4,
    quartersPerInvestment: 8,
    clients: 3,
  },
  default: {
    name: 'default',
    sponsors: 40,
    fundsPerSponsorMax: 3,
    activeInvestments: 160,
    realizedInvestments: 40,
    quartersPerInvestment: 12,
    clients: 3,
  },
};

/** Scenario tags the generator must produce in every profile (docs/14 section 3, data-level tags). */
export const DATA_SCENARIOS = [
  'missing_prior_year',
  'period_end_shift',
  'forward_entry_snapshot',
  'negative_ebitda',
  'near_miss_names',
  'two_clients_one_fund',
  'restatement',
  'stale_valuation',
  'roll_forward_break',
  'wire_change',
  'equalization',
  'walled_deal',
  'multiple_irr',
  'pik_toggle',
  'covenant_breach',
  'credit_amortization',
  'credit_prepayment',
  'lp_second_closing',
  // The Phase 3 controls (docs/14 section 10; CONTROL_SCENARIOS in controls.ts lists the same tags).
  'sourced_deal',
  'closing_open',
  'passed_deal',
  'walled_opportunity',
  'ic_pending',
  'change_request_open',
] as const;
export type DataScenario = (typeof DATA_SCENARIOS)[number];

/**
 * Tags that live on the truth sidecars of the document set and must appear in every profile
 * (docs/14 section 9). Typed as the generator's own list (`DOCUMENT_SET_SCENARIOS` in
 * documents.ts), so the two cannot drift: a tag listed here but not produced, or produced but
 * not listed, fails the type check. `units_millions`, `qtd_ytd_basis` and `sign_flip` from the
 * docs/14 scenario table are not produced yet and are not listed.
 */
export const DOCUMENT_SCENARIOS: typeof DOCUMENT_SET_SCENARIOS = [
  'injection_doc',
  'duplicate_doc',
  'untagged_doc',
  'late_financials',
  'restatement',
];
