# Spec: deal performance against the sponsor's underwritten base case

Numbers: migration 0022, decision 0023, fixtures 29 and 30, docs/08 section 12, docs/18 section 14 (the valuation suggestions spec keeps 0021, 0022, 27, 28, 11, 13).

## 1. Goal
Owner: "To the deal pages lets also add something that tracks deal performance vs. the GP's underwritten base case, unless thats already in the build." It is not.

The deal team records the sponsor's base case; a second person confirms it. The Performance tab then shows revenue, EBITDA and net debt against plan at the same date, the share of planned value creation earned, and gross MOIC and IRR against underwriting: ahead of, on or behind plan. Revisions are versions. A first draft for the owner to change, like decision 0018.

## 2. What exists and is reused
- Actuals: `mon.quarterly_performance` (LTM); entry and current quarter from `entryAndCurrent` (`apps/api/src/analytics/value-creation.ts`).
- Bridge: `computePosition` (same file) for actuals; `valueCreationBridge` (`packages/calc/src/bridge.ts`) over plan figures. A second bridge rule would be a duplicate.
- Flows, MOIC, IRR and flag: `positionMetrics` (`apps/api/src/portfolio/metrics.ts`).
- Yield to maturity: private in `creditTermsOf` (`apps/api/src/performance/performance.service.ts`); exported, not rewritten.
- Patterns: `deal.legal_term`, `mon.wire_instruction`, `mon.valuation` policies, `PerformanceTab.tsx`, `LineChart`, `UnavailableState`.
- Not duplicates: `mon.realization_outlook`; `mon.track_record` (in docs/03 only, not built).

## 3. Behaviour
- Anyone who can open the position reads the card (walls apply).
- Deal team records a Draft, edits or withdraws it, and revises a confirmed case with a reason.
- Deal team or approver confirms, never the last person to change the figures. An approver retires a case confirmed in error.
- A version dated as a confirmed case corrects and replaces it; a later date is a re-underwrite and both stay. The card compares the entry case (earliest date) unless the reader picks another, so a revision never hides the gap to the original.
- Equity and continuation vehicle cases hold plan points and exit terms; credit holds yield, loss rate, MOIC and IRR; primary funds hold nothing yet (no card, create refused).

## 4. Data model
Migration `0022_underwriting_case.sql`. No existing table changes, so the accounting import and export are untouched.

`mon.underwriting_case`, a row per version, standard columns plus (ids uuid, dates date, notes and reasons text, timestamps timestamptz):
- `investment_id` (fk, not null); `version` (integer from 1, unique with it); `form` (text: `equity`, `credit`); `state` enum (Draft, Confirmed, Superseded, Withdrawn).
- `case_date`, `planned_exit_date` (credit: expected repayment): not null, exit later.
- `exit_multiple` numeric(12,6) above 0: equity only, required.
- `gross_moic` numeric(12,6) above 0, `gross_irr` numeric(12,8) above -1: required, from our entry to the planned exit.
- `underwritten_yield` (credit, required), `annual_loss_rate` (0 to 1): numeric(12,8).
- `currency` char(3), checked `USD`, covering the points.
- `note`, `revision_reason` (from version 2), `withdrawn_reason` (when Withdrawn).
- `source_document_id` (fk doc.document), `source_page` (integer), `source_locator` (sheet and cell), `source_note`: outside Draft, a document or a note.
- `entered_by` (fk core.app_user), `entered_at`: not null, reset by every edit. `confirmed_by`, `confirmed_at`: check `confirmed_by <> entered_by`.
- Unique partial indexes: one Draft per investment; one Confirmed per investment and case date.
- Trigger: outside Draft only `state` (Confirmed to Superseded or Withdrawn) and `withdrawn_reason` change, besides what `pb.touch_row` rewrites. No delete.

`mon.underwriting_case_point` (equity): `case_id`, `period_end`, `revenue_ltm`, `ebitda_ltm`, `net_debt` numeric(20,2), nullable, one at least; unique (case_id, period_end). Revenue and EBITDA are the twelve months ending on `period_end`, net debt at that date: the actuals' basis. Written only while the case is Draft (trigger); replaced as a set, so delete is granted, as on `deal.allocation`.

Row-level security, forced: read under `pb.investment_visible` (points via a new `pb.underwriting_case_visible`). Policies by command, visible positions only: case insert deal_team; case update deal_team, approver; points deal_team. Classification: `restricted_mnpi`, retention `books_and_records`; person columns `confidential_personal`; version, form, state, timestamps `internal`. `audit.add_history` on both; audit actions `underwriting_case.create`, `.edit`, `.confirm`, `.supersede`, `.withdraw`, `.retire`, `investment.underwriting.read`.

## 5. Calculations (docs/08, new section 12)
`underwritingComparison(case, inputs, tolerances)` (`packages/calc/src/underwriting.ts`) runs these rules over rows as they travel, so API and preview agree (inputs: this spec's section 8). Tolerances are config: `underwriting.onPlanTolerance` 0.05, `underwriting.irrTolerance` 0.02. The quarter is docs/08 section 8's current quarter.

1. **`planAt`:** a point's figure on its date; between neighbours `v0+(v1-v0)*days(d0,d)/days(d0,d1)`, flagged `interpolated`. Else `before_plan_start`, `past_plan_end`, or `missing_plan_figure` (a neighbour lacks the metric; no further point is used).
2. **`planVariance`:** `actual-plan`, and that over plan; else `non_positive_plan` or `missing_actual` (`no_current_quarter` with no approved quarter). Net debt's favourable percent is the negative.
3. **`planStatus`:** ahead above the tolerance, behind below its negative, else on plan (edges included). EBITDA's is the headline; no blended score.
4. **Value creation:** planned bridge = `valueCreationBridge(entry snapshot, exit point)`, EV = exit multiple x EBITDA. Progress per driver and in total = actual/planned (`non_positive_plan` at zero or less; a negative actual shows negative). Time passed = `days(entry,quarter)/days(entry,exit)`, possibly over 100%. No status. Reasons also: the actual bridge's five; `missing_plan_figure` or `non_positive_ebitda` at the exit point.
5. **Returns:** IRR gap = gross IRR less underwritten `r`, judged as in rule 3 by `irrTolerance`, unjudged while missing or flagged (the flag is the reason). Path value = `-sum(flow_i*(1+r)^(days(d_i,asOf)/365))` over signed flows; path MOIC = (distributions + path value)/invested; MOIC gap = gross MOIC less path MOIC (zero when IRR equals `r`), no status. Past the planned exit: no path (`past_plan_end`). Realized: gap = gross MOIC less `gross_moic`, otherwise shown as the exit target.
6. **Credit:** judged on the IRR gap alone. Yield to maturity (section 10) is priced on fair value and rises as the mark falls, so it and the loss rate carry no status.

**Example 1.** Points 2023-12-31 (revenue 200,000,000.00, EBITDA 40,000,000.00, net debt 150,000,000.00) and 2024-12-31 (236,600,000.00, 47,320,000.00, 142,680,000.00). At 2024-06-30, day 182 of 366, plan 218,200,000.00, 43,640,000.00, 146,360,000.00. Actuals 220,000,000.00, 40,500,000.00, 150,000,000.00: revenue +1,800,000.00 (+0.82%), on plan; EBITDA -3,140,000.00 (-0.0719523373), behind; net debt +3,640,000.00 (2.49% over), on plan.

**Example 2.** Entry 2021-06-30: EBITDA 40,000,000.00, EV 400,000,000.00, net debt 150,000,000.00. Exit 2026-06-30: EBITDA 80,000,000.00, net debt 100,000,000.00, 11.0x, EV 880,000,000.00. Planned 400,000,000.00, 80,000,000.00, 50,000,000.00, total 530,000,000.00. Actual at 2024-06-30: 250,000,000.00, 65,000,000.00, 30,000,000.00, total 345,000,000.00. Progress 62.50%, 81.25%, 60.00%, total 65.09% (0.6509433962); time 1,096 of 1,826 days, 60.02%.

**Example 3.** `r` 20%. 10,000,000.00 invested 2021-06-30; on 2023-06-30 (730 days) 1,000,000.00 distributed, NAV 12,000,000.00. MOIC 1.30, IRR 14.02%, gap -5.98 points, behind. Path value 14,400,000.00 - 1,000,000.00 = 13,400,000.00; path MOIC 1.44; gap -0.14.

**Example 4.** Loan 10,000,000.00 at par 2021-06-30, interest 1,000,000.00 each anniversary, `r` 10%, as of 2023-06-30. At par: IRR 10%, on plan; path value 12,100,000.00 - 1,100,000.00 - 1,000,000.00 = 10,000,000.00; path MOIC 1.20, gap 0. Marked 9,000,000.00: MOIC 1.10, gap -0.10, IRR 5.12% (0.0512492197), behind.

## 6. API
- `GET /api/v1/investments/{id}/underwriting?asOf&version`: any role; audited.
- `POST /api/v1/investments/{id}/underwriting`: deal_team; a Draft, 201; idempotent.
- `PATCH /api/v1/underwriting-cases/{id}`: deal_team; replaces a Draft and its points; idempotent; `ifMatch: 'underwriting_case'`.
- `POST /api/v1/underwriting-cases/{id}/commands`: deal_team, approver; idempotent; same `ifMatch`.

**Read:** `{ asOf, form, versions[], comparedVersion, comparison, notCalculable, thresholds, calcVersion }`.
- `form` null: a primary fund (200, nothing else).
- `versions[]`: each version in full: columns, `points[]`, `rowVersion`, derived `kind` (`entry`, `correction`, `reunderwrite`), who entered and confirmed it, `source` (document id and name only if the reader can open it).
- `comparedVersion`: the Confirmed version with the earliest case date, or `version` when it names a Confirmed or Superseded one (else 404).
- `notCalculable`: `no_case` or `draft_only` (then `comparison` is null).
- `comparison`: `quarter`; `metrics[]` (metric, actual, plan, interpolated, variance, variancePct, status, notCalculable); `headline`; `series[]` (per approved quarter and plan date: actual, plan, interpolated); `valueCreation` (planned, actual, progress, timePassed, notCalculable); `returns` (grossIrr, irrGap, irrStatus, irrFlag, grossMoic, moicOnPath, moicGap, pathNotCalculable); `yieldToMaturity`. Credit carries the last two only. Decimal strings; null with a reason when missing.

**Body:** section 4's columns in dollars; a revision needs its reason. Equity: two or more ascending points, the last dated the planned exit; revenue outside `unitSanityBoundsUsd` is refused. Every PATCH writes the case row, so its row version moves even when only points change.

**Errors:** the usual 400, 403, 404 (unknown or not visible) and 412; 409 a Draft exists or the state forbids the command; 422 primary fund, non-USD, a case date neither a confirmed case's nor later than all, a source document unseen or of another position (same sentence), confirm by the last editor; 500 `configuration` for a missing tolerance.

**Machine `underwritingCaseMachine`:**
- (new) to Draft: create, deal_team; no Draft exists.
- Draft to Confirmed: `confirm`, deal_team or approver; not `entered_by`; a source.
- Draft to Withdrawn: `withdraw`, deal_team; reason.
- Confirmed to Superseded: `supersede`, a system step of the confirm that corrects it, same transaction, never a caller's.
- Confirmed to Withdrawn: `retire`, approver; reason.

Superseded and Withdrawn are terminal; other moves are forbidden and tested. Each writes audit and outbox events.

## 7. Web
Card "Against the sponsor's base case" on the Performance tab after "Value creation" (credit: after "Credit terms"): `UnderwritingCard.tsx`, `UnderwritingForm.tsx`, `underwriting.ts` (wording) in `apps/web/src/pages/deal`.
- **Tiles:** EBITDA, revenue, net debt and gross IRR against plan, each badged "Ahead of plan", "On plan" or "Behind plan"; gross MOIC with "on the underwritten path" and "at exit", no badge.
- **Chart:** actual and plan for one metric (picker, EBITDA first), table twin, and "Between plan dates the plan is a straight line, not a sponsor figure."
- **Drivers table:** "Planned to exit", "Earned to date", "Progress", a total row, "60% of the planned time has passed".
- **Credit:** IRR and MOIC tiles, then yield to maturity, underwritten yield and loss rate with "Yield to maturity rises when the mark falls, so it is not judged."
- **Case:** terms, who entered and confirmed it, source link, version picker ("Entry case", "Corrected", "Re-underwritten Jun 30, 2025").
- **Actions:** deal team "Record base case", "Edit draft", "Withdraw draft", "Revise"; a second person "Confirm"; the last editor sees "You entered these figures. A second person confirms them."; approver "Retire"; others read only.
- **Form:** case date, planned exit, exit multiple, gross MOIC and IRR ("from our entry to the planned exit"); two or more rows of "Twelve months ending", revenue, EBITDA, net debt in US$ millions, shown back in full before saving; source from the position's documents with page and "Sheet and cell", or "Where the model is held"; note; reason when revising. Credit: yield, loss rate, repayment date, MOIC, IRR.
- **States:** skeleton; "No base case recorded."; "A draft base case waits for a second person to confirm it."; `UnavailableState`; "This base case changed since you opened it. Open it again."; primary fund, no card.
- **Reasons,** beside the missing-value placeholder: `before_plan_start` "Before the plan starts."; `past_plan_end` "After the plan ends."; `missing_plan_figure` "The plan has no figure here."; `non_positive_plan` "The plan figure is zero or less."; `missing_actual` "No approved figure this quarter."; `no_current_quarter` "No approved quarter to compare."; `no_entry_snapshot` and `entry_snapshot_forward_dated` as the "Since entry" card words them; `missing_figures` "A figure is missing at entry or in this quarter."; `non_positive_ebitda` "EBITDA is zero or less."; `short_period` "Held under a year, so the IRR is not judged."; `no_valuation` "No locked valuation yet."; any other IRR flag "The cash flows give no single IRR."

## 8. Static preview
- **Recorded:** the read route per investment and credential (the wall's 404 included).
- **Simulated** (`apps/web/src/preview/routes/underwriting.ts`): create, edit and commands, with the shared machine, idempotency and If-Match.
- **The read is always computed in the browser** by `underwritingComparison`, so `version` needs no recording. Cases: the recorded `versions[]` overlaid with the session's. Inputs, from the credential's other recordings and overlays: entry, quarters and `credit.terms.yieldToMaturity` from `/investments/{id}/performance`; flows, invested, distributions, NAV, MOIC, IRR and flag from `/investments/{id}`; the actual bridge and its reason from `/investments/{id}/value-creation`. Another `asOf` is 404, as in `valueCreation.ts`. A test proves the browser's answer equals every recording.

## 9. Synthetic data
`generateUnderwriting` (`tools/synthetic/src/underwriting.ts`) runs last on its own seeded stream, so no existing value moves (tested, seed 42).
- **Equity and CV:** four in five positions whose approved entry snapshot has EBITDA and equity value above zero get a Confirmed version 1 dated at entry; the rest none. Point 0 is the snapshot; points follow on its anniversaries for 4 to 6 years, the last the planned exit. Yearly: revenue up 4% to 12%, margin up 0 to 1.5 points, net debt down 4% to 10%. Exit multiple = entry multiple plus -1.0 to 1.0. Gross MOIC = (exit multiple x exit EBITDA - exit net debt) / entry equity value; gross IRR = `MOIC^(365/days(case date,exit))-1`. Entered by deal.one, confirmed by deal.two, with a source note. A forward-dated snapshot keeps its case (`before_plan_start`).
- **Credit,** every position: yield = cash coupon + PIK coupon + OID / years to maturity; loss rate 0.5% to 2%; IRR = yield less loss rate; exit = maturity; MOIC = 1 + IRR x years.
- **Scenarios:** `underwriting_ahead`, `underwriting_on_plan`, `underwriting_behind` (held two years or more; plan EBITDA growth is the position's own annualised growth less 8 points, equal, plus 8 points, at a flat margin; underwritten IRR its gross IRR less 5 points, equal, plus 5 points; the dataset check asserts each status); `underwriting_reunderwritten`; `underwriting_corrected`; `underwriting_draft`; `underwriting_withdrawn`; `underwriting_past_exit`; `underwriting_gap` (no net debt at a point); `underwriting_net_cash` (plan net debt below zero). Existing: `negative_ebitda`, `forward_entry_snapshot`, `period_end_shift`, `walled_deal`.

## 10. Tests
- **Calc:** fixture 29 (rules 1 to 3: example 1, every reason, a value on the tolerance); fixture 30 (rules 4 to 6: examples 2 to 4, a negative driver, past the exit, realized). Properties: `planAt` lies between its neighbours; scaling actual and plan changes nothing; a higher EBITDA never lowers its status; flows whose IRR is `r` give a zero MOIC gap. Python cross-check.
- **Db:** migration on the seeded database; constraints, triggers, classification; access matrix by command, with a walled case.
- **Workflows:** every listed and forbidden transition; A creates, B edits, B confirms: refused.
- **API:** roles (403), wall (404); create, edit, confirm, correct, re-underwrite, retire; B edits then confirms (422); another position's document (422); revenue typed as 200 (400); as-of and version; replay and 412; figures equal the value creation route and the summary; a loan locked at 90% of par reads behind.
- **Web:** every state, role and reason; the form; the copy guard; the preview routes with the two-person rule.
- **Browser journey:** deal.one records, deal.two confirms, the card shows the status; accessibility scan.

## 11. Slices
1. Decision 0023 (SEC-2.1, 5.1, 5.3, 5.6, 9.1, 9.2, 9.4, 11.1), M9 acceptance criteria in docs/04, docs/08 section 12, config keys, calc rules 1 to 3, fixture 29, properties, Python cross-check.
2. Calc rules 4 to 6, `underwritingComparison`, fixture 30.
3. Migration, schema, classification, access matrix, docs/03.
4. The machine, docs/18 section 14.
5. Generator (equity), seed loader, scenarios, dataset check, docs/14.
6. Contracts and the read route. Until slice 12 a credit position answers `form: null`.
7. Write routes, with the guarded-route list in `apps/web/src/preview/routes/common.test.ts` and docs/17 section 3. Until slice 12 a credit create is 422.
8. The card, read only, and the recordings.
9. The preview simulation (writes and the computed read).
10. The form and the actions.
11. The browser journey.
12. Private credit: generator, routes, card, the exported yield to maturity.
13. docs/09, docs/11, the session log.

## 12. Risks and the owner's questions
Risks: a sponsor's model may define EBITDA differently from its reports; the generator must move no existing figure.

Questions, with the default built:
- **Case compared:** the entry case; a re-underwrite is a pick.
- **Between plan dates:** a straight line by days, labelled; or compare at plan dates only.
- **Approval:** a second person confirms; no staging table (the accounting record never reads it).
- **Timing and source:** entered once the position exists, with a document or a note on where the model is held; no block on closing.
- **Tolerances:** EBITDA headline within 5%; IRR within 2 points.
- **MOIC before exit:** against the underwritten IRR over our own cash flows; no badge.
- **Left out:** other currencies, net returns, a downside case, a watchlist flag, an Analytics roll-up.

## Review points not taken
- 4(a): the case is not chosen by the compared quarter's date; point 14's default (entry case, others by pick) removes the date from the choice.
- 6: flows and returns come from the investment detail; the value creation route has no row for a credit position.
- 2 and 9: no marked-down loan is seeded (changing a seeded mark moves recorded totals); fixture 30 and an API scenario cover it.
- 13: the twelve required points needed room.
