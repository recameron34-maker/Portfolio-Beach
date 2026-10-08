import type { AnalyticsSummary } from '@pb/contracts';
import type { InvestmentFilters } from '../../app/queries.js';

/** The bucket lists of the exposures; vehicleByDealType is the stacked breakdown, not a dimension. */
export type DimensionKey = Exclude<keyof AnalyticsSummary['exposures'], 'vehicleByDealType'>;

/** The exposure dimensions the API buckets, in the order the selector lists them. */
export const DIMENSION_KEYS: readonly DimensionKey[] = [
  'sector',
  'geography',
  'dealType',
  'vehicle',
  'sponsor',
  'vintage',
];

export const DIMENSION_LABELS: Record<DimensionKey, string> = {
  sector: 'Sector',
  geography: 'Geography',
  dealType: 'Deal type',
  vehicle: 'Vehicle',
  sponsor: 'Sponsor',
  vintage: 'Vintage',
};

export function isDimensionKey(value: string): value is DimensionKey {
  return (DIMENSION_KEYS as readonly string[]).includes(value);
}

/* Investment list filters, exactly as the preview recorder expects their query keys. */
export const CREDIT_POSITIONS: InvestmentFilters = {
  dealType: 'deal_type.private_credit',
  limit: 100,
};
export const REALIZED_POSITIONS: InvestmentFilters = { active: 'false', limit: 100 };
