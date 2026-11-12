import { valueCreationRollup } from '@pb/calc';
import { matchesValueCreationFilters } from '@pb/contracts';
import type { ValueCreation, ValueCreationFilters, ValueCreationPosition } from '@pb/contracts';

/*
 * The view a tab shows: the positions that pass the filters and their roll-up. The roll-up is
 * @pb/calc's own (valueCreationRollup, docs/08 section 8), the function the API answers
 * `portfolio` and `cohorts` with, run here over the rows the response carries: with no filter
 * set it gives the API's figures back field for field, and with a filter it recomputes every
 * figure exactly (the tiles, the bridge, the cohorts with their pooled MOIC and IRR), so there is
 * one rule and not two. The bands are the response's own cohorts, never restated in the page.
 *
 * This module is the only one of the web app's pages that imports the roll-up, and the two tabs
 * that use it load on demand (Analytics.tsx), so the entry chunk does not carry it.
 */

export interface ShownView {
  asOf: string;
  /** The positions that pass the filters, in the response's order. */
  positions: ValueCreationPosition[];
  portfolio: ValueCreation['portfolio'];
  cohorts: ValueCreation['cohorts'];
  /** How many positions the caller can see, before any filter. */
  total: number;
}

export function shownView(view: ValueCreation, filters: ValueCreationFilters): ShownView {
  const positions = view.positions.filter((p) => matchesValueCreationFilters(p, filters));
  return {
    asOf: view.asOf,
    positions,
    ...valueCreationRollup(positions, view.cohorts, view.asOf),
    total: view.positions.length,
  };
}
