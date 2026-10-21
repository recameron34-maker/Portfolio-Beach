import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, QueryKey, UseMutationResult } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  capitalNoticeRow,
  documentDetail,
  documentIndexResult,
  expectedDocumentGenerateResult,
  featureFlag,
  intakeFileDetail,
  intakeImportResult,
  previewResetResult,
  realizationOutlookDetail,
  valuationRow,
} from '@pb/contracts';
import type {
  CapitalNoticeCommand,
  CapitalNoticeRow,
  DocumentCommandBody,
  DocumentDetail,
  DocumentIndexResult,
  ExpectedDocumentGenerateBody,
  ExpectedDocumentGenerateResult,
  IntakeCommandBody,
  IntakeFileDetail,
  IntakeImportBody,
  IntakeImportResult,
  RealizationOutlookBody,
  RealizationOutlookDetail,
  ValuationCommand,
  ValuationRow,
} from '@pb/contracts';
import type { z as zod } from 'zod';
import { api, ApiError } from '../api/client.js';
import { commandLabel, humanizeState } from '../lib/states.js';
import { previewMode } from './env.js';

/**
 * Workflow writes (docs/18). The API serves them in Phase 3; the static preview simulates them in
 * the browser through the same transition tables (packages/contracts/src/simulated.ts). Pages go
 * through these helpers, never through fetch, so both paths share one request shape and one
 * vocabulary for refusals.
 */
export interface CommandBody<C extends string> {
  command: C;
  reason?: string;
}

export interface ValuationCreateBody {
  investmentId: string;
  periodEnd: string;
  method: string;
  fairValue: string;
}

function post<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  return api(path, schema, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function postValuation(body: ValuationCreateBody): Promise<ValuationRow> {
  return post('/api/v1/valuations', valuationRow, body);
}

export function postValuationCommand(
  id: string,
  body: CommandBody<ValuationCommand>,
): Promise<ValuationRow> {
  return post(`/api/v1/valuations/${encodeURIComponent(id)}/commands`, valuationRow, body);
}

export function postCapitalNoticeCommand(
  id: string,
  body: CommandBody<CapitalNoticeCommand>,
): Promise<CapitalNoticeRow> {
  return post(`/api/v1/capital-notices/${encodeURIComponent(id)}/commands`, capitalNoticeRow, body);
}

/**
 * POST /api/v1/intake/accounting: stage an accounting export (SEC-9.1). The body is the CSV as
 * text with its file name, or the id of an export the adapter lists in the drop folder. Operations
 * only; idempotent by content, so a repeat answers with the file staged before and duplicate true.
 */
export function postIntakeImport(body: IntakeImportBody): Promise<IntakeImportResult> {
  return post('/api/v1/intake/accounting', intakeImportResult, body);
}

/** POST /api/v1/intake/files/{id}/commands: approve validated rows (promoted at once) or reject flagged rows. */
export function postIntakeCommand(id: string, body: IntakeCommandBody): Promise<IntakeFileDetail> {
  return post(`/api/v1/intake/files/${encodeURIComponent(id)}/commands`, intakeFileDetail, body);
}

export type FeatureFlag = zod.infer<typeof featureFlag>;

export interface FlagChange {
  key: string;
  enabled: boolean;
  /** Required by the API (at least three characters) and kept in the audit trail. */
  reason: string;
}

/** PATCH /api/v1/flags/{key}: platform admins only; audited by the API, simulated in the preview. */
export function patchFlag({ key, enabled, reason }: FlagChange): Promise<FeatureFlag> {
  return api(`/api/v1/flags/${encodeURIComponent(key)}`, featureFlag, {
    method: 'PATCH',
    body: JSON.stringify({ enabled, reason }),
  });
}

export function useFlagChange(): UseMutationResult<FeatureFlag, Error, FlagChange> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (change: FlagChange) => patchFlag(change),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['flags'] }),
  });
}

export function postPreviewReset(): Promise<{ reset: true }> {
  return post('/api/v1/preview/reset', previewResetResult);
}

const NOT_IN_THIS_BUILD = 'Workflow actions arrive with Phase 3; this build reads only.';

/**
 * The transition tables word their refusals for engineers ("valuation: lock from DealTeamApproved
 * requires one of: approver"). The user needs the rule only: drop the machine name, spell out state
 * and command names and start with a capital ("Lock from Deal team approved requires one of:
 * approver", "Confirm funding is not allowed from Ticket drafted").
 */
export function plainRule(detail: string): string {
  const rule = detail
    .replace(/^[a-z_]+: /, '')
    .replace(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g, (state) => humanizeState(state))
    .replace(/\b[a-z]+(?:[A-Z][a-z]+)+\b/g, (command) => commandLabel(command).toLowerCase());
  return rule.charAt(0).toUpperCase() + rule.slice(1);
}

/**
 * One sentence the user can act on, from an RFC 9457 problem (docs/17 section 3). The status codes
 * follow the mapping the workflow controller and the preview simulation share: 403 role, 409
 * transition not in the table, 422 precondition, 412 stale row version. Values are never echoed.
 */
export function describeActionError(error: unknown): string {
  if (!(error instanceof ApiError))
    return error instanceof Error ? error.message : 'The action failed.';
  const detail = plainRule(error.problem.detail ?? error.problem.title);
  switch (error.status) {
    case 400:
      return `The request was not valid. ${detail}`;
    case 401:
      return 'Your session is no longer valid. Sign in again.';
    case 403:
      return `Your role cannot do this. ${detail}`;
    case 404:
      return previewMode ? detail : NOT_IN_THIS_BUILD;
    case 409:
      return `Not allowed from the current state. ${detail}`;
    case 412:
      return 'Someone changed this record first. Reload and try again.';
    case 422:
      return `Blocked by a rule. ${detail}`;
    case 501:
      return NOT_IN_THIS_BUILD;
    default:
      return detail;
  }
}

export interface CommandVariables<C extends string> {
  id: string;
  body: CommandBody<C>;
}

/**
 * The reads a write can change. A Locked valuation moves NAV wherever it is pooled (grid, one-pager,
 * performance, vehicle, sponsor, analytics, watchlist, weekly report); a funded notice moves called
 * and unfunded amounts and the report's capital activity. In the static preview these reads replay
 * their recordings (metrics are never recomputed), so refreshing them costs nothing; in Phase 3 it
 * keeps every page true after a write, including the reads held fresh for a minute.
 */
const VALUATION_KEYS: QueryKey[] = [
  ['valuations'],
  ['investment'],
  ['investments'],
  ['investment-performance'],
  ['vehicle'],
  ['vehicles'],
  ['sponsor'],
  ['analytics-summary'],
  ['watchlist'],
  ['weekly-report'],
  ['audit'],
];
const NOTICE_KEYS: QueryKey[] = [
  ['capital-notices'],
  ['capital-notice'],
  ['investment'],
  ['commitments'],
  ['vehicle'],
  ['sponsor'],
  ['clients'],
  ['weekly-report'],
  ['audit'],
];

/**
 * Promoted rows replace approved quarterly financials, which every read of a position's figures
 * pools; a staged file opens data exceptions that Data Health counts; and the staging itself is
 * audited (docs/04 M2). The drop folder listing changes once an export in it is staged.
 */
const INTAKE_KEYS: QueryKey[] = [
  ['intake-files'],
  ['intake-file'],
  ['intake-exports'],
  ['investment'],
  ['investments'],
  ['investment-performance'],
  ['data-health'],
  ['analytics-summary'],
  ['watchlist'],
  ['weekly-report'],
  ['audit'],
];

function invalidate(queryClient: QueryClient, keys: QueryKey[]): void {
  void Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

export function useValuationCommand(): UseMutationResult<
  ValuationRow,
  Error,
  CommandVariables<ValuationCommand>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: CommandVariables<ValuationCommand>) =>
      postValuationCommand(id, body),
    onSuccess: () => invalidate(queryClient, VALUATION_KEYS),
  });
}

export function useCreateValuation(): UseMutationResult<ValuationRow, Error, ValuationCreateBody> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ValuationCreateBody) => postValuation(body),
    onSuccess: () => invalidate(queryClient, VALUATION_KEYS),
  });
}

export function useCapitalNoticeCommand(): UseMutationResult<
  CapitalNoticeRow,
  Error,
  CommandVariables<CapitalNoticeCommand>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: CommandVariables<CapitalNoticeCommand>) =>
      postCapitalNoticeCommand(id, body),
    onSuccess: () => invalidate(queryClient, NOTICE_KEYS),
  });
}

export function useIntakeImport(): UseMutationResult<IntakeImportResult, Error, IntakeImportBody> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: IntakeImportBody) => postIntakeImport(body),
    onSuccess: (result) => {
      // The detail page the import navigates to opens on the answer instead of a second read.
      queryClient.setQueryData(['intake-file', result.id], result);
      invalidate(queryClient, INTAKE_KEYS);
    },
  });
}

export interface IntakeCommandVariables {
  id: string;
  body: IntakeCommandBody;
}

export function useIntakeCommand(): UseMutationResult<
  IntakeFileDetail,
  Error,
  IntakeCommandVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: IntakeCommandVariables) => postIntakeCommand(id, body),
    onSuccess: (updated) => {
      queryClient.setQueryData(['intake-file', updated.id], updated);
      invalidate(queryClient, INTAKE_KEYS);
    },
  });
}

/* Documents (docs/04 M3, docs/18 section 6, decision 0012). */

/** POST /api/v1/documents/index: scan the store; operations only; idempotent (a second scan answers unchanged). */
export function postIndexDocuments(): Promise<DocumentIndexResult> {
  return post('/api/v1/documents/index', documentIndexResult);
}

/** POST /api/v1/documents/{id}/commands: classify a NeedsReview document by hand (deal team, operations); audited. */
export function postDocumentCommand(
  id: string,
  body: DocumentCommandBody,
): Promise<DocumentDetail> {
  return post(`/api/v1/documents/${encodeURIComponent(id)}/commands`, documentDetail, body);
}

/** POST /api/v1/expected-documents/generate: the expected rows of a quarter; operations only; existing rows kept. */
export function postGenerateExpectedDocuments(
  body: ExpectedDocumentGenerateBody,
): Promise<ExpectedDocumentGenerateResult> {
  return post('/api/v1/expected-documents/generate', expectedDocumentGenerateResult, body);
}

/**
 * An index or a classification changes the hub, the queue, a document and its duplicates, the
 * expected rows a classified document matches, the monitoring board that reads them, the data
 * exceptions an unreadable file opens, and the audit trail.
 */
const DOCUMENT_KEYS: QueryKey[] = [
  ['documents'],
  ['document'],
  ['review-queue'],
  ['expected-documents'],
  ['monitoring-board'],
  ['data-health'],
  ['data-exceptions'],
  ['audit'],
];

export function useIndexDocuments(): UseMutationResult<DocumentIndexResult, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postIndexDocuments(),
    onSuccess: () => invalidate(queryClient, DOCUMENT_KEYS),
  });
}

export interface DocumentCommandVariables {
  id: string;
  body: DocumentCommandBody;
}

export function useClassifyDocument(): UseMutationResult<
  DocumentDetail,
  Error,
  DocumentCommandVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: DocumentCommandVariables) => postDocumentCommand(id, body),
    onSuccess: (updated) => {
      queryClient.setQueryData(['document', updated.id], updated);
      invalidate(queryClient, DOCUMENT_KEYS);
    },
  });
}

/** Generated rows appear on the tracker and the monitoring board; the generation is audited. */
const EXPECTED_KEYS: QueryKey[] = [['expected-documents'], ['monitoring-board'], ['audit']];

export function useGenerateExpectedDocuments(): UseMutationResult<
  ExpectedDocumentGenerateResult,
  Error,
  ExpectedDocumentGenerateBody
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ExpectedDocumentGenerateBody) => postGenerateExpectedDocuments(body),
    onSuccess: () => invalidate(queryClient, EXPECTED_KEYS),
  });
}

/** Preview only: forgets every simulated change in this page session. */
export function usePreviewReset(): UseMutationResult<{ reset: true }, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postPreviewReset(),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
}

/**
 * PUT /api/v1/monitoring/outlook/{investmentId}: the deal team sets the realization outlook by
 * hand, with a reason the API keeps on the audit event (docs/04 M9, SEC-11.1). Nothing automated
 * ever writes it: the API refuses unless definitions.realizationFlagEditableOnlyManually is on.
 */
export function putRealizationOutlook(
  investmentId: string,
  body: RealizationOutlookBody,
): Promise<RealizationOutlookDetail> {
  return api(
    `/api/v1/monitoring/outlook/${encodeURIComponent(investmentId)}`,
    realizationOutlookDetail,
    { method: 'PUT', body: JSON.stringify(body) },
  );
}

export interface OutlookVariables {
  investmentId: string;
  body: RealizationOutlookBody;
}

/**
 * The reads an outlook edit can change: the position's performance series carries the outlook
 * too, the watchlist and the realizations analytics read it, and the edit is audited.
 */
const OUTLOOK_KEYS: QueryKey[] = [
  ['realization-outlook'],
  ['investment-performance'],
  ['watchlist'],
  ['analytics-summary'],
  ['weekly-report'],
  ['audit'],
];

export function useSetRealizationOutlook(): UseMutationResult<
  RealizationOutlookDetail,
  Error,
  OutlookVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ investmentId, body }: OutlookVariables) =>
      putRealizationOutlook(investmentId, body),
    onSuccess: (detail) => {
      // The card shows the answer at once instead of waiting for a second read.
      queryClient.setQueryData(['realization-outlook', detail.investmentId], detail);
      invalidate(queryClient, OUTLOOK_KEYS);
    },
  });
}

/** Preview only: forgets every simulated change in this page session. */
export function usePreviewReset(): UseMutationResult<{ reset: true }, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postPreviewReset(),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
}
