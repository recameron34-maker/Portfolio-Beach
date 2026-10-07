# @pb/db

The Portfolio Beach database layer: numbered SQL migrations (the source of truth for the schema in `docs/03`), a typed Drizzle mirror for queries, the per-transaction user context that drives row-level security, the data classification registry (SEC-2.1), and the synthetic seed loader.

## How it fits together
- `migrations/NNNN_*.sql`: forward-only, one transaction each, recorded with a content hash in `ops.schema_migration`. An applied migration can never change (the migrator refuses a different hash).
- `src/schema/*`: Drizzle tables that mirror the SQL. `drift.test.ts` fails if either side gains or loses a column.
- `src/context.ts`: `withUserContext(db, { userId, roles, clientIds }, fn)` runs `fn` inside a transaction as the `pb_app` role with the user's identity set as transaction-local settings. Every policy reads them through `pb.*` helper functions. Nothing runs as `pb_app` outside this call.
- `src/classification.ts`: every table has a default class and column overrides. `pnpm check:classification` migrates a scratch database and fails if any column is unclassified or any registry entry is stale.
- `src/rls/`: the access matrix. `matrix.ts` states, per actor and table, the visible row count on the fixture and who may perform each representative write; `matrix.test.ts` generates a positive or negative test from every cell.
- `src/seed.ts`: the synthetic dataset contract (zod) shared with `tools/synthetic`, and an idempotent loader that runs as the owner (never through RLS; local databases only).

## Controls enforced in the database
| Control | Mechanism |
|---|---|
| Row-level security on every business table, forced for the owner too | `0006_history_rls.sql` |
| Walled investments invisible to non-members, including every child table | `pb.can_see_walled` on `core.investment`; child policies call `pb.investment_visible` so the wall applies once |
| Client entitlements; platform admins have no client data access | `pb.entitled_client`, `pb.sees_all_clients` |
| Locked valuations immutable; only a reasoned reopen is allowed; one Locked version per investment and period | trigger `mon.guard_locked_valuation`, partial unique index |
| Preparer never the final approver | CHECK constraints on `mon.valuation` |
| Append-only audit trail | no UPDATE or DELETE grant plus `pb.reject_mutation` trigger |
| Full row history on financial and approval tables | `audit.add_history` creates `<table>_history` and a SECURITY DEFINER trigger |
| Cash flow sign discipline, taxonomy domain membership, single entry snapshot, ownership bounds | CHECK constraints and partial indexes |

Write policies are always split by command (`pb.add_write_policies`): a `FOR ALL` policy's `USING` clause would also widen `SELECT`, which is how a role allowed to write could otherwise see walled rows.

## Commands
```bash
pnpm --filter @pb/db test              # migrations, drift, classification, guards, RLS matrix (in-process Postgres)
pnpm db:migrate                        # applies migrations to .pglite/dev (or PB_DATABASE_URL)
pnpm db:reset                          # recreates the local PGlite database (refuses a real Postgres)
pnpm db:seed:synthetic [dataset.json]  # loads tools/synthetic output
pnpm check:classification              # SEC-2.1 gate
```

## Adding a table
1. Write the SQL in a new migration: standard columns, lineage and approval columns where `docs/03` requires them, `call pb.add_standard_columns_trigger(...)`, history if financial, RLS enable/force, grants, read policy, `call pb.add_write_policies(...)`.
2. Mirror it in `src/schema/` and add it to `CLASSIFICATION`.
3. Add the table to `READ_MATRIX` (and a write case if it has a new access path), with the expected counts per actor.
4. Update `docs/03` and, if the table is outside `docs/03`, add a decision record.
