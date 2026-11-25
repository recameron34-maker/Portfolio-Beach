import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryKey, UseMutationResult } from '@tanstack/react-query';
import { reportPackageDetail, reportPackageList, rowVersionEtag } from '@pb/contracts';
import type {
  ReportPackageCommandBody,
  ReportPackageCreateBody,
  ReportPackageDetail,
} from '@pb/contracts';
import { api, ApiError } from '../../../api/client.js';
import { describeActionError, invalidate } from '../../../app/mutations.js';
import { retryUnlessUnavailable } from '../../../lib/unavailable.js';

/*
 * The reads and writes of the reporting packages (docs/04 M14, docs/18 section 5, decision
 * 0024), beside the pages that show them (the pattern of pages/capital/api.ts). The list takes
 * no parameters: it answers every package of the clients the caller reads, newest period first,
 * and the page filters it in the browser. Both writes are idempotent (the client names each with
 * a key); a command carries the row version the person was shown as If-Match, so a package
 * somebody moved meanwhile is refused instead of being moved twice.
 */

const BASE = '/api/v1/report-packages';

/** The packages of the clients the caller reads (GET /report-packages; 403 outside the roles that read packages). */
export function reportPackagesQuery() {
  return queryOptions({
    queryKey: ['report-packages'],
    queryFn: () => api(BASE, reportPackageList),
    retry: retryUnlessUnavailable,
  });
}

/**
 * One package with its snapshot, the findings of its latest run and its change log
 * (GET /report-packages/{id}; 404 for a package of a client the caller does not read).
 */
export function reportPackageQuery(id: string) {
  return queryOptions({
    queryKey: ['report-package', id],
    queryFn: () => api(`${BASE}/${encodeURIComponent(id)}`, reportPackageDetail),
    retry: retryUnlessUnavailable,
  });
}

/** POST /report-packages: a Draft for a client, a quarter and a basis (investor relations). */
export function postStartPackage(body: ReportPackageCreateBody): Promise<ReportPackageDetail> {
  return api(BASE, reportPackageDetail, { method: 'POST', body: JSON.stringify(body) });
}

/**
 * POST /report-packages/{id}/commands: generate, regenerate, overrideQa, submit, approve or
 * release. The If-Match header carries the row version the person was shown.
 */
export function postPackageCommand(
  id: string,
  body: ReportPackageCommandBody,
  rowVersion: number,
): Promise<ReportPackageDetail> {
  return api(`${BASE}/${encodeURIComponent(id)}/commands`, reportPackageDetail, {
    method: 'POST',
    headers: { 'if-match': rowVersionEtag(rowVersion) },
    body: JSON.stringify(body),
  });
}

/** The reads that show where a package stands: the list and the package. */
export const PACKAGE_READS: QueryKey[] = [['report-packages'], ['report-package']];

/** The reads a package write can change: where it stands, and the audit trail every write adds to. */
export const PACKAGE_KEYS: QueryKey[] = [...PACKAGE_READS, ['audit']];

/**
 * Starts a package. A refusal reads the list again, as a refused command does: what refuses a
 * start is most often what somebody else did meanwhile (the same package started, or the one in
 * progress released), and the form works out from the list whether to link to the package in the
 * way or to ask for the reason of a new version.
 */
export function useStartPackage(): UseMutationResult<
  ReportPackageDetail,
  Error,
  ReportPackageCreateBody
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ReportPackageCreateBody) => postStartPackage(body),
    onSuccess: (detail) => {
      // The package page opens on the answer instead of a second read.
      queryClient.setQueryData(['report-package', detail.id], detail);
      invalidate(queryClient, PACKAGE_KEYS);
    },
    onError: () => invalidate(queryClient, PACKAGE_READS),
  });
}

export interface PackageCommandVariables {
  id: string;
  /** The row version of the package as the person was shown it. */
  rowVersion: number;
  body: ReportPackageCommandBody;
}

/**
 * Moves a package. The answer becomes the package the page shows, so the next command carries
 * its row version. A refusal reads the package and the list again: what refuses a command is
 * most often what somebody else did to the package meanwhile (a stale row version above all),
 * and the page must then show where it stands, with the row version the next try needs.
 */
export function usePackageCommand(): UseMutationResult<
  ReportPackageDetail,
  Error,
  PackageCommandVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, rowVersion, body }: PackageCommandVariables) =>
      postPackageCommand(id, body, rowVersion),
    onSuccess: (detail) => {
      queryClient.setQueryData(['report-package', detail.id], detail);
      invalidate(queryClient, PACKAGE_KEYS);
    },
    onError: () => invalidate(queryClient, PACKAGE_READS),
  });
}

/**
 * The sentence for a refused command. A stale row version says that somebody moved the package
 * first and that the page was read again; anything else is worded as on every workflow page
 * (the rule behind a refusal, without the control it cites).
 */
export function describePackageError(error: unknown): string {
  if (error instanceof ApiError && error.status === 412)
    return 'Someone changed this package first, so nothing was done. The page now shows it as it stands.';
  return describeActionError(error);
}
