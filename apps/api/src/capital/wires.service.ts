import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lt, ne, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AdapterSet, Principal } from '@pb/adapters';
import type {
  WireInstructionCommandBody,
  WireInstructionDetail,
  WireInstructionPage,
  WireInstructionProposeBody,
  wireInstructionListQuery,
} from '@pb/contracts';
import {
  SYSTEM_USER_ID,
  decryptBankDetails,
  encryptBankDetails,
  maskBankDetails,
  schema,
} from '@pb/db';
import type { FieldCipher, Tx } from '@pb/db';
import { attempt, wireInstructionMachine } from '@pb/workflows';
import type { z } from 'zod';
import { AT_ID_CURSOR, decodeAtIdCursor, encodeCursor } from '../common/cursor.js';
import { FIELD_CIPHER } from '../common/fieldCipher.js';
import { ProblemError, workflowProblem } from '../common/problem.js';
import { requireFreshRow } from '../common/row-version.js';
import { systemStep } from '../common/system-step.js';
import { ADAPTERS } from '../common/tokens.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import type { AuditEntry } from '../db/db.service.js';
import { CapitalService } from './capital.service.js';
import {
  REGISTER_ORDER,
  exactKeyWhere,
  loadInstructionRows,
  noticesOfCounterpartyWhere,
  toInstructionRow,
} from './register.js';
import type { CounterpartyKeys } from './register.js';

/*
 * The wire instruction register (docs/04 M16, docs/18 section 11, SEC-12.1 to SEC-12.4,
 * decision 0013). Bank details enter the system in one way: a person types them from a verified
 * source into the propose body (no route fills them from a document, an email or a model). They
 * are encrypted with the field cipher before the insert and decrypted only for operations and
 * approvers on the detail, each decrypted read audited; every other reader, the list and every
 * other page gets the masked form. A new or changed instruction is a new version of its
 * counterparty in Proposed; it becomes Verified through a callback made by a person other than
 * the proposer (the machine refuses the proposer, the database check enforces it) and then is
 * the one active version, the previous one Superseded through the machine as the system actor.
 * A new version proposed while a notice of the counterparty has an approved ticket returns that
 * ticket to draft through wireChanged in the same transaction, and every open notice of the
 * counterparty is flagged (SEC-12.4). Every state change is audited with before and after.
 */

export type WireListOptions = z.infer<typeof wireInstructionListQuery>;

const wire = schema.wireInstruction;
const notice = schema.capitalNotice;
const NOT_FOUND = 'Wire instruction not found';
const ENTITY = 'mon.wire_instruction';
/** The roles that read bank details in clear (SEC-12.2); everyone else sees the masked form. */
const CLEAR_READERS = ['operations', 'approver'];
/** Why the register fires wireChanged on a notice whose ticket was approved against the old version. */
export const WIRE_CHANGED_REASON = 'new wire instruction version proposed';

/** The instruction as locked for a command. */
interface LockedInstruction {
  id: string;
  state: 'Proposed' | 'Verified' | 'Rejected' | 'Superseded';
  version: number;
  proposedBy: string;
  sponsorFundId: string | null;
  investmentId: string | null;
  active: boolean;
  rowVersion: number;
}

const conflict = (): ProblemError =>
  new ProblemError(
    409,
    'conflict',
    'wire_instruction: another command changed the instruction first; open it again',
  );

@Injectable()
export class WiresService {
  constructor(
    private readonly db: DbService,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    private readonly capital: CapitalService,
  ) {}

  /** The register, newest proposal first, masked; filtered by counterparty and state. */
  async list(
    principal: Principal,
    requestId: string,
    opts: WireListOptions,
  ): Promise<WireInstructionPage> {
    const conditions: (SQL | undefined)[] = [];
    if (opts.investmentId !== undefined) conditions.push(eq(wire.investmentId, opts.investmentId));
    if (opts.sponsorFundId !== undefined)
      conditions.push(eq(wire.sponsorFundId, opts.sponsorFundId));
    if (opts.state !== undefined) conditions.push(eq(wire.state, opts.state));
    if (opts.cursor !== undefined) {
      const key = decodeAtIdCursor(opts.cursor, AT_ID_CURSOR);
      const at = sql`${key.at}::timestamptz`;
      conditions.push(
        or(
          lt(wire.proposedAt, at),
          and(eq(wire.proposedAt, at), lt(wire.id, sql`${key.id}::uuid`)),
        ),
      );
    }
    return this.db.run(principal, requestId, async (tx) => {
      const rows = await loadInstructionRows(tx, and(...conditions), {
        orderBy: REGISTER_ORDER,
        limit: opts.limit + 1,
      });
      const page = rows.slice(0, opts.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toInstructionRow),
        nextCursor:
          rows.length > opts.limit && last !== undefined
            ? encodeCursor([last.exactAt, last.id])
            : null,
      };
    });
  }

  /** One version; bank details in clear for operations and approvers only (audited), null for every other role. */
  async detail(
    principal: Principal,
    requestId: string,
    id: string,
  ): Promise<WireInstructionDetail> {
    requireUuid(id, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const found = await this.loadDetail(tx, audit, principal, id);
      if (found === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      return found;
    });
  }

  /**
   * A new version for a counterparty: version = the counterparty's highest + 1 (under an advisory
   * lock on the counterparty), Proposed, encrypted and masked, audited with the counterparty, the
   * version and the masked form only. Then the SEC-12.4 sweep over the counterparty's notices as
   * the system actor (walled notices included): every notice not Reconciled is flagged, and one
   * whose ticket is approved goes back to TicketDrafted through wireChanged.
   */
  async propose(
    principal: Principal,
    requestId: string,
    body: WireInstructionProposeBody,
  ): Promise<WireInstructionDetail> {
    const now = new Date(this.adapters.clock.now());
    return this.db.run(principal, requestId, async (tx, audit) => {
      const keys: CounterpartyKeys = {
        sponsorFundId: body.sponsorFundId ?? null,
        investmentId: body.investmentId ?? null,
      };
      await this.requireCounterparty(tx, keys);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`wire:${keys.investmentId ?? keys.sponsorFundId ?? ''}`}))`,
      );
      const [latest] = await tx
        .select({ version: sql<number>`coalesce(max(${wire.version}), 0)::int` })
        .from(wire)
        .where(exactKeyWhere(keys));
      const version = (latest?.version ?? 0) + 1;
      const masked = maskBankDetails(body.bankDetails);
      const [inserted] = await tx
        .insert(wire)
        .values({
          sponsorFundId: keys.sponsorFundId,
          investmentId: keys.investmentId,
          counterpartyName: body.counterpartyName,
          version,
          bankDetailsEnc: encryptBankDetails(this.cipher, body.bankDetails),
          bankDetailsMasked: masked,
          state: 'Proposed',
          proposedBy: principal.userId,
          proposedAt: now,
          sourceNote: body.sourceNote ?? null,
          active: false,
        })
        .returning();
      if (inserted === undefined) throw conflict();
      await audit({
        action: 'wire_instruction.propose',
        entity: ENTITY,
        entityId: inserted.id,
        details: {
          counterparty: {
            kind: keys.investmentId !== null ? 'investment' : 'sponsor_fund',
            id: keys.investmentId ?? keys.sponsorFundId,
            name: body.counterpartyName,
          },
          version,
          state: { before: null, after: 'Proposed' },
          bankDetailsMasked: masked,
        },
      });
      await this.sweepNotices(tx, audit, principal, keys, inserted.id);
      const detail = await this.loadDetail(tx, audit, principal, inserted.id);
      if (detail === null) throw conflict();
      return detail;
    });
  }

  /**
   * verify records the confirming callback by the actor (never the proposer), makes the version
   * active and supersedes the previous active one; reject records the reason and the failed
   * callback when one was made. Both lock the row, guard the write on its state and row version
   * (409 otherwise), honour If-Match (412) and audit before and after.
   */
  async command(
    principal: Principal,
    requestId: string,
    id: string,
    body: WireInstructionCommandBody,
    ifMatch?: readonly number[],
  ): Promise<WireInstructionDetail> {
    requireUuid(id, NOT_FOUND);
    const now = new Date(this.adapters.clock.now());
    return this.db.run(principal, requestId, async (tx, audit) => {
      const locked = (
        await tx
          .select({
            id: wire.id,
            state: wire.state,
            version: wire.version,
            proposedBy: wire.proposedBy,
            sponsorFundId: wire.sponsorFundId,
            investmentId: wire.investmentId,
            active: wire.active,
            rowVersion: wire.rowVersion,
          })
          .from(wire)
          .where(eq(wire.id, id))
          .for('update')
      )[0];
      if (locked === undefined) throw new ProblemError(404, 'not-found', NOT_FOUND);
      requireFreshRow(ifMatch, locked.rowVersion, 'wire_instruction');
      const result = attempt(wireInstructionMachine, locked.state, body.command, {
        actorId: principal.userId,
        actorRoles: principal.roles,
        ...(body.command === 'reject' ? { reason: body.reason } : {}),
        record: {
          proposedBy: locked.proposedBy,
          callbackConfirmed: body.command === 'verify' && body.callbackResult === 'confirmed',
        },
      });
      if (!result.ok) throw workflowProblem(result);

      if (body.command === 'verify') {
        const superseded = await this.supersedePrevious(tx, audit, principal, locked);
        await this.write(tx, locked, {
          state: 'Verified',
          callbackBy: principal.userId,
          callbackAt: now,
          callbackNumberSource: body.callbackNumberSource,
          callbackResult: body.callbackResult,
          verifiedAt: now,
          active: true,
        });
        await audit({
          action: 'wire_instruction.verify',
          entity: ENTITY,
          entityId: id,
          details: {
            version: locked.version,
            state: { before: locked.state, after: 'Verified' },
            active: { before: locked.active, after: true },
            callback: {
              by: principal.userId,
              at: now.toISOString(),
              numberSource: body.callbackNumberSource,
              result: body.callbackResult,
            },
            superseded,
          },
        });
      } else {
        const loggedCallback = body.callbackResult !== undefined;
        if (loggedCallback && principal.userId === locked.proposedBy)
          throw new ProblemError(
            422,
            'workflow-precondition',
            'wire_instruction: the callback must be made by a person other than the proposer (SEC-12.2)',
          );
        await this.write(tx, locked, {
          state: 'Rejected',
          rejectionReason: body.reason,
          ...(loggedCallback
            ? {
                callbackBy: principal.userId,
                callbackAt: now,
                callbackNumberSource: body.callbackNumberSource ?? null,
                callbackResult: body.callbackResult,
              }
            : {}),
        });
        await audit({
          action: 'wire_instruction.reject',
          entity: ENTITY,
          entityId: id,
          reason: body.reason,
          details: {
            version: locked.version,
            state: { before: locked.state, after: 'Rejected' },
            callback: loggedCallback
              ? {
                  by: principal.userId,
                  at: now.toISOString(),
                  numberSource: body.callbackNumberSource ?? null,
                  result: body.callbackResult,
                }
              : null,
          },
        });
      }
      const detail = await this.loadDetail(tx, audit, principal, id);
      if (detail === null) throw conflict();
      return detail;
    });
  }

  /** The row with the bank details decrypted for a clear reader (audited), null for anyone else. */
  private async loadDetail(
    tx: Tx,
    audit: (entry: AuditEntry) => Promise<void>,
    principal: Principal,
    id: string,
  ): Promise<WireInstructionDetail | null> {
    const [loaded] = await loadInstructionRows(tx, eq(wire.id, id));
    if (loaded === undefined) return null;
    const row = toInstructionRow(loaded);
    if (!principal.roles.some((r) => CLEAR_READERS.includes(r)))
      return { ...row, bankDetails: null };
    const [secret] = await tx
      .select({ enc: wire.bankDetailsEnc })
      .from(wire)
      .where(eq(wire.id, id));
    if (secret === undefined) return null;
    const bankDetails = decryptBankDetails(this.cipher, secret.enc);
    await audit({ action: 'wire_instruction.read', entity: ENTITY, entityId: id });
    return { ...row, bankDetails };
  }

  /** The counterparty must exist and be visible to the proposer (404 otherwise). */
  private async requireCounterparty(tx: Tx, keys: CounterpartyKeys): Promise<void> {
    if (keys.investmentId !== null) {
      const found = await tx
        .select({ id: schema.investment.id })
        .from(schema.investment)
        .where(eq(schema.investment.id, keys.investmentId));
      if (found.length === 0) throw new ProblemError(404, 'not-found', 'Investment not found');
    } else if (keys.sponsorFundId !== null) {
      const found = await tx
        .select({ id: schema.sponsorFund.id })
        .from(schema.sponsorFund)
        .where(eq(schema.sponsorFund.id, keys.sponsorFundId));
      if (found.length === 0) throw new ProblemError(404, 'not-found', 'Sponsor fund not found');
    } else {
      throw new ProblemError(404, 'not-found', 'Counterparty not found');
    }
  }

  /** The one write of a command, on the row as it was locked; nothing written is a conflict. */
  private async write(
    tx: Tx,
    locked: LockedInstruction,
    patch: Partial<typeof wire.$inferInsert>,
  ): Promise<void> {
    const updated = await tx
      .update(wire)
      .set(patch)
      .where(
        and(
          eq(wire.id, locked.id),
          eq(wire.state, locked.state),
          eq(wire.rowVersion, locked.rowVersion),
        ),
      )
      .returning();
    if (updated[0] === undefined) throw conflict();
  }

  /**
   * The previous active version of the same counterparty key moves to Superseded through the
   * machine as the system actor (docs/18 section 11: a newer Verified version exists), before the
   * new one becomes active, so the one-active-per-counterparty index never sees two.
   */
  private async supersedePrevious(
    tx: Tx,
    audit: (entry: AuditEntry) => Promise<void>,
    principal: Principal,
    verified: LockedInstruction,
  ): Promise<string[]> {
    const previous = await tx
      .select({
        id: wire.id,
        state: wire.state,
        version: wire.version,
        proposedBy: wire.proposedBy,
        sponsorFundId: wire.sponsorFundId,
        investmentId: wire.investmentId,
        active: wire.active,
        rowVersion: wire.rowVersion,
      })
      .from(wire)
      .where(and(exactKeyWhere(verified), eq(wire.active, true), ne(wire.id, verified.id)))
      .for('update');
    const superseded: string[] = [];
    for (const old of previous) {
      const result = attempt(wireInstructionMachine, old.state, 'supersede', {
        actorId: SYSTEM_USER_ID,
        actorRoles: ['service'],
        record: { newerVerifiedExists: true },
      });
      if (!result.ok) throw workflowProblem(result);
      await this.write(tx, old, { state: 'Superseded', active: false });
      await audit({
        action: 'wire_instruction.supersede',
        entity: ENTITY,
        entityId: old.id,
        details: {
          version: old.version,
          state: { before: old.state, after: 'Superseded' },
          active: { before: old.active, after: false },
          supersededBy: verified.id,
          step: `system step of verify by ${principal.userId}`,
        },
      });
      superseded.push(old.id);
    }
    return superseded;
  }

  /**
   * SEC-12.4 after a new version: every notice of the counterparty not yet Reconciled carries the
   * wire change flag, and a notice whose ticket was approved against the previous version goes
   * back to TicketDrafted through capitalNoticeMachine (wireChanged, the service path's reason).
   * Runs as the system actor inside the proposer's transaction so a walled notice is flagged too.
   */
  private async sweepNotices(
    tx: Tx,
    audit: (entry: AuditEntry) => Promise<void>,
    principal: Principal,
    keys: CounterpartyKeys,
    newVersionId: string,
  ): Promise<void> {
    await systemStep(tx, principal, async () => {
      const open = await tx
        .select({ id: notice.id, state: notice.state, wireChangeFlag: notice.wireChangeFlag })
        .from(notice)
        .where(and(noticesOfCounterpartyWhere(keys), ne(notice.state, 'Reconciled')))
        .for('update');
      for (const n of open) {
        if (n.state === 'TicketApproved') {
          // wireChanged sets the flag on its own write.
          await this.capital.commandWithin(tx, audit, principal, n.id, {
            command: 'wireChanged',
            reason: WIRE_CHANGED_REASON,
          });
          continue;
        }
        if (n.wireChangeFlag) continue;
        await tx.update(notice).set({ wireChangeFlag: true }).where(eq(notice.id, n.id));
        await audit({
          action: 'capital_notice.wire_change_flag',
          entity: 'mon.capital_notice',
          entityId: n.id,
          reason: WIRE_CHANGED_REASON,
          details: {
            wireChangeFlag: { before: false, after: true },
            wireInstructionId: newVersionId,
          },
        });
      }
    });
  }
}
