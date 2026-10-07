# @pb/api

The Portfolio Beach API (NestJS 12 on Express 5). Phase 0 scope: health, identity to row-level security context, problem-details errors, feature flags and kill switches, and the first M1 read endpoints (portfolio grid with calculated metrics, investment detail, sponsors, vehicles, Data Health, Data Dictionary).

```bash
pnpm synth --profile small --seed 42 --out .synthetic/   # mock users and seed data (run from the repo root)
pnpm db:seed:synthetic .synthetic/dataset.json
pnpm --filter @pb/api dev                                 # http://localhost:3001
pnpm --filter @pb/api test                                # supertest over an in-memory seeded database
pnpm openapi:generate                                     # writes apps/api/openapi.json from packages/contracts
```

## How a request flows
1. `requestIdMiddleware` accepts or mints `x-request-id` and echoes it.
2. `IdentityMiddleware` resolves `Authorization: Bearer <credential>` through the identity adapter: the mock (credential = external id) in the prototype, Entra ID after merge (SEC-4.5). Unknown credentials leave the request anonymous.
3. `AuthGuard` enforces `@Public()` and `@Roles()` metadata: 401 without a principal, 403 for a role-restricted operation.
4. Controllers validate query and body with the zod contracts (`parseOrProblem`); unknown fields are rejected.
5. Services run every business query through `DbService.run`, which is `withUserContext` from `@pb/db`: a transaction as the `pb_app` role with the caller's id, roles and client entitlements set, so Postgres row-level security applies (SEC-5.1). Sensitive reads and config changes append `audit.event` inside the same transaction.
6. Metrics come from `@pb/calc` (MOIC, XIRR with flags, operating ratios, prior-year matching, credit yields and coverage). Nothing is invented: not calculable is `null`.
7. `ProblemFilter` turns every error into RFC 9457 `application/problem+json` with the request id; the `instance` is the path only, never the query string; validation errors list paths and messages, never values. Unknown errors log without content and return a generic 500.

Records the caller cannot see return 404, never 403 (docs/17 section 3).

## Startup guard
`buildRuntime` wires the adapters and calls `assertProductionSafe` before the database opens. With `NODE_ENV=production` and any mock adapter or `PB_MOCK_IDENTITY=true`, the process refuses to start (SEC-17.6).

## Configuration
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3001 | Listen port |
| `PB_DATABASE_URL` | unset | Postgres connection string; unset means PGlite at `PB_PGLITE_DIR` |
| `PB_PGLITE_DIR` | `.pglite/dev` | Local in-process database directory |
| `PB_MOCK_IDENTITY` | `true` | Prototype sign-in; refused in production |
| `PB_MOCK_USERS` | `.synthetic/dataset.json` | Where the mock identity reads its users |
| `PB_CONFIG_DIR` | `config` | `definitions.json` for the Data Dictionary and calculation settings |
| `PB_LOG_LEVEL` | `info` | pino level; logs are structured and content-free (docs/17 section 7) |

No secrets are read by the API in the prototype; production credentials come from Key Vault through managed identity (SEC-4.6).

## Tests
`src/test/api.test.ts` boots the API over a fresh in-memory database seeded with the small synthetic profile and checks: contract parity (every implemented route is in `packages/contracts` and vice versa), health, authentication and problem details, the walled deal hidden from a viewer but visible to a wall member, 404 for invisible records with an audit event on a successful open, calculated metrics including the multiple-IRR flag, cursor pagination, credit and operating views with null where the prior year is missing, client-entitled vehicle totals, data health, data dictionary, and audited flag changes by platform admins only. `src/test/guards.test.ts` covers the production guard and log redaction.
