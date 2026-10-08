import { useQuery } from '@tanstack/react-query';
import { registerTaxonomyLabels } from '../lib/format.js';
import { taxonomyQuery } from './queries.js';

/**
 * Loads the taxonomy once per session and registers its labels for labelOf, so every page shows
 * "SOFR" or "Financial services" exactly as core.taxonomy_term names them. Returns true once the
 * labels are in place or the read failed (labelOf then falls back to labels generated from the
 * code), so the shell can hold the page for that one request instead of re-rendering its labels.
 */
export function useTaxonomyLabels(): boolean {
  const q = useQuery({ ...taxonomyQuery, retry: false });
  if (q.data !== undefined) registerTaxonomyLabels(q.data.domains.flatMap((d) => d.terms));
  return q.data !== undefined || q.isError;
}
