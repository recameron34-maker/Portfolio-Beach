import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryKey, UseMutationResult } from '@tanstack/react-query';
import { reportPackageDetail, reportPackageList, rowVersionEtag } from '@pb/contracts';
import type {
  ReportPackageCommandBody,
  ReportPackageCreateBody,
  ReportPackageDetail,
} from '@pb/contracts';
import { api } from '../../../api/client.js';
import { invalidate } from '../../../app/mutations.js';
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

/** The reads a package write can change: the list, the package, and the audit trail every write adds to. */
export const PACKAGE_KEYS: QueryKey[] = [['report-packages'], ['report-package'], ['audit']];

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
  });
}

export interface PackageCommandVariables {
  id: string;
  /** The row version of the package as the person was shown it. */
  rowVersion: number;
  body: ReportPackageCommandBody;
}

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
  });
}
