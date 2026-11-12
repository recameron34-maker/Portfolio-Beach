import { useMemo } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { ValueCreationFilters } from '@pb/contracts';
import { parseValueCreationSearch, valueCreationSearch } from './value-creation-filters.js';

/**
 * The filters of the tab, read from and written to the URL search, so the address of a filtered
 * view can be shared and both tabs read the same state. A change replaces the history entry: a
 * reader goes back to the page they came from, not through every filter they tried.
 */
export function useValueCreationFilters(): [
  ValueCreationFilters,
  (next: ValueCreationFilters) => void,
] {
  const search: Record<string, unknown> = useSearch({ strict: false });
  const navigate = useNavigate();
  const filters = useMemo(() => parseValueCreationSearch(search), [search]);
  const setFilters = (next: ValueCreationFilters): void => {
    // The two tabs' routes validate the same search (parseValueCreationSearch in the router); a
    // navigation that is not tied to one of them has no single search type to name.
    void navigate({ to: '.', search: valueCreationSearch(next) as never, replace: true });
  };
  return [filters, setFilters];
}
