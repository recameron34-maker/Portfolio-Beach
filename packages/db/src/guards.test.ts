import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from './testing.js';
import type { DbHandle } from './client.js';
import { asSystemActor, withUserContext } from './context.js';
import type { Tx } from './context.js';
import type { AppRole } from './roles.js';
import { SYSTEM_USER_ID } from './roles.js';
import { ids, loadFixture } from './rls/fixture.js';
import { expectDbRejection } from './test-utils.js';

/** Database-level financial controls: locks, immutability, history, segregation of duties, sign discipline. */
describe('database guards', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
    await loadFixture(handle);
  });
  afterAll(async () => {
    await handle.close();
  });

  const asOps = (fn: (tx: Tx) => Promise<unknown>): Promise<void> =>
    withUserContext(
      handle.db,
      { userId: ids.users.operations, roles: ['operations'] },
      async (tx) => {
        await fn(tx);
      },
    );

  describe('Locked valuations (SEC-9.3, M10)', () => {
    it('cannot be updated in place, even by operations', async () => {
      await expectDbRejection(
        asOps((tx) =>
          tx.execute(
            sql`update mon.valuation set fair_value = 1 where id = ${ids.valuationLocked}`,
          ),
        ),
        /Locked and cannot be updated in place/,
      );
    });
    it('cannot be deleted by anyone, including the owner', async () => {
      await expectDbRejection(
        handle.exec(`delete from mon.valuation where id = '${ids.valuationLocked}'`),
        /immutable/,
      );
    });
    it('cannot be reopened without a reason', async () => {
      await expectDbRejection(
        asOps((tx) =>
          tx.execute(
            sql`update mon.valuation set state = 'Reopened' where id = ${ids.valuationLocked}`,
          ),
        ),
        /requires a reason/,
      );
    });
    it('cannot change locked values while reopening', async () => {
      await expectDbRejection(
        asOps((tx) =>
          tx.execute(
            sql`update mon.valuation set state = 'Reopened', reopen_reason = 'restated', fair_value = 1 where id = ${ids.valuationLocked}`,
          ),
        ),
        /keeps its locked values/,
      );
    });
    it('allows only one Locked version per investment and period', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into mon.valuation (investment_id, period_end, version, method, fair_value, state, lock_hash, prepared_by, approved_by)
           values ('${ids.investment1}', '2024-06-30', 2, 'valuation_method.cost', 1, 'Locked', 'h', '${ids.users.operations}', '${ids.users.approver}')`,
        ),
        /valuation_one_locked_idx/,
      );
    });
    it('can be reopened with a reason, after which the row is read-only', async () => {
      await asOps((tx) =>
        tx.execute(
          sql`update mon.valuation set state = 'Reopened', reopen_reason = 'Sponsor restated Q2' where id = ${ids.valuationLocked}`,
        ),
      );
      const rows = await handle.query<{ state: string; fair_value: string }>(
        `select state, fair_value from mon.valuation where id = '${ids.valuationLocked}'`,
      );
      expect(rows[0]).toEqual({ state: 'Reopened', fair_value: '45000000.00' });
      await expectDbRejection(
        asOps((tx) =>
          tx.execute(
            sql`update mon.valuation set fair_value = 2 where id = ${ids.valuationLocked}`,
          ),
        ),
        /read-only/,
      );
    });
  });

  describe('segregation of duties (SEC-5.6)', () => {
    it('rejects a valuation whose preparer is also the final approver', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into mon.valuation (investment_id, period_end, version, method, fair_value, state, lock_hash, prepared_by, approved_by)
           values ('${ids.investment1}', '2024-09-30', 1, 'valuation_method.cost', 1, 'Locked', 'h', '${ids.users.operations}', '${ids.users.operations}')`,
        ),
        /check constraint/,
      );
    });
    it('requires an approver before a valuation can be Locked', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into mon.valuation (investment_id, period_end, version, method, fair_value, state, lock_hash, prepared_by)
           values ('${ids.investment1}', '2024-09-30', 1, 'valuation_method.cost', 1, 'Locked', 'h', '${ids.users.operations}')`,
        ),
        /check constraint/,
      );
    });
  });

  describe('wire instructions and trade tickets (SEC-12.2, SEC-12.3, migration 0013)', () => {
    const wire = (columns: string, values: string) =>
      handle.exec(
        `insert into mon.wire_instruction (investment_id, counterparty_name, version, bank_details_enc, bank_details_masked, proposed_by, ${columns})
         values ('${ids.investment1}', 'Harborlight Fund IV', 9, 'enc', 'Harbor Street Bank ****7788', '${ids.users.operations}', ${values})`,
      );

    it('rejects a callback made by the proposer', async () => {
      await expectDbRejection(
        wire(
          'callback_by, callback_at, callback_number_source, callback_result',
          `'${ids.users.operations}', now(), 'prior_instruction', 'confirmed'`,
        ),
        /check constraint/,
      );
    });
    it('rejects Verified without a confirmed callback by a named person', async () => {
      await expectDbRejection(wire('state', `'Verified'`), /check constraint/);
      await expectDbRejection(
        wire(
          'state, callback_by, callback_at, callback_number_source, callback_result, verified_at',
          `'Verified', '${ids.users.operations2}', now(), 'known_contact', 'not_confirmed', now()`,
        ),
        /check constraint/,
      );
    });
    it('rejects an active version that is not Verified, and a second active version per counterparty', async () => {
      await expectDbRejection(wire('active', 'true'), /check constraint/);
      await expectDbRejection(
        wire(
          'state, callback_by, callback_at, callback_number_source, callback_result, verified_at, active',
          `'Verified', '${ids.users.operations2}', now(), 'prior_instruction', 'confirmed', now(), true`,
        ),
        /wire_instruction_investment_active_idx/,
      );
    });
    it('rejects a counterparty that is both a sponsor fund and an investment, or neither', async () => {
      await expectDbRejection(wire('sponsor_fund_id', `'${ids.sponsorFund}'`), /check constraint/);
      await expectDbRejection(
        handle.exec(
          `insert into mon.wire_instruction (counterparty_name, version, bank_details_enc, bank_details_masked, proposed_by) values ('Nobody', 1, 'enc', 'x ****0000', '${ids.users.operations}')`,
        ),
        /check constraint/,
      );
    });
    it('rejects a Rejected version without a reason', async () => {
      await expectDbRejection(wire('state', `'Rejected'`), /check constraint/);
    });
    it('rejects a ticket approved by its preparer, and Approved without an approver and an instruction', async () => {
      const ticket = (columns: string, values: string) =>
        handle.exec(
          `insert into mon.trade_ticket (capital_notice_id, amount, funding_date, prepared_by, ${columns})
           values ('${ids.capitalNoticeOpenDistribution}', 500000, '2024-10-15', '${ids.users.operations}', ${values})`,
        );
      await expectDbRejection(
        ticket('approved_by, approved_at', `'${ids.users.operations}', now()`),
        /check constraint/,
      );
      await expectDbRejection(ticket('state', `'Approved'`), /check constraint/);
      await expectDbRejection(
        ticket('state, approved_by, approved_at', `'Approved', '${ids.users.approver}', now()`),
        /check constraint/,
      );
      await expectDbRejection(ticket('state', `'Withdrawn'`), /check constraint/);
      await expectDbRejection(
        handle.exec(
          `insert into mon.trade_ticket (capital_notice_id, amount, funding_date, prepared_by) values ('${ids.capitalNoticeOpenDistribution}', 0, '2024-10-15', '${ids.users.operations}')`,
        ),
        /check constraint/,
      );
    });
    it('allows one ticket per notice', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into mon.trade_ticket (capital_notice_id, amount, funding_date, prepared_by) values ('${ids.capitalNoticeOpen}', 1, '2024-09-15', '${ids.users.operations}')`,
        ),
        /unique|duplicate key/,
      );
    });
    it('keeps a full history image of the register and the tickets', async () => {
      await asOps((tx) =>
        tx.execute(
          sql`update mon.wire_instruction set source_note = 'Confirmed again at the AGM' where id = ${ids.wireInstructionProposed}`,
        ),
      );
      const history = await handle.query<{ op: string; row_image: { source_note: string } }>(
        `select op, row_image from mon.wire_instruction_history where row_id = '${ids.wireInstructionProposed}' order by history_id`,
      );
      expect(history.map((h) => h.op)).toEqual(['INSERT', 'UPDATE']);
      expect(history[1]?.row_image.source_note).toBe('Confirmed again at the AGM');
      const tickets = await handle.query<{ n: number }>(
        `select count(*)::int as n from mon.trade_ticket_history where row_id = '${ids.tradeTicketOpen}'`,
      );
      expect(tickets[0]?.n).toBe(1);
    });
  });

  describe('change requests, the pipeline and closings (migration 0013)', () => {
    it('rejects a change request Applied without a period and an applier, Rejected without a reason, Routed without an owner', async () => {
      const request = (columns: string, values: string) =>
        handle.exec(
          `insert into mon.deal_change_request (investment_id, change_type, effective_date, summary, submitted_by, ${columns})
           values ('${ids.investment1}', 'change_type.partial_exit', '2024-09-30', 'Partial exit of the minority stake', '${ids.users.dealTeam}', ${values})`,
        );
      await expectDbRejection(
        request('state, owner_id', `'Applied', '${ids.users.operations}'`),
        /check constraint/,
      );
      await expectDbRejection(
        request(
          'state, owner_id, applied_period',
          `'Applied', '${ids.users.operations}', '2024-09-30'`,
        ),
        /check constraint/,
      );
      await expectDbRejection(request('state', `'Rejected'`), /check constraint/);
      await expectDbRejection(request('state', `'Routed'`), /check constraint/);
      await expectDbRejection(
        handle.exec(
          `insert into mon.deal_change_request (investment_id, change_type, effective_date, summary, submitted_by) values ('${ids.investment1}', 'sector.software', '2024-09-30', 'Wrong domain', '${ids.users.dealTeam}')`,
        ),
        /check constraint/,
      );
    });
    it('rejects a Passed opportunity without a reason code and a Closed one without an investment', async () => {
      const opportunity = (columns: string, values: string) =>
        handle.exec(
          `insert into deal.opportunity (name, company_name, sponsor_id, deal_type, received_date, ${columns})
           values ('Project Reef', 'Reef Analytics', '${ids.sponsor}', 'deal_type.co_invest_equity', '2024-10-01', ${values})`,
        );
      await expectDbRejection(opportunity('stage', `'Passed'`), /check constraint/);
      await expectDbRejection(opportunity('stage', `'Closed'`), /check constraint/);
      await expectDbRejection(
        opportunity('pass_reason_code', `'change_type.other'`),
        /check constraint/,
      );
    });
    it('rejects a closing that is OpsConfirmed without a confirmer, or anchored on nothing', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into deal.closing (investment_id, close_date, commitment_amount, state) values ('${ids.investment1}', '2022-03-15', 30000000, 'OpsConfirmed')`,
        ),
        /check constraint/,
      );
      await expectDbRejection(
        handle.exec(
          `insert into deal.closing (close_date, commitment_amount) values ('2022-03-15', 30000000)`,
        ),
        /check constraint/,
      );
      await expectDbRejection(
        handle.exec(
          `insert into deal.closing (investment_id, close_date, commitment_amount) values ('${ids.investment1}', '2022-03-15', 0)`,
        ),
        /check constraint/,
      );
    });
    it('rejects a received checklist item without a document and a waived one without a reason', async () => {
      await expectDbRejection(
        asOps((tx) =>
          tx.execute(
            sql`update deal.closing_item set status = 'received' where id = ${ids.closingItemOpen}`,
          ),
        ),
        /check constraint/,
      );
      await expectDbRejection(
        asOps((tx) =>
          tx.execute(
            sql`update deal.closing_item set status = 'waived' where id = ${ids.closingItemOpen}`,
          ),
        ),
        /check constraint/,
      );
      // The deal team owns diligence tasks (operations is filtered out by the policy, not refused).
      await expectDbRejection(
        withUserContext(
          handle.db,
          { userId: ids.users.dealTeam, roles: ['deal_team'] },
          async (tx) => {
            await tx.execute(
              sql`update deal.diligence_task set status = 'waived' where id = ${ids.diligenceTaskOpen}`,
            );
          },
        ),
        /check constraint/,
      );
    });
    it('keeps the close date in one place: no other table has a column named close_date', async () => {
      const rows = await handle.query<{ table_schema: string; table_name: string }>(
        `select table_schema, table_name from information_schema.columns where column_name = 'close_date' and table_schema not in ('pg_catalog', 'information_schema')`,
      );
      expect(rows).toEqual([{ table_schema: 'deal', table_name: 'closing' }]);
    });
    it('keeps one allocation line per anchor, vehicle and client', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into deal.allocation (opportunity_id, vehicle_id, requested) values ('${ids.opportunityOpen}', '${ids.vehicle}', 1)`,
        ),
        /unique|duplicate key/,
      );
    });
  });

  describe('audit trail (SEC-11.1)', () => {
    it('rejects UPDATE and DELETE even for the owner', async () => {
      await expectDbRejection(handle.exec(`update audit.event set action = 'x'`), /immutable/);
      await expectDbRejection(handle.exec(`delete from audit.event`), /immutable/);
    });
    it('rejects UPDATE and DELETE for the application role by grant', async () => {
      await expectDbRejection(
        asOps((tx) => tx.execute(sql`update audit.event set action = 'x'`)),
        /permission denied/,
      );
      await expectDbRejection(
        asOps((tx) => tx.execute(sql`delete from audit.event`)),
        /permission denied/,
      );
    });
  });

  describe('history tables (SEC-9.2)', () => {
    it('record a full row image for insert and update with the acting user', async () => {
      await asOps((tx) =>
        tx.execute(
          sql`update core.investment set exit_date = '2025-01-31', is_active = false where id = ${ids.investment1}`,
        ),
      );
      const history = await handle.query<{
        op: string;
        actor_id: string | null;
        row_image: { exit_date: string | null; row_version: number };
      }>(
        `select op, actor_id, row_image from core.investment_history where row_id = '${ids.investment1}' order by history_id`,
      );
      expect(history.map((h) => h.op)).toEqual(['INSERT', 'UPDATE']);
      expect(history[1]?.actor_id).toBe(ids.users.operations);
      expect(history[1]?.row_image.exit_date).toBe('2025-01-31');
      expect(history[1]?.row_image.row_version).toBe(2);
    });
    it('cannot be written directly by the application role', async () => {
      await expectDbRejection(
        asOps((tx) =>
          tx.execute(
            sql`insert into core.investment_history (row_id, op, row_image) values (${ids.investment1}, 'INSERT', '{}')`,
          ),
        ),
        /permission denied/,
      );
    });
  });

  describe('standard columns', () => {
    it('stamp created_by and bump row_version through the trigger', async () => {
      await asOps((tx) =>
        tx.execute(
          sql`insert into core.sponsor (name, canonical_name, tier) values ('Driftwood Partners', 'driftwood partners', 'sponsor_tier.new')`,
        ),
      );
      const before = await handle.query<{ created_by: string; row_version: number }>(
        `select created_by, row_version from core.sponsor where canonical_name = 'driftwood partners'`,
      );
      expect(before[0]).toEqual({ created_by: ids.users.operations, row_version: 1 });
      await withUserContext(
        handle.db,
        { userId: ids.users.dealTeam, roles: ['deal_team'] },
        async (tx) => {
          await tx.execute(
            sql`update core.sponsor set description = 'Lower mid-market buyout' where canonical_name = 'driftwood partners'`,
          );
        },
      );
      const after = await handle.query<{
        created_by: string;
        updated_by: string;
        row_version: number;
      }>(
        `select created_by, updated_by, row_version from core.sponsor where canonical_name = 'driftwood partners'`,
      );
      expect(after[0]).toEqual({
        created_by: ids.users.operations,
        updated_by: ids.users.dealTeam,
        row_version: 2,
      });
    });
  });

  describe('constraints over code', () => {
    it('rejects a contribution with a positive amount and a distribution with a negative one', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into mon.cash_flow (investment_id, flow_date, flow_type, amount) values ('${ids.investment1}', '2024-01-01', 'flow_type.contribution', 5)`,
        ),
        /check constraint/,
      );
      await expectDbRejection(
        handle.exec(
          `insert into mon.cash_flow (investment_id, flow_date, flow_type, amount) values ('${ids.investment1}', '2024-01-01', 'flow_type.distribution', -5)`,
        ),
        /check constraint/,
      );
    });
    it('rejects a taxonomy code from the wrong domain', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into core.sponsor (name, canonical_name, tier) values ('X', 'x', 'sector.software')`,
        ),
        /check constraint/,
      );
      await expectDbRejection(
        handle.exec(
          `insert into core.taxonomy_term (domain, code, label) values ('sector', 'strategy.oops', 'Oops')`,
        ),
        /check constraint/,
      );
    });
    it('allows at most one entry snapshot per investment', async () => {
      await handle.exec(
        `insert into mon.quarterly_performance (investment_id, period_end, is_entry_snapshot) values ('${ids.investment1}', '2022-03-31', true)`,
      );
      await expectDbRejection(
        handle.exec(
          `insert into mon.quarterly_performance (investment_id, period_end, is_entry_snapshot) values ('${ids.investment1}', '2022-06-30', true)`,
        ),
        /quarterly_performance_entry_idx/,
      );
    });
    it('never deletes cash flows', async () => {
      await expectDbRejection(handle.exec(`delete from mon.cash_flow`), /immutable/);
    });
    it('rejects an ownership percentage above 100%', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into core.lp_commitment (client_id, vehicle_id, amount, commitment_date, ownership_pct) values ('${ids.clientA}', '${ids.vehicle}', 1, '2024-01-01', 1.5)`,
        ),
        /check constraint/,
      );
    });
  });

  describe('user context', () => {
    it('rejects malformed ids before touching the database', async () => {
      await expect(
        withUserContext(handle.db, { userId: 'not-a-uuid', roles: ['viewer'] }, () =>
          Promise.resolve(1),
        ),
      ).rejects.toThrow(/UUID/);
      await expect(
        withUserContext(
          handle.db,
          { userId: ids.users.viewer, roles: ['viewer'], clientIds: ['x'] },
          () => Promise.resolve(1),
        ),
      ).rejects.toThrow(/UUID/);
    });
    it('resets the role when the transaction ends', async () => {
      await withUserContext(
        handle.db,
        { userId: ids.users.viewer, roles: ['viewer'] },
        async (tx) => {
          const r = await tx.execute<{ r: string }>(sql`select current_user as r`);
          expect(r.rows[0]?.r).toBe('pb_app');
        },
      );
      const after = await handle.query<{ r: string }>('select current_user as r');
      expect(after[0]?.r).not.toBe('pb_app');
    });
    it('refuses a role that is not an application role, so a comma-joined string never carries the service role (SEC-5.3)', async () => {
      // The roles setting is one comma-joined string that pb.current_roles() splits again.
      for (const roles of [
        ['viewer,service'],
        ['service,viewer'],
        ['editor'],
        [''],
        ['viewer', 'Service'],
      ]) {
        await expect(
          withUserContext(
            handle.db,
            { userId: ids.users.viewer, roles: roles as unknown as AppRole[] },
            () => Promise.resolve(1),
          ),
        ).rejects.toThrow(/not an application role/);
      }
      // The same string typed as a role would otherwise have been the system actor.
      const n = await withUserContext(
        handle.db,
        { userId: ids.users.viewer, roles: ['viewer'] },
        async (tx) => {
          const r = await tx.execute<{ n: number }>(
            sql`select count(*)::int as n from core.investment`,
          );
          return r.rows[0]?.n;
        },
      );
      expect(n).toBe(1);
    });
  });

  describe('system actor inside a user transaction (migration 0008, SEC-5.3)', () => {
    const identity = async (tx: Tx) => {
      const r = await tx.execute<{
        user_id: string;
        roles: string;
        client_ids: string;
        role: string;
        investments: number;
      }>(
        sql`select current_setting('app.user_id', true) as user_id, current_setting('app.roles', true) as roles, current_setting('app.client_ids', true) as client_ids, current_user as role, (select count(*)::int from core.investment) as investments`,
      );
      return r.rows[0]!;
    };
    const viewer = {
      userId: ids.users.viewer,
      roles: ['viewer'] as AppRole[],
      clientIds: [ids.clientA],
    };

    it('sees every walled record while it runs and gives the caller back their own identity', async () => {
      await withUserContext(handle.db, viewer, async (tx) => {
        expect(await identity(tx)).toMatchObject({
          user_id: ids.users.viewer,
          roles: 'viewer',
          client_ids: ids.clientA,
          investments: 1,
        });
        const inside = await asSystemActor(tx, (stx) => identity(stx));
        expect(inside).toMatchObject({
          user_id: SYSTEM_USER_ID,
          roles: 'service',
          client_ids: '',
          role: 'pb_app',
          investments: 2,
        });
        expect(await identity(tx)).toMatchObject({
          user_id: ids.users.viewer,
          roles: 'viewer',
          client_ids: ids.clientA,
          role: 'pb_app',
          investments: 1,
        });
      });
    });

    it('restores the caller after a failure inside, and the transaction stays usable', async () => {
      await withUserContext(handle.db, viewer, async (tx) => {
        await expect(asSystemActor(tx, () => Promise.reject(new Error('boom')))).rejects.toThrow(
          'boom',
        );
        expect(await identity(tx)).toMatchObject({ user_id: ids.users.viewer, investments: 1 });
        // A failed statement aborts the savepoint only, never the caller's transaction.
        await expectDbRejection(
          asSystemActor(tx, async (stx) => {
            await stx.execute(sql`select 1 / 0`);
          }),
          /division by zero/,
        );
        expect(await identity(tx)).toMatchObject({ user_id: ids.users.viewer, investments: 1 });
      });
    });

    it('runs only inside a user transaction', async () => {
      await expect(
        handle.db.transaction((tx) => asSystemActor(tx, () => Promise.resolve(1))),
      ).rejects.toThrow(/only inside a user transaction/);
    });
  });
});
