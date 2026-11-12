/*
 * The names the value creation views share with the API contract (docs/08 section 8). They live
 * apart from the functions so a consumer that only needs the names bundles nothing else.
 */

/**
 * Why a figure of the value creation views is not calculable, in the order every view lists the
 * reasons. The first five say why a company has no EBITDA bridge: no approved entry snapshot, an
 * approved entry snapshot dated after the as-of date, no approved quarter on or before the as-of
 * date (or the exit), an EBITDA, EV or net debt missing at either end, or an EBITDA at or below
 * zero at either end. The last two say why our gain is not set against a bridge that stands: the
 * company's equity value at entry is not positive (no stake), or our own gain is not calculable
 * (no Locked valuation, or nothing invested).
 */
export const VALUE_CREATION_REASONS = [
  'no_entry_snapshot',
  'entry_snapshot_forward_dated',
  'no_current_quarter',
  'missing_figures',
  'non_positive_ebitda',
  'non_positive_entry_equity',
  'no_gain',
] as const;
export type ValueCreationReason = (typeof VALUE_CREATION_REASONS)[number];

/** The key of the cohort that holds the positions with no entry figure to band. */
export const NOT_CALCULABLE_BAND = 'not_calculable';
