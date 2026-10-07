# 0005: Phase 0 toolchain and library choices
- **Status:** Accepted for the prototype
- **Date:** 2026-10-07
- **Deciders:** repo owner
## Context
`docs/13` names the stack at the level of frameworks. Phase 0 needs concrete, pinned libraries that work in the cloud sandbox without Docker.
## Decision
| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript 5.9 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | Stable with decorators (NestJS) and typescript-eslint |
| Lint / format | ESLint 10 flat config + typescript-eslint 8, Prettier 3 | Current majors, MIT |
| Tests | Vitest 5 (+ fast-check for properties, @vitest/coverage-v8), jsdom 27 for components, Playwright 1.56 with axe-core for e2e and accessibility | Fast, TS-native, works with Vite. jsdom 30 and Playwright 1.63 need a newer Node or browser than the sandbox provides, so both are pinned one line back |
| Decimal math | decimal.js | Exact decimals for money and rates (`docs/17` section 4) |
| Database in tests | PGlite (Postgres in WASM, in-process) via drizzle-orm's pglite driver | No Docker; real Postgres SQL, enums, RLS and triggers |
| Schema and migrations | Plain SQL migrations applied by `packages/db` (tracked in `ops.schema_migration`); Drizzle table definitions mirror the SQL for typed queries, with a drift test | RLS policies, triggers and history tables need hand-written SQL anyway |
| API | NestJS 12 (ESM, legacy decorators with emitted metadata compiled by tsc; swc in Vitest) on Express 5, Zod at the boundary, pino logs | Named in `docs/13`; mature DI. OpenAPI is generated from `packages/contracts` rather than Nest decorators so one zod schema serves validation, types and the document |
| Web | React 19, Vite 8, TanStack Router (code-based routes) and Query, Fluent UI v9, AG Grid Community; ECharts arrives with analytics | Named in `docs/13`; all MIT |
| Python | Python 3.12+, uv, pytest, Hypothesis, ruff, mypy strict | Cross-check implementation of `docs/08` |
Versions are pinned in `package.json` files and lockfiles; Dependabot proposes updates.
## Consequences
PGlite runs as a single superuser, so RLS tests `SET ROLE` to a non-superuser application role created by the baseline migration, mirroring production where the API connects as a non-owner role. Any Postgres-only feature stays inside `packages/db` (`docs/decisions/0002`).
## SEC IDs affected
SEC-10.5 (lockfiles, pinned versions), SEC-17.6 (mock exclusion is a build flag plus a startup assertion)
## Verification
Package versions and peer ranges checked against the npm registry on the date above.
