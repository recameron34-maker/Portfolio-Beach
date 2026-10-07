# 17: Engineering Standards

## 1. Repository and tooling
- pnpm workspaces; Node 22 LTS (`.nvmrc`); Python 3.12 with `uv`; TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- ESLint + Prettier; Ruff + mypy (strict) for Python.
- **Conventional Commits** (`feat:`, `fix:`, `chore:`...) with the issue number; squash merge.
- Semantic versioning for the app; a `CHANGELOG.md` generated from commits.

## 2. Package scripts contract (root `package.json`)
`dev`, `build`, `typecheck`, `lint`, `test`, `test:calc`, `test:rls`, `test:workflows`, `test:evals`, `test:e2e`, `test:a11y`, `test:perf`, `db:migrate`, `db:reset`, `db:seed:synthetic`, `synth`, `synth:verify`, `check:style`, `check:employer-data`, `openapi:generate`. Claude Code must keep these names stable; CI depends on them.

## 3. API conventions
- REST with OpenAPI 3.1 generated from code; contracts shared in `packages/contracts`.
- **Errors:** RFC 9457 problem details (`type`, `title`, `status`, `detail`, `instance`, `request_id`). No stack traces or data values in error bodies.
- **Not found vs. forbidden:** return 404 for records the caller may not see (no existence leaks).
- **Pagination:** cursor-based, `limit` max 200.
- **Concurrency:** `ETag` = `row_version`; updates require `If-Match`; mismatch returns 412.
- **Idempotency:** all POSTs that create financial records or trigger jobs accept an `Idempotency-Key` header; repeats return the original result.
- **Validation:** Zod at every boundary; reject unknown fields.
- **Versioning:** `/api/v1`; breaking changes need a new version.

## 4. Money, numbers and time
- Money and ratios use a decimal library (for example `decimal.js` in TS, `Decimal` in Python). JS `number` is forbidden for money (lint rule).
- Clock is injected (`Clock` interface). No `new Date()` in domain code.
- All stored times UTC; business dates are `date` types.

## 5. Resilience patterns
- Every adapter call has a **timeout**, **retry with exponential backoff and jitter** (only for idempotent operations), and a **circuit breaker**.
- **Outbox pattern** for events: DB change and event row commit together; a relay publishes.
- **Dead-letter** queue for jobs failing after retries, surfaced on the exceptions page.
- **Kill switch** (feature flag) per adapter and per AI feature, checked on every call.
- **Rate and cost limits** for AI calls: per-job token budget, per-day budget; exceeding pauses the job and alerts.
- **Graceful degradation:** if AI is unavailable, intake continues and items queue for later extraction.

## 6. Mock adapters must never reach production
- Mocks live in `packages/adapters/*/mock` and are excluded from production builds by a build-time flag.
- The API refuses to start if `NODE_ENV=production` and any adapter resolves to a mock, or if mock identity is enabled (startup assertion + test).

## 7. Logging and telemetry
- Structured JSON logs with `request_id`, `user_id` (internal ID only), `action`, `entity`, `entity_id`, `status`, `duration_ms`.
- **Never log** document text, email content, AI prompts or outputs, money values or bank details. A log-redaction unit test scans for forbidden fields.
- OpenTelemetry traces across web, API, workers and adapters.
- Health endpoints: `/health/live`, `/health/ready` (checks DB, queue, critical adapters).

## 8. Performance budgets (seeded default profile)
| Action | Budget (p95) |
|---|---|
| Portfolio grid (200 rows, server paging) | 800 ms API, 2 s page |
| Deal one-pager | 1.5 s |
| Search | 1 s |
| Calc refresh for one investment | 200 ms |
| Full portfolio calc refresh (200 investments) | 30 s (background job) |

## 9. Accessibility and UI quality
WCAG 2.1 AA; keyboard navigation for all workflows; visible focus; tables with proper headers; no information by color alone.

## 10. Dependencies
- New dependencies need a reason in the PR (purpose, license, maintenance health, alternatives).
- License allow-list: MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0 (file-level). No GPL/AGPL in shipped code.
- Lockfiles committed; `pnpm install --frozen-lockfile` in CI.

## 11. Documentation as code
- Each module has a `README.md` (purpose, how to run, key decisions).
- Decision records in `docs/decisions/` using the template.
- Runbooks in `ops/runbooks/` are executable and tested, with a short README each.
