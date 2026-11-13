# 0022: Deal performance against the sponsor's underwritten base case

- **Status:** Accepted for the prototype, as a first draft for the owner to change
- **Date:** 2026-11-12
- **Deciders:** repo owner (asked for it); built in Claude Code

## Context

The owner asked: "To the deal pages lets also add something that tracks deal performance vs. the GP's underwritten base case, unless thats already in the build." It was not in the build.

What the platform already holds is the actual side of that comparison: the approved quarters of a company (`mon.quarterly_performance`, twelve-month revenue and EBITDA, net debt), its entry snapshot and current quarter (`docs/08` section 8), the EBITDA bridge from entry to the current quarter (`valueCreationBridge`), and our own cash flows, gross MOIC and gross IRR on the position. What it does not hold is the plan: the figures the sponsor underwrote when we invested. `mon.realization_outlook` is our own view of when a position will be realized, and `mon.track_record` (in `docs/03`, not built) is a sponsor's past deals; neither is a base case for one position.

Four rules of the build guide shape the design. A number is never invented (rule 10), so a plan figure that the sponsor did not give is not filled in silently. Thresholds are configuration (rule 9). Financial math is specified and tested before anything uses it (rule 12). And a figure a second person has not seen is not shown as settled (SEC-5.6).

## Options considered

1. **Where the plan is read between two plan dates.** Compare only on the dates the sponsor gave a figure for (a comparison once a year, and none in most quarters), or read the plan on a straight line by days between the two neighbouring plan dates (chosen). The straight line is ours, not the sponsor's, so it is flagged on every figure it produces and the page says so.
2. **Which case is compared when there are several.** The latest one (a revision would then hide the gap to what was first underwritten), or the entry case, the one with the earliest date (chosen); a later re-underwriting is a pick on the page.
3. **How a case is approved.** A staging table with an approval step, as for valuations and quarterly figures, or a second person confirming the record itself (chosen). The base case is not one of the core financial tables of rule 5: the accounting import and export never read it, no client report prints it, and it changes no valuation, quarter or position. It still takes two people (the one who last changed the figures cannot confirm them), keeps every version, and names its source.
4. **Gross MOIC before the exit.** Against the underwritten MOIC at exit only (every young position would read as behind), or against the MOIC the position would show today if it had compounded at the underwritten IRR over our own cash flows (chosen). It carries no status: the IRR gap is the judged figure, and the two say the same thing.
5. **One blended score.** Not built. It would need weights nobody has chosen. The status of EBITDA against plan is the headline, and revenue, net debt and the IRR stand beside it.

## Decision

**The record.** Two new tables, `mon.underwriting_case` (one row per version: the form, the case date, the planned exit, the exit multiple, the underwritten gross MOIC and IRR, for credit the underwritten yield and loss rate, the source, who entered it and who confirmed it) and `mon.underwriting_case_point` (for an equity case, the plan at each date: twelve-month revenue and EBITDA and net debt, on the basis the actuals use). US dollars only. No existing table changes, so the accounting import and export are untouched.

**Who does what.** The deal team records a draft, edits or withdraws it, and revises a confirmed case with a reason. The deal team or an approver confirms, never the person who last changed the figures. An approver retires a case confirmed in error. Anyone who can open the position reads it; a wall on the position covers its base case.

**Versions.** A new version dated as a confirmed case corrects and replaces it (the old one becomes Superseded). A later date is a re-underwriting, and both stay. States and transitions are a machine in `packages/workflows` (`docs/18`), with rejection tests for every forbidden move.

**Forms.** Equity and continuation vehicle positions hold plan points and exit terms. Private credit positions hold the underwritten yield, loss rate, MOIC and IRR. Primary funds hold nothing yet: no card, and a create is refused.

**The calculation** is `docs/08` section 11, in `@pb/calc` (`underwriting.ts`), with golden fixtures 27 and 28, property tests and the Python cross-check, written before anything used it:

- the plan at a date (a plan figure, or a straight line by days between two, flagged);
- the variance of the current quarter's revenue, EBITDA and net debt against it, and a status (ahead of, on or behind plan) by a tolerance;
- the planned EBITDA bridge from the entry snapshot to the planned exit, by the one bridge rule the actuals use, and the share of each planned driver earned to date beside the share of the planned time that has passed;
- the gross IRR against the underwritten IRR, with a status, and the gross MOIC against the underwritten path;
- for credit, the IRR gap alone is judged: yield to maturity is priced on the fair value of the latest approved credit quarter (our own Locked mark does not change it) and rises as that fair value falls, so it and the loss rate are shown without a status.

A figure that cannot be worked out is missing and says why (before the plan starts, after it ends, no plan figure there, a plan figure of zero or less, no approved figure this quarter, and the reasons the bridge and the IRR already give). It is never a zero and never taken from another date.

**Configuration.** `underwriting.onPlanTolerance` (0.05: within 5% of plan is on plan) and `underwriting.irrTolerance` (0.02: within 2 points of the underwritten IRR) in `config/definitions.json`. The API refuses to answer with one missing and names the key; there is no default in code.

**The API.** `GET /api/v1/investments/{id}/underwriting` (any role that can open the position; audited), `POST /api/v1/investments/{id}/underwriting` (a draft), `PATCH /api/v1/underwriting-cases/{id}` (replaces a draft and its points) and `POST /api/v1/underwriting-cases/{id}/commands` (confirm, withdraw, retire). Writes are idempotent and read `If-Match`.

**The page.** A card "Against the sponsor's base case" on the Performance tab of a deal: tiles with their status, actual against plan by quarter for one metric with a table twin, the planned drivers against what has been earned, the terms of the case with its source and versions, and the actions the reader's role allows.

**The static preview** records the read for every position and credential, simulates the writes with the same machine, and works the comparison out in the browser with the same function the API calls.

**Synthetic data.** Most equity and continuation vehicle positions and every credit position get a confirmed base case, drawn last on its own random stream so that no existing figure moves; scenarios cover ahead, on and behind plan, a correction, a re-underwriting, a draft, a withdrawn case, a plan that has ended, a gap in the plan and a plan in net cash (`docs/14`).

**Left out for now:** other currencies, net returns, a downside case, a watchlist flag and an Analytics roll-up across positions.

## Consequences (security, cost, operations, migration)

- Two migrations: 0021 adds the two tables, with row-level security forced on both, and 0022 narrows who writes a plan point to the person the Draft names (a review finding, below). Nothing is backfilled and nothing existing changes.
- No outbox event is written, although `docs/18` says every transition emits one: no service of the API writes `ops.outbox` yet and nothing relays it, so the base case follows the other workflows. Every transition is in the audit trail. The events are added when the API gains an outbox writer.
- No dependency and no new external service. The comparison is worked out on read; only the case is stored.
- A sponsor's model may define EBITDA differently from its quarterly reports. The platform compares the two figures as given; the source of the case is on the card so a reader can check.
- The straight line between plan dates is a convention of ours. It is flagged wherever it is used, and the owner may prefer a comparison on plan dates only.
- The measures are a first draft. A tolerance is a configuration edit; a rule is a change to `docs/08`, the fixtures and this record.

## SEC IDs affected

- SEC-2.1: every column of the two tables is classified (`restricted_mnpi`, retention `books_and_records`; the person columns `confidential_personal`).
- SEC-5.1 and SEC-5.3: read and write policies under row-level security, by command, on visible positions only; a walled position's base case is invisible to everyone outside the wall, and the API answers 404.
- SEC-5.6: the person who last changed the figures cannot confirm them (a check constraint, the machine and the API each refuse it). The rule covers the plan points: only the person the Draft names writes them (the write policies of `mon.underwriting_case_point`, migration 0022), so nobody rewrites the points of somebody else's Draft and then confirms it.
- SEC-9.1: a case is a draft until a second person confirms it, and only a confirmed case is compared.
- SEC-9.2: versions are kept, never overwritten; both tables carry history.
- SEC-9.4: outside a draft a case names its source: a document of the position with a page or a sheet and cell, or a note on where the model is held.
- SEC-11.1: every create, edit, confirm, supersede, withdraw and retire is in the audit trail, as is each read of the card.

## Verification (what was checked, docs/versions consulted)

- `docs/04` (M9), `docs/05`, `docs/08` (sections 1 to 5, 8 and 10), `docs/18`, CLAUDE.md rules 5, 7, 9, 10 and 12.
- The calculation: `packages/calc` `underwriting.test.ts` and fixtures 27 and 28 (the four worked examples of `docs/08` section 11 by hand, every reason, a value on each tolerance), the same fixtures and cases in `apps/worker-py` `calc_check`, and the random cross-check with 0 mismatches.
- The slices that follow (the tables, the machine, the routes, the page, the preview, the data) record their own checks in `docs/SESSION_LOG.md`.
- Three independent reviews of the finished feature, and the fixes that followed (the plan points under the two-person rule, the card's result and keyboard focus through every step, no time passed before the entry snapshot, an exact Python cross-check), are in `docs/SESSION_LOG.md` too.

## Open for the owner

Each is built with the default named here and can change:

- **Case compared:** the entry case; a re-underwriting is a pick.
- **Between plan dates:** a straight line by days, labelled; the other choice is to compare on plan dates only.
- **Approval:** a second person confirms; no staging table.
- **Timing and source:** a case is entered once the position exists, with a document or a note on where the model is held; it does not block a closing.
- **Tolerances:** EBITDA within 5% of plan is on plan; the IRR within 2 points.
- **MOIC before the exit:** against the underwritten IRR over our own cash flows, with no status.
