import { capitalNoticePage, valuationPage } from '@pb/contracts';
import type {
  CapitalNoticeRow,
  DataExceptionState,
  IntakeFinding,
  IntakeLink,
  IntakeRow,
  IntakeSource,
  LookthroughDifference,
  LookthroughRow,
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
  /** The intake that opened it, such as accounting_import or lookthrough_reconcile. */
  source: string;
  entity: 'stg.intake_row' | 'stg.valuation';
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
    intakeFileId: string;
    intakeFileName: string;
    rowNo: number;
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
    | 'data_exception';
  entityId: string;
  reason: string | null;
  from: string | null;
  to: string | null;
  /** Counts only, never row content (the intake events). */
  details?: Readonly<Record<string, number>> | undefined;
}

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
  state.audit.length = 0;
  state.idempotency.clear();
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
