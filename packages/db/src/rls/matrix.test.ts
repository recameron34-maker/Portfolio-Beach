import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from '../testing.js';
import type { DbHandle } from '../client.js';
import { withUserContext } from '../context.js';
import { actors, loadFixture } from './fixture.js';
import { ACTOR_NAMES, READ_MATRIX, WRITE_MATRIX } from './matrix.js';
import type { ActorName } from './matrix.js';
import { expectDbRejection } from '../test-utils.js';

/**
 * Generated access-matrix tests: every actor x every table x read, and every actor x every
 * representative write, as positive and negative cases (docs/12 section 1). A change to a policy
 * must change the matrix, and the matrix is reviewed with the security checklist.
 */
describe('RLS access matrix', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
    await loadFixture(handle);
  });
  afterAll(async () => {
    await handle.close();
  });

  const actorByName = (name: ActorName) => {
    const a = actors.find((x) => x.name === name);
    if (!a) throw new Error(`no actor ${name}`);
    return a;
  };

  const countAs = async (name: ActorName, table: string): Promise<number> => {
    const actor = actorByName(name);
    return withUserContext(
      handle.db,
      {
        userId: actor.userId,
        roles: actor.roles,
        ...(actor.clientIds ? { clientIds: actor.clientIds } : {}),
      },
      async (tx) => {
        const r = await tx.execute<{ n: number }>(
          sql.raw(`select count(*)::int as n from ${table}`),
        );
        return r.rows[0]?.n ?? -1;
      },
    );
  };

  describe('reads', () => {
    for (const [table, expected] of Object.entries(READ_MATRIX)) {
      for (const actor of ACTOR_NAMES) {
        it(`${actor} sees ${expected[actor]} row(s) of ${table}`, async () => {
          expect(await countAs(actor, table)).toBe(expected[actor]);
        });
      }
    }

    it('an unauthenticated transaction sees nothing anywhere', async () => {
      for (const table of Object.keys(READ_MATRIX)) {
        const n = await handle.db.transaction(async (tx) => {
          await tx.execute(sql`set local role pb_app`);
          const r = await tx.execute<{ n: number }>(
            sql.raw(`select count(*)::int as n from ${table}`),
          );
          return r.rows[0]?.n ?? -1;
        });
        expect(n, table).toBe(0);
      }
    });

    it('the owner connection still sees everything (seeding and migrations run outside RLS)', async () => {
      const rows = await handle.query<{ n: number }>(
        'select count(*)::int as n from core.investment',
      );
      expect(rows[0]?.n).toBe(2);
    });
  });

  describe('writes', () => {
    for (const wc of WRITE_MATRIX) {
      for (const actor of ACTOR_NAMES) {
        const allowed = wc.allowed.includes(actor);
        it(`${actor} ${allowed ? 'may' : 'may not'} ${wc.name}`, async () => {
          const a = actorByName(actor);
          const attempt = withUserContext(
            handle.db,
            {
              userId: a.userId,
              roles: a.roles,
              ...(a.clientIds ? { clientIds: a.clientIds } : {}),
            },
            async (tx) => {
              const result = await tx.execute(sql.raw(wc.sql));
              // An UPDATE that RLS filters down to zero rows is a denial, not a success.
              const affected = 'affectedRows' in result ? result.affectedRows : result.rowCount;
              if (wc.sql.startsWith('update') && (affected ?? 0) === 0)
                throw new Error('row-level security hid every row (0 rows affected)');
              // Roll back so each cell starts from the same fixture.
              throw new Rollback();
            },
          );
          if (allowed) {
            await expect(attempt).rejects.toBeInstanceOf(Rollback);
          } else {
            await expectDbRejection(attempt, /row-level security|permission denied/);
          }
        });
      }
    }
  });
});

class Rollback extends Error {
  constructor() {
    super('rollback');
  }
}
