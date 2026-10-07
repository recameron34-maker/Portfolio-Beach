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
] as const;
export type DataScenario = (typeof DATA_SCENARIOS)[number];

/** Tags that live in documents or expected-document records and arrive with the PDF generator (Phase 2). */
export const DOCUMENT_SCENARIOS = [
  'units_millions',
  'qtd_ytd_basis',
  'sign_flip',
  'injection_doc',
  'duplicate_doc',
  'untagged_doc',
  'late_financials',
] as const;
