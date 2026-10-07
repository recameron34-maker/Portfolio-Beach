import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from './testing.js';
import type { DbHandle } from './client.js';
import { withUserContext } from './context.js';
import type { Tx } from './context.js';
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
  });
});
