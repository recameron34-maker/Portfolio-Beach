import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, QueryKey, UseMutationResult } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  IDEMPOTENCY_KEY_IN_PROGRESS,
  IDEMPOTENCY_KEY_ISSUE,
  IDEMPOTENCY_KEY_REUSE,
  IF_MATCH_ISSUE,
  capitalNoticeRow,
  documentDetail,
  documentIndexResult,
  expectedDocumentGenerateResult,
  extractionBatch,
  extractionRunDetail,
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
  ExtractionBatch,
  ExtractionBatchBody,
  ExtractionRunCommandBody,
  ExtractionRunDetail,
  IntakeCommandBody,
  IntakeFileDetail,
  IntakeImportBody,
  IntakeImportResult,
  ProblemDetails,
  RealizationOutlookBody,
  RealizationOutlookDetail,
  ValuationCommand,
  ValuationRow,
} from '@pb/contracts';
import type { z as zod } from 'zod';
import { api, ApiError } from '../api/client.js';
import { commandLabel, humanizeState } from '../lib/states.js';
import { withoutReferences } from '../lib/references.js';

/**
 * Workflow writes (docs/18). The API serves them (packages/contracts/src/routes-controls.ts); the
 * static preview simulates them in the browser through the same transition tables. Pages go
 * through these helpers, never through fetch, so both paths share one request shape and one
 * vocabulary for refusals. The Phase 3 domains keep their hooks beside their pages
 * (pages/valuations/api.ts, pages/capital/api.ts, pages/pipeline/api.ts) and reuse post,
 * invalidate and the key lists below.
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

/** POST a JSON body (or nothing) and parse the answer; the per-domain api files reuse it. */
export function post<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
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

/** A 501 is the one answer that means the build, not the record or the role, is behind. */
const NOT_SERVED = 'This build does not serve that action yet.';

/**
 * The transition tables word their refusals for engineers ("valuation: lock from DealTeamApproved
 * requires one of: approver"). The user needs the rule only: drop the machine name and the
 * reference to the control behind the rule, spell out state and command names and start with a
 * capital ("Lock from Deal team approved requires one of: approver", "Confirm funding is not
 * allowed from Ticket drafted").
 */
export { withoutReferences };

export function plainRule(detail: string): string {
  const rule = withoutReferences(detail)
    .replace(/^[a-z_]+: /, '')
    .replace(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g, (state) => humanizeState(state))
    .replace(/\b[a-z]+(?:[A-Z][a-z]+)+\b/g, (command) => commandLabel(command).toLowerCase());
  return rule.charAt(0).toUpperCase() + rule.slice(1);
}

/**
 * One sentence the user can act on, from a refusal's status and detail (docs/17 section 3). The
 * status codes follow the mapping the workflow controllers and the preview simulation share: 403
 * role, 409 transition not in the table, 422 precondition, 412 stale row version, 404 a record
 * the caller cannot see (the detail says so without hinting at what exists). Values are never
 * echoed. A batch answer carries one such status and detail per id (valuationBatchResult).
 */
export function describeRefusal(status: number, rawDetail: string): string {
  const detail = plainRule(rawDetail);
  switch (status) {
    case 400:
      return `The request was not valid. ${detail}`;
    case 401:
      return 'Your session is no longer valid. Sign in again.';
    case 403:
      return `Your role cannot do this. ${detail}`;
    case 404:
      return detail;
    case 409:
      return `Not allowed from the current state. ${detail}`;
    case 412:
      return 'Someone changed this record first. Reload and try again.';
    case 422:
      return `Blocked by a rule. ${detail}`;
    case 501:
      return NOT_SERVED;
    default:
      return detail;
  }
}

type Issue = NonNullable<ProblemDetails['errors']>[number];

/** "Fair value" stays as it is; "Bank name" after another part reads "bank name"; "IC decision" keeps its capitals. */
const lowerFirst = (words: string): string =>
  /^[A-Z][a-z]/.test(words) ? words.charAt(0).toLowerCase() + words.slice(1) : words;

/**
 * The path of a validation issue as a person reads the field: "fairValue" is "Fair value",
 * "bankDetails.bankName" is "Bank details, bank name", "allocations.0.requested" is
 * "Allocations, line 1, requested", and an id is called by what it names ("investmentId" is
 * "Investment"). Null for an issue about the body as a whole ("(root)").
 */
export function fieldLabel(path: string): string | null {
  if (path === '' || path === '(root)') return null;
  const parts = path.split('.').map((part) => {
    if (/^\d+$/.test(part)) return `line ${Number(part) + 1}`;
    return commandLabel(part.replace(/(?<=.)Ids$/, 's').replace(/(?<=.)Id$/, ''));
  });
  return parts.map((part, i) => (i === 0 ? part : lowerFirst(part))).join(', ');
}

/**
 * The messages zod writes by default (zod 4), in the words a person would use. A message that
 * is not listed is kept as the API wrote it: the contracts word their own rules plainly ("Must
 * be above zero", "Not a quarter end"). A pattern is never shown. mutations.test.ts builds these
 * messages from the contracts, so a zod upgrade that rewords them fails there.
 */
const PLAIN_MESSAGES: readonly (readonly [RegExp, string])[] = [
  [/^Invalid input: expected \w+, received undefined$/, 'Required'],
  [/^Too small: expected string to have >=1 characters$/, 'Required'],
  [/^Too small: expected string to have >=(\d+) characters$/, 'Needs at least $1 characters'],
  [/^Too big: expected string to have <=(\d+) characters$/, 'Allows at most $1 characters'],
  [/^Too small: expected array to have >=(\d+) items$/, 'Needs at least $1'],
  [/^Too big: expected array to have <=(\d+) items$/, 'Allows at most $1'],
  [/^Too small: expected number to be >=(\S+)$/, 'Must be $1 or more'],
  [/^Too big: expected number to be <=(\S+)$/, 'Must be $1 or less'],
  [/^Invalid (?:UUID|string: must match pattern .*)$/, 'Not in the expected format'],
  [
    /^Invalid (?:option: expected one of .*|discriminator value\..*|input: expected ".*")$/,
    'Not one of the allowed values',
  ],
  [/^Invalid input: expected \w+, received \w+$/, 'Not the expected kind of value'],
];

/** "Unrecognized key: "extra"" names fields, never values, so the names are shown. */
const UNRECOGNIZED_KEYS = /^Unrecognized keys?: (.*)$/;

function plainMessage(message: string): string {
  const unknownFields = UNRECOGNIZED_KEYS.exec(message)?.[1];
  if (unknownFields !== undefined)
    return `The server does not accept these fields: ${unknownFields.replace(/"/g, '')}`;
  for (const [pattern, words] of PLAIN_MESSAGES)
    if (pattern.test(message)) return message.replace(pattern, words);
  return message;
}

/** The headers the client sets itself; an issue about one is a fault of the app, not of what was entered. */
const HEADER_PATHS: ReadonlySet<string> = new Set([
  IDEMPOTENCY_KEY_ISSUE.path,
  IF_MATCH_ISSUE.path,
]);

/** How many issues one message lists before it counts the rest. */
const MAX_ISSUES = 5;

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * A validation refusal (400 with an `errors` list, docs/17 section 3) as sentences: each issue
 * with its field in words and what is wrong with it. The API lists paths and messages only,
 * never the values, so nothing entered is echoed here either.
 */
function describeIssues(
  issues: readonly Issue[],
  label: (path: string) => string | null = () => null,
): string {
  const header = issues.find((issue) => HEADER_PATHS.has(issue.path));
  if (header !== undefined)
    return `The app sent a request the server could not read (${header.path} header: ${header.message}). Nothing was changed. Reload the page and try again.`;
  const listed = issues.slice(0, MAX_ISSUES).map((issue) => {
    const field = label(issue.path) ?? fieldLabel(issue.path);
    const message = plainMessage(issue.message);
    return sentence(field === null ? message : `${field}: ${message}`);
  });
  const rest = issues.length - listed.length;
  return ['The request was not valid.', ...listed, ...(rest > 0 ? [`And ${rest} more.`] : [])].join(
    ' ',
  );
}

/**
 * The two refusals of the Idempotency-Key store (apps/web/src/api/idempotency.ts names each
 * write with a key). Neither is about the record's state or a business rule, so neither reads
 * as one: the first request may still be running (409), or the app sent one key with two
 * different bodies (422).
 */
const STILL_RUNNING =
  'This action is still running from an earlier try. Wait a moment, then check the record before you try again.';
const KEY_REUSED =
  'The app repeated an earlier request with different content, and the server refused it. Nothing was changed. Try again.';

/**
 * The sentence for a failed write: the issues of a validation refusal field by field, the
 * problem's refusal otherwise, or the error's own words. A form that calls a field by another
 * name than its path reads as gives `label` (null for a path it has no word for).
 */
export function describeActionError(
  error: unknown,
  label?: (path: string) => string | null,
): string {
  if (!(error instanceof ApiError))
    return error instanceof Error ? error.message : 'The action failed.';
  const { problem } = error;
  if (error.code === IDEMPOTENCY_KEY_IN_PROGRESS.code) return STILL_RUNNING;
  if (error.code === IDEMPOTENCY_KEY_REUSE.code) return KEY_REUSED;
  const issues = problem.status === 400 ? (problem.errors ?? []) : [];
  if (issues.length > 0) return describeIssues(issues, label);
  return describeRefusal(error.status, problem.detail ?? problem.title);
}

export interface CommandVariables<C extends string> {
  id: string;
  body: CommandBody<C>;
}

/**
 * The reads a write can change. A Locked valuation moves NAV wherever it is pooled (grid, one-pager,
 * performance, vehicle, sponsor, analytics, watchlist, weekly report) and every command changes the
 * version's own screen (its approval trail); a funded notice moves called and unfunded amounts,
 * the report's capital activity, its trade ticket and the wire register the ticket was approved
 * against. In the static preview these reads replay their recordings (metrics are never
 * recomputed), so refreshing them costs nothing; against the API it keeps every page true after a
 * write, including the reads held fresh for a minute. The per-domain api files (the api.ts
 * beside each Phase 3 page folder) spread these lists into their own.
 */
/**
 * The valuation suggestions (decision 0023). They are worked out again when a statement or a
 * report is approved, when an import is promoted and when a valuation is locked or reopened, and
 * what they offer follows the valuation versions of their quarter, so each of those writes
 * refreshes them.
 */
const SUGGESTION_READS: QueryKey[] = [['valuation-suggestions'], ['valuation-suggestion']];

export const VALUATION_KEYS: QueryKey[] = [
  ['valuations'],
  ['valuation'],
  ...SUGGESTION_READS,
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
export const NOTICE_KEYS: QueryKey[] = [
  ['capital-notices'],
  ['capital-notice'],
  ['trade-tickets'],
  ['trade-ticket'],
  ['wire-instructions'],
  ['wire-instruction'],
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
  ...SUGGESTION_READS,
  ['investment'],
  ['investments'],
  ['investment-performance'],
  ['data-health'],
  ['analytics-summary'],
  ['watchlist'],
  ['weekly-report'],
  ['audit'],
];

/** Refresh every read under these keys; the per-domain api files call it after their own writes. */
export function invalidate(queryClient: QueryClient, keys: QueryKey[]): void {
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

/**
 * POST /api/v1/extraction/batches: queue and run an extraction over the documents named or over
 * every classified document of a type for a quarter (operations; refused while ai.extraction is
 * off). The API processes the batch before it answers, so the batch arrives terminal.
 */
export function postExtractionBatch(body: ExtractionBatchBody): Promise<ExtractionBatch> {
  return post('/api/v1/extraction/batches', extractionBatch, body);
}

/** POST /api/v1/extraction/runs/{id}/commands: accept, edit, reject, acceptClean, approve (promotes) or retry. */
export function postExtractionRunCommand(
  id: string,
  body: ExtractionRunCommandBody,
): Promise<ExtractionRunDetail> {
  return post(
    `/api/v1/extraction/runs/${encodeURIComponent(id)}/commands`,
    extractionRunDetail,
    body,
  );
}

/**
 * A batch writes runs and values, changes each document's latest run, the monitoring board, and
 * opens a data exception when a run fails; a review decision changes the run and, on approval,
 * the promoted quarter that every read of a position's figures pools (docs/04 M4, SEC-9.1).
 */
const EXTRACTION_KEYS: QueryKey[] = [
  ['extraction-batches'],
  ['extraction-runs'],
  ['extraction-run'],
  ...SUGGESTION_READS,
  ['documents'],
  ['document'],
  ['monitoring-board'],
  ['investment'],
  ['investments'],
  ['investment-performance'],
  ['data-health'],
  ['data-exceptions'],
  ['analytics-summary'],
  ['watchlist'],
  ['weekly-report'],
  ['audit'],
];

export function useStartExtractionBatch(): UseMutationResult<
  ExtractionBatch,
  Error,
  ExtractionBatchBody
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ExtractionBatchBody) => postExtractionBatch(body),
    onSuccess: () => invalidate(queryClient, EXTRACTION_KEYS),
  });
}

export interface ExtractionRunCommandVariables {
  id: string;
  body: ExtractionRunCommandBody;
}

export function useExtractionRunCommand(): UseMutationResult<
  ExtractionRunDetail,
  Error,
  ExtractionRunCommandVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: ExtractionRunCommandVariables) => postExtractionRunCommand(id, body),
    onSuccess: (updated) => {
      // A retry of a Failed run answers with the new run; the page opens on it without a second read.
      queryClient.setQueryData(['extraction-run', updated.run.id], updated);
      invalidate(queryClient, EXTRACTION_KEYS);
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
