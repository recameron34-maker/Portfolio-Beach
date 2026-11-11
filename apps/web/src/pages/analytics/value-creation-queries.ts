import { queryOptions } from '@tanstack/react-query';
import { investmentValueCreation, problemDetails, valueCreation } from '@pb/contracts';
import type { ProblemDetails } from '@pb/contracts';
import { api, ApiError } from '../../api/client.js';
import { getCredential } from '../../app/session.js';
import { retryUnlessUnavailable } from '../../lib/unavailable.js';

/*
 * The value creation reads (docs/04 M13 and M20). Each sends a fixed path with no parameters, so
 * scripts/preview-plan.mjs records exactly these keys; the tabs sort and open detail in the page
 * over the one answer, as the other analytics tabs do.
 */

export const VALUE_CREATION_PATH = '/api/v1/analytics/value-creation';
export const VALUE_CREATION_EXPORT_PATH = '/api/v1/analytics/value-creation/export';

/**
 * Value creation by position, the roll-up of our gain by driver and the entry metric cohorts.
 * The key sits under 'analytics-summary', so every write that refreshes the analytics summary (a
 * Locked valuation, promoted quarterly figures, a closed deal: the key lists in app/mutations.ts)
 * refreshes this read with it.
 */
export const valueCreationQuery = queryOptions({
  queryKey: ['analytics-summary', 'value-creation'],
  queryFn: () => api(VALUE_CREATION_PATH, valueCreation),
  retry: retryUnlessUnavailable,
});

/**
 * One position's bridge, entry against current metrics and indexed series. The API audits every
 * open (SEC-11.1), so the answer stays fresh for a minute and a tab switch reads the cache. The
 * key sits under the position's 'investment-performance' key, so the writes that refresh its
 * performance refresh this read too.
 */
export function investmentValueCreationQuery(id: string) {
  return queryOptions({
    queryKey: ['investment-performance', id, 'value-creation'],
    queryFn: () =>
      api(`/api/v1/investments/${encodeURIComponent(id)}/value-creation`, investmentValueCreation),
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * GET /api/v1/analytics/value-creation/export: the same positions as text/csv. The body is not
 * JSON, so it bypasses the typed client and parses nothing; the credential travels in the header
 * as on every other call (SEC-4.5), which is why the page fetches the text and offers it as a
 * download instead of linking the URL. A failure is the API's problem, as an ApiError.
 */
export async function fetchValueCreationExport(): Promise<string> {
  const headers = new Headers({ accept: 'text/csv' });
  const credential = getCredential();
  if (credential !== null) headers.set('authorization', `Bearer ${credential}`);
  const res = await fetch(VALUE_CREATION_EXPORT_PATH, { headers });
  if (!res.ok) {
    let problem: ProblemDetails;
    try {
      problem = problemDetails.parse(await res.json());
    } catch {
      problem = {
        type: 'about:blank',
        title: res.statusText || 'Request failed',
        status: res.status,
        request_id: res.headers.get('x-request-id') ?? 'unknown',
      };
    }
    throw new ApiError(problem);
  }
  return res.text();
}
