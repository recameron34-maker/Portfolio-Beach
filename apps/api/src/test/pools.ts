import type { PooledMetrics } from '@pb/contracts';

/**
 * What every pooled view answers for a set with no position at all: nothing is calculable, so
 * every figure is null (never 0) and the IRR flag says why (docs/06 section 3). Written out here
 * rather than taken from the API, so the tests check the rule instead of repeating the code.
 */
export const NOTHING_POOLED: PooledMetrics = {
  count: 0,
  invested: null,
  distributions: null,
  nav: null,
  dpi: null,
  rvpi: null,
  tvpi: null,
  grossMoic: null,
  grossIrr: null,
  irrFlag: 'insufficient_flows',
};
