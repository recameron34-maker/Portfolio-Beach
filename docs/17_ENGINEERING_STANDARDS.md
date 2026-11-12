# 17: Engineering Standards

## 1. Repository and tooling
- pnpm workspaces; Node 22 LTS (`.nvmrc`); Python 3.12 or later with `uv`; TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
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
- **Concurrency:** `ETag` = `row_version`; updates require `If-Match`; mismatch returns 412. As built (one parser for the API and the preview, `packages/contracts/src/row-version.ts`):
  - A route that reads the header is marked `ifMatch` in the route table with the kind of record it guards. Today these are the command routes of valuations, capital notices, wire instructions, change requests, opportunities and closings, and the correction of a Draft valuation.
  - Every record carries its `rowVersion`; the valuation and change request routes also send it as the `ETag` header (the number in double quotes).
  - The header may name one or more entity tags, each a quoted or bare row version, weak ones (`W/"3"`) included. When none of them is the record's, the answer is 412 `stale-row-version` and the detail names the row version the record is at. Nothing is changed.
  - Anything else in the header is 400 `validation` with the path `If-Match`, so a malformed header never reads as no header.
  - The API does not enforce the header yet: without it, or with `*`, the command runs on the record as it stands (the row is locked, and the write is guarded on the state and row version that were read).
- **Idempotency:** all POSTs that create financial records or trigger jobs accept an `Idempotency-Key` header; repeats return the original result. As built (the rules both sides share are in `packages/contracts/src/idempotency.ts`, the store is `apps/api/src/common/idempotency.ts`):
  - **Which routes:** those the route table marks `idempotent: true`, and no other: every command, create and correction of the control routes (valuations, capital notices, the wire register, change requests, the pipeline and closings), whether POST, PUT or PATCH. The intakes are idempotent by content instead (the file hash). `POST /extraction/batches` triggers jobs and is not marked yet.
  - **The key:** 1 to 200 visible ASCII characters (0x21 to 0x7E, so no space). Anything else, an empty value included, is 400 `validation` with `errors` `[{ path: "Idempotency-Key", message: "Expected 1 to 200 visible ASCII characters" }]`; the key is never echoed. The check runs after 401 and 403 and before the body is validated. Without the header a route behaves as it always did.
  - **Scope:** a key belongs to the person, the method and the path. Two people may choose the same key, and the same key on another path is another request.
  - **Replay:** the first request reserves the key, runs, and stores its 2xx answer. A repeat with the same body answers the stored status and body, the stored `ETag` where there was one, and the response header `Idempotency-Replayed: true`. Nothing runs and nothing is audited. Bodies are compared as canonical JSON, so the order of the keys and the spacing do not matter.
  - **422 `idempotency-key-reuse`:** the same key with a different body. Nothing runs.
  - **409 `idempotency-key-in-progress`:** a repeat that arrives while the first request is still running, or whose completion was never recorded. It is never run beside the first one. The caller waits, reads the record again, and sends a new key if the change is still needed.
  - **A refused request** (any answer outside 2xx) stores nothing, so the corrected request may use the same key.
  - **What is stored:** the request as a sealed fingerprint only, and the answer without bank details in clear. The replay of a wire instruction answer therefore carries `bankDetails: null`; the details are read again on the instruction, where each clear read is audited (SEC-12.2).
  - **A path longer than 500 characters** with a key is 404: it names no record.
  - **The web** sends a key on every one of these routes (`apps/web/src/api/idempotency.ts`): one key per action, the same key when that action is tried again while its outcome is unknown, for at most five minutes, and never the same key for another body.
  - **The preview** simulates the store in the browser with the same rules, except the 409: it answers one request at a time, so a repeat always finds the first one finished.
  - The OpenAPI document describes both headers and their problems on the routes that take them.
- **Caching:** no answer is stored and no read is conditional. Every response carries `Cache-Control: no-store` (answers hold restricted data), and the API ignores `If-None-Match` and `If-Modified-Since`, so it never answers 304: the ETag of a record is its row version, a concurrency token for `If-Match`, and a detail carries child rows that tag does not cover.
- **Validation:** Zod at every boundary; reject unknown fields. A refusal is 400 `validation` with one `errors` entry per issue (`path` and `message`, never the value); the web shows each field and its message. A body the server cannot read is answered in fixed words (400 `validation`, "The body is not valid JSON"; 413 for one over the size limit), after the request has its id and its log line: the parser's own message spells out the body and is never passed on.
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
