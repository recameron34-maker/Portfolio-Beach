import type {
  ClassifierEvidence,
  DocumentCommandBody,
  DocumentIndexResult,
  DocumentReviewStatus,
  DocumentSummary,
  ExpectedDocument,
  ExpectedDocumentGenerateResult,
  ExpectedDocumentStatus,
  ExtractionRunState,
  Taxonomy,
} from '@pb/contracts';
import {
  documentReviewStatus,
  expectedDocumentStatus,
  isCalendarDate,
  isQuarterEnd,
  ROUTES,
} from '@pb/contracts';
import { latestQuarterEndOnOrBefore } from '@pb/calc';
import type { Tone } from '../../components/ui.js';
import { formatDate, formatPct, labelOf, MISSING } from '../../lib/format.js';
import { humanizeState } from '../../lib/states.js';

/*
 * Pure helpers of the documents pages (docs/04 M3, docs/18 section 6, decision 0012): words,
 * tones, the roles each write needs and the status phrases. Nothing here reads the network or
 * the DOM.
 */

/** The page headers' context lines. */
export const DOCUMENTS_META =
  'Indexed from the document store, tagged by the classifier, reviewed by a person (docs/04 M3)';
export const REVIEW_QUEUE_META =
  'Documents the classifier was not sure about: a person names the type and the links';
export const EXPECTED_META =
  'What each position and sponsor fund owes for a quarter, and whether it has arrived';

/** The read-only sentences for the roles the write routes refuse. */
export const INDEX_READ_ONLY = 'Operations indexes documents; your role reads the hub.';
export const CLASSIFY_READ_ONLY =
  'The deal team and operations classify documents; your role reads them.';
export const GENERATE_READ_ONLY =
  'Operations generates expected documents; your role reads the tracker.';

/** docs/18 section 6, from the contract's enum: Received, Classified, NeedsReview, Duplicate. */
export const REVIEW_STATUSES: readonly DocumentReviewStatus[] = documentReviewStatus.options;

export function isReviewStatus(value: string): value is DocumentReviewStatus {
  return (REVIEW_STATUSES as readonly string[]).includes(value);
}

export const EXPECTED_STATUSES: readonly ExpectedDocumentStatus[] = expectedDocumentStatus.options;

export function isExpectedStatus(value: string): value is ExpectedDocumentStatus {
  return (EXPECTED_STATUSES as readonly string[]).includes(value);
}

/** Classified is done, NeedsReview waits for a person, a Duplicate points at its original, Received waits for the classifier. */
const REVIEW_TONES: Readonly<Record<DocumentReviewStatus, Tone>> = {
  Received: 'neutral',
  Classified: 'good',
  NeedsReview: 'watch',
  Duplicate: 'neutral',
};

export function reviewTone(status: DocumentReviewStatus): Tone {
  return REVIEW_TONES[status];
}

/** "Needs review", "Classified". */
export function reviewWord(status: DocumentReviewStatus): string {
  return humanizeState(status);
}

/** A received document is done; late waits on the sponsor; missing is a gap the board must show. */
const EXPECTED_TONES: Readonly<Record<ExpectedDocumentStatus, Tone>> = {
  expected: 'neutral',
  received: 'good',
  late: 'watch',
  missing: 'bad',
};

export function expectedTone(status: ExpectedDocumentStatus): Tone {
  return EXPECTED_TONES[status];
}

/** "Expected", "Received", "Late", "Missing". */
export function expectedWord(status: ExpectedDocumentStatus): string {
  return humanizeState(status);
}

/** docs/18 section 7: Succeeded is done, Failed is a data exception, the rest are in flight. */
const RUN_TONES: Readonly<Record<ExtractionRunState, Tone>> = {
  Queued: 'neutral',
  Running: 'brand',
  Succeeded: 'good',
  Failed: 'bad',
  NeedsRetry: 'watch',
};

export function runTone(state: ExtractionRunState): Tone {
  return RUN_TONES[state];
}

export function runWord(state: ExtractionRunState): string {
  return humanizeState(state);
}

/** "Quarterly financials": the taxonomy's own label once loaded; the missing placeholder when untyped. */
export function docTypeLabel(code: string | null): string {
  return code === null ? MISSING : labelOf(code);
}

export interface DocTypeOption {
  code: string;
  label: string;
}

/** The active doc_type terms of the taxonomy in its order, for the filters and the classify form. */
export function docTypeOptions(taxonomy: Taxonomy | undefined): DocTypeOption[] {
  const domain = taxonomy?.domains.find((d) => d.domain === 'doc_type');
  if (domain === undefined) return [];
  return [...domain.terms]
    .filter((t) => t.active)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((t) => ({ code: t.code, label: t.label }));
}

export interface Subject {
  /** The company, else the sponsor fund, else the missing placeholder. */
  text: string;
  link: { to: '/portfolio/$id' | '/sponsors/$id'; params: { id: string } } | null;
}

/**
 * What a document is about: the position it is linked to (a link to the deal workspace), else
 * the sponsor fund (a link to the sponsor, who lists the fund), else nothing yet.
 */
export function subjectOf(
  doc: Pick<DocumentSummary, 'investmentId' | 'companyName' | 'sponsorId' | 'sponsorFundName'>,
): Subject {
  if (doc.investmentId !== null && doc.companyName !== null) {
    return {
      text: doc.companyName,
      link: { to: '/portfolio/$id', params: { id: doc.investmentId } },
    };
  }
  if (doc.sponsorFundName !== null) {
    return {
      text: doc.sponsorFundName,
      link: doc.sponsorId === null ? null : { to: '/sponsors/$id', params: { id: doc.sponsorId } },
    };
  }
  return { text: MISSING, link: null };
}

/** The first twelve hex characters of the content hash, enough to tell duplicates apart by eye. */
export function hashShort(hash: string): string {
  return hash.slice(0, 12);
}

/** "9.8 KB", "1.2 MB": the file size in plain units. */
export function sizeText(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** "97%" from the classifier's decimal confidence; the missing placeholder until classified. */
export function confidenceText(value: string | null): string {
  return formatPct(value, 0);
}

/** "Jul 1, 2025" from an API timestamp: the date part only. */
export function dayOf(iso: string | null): string {
  return iso === null ? MISSING : formatDate(iso.slice(0, 10));
}

/** "quarterly report, period end": the keywords the classifier matched, or the placeholder. */
export function keywordsText(evidence: ClassifierEvidence): string {
  return evidence.keywords.length === 0 ? MISSING : evidence.keywords.join(', ');
}

/** The other candidates the classifier saw, by reason only (never a value), or the placeholder. */
export function candidatesText(evidence: ClassifierEvidence): string {
  return evidence.candidates.length === 0
    ? MISSING
    : evidence.candidates.map((c) => c.reason).join('; ');
}

/** The exact status phrases the probe and the journeys look for. */
export function indexResultText(result: DocumentIndexResult): string {
  return `Indexed ${result.indexed} documents, ${result.duplicates} duplicates, ${result.unchanged} unchanged`;
}

export function classifiedText(label: string): string {
  return `Classified as ${label}`;
}

export function generateResultText(result: ExpectedDocumentGenerateResult): string {
  return `Expected documents generated: ${result.created} created, ${result.existing} existing`;
}

/** Roles that may issue a write, read from its route in the contract so no page keeps its own list. */
function routeRoles(method: 'POST', path: string): readonly string[] {
  return ROUTES.find((r) => r.method === method && r.path.endsWith(path))?.roles ?? [];
}

export const INDEX_ROLES: readonly string[] = routeRoles('POST', '/documents/index');
export const CLASSIFY_ROLES: readonly string[] = routeRoles('POST', '/documents/{id}/commands');
export const GENERATE_ROLES: readonly string[] = routeRoles('POST', '/expected-documents/generate');

const holdsAny = (roles: readonly string[], allowed: readonly string[]): boolean =>
  roles.some((r) => allowed.includes(r));

export const mayIndex = (roles: readonly string[]): boolean => holdsAny(roles, INDEX_ROLES);
export const mayClassify = (roles: readonly string[]): boolean => holdsAny(roles, CLASSIFY_ROLES);
export const mayGenerate = (roles: readonly string[]): boolean => holdsAny(roles, GENERATE_ROLES);

/** The classify form is offered on a NeedsReview document only (docs/18 section 6), to the roles the route allows. */
export function classifyOffered(
  roles: readonly string[],
  doc: Pick<DocumentSummary, 'reviewStatus'>,
): boolean {
  return mayClassify(roles) && doc.reviewStatus === 'NeedsReview';
}

export interface ClassifyForm {
  docType: string;
  investmentId: string;
  sponsorFundId: string;
  periodEnd: string;
  reason: string;
}

/** Why the form cannot be sent yet, or null: a type is required; a period end must be a calendar date. */
export function classifyProblem(form: ClassifyForm): string | null {
  if (form.docType === '') return 'Pick a document type.';
  const period = form.periodEnd.trim();
  if (period !== '' && !isCalendarDate(period)) return 'The period end must be a calendar date.';
  return null;
}

/** The strict command body: a link or a period left blank is left out, which keeps the classifier's. */
export function classifyBody(form: ClassifyForm): DocumentCommandBody {
  const reason = form.reason.trim();
  const period = form.periodEnd.trim();
  return {
    command: 'classify',
    docType: form.docType,
    ...(form.investmentId === '' ? {} : { investmentId: form.investmentId }),
    ...(form.sponsorFundId === '' ? {} : { sponsorFundId: form.sponsorFundId }),
    ...(period === '' ? {} : { periodEnd: period }),
    ...(reason === '' ? {} : { reason }),
  };
}

/** The quarter a generation runs for, by default: the latest quarter end on or before the record's as-of day. */
export function defaultQuarterEnd(asOf: string | undefined): string {
  return asOf === undefined || !isCalendarDate(asOf) ? '' : latestQuarterEndOnOrBefore(asOf);
}

/** Why a generation cannot run yet, or null: the date must be a quarter end. */
export function quarterEndProblem(text: string): string | null {
  const date = text.trim();
  if (date === '') return 'Pick a quarter end.';
  if (!isQuarterEnd(date))
    return 'The date must be a quarter end (March 31, June 30, September 30 or December 31).';
  return null;
}

/** A date filter is applied once it is a whole calendar date; anything else leaves the filter off. */
export function dateFilter(text: string): string | undefined {
  const date = text.trim();
  return isCalendarDate(date) ? date : undefined;
}

/** "45 days before due", "16 days past due", "received 3 days after due": the age in words for the cell's title. */
export function ageTitle(row: Pick<ExpectedDocument, 'ageDays' | 'status'>): string {
  const n = Math.abs(row.ageDays);
  const days = n === 1 ? '1 day' : `${n} days`;
  if (row.status === 'received')
    return row.ageDays <= 0 ? `Received ${days} before due` : `Received ${days} after due`;
  return row.ageDays < 0
    ? `${days} before due`
    : row.ageDays === 0
      ? 'Due today'
      : `${days} past due`;
}

/** The link to an extraction run review page, registered by the extraction routes (merged alongside this slice). */
export const RUN_ROUTE = '/documents/extraction/$id' as unknown as '/documents/$id';
