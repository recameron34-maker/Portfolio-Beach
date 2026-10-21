import { capitalNoticePage, valuationPage } from '@pb/contracts';
import type {
  CapitalNoticeRow,
  ClassifierEvidence,
  DataExceptionState,
  DocumentReviewStatus,
  ExtractionBatchState,
  ExtractionDecision,
  ExtractionErrorKind,
  ExtractionFinding,
  ExtractionRunState,
  ExtractionUnit,
  ExtractionValidationState,
  IntakeFinding,
  IntakeLink,
  IntakeRow,
  IntakeSource,
  LookthroughDifference,
  LookthroughRow,
  QuarterSource,
  RealizationOutlookCode,
  StagingState,
  ValuationRow,
  WeeklyPriorSource,
} from '@pb/contracts';
import { LIST_LIMIT } from '../app/queries.js';
import type { PreviewUser, Recordings } from './fixtures.js';

/**
 * What the simulation remembers for one page session: in memory only (never storage), shared by
 * every role the switcher picks, since it is keyed by record id rather than by credential. Who may
 * see a record is decided again on every read from that credential's own recordings (overlay.ts).
 */

/** The acting user, from the credential's recorded GET /api/v1/auth/me. */
export interface SimActor {
  userId: string;
  externalId: string;
  displayName: string;
  roles: readonly string[];
}

export interface SimValuation {
  /** The record as the API would serve it; display fields hold display names. */
  row: ValuationRow;
  /** 'recorded' rows were seeded from a recorded list; 'created' rows exist only in this session. */
  origin: 'recorded' | 'created';
  /** True once a simulated command changed the record; overlays touch only changed or created records. */
  changed: boolean;
  /** The investment's vehicle, for vehicle-filtered lists; known for created records. */
  vehicleId: string | null;
  /** User ids behind the display fields, for segregation-of-duties checks. */
  preparedByIds: readonly string[];
  dealTeamApprovedByIds: readonly string[];
  approvedByIds: readonly string[];
}

export interface SimNotice {
  row: CapitalNoticeRow;
  changed: boolean;
  /** User id of whoever drafted the trade ticket (draftTicket). */
  ticketPreparedBy: string | null;
}

/** The header every simulated intake file shares (stg.intake_file), whatever its source. */
export interface SimFileHeader {
  id: string;
  fileName: string;
  /** SHA-256 of the file's content: with the source, the idempotency key (docs/04 M2). */
  contentHash: string;
  receivedAt: string;
  receivedBy: string;
  rowCount: number;
  fileFindings: IntakeFinding[];
  rowVersion: number;
}

/**
 * One staged row of a simulated import: what stg.intake_row holds in the API (the row as the
 * file said it, how the system actor linked it, its diff and findings) plus its decision.
 */
export interface SimIntakeRow {
  id: string;
  rowNo: number;
  naturalKey: string;
  /** The approved quarter the row would replace, or the one its promotion created; null for a new quarter not yet promoted. */
  targetId: string | null;
  status: StagingState;
  decision: string | null;
  decidedBy: string | null;
  promotedAt: string | null;
  investmentNumber: string | null;
  companyName: string | null;
  periodEnd: string | null;
  /** The calendar quarter end the row reports for (alignedQuarterEnd), when the period end is a real date. */
  quarterEnd: string | null;
  figures: IntakeRow['figures'];
  /** As the system actor linked it, every candidate included; the detail filters them per credential. */
  link: IntakeLink;
  diff: IntakeRow['diff'];
  findings: IntakeFinding[];
}

/** A simulated file of accounting-shaped rows: the accounting export, or an operations workbook mapped onto its layout. */
export interface SimIntakeFile extends SimFileHeader {
  source: Extract<IntakeSource, 'accounting' | 'ops_drop'>;
  /** The ops-drop template the workbook matched (config/ops_drop_templates.json); null for the accounting export. */
  templateSignature: string | null;
  rows: SimIntakeRow[];
}

/** One staged weekly value (stg.valuation): the cells as written, the typed readings, the prior and the decision. */
export interface SimWeeklyRow {
  id: string;
  rowNo: number;
  investmentNumber: string | null;
  companyName: string | null;
  investmentId: string | null;
  /** The report date when it is a real day the intake reads; else null (the raw cell stays in `raw`). */
  reportDate: string | null;
  /** The value when it is a decimal the record holds as written; else null. */
  reportedValue: string | null;
  priorValue: string | null;
  priorSource: WeeklyPriorSource | null;
  priorDate: string | null;
  variancePct: string | null;
  flag: 'above_threshold' | null;
  status: StagingState;
  decision: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  promotedAt: string | null;
  /** The simulated Draft valuation the approval created, once promoted. */
  valuationId: string | null;
  link: IntakeLink;
  findings: IntakeFinding[];
  /** Every cell by its column name, as the file wrote it. */
  raw: Record<string, string>;
}

/** A simulated weekly values file (source weekly) with every staged value. */
export interface SimWeeklyFile extends SimFileHeader {
  rows: SimWeeklyRow[];
}

/** One provider row of a simulated reconcile run, with what the mapping and the comparison made of it. */
export interface SimLookthroughRow {
  id: string;
  rowNo: number;
  status: StagingState;
  provider: {
    investmentNumber: string | null;
    companyName: string;
    sector: string;
    geography: string;
    exposureAtCost: string;
    exposureAtNav: string;
    asOf: string;
  };
  mapped: LookthroughRow['mapped'];
  record: LookthroughRow['approved'] | null;
  differences: LookthroughDifference[];
  link: IntakeLink;
  findings: IntakeFinding[];
}

/** A simulated reconcile run (source lookthrough) with every provider row. */
export interface SimLookthroughRun extends SimFileHeader {
  asOf: string;
  rows: SimLookthroughRow[];
}

/**
 * A simulated data exception (ops.data_exception): what an intake could not decide, with the
 * staged row it is about. Visibility follows the row: a reader who cannot open the row's
 * investment never sees the exception (the select policy of migration 0010).
 */
export interface SimException {
  id: string;
  /** The intake or job that opened it, such as accounting_import, lookthrough_reconcile, documents or extraction. */
  source: string;
  entity: 'stg.intake_row' | 'stg.valuation' | 'doc.document' | 'doc.extraction_run';
  entityId: string;
  ruleId: string;
  expected: string | null;
  actual: string | null;
  severity: string;
  ownerId: string | null;
  ownerName: string | null;
  state: DataExceptionState;
  externalTicket: string | null;
  candidates: { reason: string }[];
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
  context: {
    /** The staged file and row it is about; null for an exception about a document or an extraction run. */
    intakeFileId: string | null;
    intakeFileName: string | null;
    rowNo: number | null;
    /** The investment the staged row links to; null for an unresolved link. */
    investmentId: string | null;
  };
}

/** One simulated change, kept for this page session only; never shown as the audit trail. */
export interface SimAuditEvent {
  at: string;
  actorId: string;
  actorExternalId: string;
  actorName: string;
  action: string;
  entity:
    | 'valuation'
    | 'capital_notice'
    | 'feature_flag'
    | 'intake_file'
    | 'quarterly_performance'
    | 'data_exception'
    | 'document'
    | 'expected_document'
    | 'extraction_batch'
    | 'extraction_run'
    | 'extracted_value'
    | 'realization_outlook';
  entityId: string;
  reason: string | null;
  from: string | null;
  to: string | null;
  /** Counts only, never row content (the intake events). */
  details?: Readonly<Record<string, number>> | undefined;
}

/* ---- The document hub, the extraction engine and the monitoring board (Phase 2, decision 0012) ---- */

/** One page of an indexed item as @pb/pdf read it: the text for search and the model, the lines for the pages viewer, the runs for click-to-source. */
export interface SimDocumentPage {
  number: number;
  width: number;
  height: number;
  text: string;
  lines: string[];
  runs: { x: number; y: number; size: number; text: string }[];
}

/** One indexed item of the simulated store (doc.document), with the pages read from its bundled PDF. */
export interface SimDocument {
  id: string;
  /** The store's id: the path relative to the root (inbox/<fileName>). */
  sourceItemId: string;
  fileName: string;
  folder: string;
  title: string;
  docType: string | null;
  reviewStatus: DocumentReviewStatus;
  sponsorId: string | null;
  sponsorFundId: string | null;
  investmentId: string | null;
  periodEnd: string | null;
  contentHash: string;
  sizeBytes: number;
  pageCount: number | null;
  receivedAt: string;
  indexedAt: string;
  classificationConfidence: string | null;
  classifierEvidence: ClassifierEvidence;
  /** The person who classified it by hand (user id and display name); null when the classifier did, or nobody yet. */
  classifiedById: string | null;
  classifiedBy: string | null;
  classifiedAt: string | null;
  duplicateOfId: string | null;
  /** The first 2000 characters of the text, for search only. */
  textExcerpt: string | null;
  /** The pages as read; null for an item the reader refused. */
  pages: SimDocumentPage[] | null;
  /** The reader's refusal code for an unreadable item (PdfErrorCode), else null. */
  unreadableCode: string | null;
  rowVersion: number;
}

/** One expected document of a quarter (doc.expected_document); status and age are derived when read. */
export interface SimExpectedDocument {
  id: string;
  investmentId: string | null;
  sponsorFundId: string | null;
  periodEnd: string;
  docType: string;
  dueDate: string;
  receivedDocumentId: string | null;
  createdAt: string;
}

/** An extraction batch (ops.job of type extraction_batch). */
export interface SimBatch {
  id: string;
  state: ExtractionBatchState;
  progress: number;
  requestedById: string;
  requestedBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
}

/** An extraction run (doc.extraction_run). */
export interface SimRun {
  id: string;
  documentId: string;
  investmentId: string | null;
  periodEnd: string | null;
  schemaId: string;
  promptId: string;
  promptVersion: string;
  modelId: string | null;
  state: ExtractionRunState;
  batchId: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  errorKind: ExtractionErrorKind | null;
  schemaRetries: number;
  transientRetries: number;
  requestedById: string | null;
  requestedBy: string | null;
  approvedById: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  promotedRecordId: string | null;
  createdAt: string;
  rowVersion: number;
}

/** One staged value of a run (stg.extracted_value): a schema field, or the highlights or commentary row. */
export interface SimValue {
  id: string;
  runId: string;
  investmentId: string | null;
  field: string;
  value: string | null;
  unit: ExtractionUnit | null;
  page: number | null;
  quote: string | null;
  confidence: string | null;
  validationState: ExtractionValidationState;
  findings: ExtractionFinding[];
  reviewerId: string | null;
  decidedBy: string | null;
  decision: ExtractionDecision | null;
  editedValue: string | null;
  decidedAt: string | null;
  rowVersion: number;
}

/** The figure columns a promotion writes into mon.quarterly_performance, in the record's order. */
export const QUARTERLY_FIGURE_KEYS = [
  'revenueLtm',
  'ebitdaLtm',
  'ev',
  'netDebt',
  'cash',
  'totalEquity',
] as const;
export type QuarterlyFigureKey = (typeof QUARTERLY_FIGURE_KEYS)[number];
export type QuarterlyFigures = Partial<Record<QuarterlyFigureKey, string | null>>;

/**
 * A quarter an approved extraction run promoted (mon.quarterly_performance as the promotion
 * writes it): the figures in dollars for the keys written, the approval and the lineage. The
 * Performance tab overlay lays it over the recorded quarter of the same period end, or adds it.
 */
export interface SimPromotedQuarter {
  /** The record's id: the quarter on record it replaced, or a new id for the quarter it created. */
  id: string;
  investmentId: string;
  periodEnd: string;
  created: boolean;
  figures: QuarterlyFigures;
  approvedById: string;
  approvedBy: string;
  approvedAt: string;
  approvalReason: string;
  /** The narrative written only when its rows were accepted; a key left out keeps the record's. */
  highlights?: string[] | undefined;
  commentary?: string | null | undefined;
  source: QuarterSource;
  promptVersion: string | null;
  modelId: string | null;
}

/** The realization outlook set by hand this session (mon.realization_outlook), one per investment. */
export interface SimOutlook {
  investmentId: string;
  outlook: RealizationOutlookCode;
  horizonMonths: number;
  note: string | null;
  setById: string;
  setBy: string;
  setAt: string;
  rowVersion: number;
}

/** The key of a promoted quarter: its investment and period end. */
export const quarterKey = (investmentId: string, periodEnd: string): string =>
  `${investmentId}|${periodEnd}`;

/** A successful answer kept for an Idempotency-Key (docs/17 section 3). */
export interface StoredResponse {
  status: number;
  headers: [string, string][];
  body: string;
  /** The request body it answered; the same key with another body is refused. */
  requestBody: string;
}

export interface PreviewState {
  flags: Map<string, boolean>;
  /** Seeded lazily from the recordings on the first simulated write; null until then. */
  valuations: Map<string, SimValuation> | null;
  notices: Map<string, SimNotice> | null;
  /** Files of accounting-shaped rows (the accounting export, the ops drop) staged this session, by id. */
  intakeFiles: Map<string, SimIntakeFile>;
  /** Weekly values files staged this session, by id. */
  weeklyFiles: Map<string, SimWeeklyFile>;
  /** Look-through reconcile runs staged this session, by id. */
  lookthroughRuns: Map<string, SimLookthroughRun>;
  /** Data exceptions the simulated intakes opened this session, by id. */
  exceptions: Map<string, SimException>;
  /** Documents the simulated index wrote this session, by id (insertion order is index order). */
  documents: Map<string, SimDocument>;
  /** Expected documents generated this session, by id. */
  expectedDocuments: Map<string, SimExpectedDocument>;
  /** Extraction batches started this session, by id. */
  batches: Map<string, SimBatch>;
  /** Extraction runs queued this session, by id. */
  runs: Map<string, SimRun>;
  /** Staged values of every run, by id. */
  values: Map<string, SimValue>;
  /** Quarters promoted by approved runs this session, by investment and period end (quarterKey). */
  promotedQuarters: Map<string, SimPromotedQuarter>;
  /** Realization outlooks set this session, by investment id. */
  outlooks: Map<string, SimOutlook>;
  audit: SimAuditEvent[];
  idempotency: Map<string, StoredResponse>;
}

/** Ids and clock for simulated records; injectable so tests are deterministic. */
export interface PreviewEnv {
  newId(): string;
  now(): string;
}

/**
 * A version 4 UUID. Browsers offer crypto.randomUUID only on secure pages (https or localhost);
 * elsewhere, such as a preview opened from a file, one is built from getRandomValues.
 */
export function newUuid(): string {
  const c: Crypto = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const defaultEnv: PreviewEnv = {
  newId: newUuid,
  now: () => new Date().toISOString(),
};

export function createPreviewState(): PreviewState {
  return {
    flags: new Map(),
    valuations: null,
    notices: null,
    intakeFiles: new Map(),
    weeklyFiles: new Map(),
    lookthroughRuns: new Map(),
    exceptions: new Map(),
    documents: new Map(),
    expectedDocuments: new Map(),
    batches: new Map(),
    runs: new Map(),
    values: new Map(),
    promotedQuarters: new Map(),
    outlooks: new Map(),
    audit: [],
    idempotency: new Map(),
  };
}

/** Forgets every simulated change; the next write seeds from the recordings again. */
export function resetPreviewState(state: PreviewState): void {
  state.flags.clear();
  state.valuations = null;
  state.notices = null;
  state.intakeFiles.clear();
  state.weeklyFiles.clear();
  state.lookthroughRuns.clear();
  state.exceptions.clear();
  state.documents.clear();
  state.expectedDocuments.clear();
  state.batches.clear();
  state.runs.clear();
  state.values.clear();
  state.promotedQuarters.clear();
  state.outlooks.clear();
  state.audit.length = 0;
  state.idempotency.clear();
}

/** The staged values of a run, in the order they were staged (schema order, then the narrative rows). */
export function valuesOfRun(state: PreviewState, runId: string): SimValue[] {
  return [...state.values.values()].filter((v) => v.runId === runId);
}

/** The newest run of a document by (createdAt, id), or null. */
export function latestRunOf(state: PreviewState, documentId: string): SimRun | null {
  let latest: SimRun | null = null;
  for (const run of state.runs.values()) {
    if (run.documentId !== documentId) continue;
    if (
      latest === null ||
      run.createdAt > latest.createdAt ||
      (run.createdAt === latest.createdAt && run.id > latest.id)
    )
      latest = run;
  }
  return latest;
}

/** The data exceptions opened about the rows of a file, whichever intake opened them (the file header's count). */
export function exceptionsOfFile(state: PreviewState, fileId: string): SimException[] {
  return [...state.exceptions.values()].filter((x) => x.context.intakeFileId === fileId);
}

/** The unfiltered lists the seeds read; the same paths the pages request (src/app/queries.ts). */
export const VALUATIONS_PATH = `/api/v1/valuations?limit=${LIST_LIMIT}`;
export const NOTICES_PATH = `/api/v1/capital-notices?limit=${LIST_LIMIT}`;

/**
 * User ids behind a recorded display field. The API serves display names; a field that already
 * holds a user id maps to itself. A name two users share maps to both, so either one counts as
 * that person in segregation-of-duties checks.
 */
export function userIdsFor(users: readonly PreviewUser[], recorded: string | null): string[] {
  if (recorded === null) return [];
  const byId = users.filter((u) => u.userId === recorded).map((u) => u.userId);
  if (byId.length > 0) return byId;
  return users.filter((u) => u.displayName === recorded).map((u) => u.userId);
}

/** The id a precondition compares with the actor: the actor when they are one of the people behind the field. */
export function personFor(ids: readonly string[], actor: SimActor): string | null {
  return ids.includes(actor.userId) ? actor.userId : (ids[0] ?? null);
}

/**
 * Every recorded list for the path, largest first: the user who sees the most rows seeds the
 * records, and rows only other users see are added after. Lists that were not recorded with 200
 * (an endpoint answering 501, say) contribute nothing.
 */
function recordedLists<T extends { items: readonly unknown[] }>(
  recordings: Recordings,
  read: (credential: string) => T | undefined,
): T[] {
  const lists: T[] = [];
  for (const user of recordings.users) {
    const list = read(user.externalId);
    if (list !== undefined) lists.push(list);
  }
  return lists.sort((a, b) => b.items.length - a.items.length);
}

export function seedValuations(recordings: Recordings): Map<string, SimValuation> {
  const seeded = new Map<string, SimValuation>();
  const lists = recordedLists(recordings, (c) =>
    recordings.read(c, VALUATIONS_PATH, valuationPage),
  );
  for (const list of lists) {
    for (const row of list.items) {
      if (seeded.has(row.id)) continue;
      seeded.set(row.id, {
        row,
        origin: 'recorded',
        changed: false,
        vehicleId: null,
        preparedByIds: userIdsFor(recordings.users, row.preparedBy),
        dealTeamApprovedByIds: userIdsFor(recordings.users, row.dealTeamApprovedBy),
        approvedByIds: userIdsFor(recordings.users, row.approvedBy),
      });
    }
  }
  return seeded;
}

export function seedNotices(recordings: Recordings): Map<string, SimNotice> {
  const seeded = new Map<string, SimNotice>();
  const lists = recordedLists(recordings, (c) =>
    recordings.read(c, NOTICES_PATH, capitalNoticePage),
  );
  for (const list of lists) {
    for (const row of [...list.items, ...list.attention]) {
      if (!seeded.has(row.id)) seeded.set(row.id, { row, changed: false, ticketPreparedBy: null });
    }
  }
  return seeded;
}

export function ensureValuations(
  state: PreviewState,
  recordings: Recordings,
): Map<string, SimValuation> {
  return (state.valuations ??= seedValuations(recordings));
}

export function ensureNotices(state: PreviewState, recordings: Recordings): Map<string, SimNotice> {
  return (state.notices ??= seedNotices(recordings));
}
