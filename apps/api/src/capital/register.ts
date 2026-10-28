import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { addDays } from '@pb/calc';
import { callbackNumberSource, callbackResult, wireInstructionState } from '@pb/contracts';
import type { WireInstructionRow } from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { EXACT_AT_FORMAT } from '../common/cursor.js';

/*
 * The wire instruction register as the capital controls read it (docs/04 M16, docs/18 section
 * 11, SEC-12.2, decision 0013). An instruction belongs to a counterparty: a sponsor fund or an
 * investment. A capital notice's counterparty is its investment (and that investment's sponsor
 * fund) or its commitment's sponsor fund, so a notice is funded against an instruction keyed by
 * either; when both kinds carry an active version, the investment-level one is the more specific
 * and wins. Everything here reads under the caller's own row-level security (the register is
 * readable by operations, approvers, auditors, platform admins and the system actor only) and
 * returns the masked form of the bank details; the clear form is decrypted in wires.service.ts
 * alone. Nothing here reads the clock: the as-of date or today comes from the caller.
 */

const wire = schema.wireInstruction;
const proposer = alias(schema.appUser, 'wire_proposer');
const callbackPerson = alias(schema.appUser, 'wire_callback_by');

/** The two keys an instruction can carry; a notice's counterparty may hold both. */
export interface CounterpartyKeys {
  sponsorFundId: string | null;
  investmentId: string | null;
}

/** The register for one counterparty: every version, newest first, and the active Verified one. */
export interface RegisterView {
  versions: WireInstructionRow[];
  active: WireInstructionRow | null;
}

export const EMPTY_REGISTER: RegisterView = { versions: [], active: null };

/** A loaded row carries the exact proposed_at text the list cursor needs; the contract row has none. */
export type LoadedInstruction = WireInstructionRow & { exactAt: string };

/** The ISO calendar date (UTC) of a timestamp, for the hold window arithmetic. */
export const isoDateOf = (at: Date): string => at.toISOString().slice(0, 10);

/** The map key of a counterparty, stable across the two kinds. */
export const keyOf = (keys: CounterpartyKeys): string =>
  `${keys.investmentId ?? ''}|${keys.sponsorFundId ?? ''}`;

/** The condition selecting every version of a counterparty (by either key); nothing when the keys are empty. */
export function counterpartyWhere(keys: CounterpartyKeys): SQL {
  const parts: SQL[] = [];
  if (keys.investmentId !== null) parts.push(eq(wire.investmentId, keys.investmentId));
  if (keys.sponsorFundId !== null) parts.push(eq(wire.sponsorFundId, keys.sponsorFundId));
  if (parts.length === 0) return sql`false`;
  return or(...parts) ?? sql`false`;
}

/** The exact key a version is unique under (the partial unique indexes of migration 0013). */
export function exactKeyWhere(keys: CounterpartyKeys): SQL {
  return keys.investmentId !== null
    ? eq(wire.investmentId, keys.investmentId)
    : keys.sponsorFundId !== null
      ? eq(wire.sponsorFundId, keys.sponsorFundId)
      : sql`false`;
}

/** The register order: newest proposal first, then id, the list cursor's key. */
export const REGISTER_ORDER: readonly SQL[] = [desc(wire.proposedAt), desc(wire.id)];

export interface InstructionRowOptions {
  orderBy?: readonly SQL[];
  limit?: number;
}

/** Instruction versions as contract rows (masked), with the proposer's and the caller's names. */
export async function loadInstructionRows(
  tx: Tx,
  where?: SQL,
  options: InstructionRowOptions = {},
): Promise<LoadedInstruction[]> {
  const query = tx
    .select({
      id: wire.id,
      sponsorFundId: wire.sponsorFundId,
      investmentId: wire.investmentId,
      counterpartyName: wire.counterpartyName,
      version: wire.version,
      state: wire.state,
      bankDetailsMasked: wire.bankDetailsMasked,
      proposedBy: wire.proposedBy,
      proposerName: proposer.displayName,
      proposedAt: wire.proposedAt,
      sourceNote: wire.sourceNote,
      callbackBy: wire.callbackBy,
      callbackName: callbackPerson.displayName,
      callbackAt: wire.callbackAt,
      callbackNumberSource: wire.callbackNumberSource,
      callbackResult: wire.callbackResult,
      verifiedAt: wire.verifiedAt,
      rejectionReason: wire.rejectionReason,
      active: wire.active,
      rowVersion: wire.rowVersion,
      exactAt: sql<string>`to_char(${wire.proposedAt} at time zone 'UTC', ${EXACT_AT_FORMAT})`,
    })
    .from(wire)
    .innerJoin(proposer, eq(proposer.id, wire.proposedBy))
    .leftJoin(callbackPerson, eq(callbackPerson.id, wire.callbackBy))
    .where(where)
    .orderBy(...(options.orderBy ?? REGISTER_ORDER));
  const rows = await (options.limit === undefined ? query : query.limit(options.limit));
  return rows.map((r) => {
    const callback =
      r.callbackBy !== null &&
      r.callbackName !== null &&
      r.callbackAt !== null &&
      r.callbackNumberSource !== null &&
      r.callbackResult !== null
        ? {
            by: { id: r.callbackBy, name: r.callbackName },
            at: r.callbackAt.toISOString(),
            numberSource: callbackNumberSource.parse(r.callbackNumberSource),
            result: callbackResult.parse(r.callbackResult),
          }
        : null;
    return {
      id: r.id,
      counterparty:
        r.investmentId !== null
          ? { kind: 'investment' as const, id: r.investmentId, name: r.counterpartyName }
          : {
              kind: 'sponsor_fund' as const,
              id: r.sponsorFundId ?? '',
              name: r.counterpartyName,
            },
      version: r.version,
      state: wireInstructionState.parse(r.state),
      bankDetailsMasked: r.bankDetailsMasked,
      proposedBy: { id: r.proposedBy, name: r.proposerName },
      proposedAt: r.proposedAt.toISOString(),
      sourceNote: r.sourceNote,
      callback,
      verifiedAt: r.verifiedAt === null ? null : r.verifiedAt.toISOString(),
      rejectionReason: r.rejectionReason,
      active: r.active,
      rowVersion: r.rowVersion,
      exactAt: r.exactAt,
    };
  });
}

/** The contract row without the cursor text. */
export function toInstructionRow(loaded: LoadedInstruction): WireInstructionRow {
  const { exactAt: _exactAt, ...row } = loaded;
  return row;
}

/**
 * The counterparty of a capital notice: its investment and that investment's sponsor fund, or
 * its commitment's sponsor fund. Read under the caller's row-level security, so a notice the
 * caller can see always resolves (the investment or commitment it names is visible with it).
 */
export async function counterpartyOfNotice(
  tx: Tx,
  notice: { investmentId: string | null; commitmentId: string | null },
): Promise<CounterpartyKeys> {
  if (notice.investmentId !== null) {
    const [inv] = await tx
      .select({ sponsorFundId: schema.investment.sponsorFundId })
      .from(schema.investment)
      .where(eq(schema.investment.id, notice.investmentId));
    return { investmentId: notice.investmentId, sponsorFundId: inv?.sponsorFundId ?? null };
  }
  if (notice.commitmentId !== null) {
    const [c] = await tx
      .select({ sponsorFundId: schema.commitment.sponsorFundId })
      .from(schema.commitment)
      .where(eq(schema.commitment.id, notice.commitmentId));
    return { investmentId: null, sponsorFundId: c?.sponsorFundId ?? null };
  }
  return { investmentId: null, sponsorFundId: null };
}

/**
 * The register of several counterparties in one query, keyed by keyOf. A version keyed by an
 * investment belongs to every counterparty naming that investment; one keyed by a sponsor fund to
 * every counterparty naming that fund. The active version is the investment-level one when both
 * kinds carry one.
 */
export async function loadRegisters(
  tx: Tx,
  counterparties: readonly CounterpartyKeys[],
): Promise<Map<string, RegisterView>> {
  const out = new Map<string, RegisterView>();
  for (const keys of counterparties) out.set(keyOf(keys), { versions: [], active: null });
  const investmentIds = [
    ...new Set(counterparties.flatMap((k) => (k.investmentId === null ? [] : [k.investmentId]))),
  ];
  const fundIds = [
    ...new Set(counterparties.flatMap((k) => (k.sponsorFundId === null ? [] : [k.sponsorFundId]))),
  ];
  const parts: SQL[] = [];
  if (investmentIds.length > 0) parts.push(inArray(wire.investmentId, investmentIds));
  if (fundIds.length > 0) parts.push(inArray(wire.sponsorFundId, fundIds));
  if (parts.length === 0) return out;
  const rows = await loadInstructionRows(tx, or(...parts));
  for (const keys of counterparties) {
    const view = out.get(keyOf(keys));
    if (view === undefined) continue;
    view.versions = rows
      .filter(
        (r) =>
          (r.counterparty.kind === 'investment' && r.counterparty.id === keys.investmentId) ||
          (r.counterparty.kind === 'sponsor_fund' && r.counterparty.id === keys.sponsorFundId),
      )
      .map(toInstructionRow);
    view.active =
      view.versions.find((v) => v.active && v.counterparty.kind === 'investment') ??
      view.versions.find((v) => v.active) ??
      null;
  }
  return out;
}

/**
 * The pending change that holds a release (SEC-12.3, docs/04 M16): the latest version of the
 * counterparty other than the active Verified one that was proposed within the hold window, that
 * is, whose proposal date plus capitalActivity.wireChangeHoldDays is still after the date given.
 * A Rejected version is not a change (the callback refused it; the active instruction stands), so
 * it never holds a release; a Proposed version waiting for its callback, or a version Verified or
 * Superseded within the window, does. Once the changed version is verified by a second person
 * and becomes the active one, it is no longer "other than the active one" and the hold lifts:
 * the callback is the second approval the control asks for. Null when nothing holds.
 */
export function pendingChange(
  register: RegisterView,
  asOf: string,
  holdDays: number,
): WireInstructionRow | null {
  let latest: WireInstructionRow | null = null;
  for (const v of register.versions) {
    if (v.id === register.active?.id || v.state === 'Rejected') continue;
    if (asOf >= addDays(isoDateOf(new Date(v.proposedAt)), holdDays)) continue;
    if (latest === null || v.proposedAt > latest.proposedAt) latest = v;
  }
  return latest;
}

/** The notices a counterparty's instructions pay: by the investment, or by the fund through the investment or the commitment. */
export function noticesOfCounterpartyWhere(keys: CounterpartyKeys): SQL {
  const notice = schema.capitalNotice;
  const parts: SQL[] = [];
  if (keys.investmentId !== null) parts.push(eq(notice.investmentId, keys.investmentId));
  if (keys.sponsorFundId !== null) {
    parts.push(
      sql`${notice.investmentId} in (select i.id from core.investment i where i.sponsor_fund_id = ${keys.sponsorFundId}::uuid)`,
      sql`${notice.commitmentId} in (select c.id from core.commitment c where c.sponsor_fund_id = ${keys.sponsorFundId}::uuid)`,
    );
  }
  if (parts.length === 0) return sql`false`;
  return and(or(...parts)) ?? sql`false`;
}
