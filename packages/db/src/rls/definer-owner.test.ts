import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from '../testing.js';
import type { DbHandle } from '../client.js';
import { withUserContext } from '../context.js';
import { actors, countAs, ids, loadFixture } from './fixture.js';
import { ACTOR_NAMES, READ_MATRIX } from './matrix.js';
import type { ActorName } from './matrix.js';

/**
 * pb.can_see_walled is SECURITY DEFINER: it reads core.walled_record and core.wall_member as the
 * role that owns it, the migration role. The test harness runs migrations as a superuser, which
 * bypasses row-level security, so the matrix alone cannot tell whether walls hold for the owner a
 * deployment has (an administrator that is neither SUPERUSER nor BYPASSRLS). This file makes such a
 * role the owner of the wall tables and of the function, then reruns the whole read matrix
 * (migration 0009, SEC-5.3).
 */
describe('walls with a definer owner that is neither superuser nor bypassrls', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
    await loadFixture(handle);
    await handle.exec(`
      create role pb_migrator nosuperuser nobypassrls nologin;
      grant usage, create on schema core to pb_migrator;
      grant usage, create on schema pb to pb_migrator;
      alter table core.walled_record owner to pb_migrator;
      alter table core.wall_member owner to pb_migrator;
      alter function pb.can_see_walled(text, uuid) owner to pb_migrator;
    `);
  });
  afterAll(async () => {
    await handle.close();
  });

  const actorByName = (name: ActorName) => {
    const a = actors.find((x) => x.name === name);
    if (!a) throw new Error(`no actor ${name}`);
    return a;
  };

  it('keeps the function a definer with its pinned search_path and the new owner', async () => {
    const rows = await handle.query<{ owner: string; secdef: boolean; config: string[] | null }>(
      `select pg_get_userbyid(p.proowner) as owner, p.prosecdef as secdef, p.proconfig as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'pb' and p.proname = 'can_see_walled'`,
    );
    expect(rows).toEqual([
      { owner: 'pb_migrator', secdef: true, config: ['search_path=pg_catalog, public'] },
    ]);
  });

  it('binds the application role to the wall tables through enable, not force', async () => {
    const rows = await handle.query<{ table: string; enabled: boolean; forced: boolean }>(
      `select c.relname as "table", c.relrowsecurity as enabled, c.relforcerowsecurity as forced
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'core' and c.relname in ('wall', 'wall_member', 'walled_record') order by 1`,
    );
    expect(rows).toEqual([
      { table: 'wall', enabled: true, forced: true },
      { table: 'wall_member', enabled: true, forced: false },
      { table: 'walled_record', enabled: true, forced: false },
    ]);
  });

  describe('the read matrix holds for every actor and table', () => {
    for (const [table, expected] of Object.entries(READ_MATRIX)) {
      for (const actor of ACTOR_NAMES) {
        it(`${actor} sees ${expected[actor]} row(s) of ${table}`, async () => {
          expect(await countAs(handle, actorByName(actor), table)).toBe(expected[actor]);
        });
      }
    }
  });

  it('answers the wall question itself for a non-member, a member and the system actor', async () => {
    const asks = async (name: ActorName) => {
      const a = actorByName(name);
      return withUserContext(
        handle.db,
        { userId: a.userId, roles: a.roles, ...(a.clientIds ? { clientIds: a.clientIds } : {}) },
        async (tx) => {
          const r = await tx.execute<{ open: boolean; walled: boolean }>(
            sql`select pb.can_see_walled('investment', ${ids.investment1}::uuid) as open, pb.can_see_walled('investment', ${ids.investmentWalled}::uuid) as walled`,
          );
          return r.rows[0];
        },
      );
    };
    expect(await asks('deal_team')).toEqual({ open: true, walled: false });
    expect(await asks('wall_member(deal_team)')).toEqual({ open: true, walled: true });
    expect(await asks('service')).toEqual({ open: true, walled: true });
  });
});
