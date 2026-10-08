import { capitalNoticePage, valuationPage } from '@pb/contracts';
import type { CapitalNoticeRow, ValuationRow } from '@pb/contracts';
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

/** One simulated change, kept for this page session only; never shown as the audit trail. */
export interface SimAuditEvent {
  at: string;
  actorId: string;
  actorExternalId: string;
  actorName: string;
  action: string;
  entity: 'valuation' | 'capital_notice' | 'feature_flag';
  entityId: string;
  reason: string | null;
  from: string | null;
  to: string | null;
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
  audit: SimAuditEvent[];
  idempotency: Map<string, StoredResponse>;
}

/** Ids and clock for simulated records; injectable so tests are deterministic. */
export interface PreviewEnv {
  newId(): string;
  now(): string;
}

export const defaultEnv: PreviewEnv = {
  newId: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
};

export function createPreviewState(): PreviewState {
  return {
    flags: new Map(),
    valuations: null,
    notices: null,
    audit: [],
    idempotency: new Map(),
  };
}

/** Forgets every simulated change; the next write seeds from the recordings again. */
export function resetPreviewState(state: PreviewState): void {
  state.flags.clear();
  state.valuations = null;
  state.notices = null;
  state.audit.length = 0;
  state.idempotency.clear();
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
