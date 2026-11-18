# Spec: valuation suggestions from capital account statements and quarterly reports

Numbers: the base case build took decision 0022, docs/08 section 11 and fixtures 27 and 28. The base case build has since also taken migrations 0021 and 0022 and docs/18 section 13. This spec takes decision 0023, docs/08 section 12, fixtures 29 and 30, and the next free migration and docs/18 section: migration 0023 and section 14 as the repository stands (where the text below says migration 0022, read 0023).

## 1. Goal
The owner: "I also would like to find a way to have the site read PCAP statements and financial statements and suggest valuation updates as they come in." Then: "We get company specific PCAP as well, which relate specifically to co-investments. (WE do also get fund PCAPs for our fund commitments)".

When a person approves figures read from a capital account statement or a quarterly report, the platform works out the mark they imply, shows each input with its source, and sets it beside the current mark. Operations opens a draft valuation from it or dismisses it with a reason. No mark is written without that person.

A statement is one of two kinds:
- **Position-level:** the sponsor's vehicle reports our capital account for one co-investment or continuation vehicle position. Its ending balance is the sponsor's stated value of our interest: the first source for that position, ahead of the company's financial statements.
- **Fund-level:** our account in a fund we committed to. **Limit:** a commitment has no valuation record, so these are read and reviewed and raise no suggestion until question 1 is answered.

## 2. What exists today
- **Reused, never copied:** extraction runs, their review, schemas, prompts and the mock; `buildStatement`; `valuationMachine` and the Draft create and edit of `valuations/workflow.service.ts`; `promoteQuarterlyPerformance`; `valueChange`, `qtdGainLoss`, `navRollForward`, `summarizeFlows`, `alignedQuarterEnd`, `lockedNear`; the board's variance rule; the advisory lock of `capital/wires.service.ts`; the method term `valuation_method.sponsor_mark` ("Sponsor mark"), which the seeded co-investment marks carry.
- **The kind is the link, not a field:** `linkDocument` (`documents/link.ts`) sets `doc.document.investment_id` from "INV-nnnn" on page one (the number wins) or the exact company name in the file name, or a person sets it in the review queue; otherwise only `sponsor_fund_id` is set. The run copies it. Both kinds share one document type, schema and review page. Classified is terminal: no relink.
- **Four defects, fixed before any statement can be extracted** (slice 4, with the preview's mirrors):
  - `matchExpectedDocument` and `matchIndexed` give a fund's expected row to any statement carrying its `sponsor_fund_id`, as a position-level one does. Fix: only a statement with no position takes one.
  - The monitoring board shows a position's newest run whatever its schema (`loadRuns`; the preview's `runOf`). Fix: quarterly-schema runs only.
  - Approval promotes any run with a position, and an empty promotion still writes status, approver and lineage on the quarter (`review.service.ts`, `promote.ts`). Fix: a schema with no target skips the position requirement and the promotion.
  - A statement naming a position that did not link reads as fund-level. Fix: the review rule of section 3, its reason kept in `classifier_evidence`, never a name.
- **Would be duplicates:** a second run or review path, statement type or schema; a third Draft insert; a second variance rule.
- **Not reused:** `stg.valuation` belongs to an intake file, is keyed on report date and investment number, follows the staging states and cannot be superseded (decision 0023).

## 3. Behaviour
- Operations extract and review a statement like a quarterly report. Approving one writes nothing to the quarterly record. The review page says how it will be read ("Our account for <company>, INV-nnnn" or "Our account in <fund>"); the approval's audit event records it.
- **Review rule:** a statement naming a position (a company in the file name, a reference on page one) that does not link to exactly one position, or whose reference and name disagree, goes to the review queue, not straight to Classified: "This statement names a position that did not link. Choose the position, or leave it empty for a fund statement."
- Approving a run linked to a position derives, in the same transaction, at most one Open suggestion for that position and quarter: a value, or "not calculable" with a reason. Its period end is a calendar quarter end; marks, Drafts and figures for a quarter are found as the valuation workflow finds them (`alignedQuarterEnd`, `lockedNear`).
- **Order of sources** (config): a position-level statement's ending balance; then the equity value the sponsor's report states, scaling our last Locked mark; then the same with the multiple held. The first with a value is the suggestion; if none has one, the first on hand gives the reason. Never blended: the others sit beside it as cross-checks, with their value (or why none) and the difference.
- **Replacement:** a statement approved while a report-based suggestion is Open supersedes it; a report approved after a statement changes only the cross-check. Of two approved statements for a quarter, the later counts. An Open suggestion that stops applying (a mark is Locked, the position exits) is closed with that reason.
- **Statement rules** (12.1): the quarter is the statement's own period end, never another; a period end that is not a calendar quarter end cannot be approved (existing rule). A flag (does not tie, contributions differ) never holds a value back. A whole-vehicle statement with no share, or one not in US dollars, has no value (never 100%, nothing converted) and the next source is used, as for any statement with no value.
- **None when,** each with its run page sentence after "No mark suggested:":
  - no linked position, or a primary fund position: "this is our account in a fund commitment, which has no valuation record yet."
  - a private credit position: "suggestions are not built for private credit."
  - a position not in US dollars: "the position is not held in US dollars and nothing is converted."
  - inactive, or not held at the period end: "the position was not held at this period end."
  - a Locked mark for that quarter or a later one: "a mark for this quarter or a later one is Locked."
  - the same basis, value and inputs dismissed: "the same value from this source was dismissed."
  - or accepted onto a version in progress: "this value is already on the valuation in progress."
- Operations open a draft valuation from it, put its value and method on a Draft already open for the quarter (the Draft keeps its date), or dismiss it. Deal team, approvers and auditors read. Whoever approved a run behind it or typed one of its figures can take neither approval of that valuation.
- Viewers, investor relations and platform admins get nothing: no request, no gap, no error. A position-level statement, its run and its suggestion carry the position's wall.

## 4. Data model
One migration; no existing table changes.

`mon.valuation_suggestion`: every column `restricted_mnpi`, retention `books_and_records`; standard columns, `_history`, no delete.
- `investment_id` (the wall), `period_end` (a calendar quarter end), both not null.
- `basis`: `capital_account_balance`, `sponsor_equity_value`, `held_multiple`; `method`.
- `suggested_value` numeric(20,2) above zero, or `reason_code`: exactly one.
- `workings` jsonb: `{ inputs: [{ key, value, periodEnd, source: { kind, id, page }, edited }] }`; kind: document, reviewer, record or valuation.
- `source_document_id`, `extraction_run_id` (not null): the approved run that produced the row; `source_page`, `source_locator`: the first input read from its document, else null.
- `source_reviewer_ids` uuid[]: the approver of each run an input came from, and whoever edited one.
- `prompt_version`, `model_id`, `calc_version`.
- `state` (Open, Accepted, Dismissed, Superseded), `decided_by`, `decided_at`; `decision_reason` (required when Dismissed); `valuation_id` (required when Accepted; not unique); `superseded_reason` (required when Superseded: `better_source`, `figures_changed`, `mark_locked`, `position_closed`) and `superseded_by_id` (the first two only).
- Unique partial index on (`investment_id`, `period_end`) where Open.

Also: taxonomy term `valuation_method.report_indication` ("Indication from sponsor report") for the two report bases (not "Market multiple": 12.3 holds the sponsor's own earlier multiple, not one from comparable companies); a statement-based draft uses the existing `valuation_method.sponsor_mark`. Flag `valuation.suggestions`, on. Config `valuationSuggestions` in `config/definitions.json`: `sourceOrder` (the three bases), `tieToleranceByUnit` (`USD_K` 2,500, `USD_M` 25,000, `USD_B` 25,000,000), `contributionsTolerancePct` (0.02); the API refuses to start without it.

Row-level security, forced. Select: `operations`, `deal_team`, `approver`, `auditor`, `service`, inside `pb.can_see_walled('investment', investment_id)`. Insert: `service`. Update: `operations` (decision columns), `service`. Registered in `classification.ts`, `rls/matrix.ts`, `rls/fixture.ts`. Every derivation, replacement, closing and command writes `audit.event` with before and after. Cross-checks, comparison and flags are derived when read.

## 5. Calculations (docs/08 section 12, `packages/calc/src/suggestion.ts`)
Dollars in. S is rounded half up to the cent; change and percent use the rounded S. A missing input gives a reason, never zero and never another quarter's figure; when several apply, the first listed.

**12.1 Statement (`statementMark`).** S = B x p: B is the ending capital balance; p is our share when the lines are for the whole vehicle, 1 when they are our own account (the workings then say "Read as our own account"). Method `sponsor_mark`. Reasons: `no_ending_balance`, `non_positive_balance`, `share_out_of_range` (p not above 0, or above 1). Two checks, which change neither S nor the order:
- `ties`: `navRollForward` on the statement's own lines when beginning balance, contributions, distributions and net gain or loss are all stated, else null; `tieDifference` is B less the sum of those lines. Tolerance: `rollForwardToleranceUsd` for lines read in dollars, else `tieToleranceByUnit` for the coarsest unit read (five lines, each rounded to two places).
- `contributionsCheck`: T = contributions to date x p; R = approved contributions on the position on or before the period end (`summarizeFlows`). They differ when |T - R| / R is above `contributionsTolerancePct`; not checked, and said so, when T is not stated or R is zero.

**12.2 Sponsor's equity value (`impliedStakeMark`).** A report values the company, not our holding, so the last Locked mark is scaled. M0 = the latest Locked mark of an earlier quarter; E0 = EV0 - net debt0 from that quarter's approved figures; E1 likewise for the new quarter (never the record's total equity, which may be book equity). S = M0 x E1 / E0. Method `report_indication`. Reasons: `no_reference_mark`; `flows_since_reference_mark` (an approved cash flow after M0's period end, on or before the new one); `no_reference_figures`; `non_positive_reference_equity`; `no_net_debt`; `non_positive_equity`.

**12.3 Multiple held (`heldMultipleMark`).** Only when the new quarter has no EV: EV1 = EBITDA1 x EV0 / EBITDA0, then 12.2. Extra reasons, before `no_net_debt`: `no_ebitda` (either quarter), `non_positive_ebitda`.

**12.4 Comparison (`markComparison`).** C = the latest Locked mark of an earlier quarter, shown with its date and age in quarters. Change = S - C; percent = `valueChange(S, C)`; neither without C. Variance is the board's rule and no other: the absolute percent at or above `valuationVarianceFlag` when C is the previous quarter's mark; otherwise no badge. Net of flows = `qtdGainLoss(S, C, contributions, distributions)`, a separate figure, only when C is the previous quarter's mark and the statement gives both period lines and a beginning balance (each times p) equal to C within the tie tolerance; otherwise the page shows that balance beside C.

**12.5 Cross-check (`sourceCrossCheck`).** For another source's value X: difference = X - S; percent = `valueChange(X, S)`. Sources differ: the absolute percent at or above `valuationVarianceFlag`. Nothing is averaged.

By hand:
1. Our account, US$ millions: beginning 18.42, contributions 2.00, distributions 0.35, net gain 0.87, ending 20.94. 18.42 + 2.00 - 0.35 + 0.87 = 20.94: ties. S = 20,940,000.00; C = 18,420,000.00, the previous quarter. Change 2,520,000.00, 13.68078176%: Variance, as the board will show on the Draft. Net of flows 870,000.00, 4.72312704%.
2. Net gain 0.89: the lines give 20.96, `tieDifference` -20,000.00, inside 25,000: ties. Net gain 0.92: -50,000.00: does not tie. S is unchanged in both.
3. Whole vehicle: ending 83.76, contributions 8.00, distributions 1.40, our share 25.00%. S = 20,940,000.00; period lines 2,000,000.00 and 350,000.00.
4. M0 = 7,310,450.25; E0 = 413,000,000 - 150,000,000 = 263,000,000; E1 = 428,050,000 - 146,300,000 = 281,750,000. S = M0 x E1 / E0 = 7,831,632.5396..., so 7,831,632.54. Change 521,182.29, 7.12927757%. No variance.
5. Same, no EV1: EBITDA 41,300,000 then 43,900,000. EV1 = 43,900,000 x 413,000,000 / 41,300,000 = 439,000,000; E1 = 292,700,000; S = 8,136,002.9968..., so 8,136,003.00. Change 825,552.75, 11.29277571%: variance.
6. Rounding: M0 = 100.00, E0 = 3,000,000, E1 = 1,000,000. S = 33.33, change -66.67, percent -66.67% (not -66.66666667%).
7. Cross-check: a statement gives S = 7,810,000.00, the report example 4. Difference 21,632.54, 0.27698515%: the sources do not differ.
8. Contributions to date 12.40 against a record of 12,400,000.00: agree. A statement showing 30.00: difference 17,600,000.00, 141.93548387%: differ.

## 6. API
`valuationSuggestionMachine` (docs/18 section 14): Open (initial); Accepted, Dismissed, Superseded (terminal). "Not calculable" is data, not a state.
- (new) to Open, and Open to Superseded (`supersede`, with its reason code): `service`.
- Open to Accepted: `accept`, `operations`; has a value; no version in progress for the quarter.
- Open to Accepted: `applyToDraft`, `operations`; has a value; a Draft exists for the quarter.
- Open to Dismissed: `dismiss`, `operations`; reason.

`valuationMachine` (docs/18 section 1): `dealTeamApprove` and `lock` also require the actor not among `sourceReviewers` (new helper `notAmong`; an absent or empty list bars nobody, as `notSameAs` passes an absent key): the union over every Accepted suggestion whose `valuation_id` is the version.

Routes (`packages/contracts/src/routes-controls.ts`); readers `deal_team`, `operations`, `approver`, `auditor`:
- `GET /api/v1/valuation-suggestions?state&investmentId&periodEnd&extractionRunId&cursor&limit`: `{ items, nextCursor, openCount }`, newest first, Open by default; `GET .../{id}` with an ETag.
- `POST .../{id}/commands`: `operations`, idempotent, `ifMatch: 'valuation_suggestion'`; `{ command: 'accept' | 'applyToDraft' }` or `{ command: 'dismiss', reason }` (3 to 500 characters). Returns the row.

Row: the columns, plus the position's names, `currentMark`, the comparison of 12.4, the two checks, `crossChecks`, `inProgress`, `flags { variance, ties, contributionsDiffer, sourcesDiffer, editedByReviewer }` and `source`; money and percents as decimal strings or null.

Errors: 404 unknown or outside the wall; 409 decided, lost race, replaced at accept, or flag off; 412 stale If-Match; 422 precondition, in the valuation workflow's sentence.

`accept` and `applyToDraft` lock the row, then derive again. If the basis, the value or an input differs, or nothing applies any more: supersede, write any replacement, commit, then answer 409, "The figures behind this suggestion changed. It has been replaced or closed." Otherwise `accept` calls the shared create-Draft function (split out of `create`) at the suggestion's period end; `applyToDraft` calls the shared edit with the value and the method, and the Draft keeps its own period end. Both set `valuation_id` and audit. The Draft's `inputs` gain flat text keys, nulls omitted: `suggestion.id`, `.basis`, `.value`, `.periodEnd`, `.documentId`, `.page`, `.runId`, `.input.<key>`, `.crossCheck.<basis>`, replacing any earlier ones. PATCH keeps stored `suggestion.` keys whatever the body sends, so the lock hash seals them.

Derivation (`apps/api/src/suggestions/`) always runs as the system actor. It takes `pg_advisory_xact_lock` on the position and quarter before it reads; a lock timeout or a unique violation answers 409, "Another approval for this position and quarter is in progress. Try again." It gathers the sources on hand (the latest approved statement run; the report figures: the run's accepted or edited value, else the approved record's) and calls one pure function, `selectSuggestion` (`packages/workflows/src/controls-suggestion.ts`), shared with the preview.
- A "None when" rule applies: an Open row is superseded with its reason; nothing is written.
- No Open row: write one, unless the same basis, value and inputs were Dismissed, or Accepted onto a version in progress or Locked.
- An Open row with the same basis, value and inputs: nothing. Otherwise supersede and write.

It runs when a statement or report run is approved. Open rows are derived again (never created) inside `promoteQuarterlyPerformance`, so an accounting import refreshes them whoever approves it, and on valuation `lock` and `reopen`; a later cash flow is caught at accept. Flag off: nothing derived; `accept` and `applyToDraft` 409; reads and `dismiss` work. Logs carry outcome, basis and reason code, no figures.

## 7. Web
- Tab **Suggestions**, `/valuations/suggestions` (`pages/valuations/Suggestions.tsx`; in `VALUATION_TABS` for the four roles): position, quarter, suggested mark, current mark with its date ("Mar 31, 2025, one quarter old"), change, net of flows, source ("Capital account statement", "Sponsor report", "Sponsor report, multiple held"); a state filter. Badges: "Variance", "Does not tie", "Contributions differ", "Sources differ", "Typed by reviewer". A Superseded row reads "Replaced" with a link, "Closed: a mark for this quarter is Locked." or "Closed: the position is no longer held."
- `SuggestionWorkings.tsx`: the rule sentence, then each input with label, value and source: "From <file name>, page N" (opens `PageView.tsx`), "Typed by the reviewer", "From the record", "Locked mark, <date>". Then the checks: "The lines add up." or "The lines are $50,000 apart."; "Contributions to date: statement $30.00M, record $12.40M." or "Contributions not checked: <why>". Then **Other sources for this quarter**: "Sponsor report: $7.83M, $21,633 (0.3%) above the statement." or "Capital account statement: no value. <reason>"
- Rules: "The ending capital balance on the capital account statement." (with a share: ", times our share of the vehicle.") "The last Locked mark, scaled by the change in equity value (enterprise value less net debt)." The third adds: "Enterprise value is the new EBITDA at the earlier quarter's multiple."
- Reasons, in section 5 order: "The statement gives no ending balance for our account in US dollars." "The ending balance is zero or negative." "Our share of the vehicle must be above 0% and at most 100%." "No Locked mark from an earlier quarter." "Cash has moved since the last Locked mark." "No approved figures for the quarter of the last Locked mark." "Equity value at the last Locked mark was zero or negative." "EBITDA is missing for one of the two quarters." "EBITDA is zero or negative in one of the two quarters." "No approved net debt for the new quarter." "Equity value for the new quarter is zero or negative."
- Operations: **Open a draft valuation** (confirm: "This opens a draft valuation at $20.9M for Jun 30, 2025. It still has to be prepared and approved before it is locked.", plus each flag in words); with a Draft open, **Use this value on the draft** (confirm: "This puts $20.9M and the method Sponsor mark on the draft dated Jun 27, 2025. The draft keeps its date."); with a version past Draft, "A valuation for this quarter is being approved. Send it back to change it."; **Dismiss**, with a reason.
- Run page, for the four roles: "Valuation suggestion opened", "Valuation suggestion replaced", or "No mark suggested:" with the reason or the sentence of section 3. Below, for a statement: "Wrong position, or none? A classified document cannot be relinked yet. Dismiss the suggestion; a draft can still be started on the board."
- Elsewhere: a "Suggested" column on the board's Missing marks card, for the same quarter only; a "Suggested mark" panel on the deal's Valuations tab; on the version screen, from `inputs`, "Started from a suggestion of $20.9M. Source document, page 1.", read-only suggestion keys in the edit form, and "A newer suggestion is open for this quarter." when one is.
- `config/role_focus.json`, operations and deal team work lists: to `/valuations/suggestions`, label "Valuation suggestions", what "Marks worked out from approved statements and reports".
- States: empty, "No suggestions are open. One appears when a statement or quarterly report is approved for a position with no mark for that quarter."; flag off, "Suggestions are switched off. Open ones can be read and dismissed."; not calculable, the missing-value placeholder and the reason.

## 8. Static preview
Nothing is recorded: a suggestion exists only after an approval in the session. Simulated in `apps/web/src/preview/routes/`: a new `valuationSuggestions.ts`, and the API's changes mirrored in `extraction.ts`, `valuations.ts`, `intake.ts`, `documents.ts` (matcher, review rule) and `monitoring.ts` (the board's run), all calling `controls-suggestion.ts` and `@pb/calc`. `lib/preview-guide.ts` gains a walkthrough of the example sequence (section 9).

## 9. Synthetic data (seed 42)
- Schema `capital_account_statement`, prompt `capital_account_extraction` (in `PROMPT_IDS`); no target, bounds, highlights (`bullets: 0`) or commentary. Fields: `period_end` (required), `total_commitment`, `contributions_to_date`, `distributions_to_date`, `unfunded_commitment`, `beginning_capital_balance`, `contributions_in_period`, `distributions_in_period`, `net_gain_loss`, `ending_capital_balance`, `investor_share_pct` (a percent). Labels are the keys in sentence case, except "Contributions in the period", "Distributions in the period", "Net gain or loss", "Our share of the vehicle".
- Task text: the quarterly one, its first line replaced by "Extract the fields listed below from the capital account statement, for the period it states. When it lists several investor accounts, read the totals for the four commitment lines and answer null for the five balance lines. Answer our share only when the balance lines are for the whole vehicle and the statement gives our share of it. When the balance lines are for the whole vehicle and the statement gives neither our share nor our own account, answer null for the five balance lines. If the statement is not in US dollars, answer null for every money line." and its last by "Write no highlights and no commentary."
- The mock: `ai.register('capital_account_extraction', fixtureExtractor(truths))` in `apps/api/src/composition.ts`. The runner still stages two empty narrative rows; the review page hides that block.
- The eleven fund-level statements keep their bytes and hashes; their truths gain the six new keys, all null.
- **Position-level statements (new; documents only, no new random draw):** `positionStatement`, called by `generateDocuments`, for the `stale_valuation`, `roll_forward_break` and walled positions, then up to three active co-investment or continuation vehicle positions with no data scenario that no document scenario took, by number (fewer when fewer remain): one for the as-of quarter end, one for the quarter before. File `<period> <fund> - Capital account statement - <company>.pdf`; one page: letterhead, title, "Prepared for <vehicle>, reference INV-nnnn", "Period end", then an "Account <vehicle>" block in US$ millions: contributions and distributions to date and the five balance lines (commitment and share truths null).
- Figures from the dataset's rows only. Ending balance: the Locked mark for the period end; with none (the `stale_valuation` as-of quarter, the `roll_forward_break` prior quarter), cost (the entry contribution flow) over the entry snapshot's total equity, times the larger of the quarter's enterprise value less net debt and 10% of cost, the rule `generate.ts` marks positions by; else "n/a". Beginning balance: the prior quarter's ending by the same rule. Flows: approved cash flows (`summarizeFlows`). Net gain or loss: printed ending less beginning less contributions plus distributions, so every seeded statement ties.
- **What moves (small profile):** documents 78 to at most 90 (docs/14's count and range move, and the generator test's cap of 80 becomes 95); statements 11 to at most 23, so tests equating statements with committed funds count fund-level ones; `expectations.positionStatements` is new; `walledFiles` gains two; hub lists, the gold set, the classifier eval and the preview book grow. Expected-document rows, positions, marks, cash flows and totals do not move. docs/14 no longer says a co-investor has no statement.
- Test-only fixtures (same builder, lines passed in): examples 1 to 3 and 8; a whole vehicle with no share (balance truths null); one in "EUR millions" (money truths null); a fund-level statement and one read in thousands, each linked to a position (contributions differ); one far from the report's indication; a reference and a name that disagree, and a company two positions hold (both held for review); the walled position's statement for the quarter after the as-of date, which gives the suggestion the wall tests need.
- **Example sequence,** on `stale_valuation` (INV-0007 in the small profile): its as-of report approved gives an Open suggestion by 12.2; its as-of statement approved supersedes it with one by 12.1, the 12.2 indication beside it. A generator test asserts the two are under US$ 10,000 apart, that the 10% floor is not hit and no flow follows its prior quarter end, and records the badges the guide names. Statement first: 12.1 at once. Every other seeded statement, and the `roll_forward_break` position's prior-quarter report: none.

## 10. Tests
- **Calc:** fixtures 29 (12.1: tie-out by unit, break, share and its range, contributions check) and 30 (12.2 to 12.5, rounding, every reason and its precedence); properties (scaling M0 scales S; E1 = E0 gives S = M0; S is linear in the share); the Python cross-check.
- **Workflows, DB, AI:** every allowed move and a rejection for every other pair, on both machines; `notAmong` with an absent list; the selection cases (each order, a first source with no value, none on hand, the config order reversed); each constraint; the access matrix by role and across the wall; the gold set with both kinds of statement and the whole vehicle with no share (0 unit errors, 0 uncited values).
- **Synthetic:** every position statement ties, chains from the one before and links to its position by name and by number; the fund-level eleven are byte-identical; counts against `expectations`.
- **API, guards:** approving a statement leaves `mon.quarterly_performance`, lineage included, unchanged; the board keeps the report's run; a position-level statement never fills a fund's expected row; a statement held for review fills none; every "None when" case and its sentence.
- **API, suggestions:** the example sequence both ways, through to Locked as Sponsor mark; each fixture; two approvals at once end with one Open row, statement-based; no repeat after a dismissal, nor after an acceptance when the report arrives; closing when a Draft made by hand is Locked; a statement with no value falling to 12.2; 12.3; a flow since the mark; a mark dated three days early counts for its quarter; `applyToDraft` on a weekly Draft (value, method, date kept) and on a Draft from an earlier suggestion; a refresh after a promotion approved by a deal team reviewer, a lock and a reopen; the 409 at accept; every source reviewer refused at both approvals; PATCH keeps the keys; the walled statement and suggestion hidden outside the wall; the usual 403, 404, replay, 412 and flag-off cases.
- **Web and browser:** states, workings, checks, cross-checks, dialogs, no request for the three other roles, copy guard; one journey: an admin switches extraction on, operations run the example sequence, open the draft from the statement's suggestion and find it on the board with its source.

## 11. Slices
1. Calc: `suggestion.ts`, fixtures, properties, cross-check, docs/08.
2. Workflows: the machine, `notAmong` and the valuation precondition, `controls-suggestion.ts`, the config keys, docs/18.
3. DB: migration, schema, classification, matrix, docs/03. Rebuilds the recordings (flag and taxonomy lists).
4. Guards, before any statement schema exists: the no-target approval branch (tested with a test schema), the board's run, the matcher, the review rule, their preview mirrors.
5. Statement schema and documents: config, prompt, truths, mock, the review page, `positionStatement`, `expectations`, evals, docs/14, docs/04 M4, the docs/07 agent table, docs/11 E4. Rebuilds the preview book.
6. Contracts and API reads: routes, OpenAPI, list, detail, cross-checks, derivation with its lock, replacement, closing, the refresh, the config startup check.
7. API commands: accept, applyToDraft, dismiss, shared create and edit, kept keys, the precondition's record.
8. Web: Suggestions tab, workings, checks, dialogs, role focus.
9. Web: board column, deal tab, version screen, run page, review queue line.
10. Preview simulations and tests. Rebuilds the preview bundle.
11. Browser journey, guide step, decision 0023, docs/04 M10, docs/09, session log.

## 12. Risks and owner questions
Risks: a suggested number can anchor the preparer, so it shows its workings and its source reviewers cannot approve it. The new precondition and the kept `suggestion.` keys change existing valuation behaviour. A wrong statement on a position (a fund statement, a wrong unit) is flagged by the contributions check, the "read as" line and the Variance badge; none blocks. A statement classified to the wrong position, or to none, cannot be relinked. Only the task text keeps a whole-vehicle or non-dollar balance out. 12.2 assumes our share of the company is unchanged since the last Locked mark. Only the mock has been measured on statements.

Questions, each with the default built:
1. **How does a fund commitment carry a mark?** Blocks suggestions for fund-level statements only. Default: it does not yet. Recommended: a position per commitment (deal type primary fund, as closing a primary fund deal already creates), kept out of the company-level exports and report sets; 12.1 then applies as written. The alternative, a valuation on the commitment, changes `mon.valuation`, which the accounting export reads.
2. **Order of sources.** Statement, then the report's equity value (12.2), then the multiple held (12.3): one config list; the report rules are a draft set. A statement with no value falls to the next source, and the page says so. Equity is enterprise value less net debt; or the equity a report states.
3. **A statement that does not tie, or whose contributions differ from the record.** Suggested with a flag; or held back until someone explains it.
4. **Cash flows since the last Locked mark** (report bases). Not calculable; or roll the scaled mark forward by the flows.
5. **Method labels.** Statement-based: the existing "Sponsor mark". Report-based: a new term, "Indication from sponsor report"; or "Sponsor mark" for both.
6. **Source reviewers.** Blocked from both approvals; or named and not blocked.
7. **Expected documents.** Position-level statements are not tracked yet; or one per held co-investment and continuation vehicle position each quarter.
8. **What names a company-specific statement?** Default: our reference on page one or the company in the file name links it; anything else, such as the sponsor's co-investment vehicle name alone, reads as fund-level or goes to a person. Recommended for real documents: the classifier also reads the company name from page one.
9. **Relinking.** Not built. Recommended next: a command sending a Classified document back to review, with a reason, refused once one of its runs is approved.
10. **Smaller defaults.** No suggestion for a private credit or primary fund position, or one not in US dollars. Operations alone act. Accounting import approvals refresh suggestions and raise none. Using a value on a Draft keeps the Draft's date. The board's 10% variance flag also decides "Sources differ". The two tolerances of section 4.

## Review points not taken
First review:
- 1, second option: no primary fund positions are seeded; the first option is taken.
- 4a, in part: the promotion already refuses an entry snapshot (`promote.ts`), so that approval fails before any row is written; the rule is added anyway.
- 6, stale key: `intake.staleQuarters` measures a late restatement of figures, not a mark; no key is added.
- 13, in part: the preview does not open with approved documents, since the existing walkthroughs and the probe start from an empty hub; the empty state and a guide step say what to do.

Second review:
- 3c: no relink transition in this build: it ends Classified being terminal and must release expected rows and duplicates, a slice of its own (question 9); the limit is stated on the page.
- 4, last point: a reference and a name that disagree are stopped at classification, so no suggestion-level reason exists for them.
- 15, own reason: the schema has no text field to carry a currency code, so a statement in another currency and one with no balance read the same; one sentence covers both, and the position's currency is the mechanical guard.
- 17c: a dismissed statement still shows the report's indication beside it, and a draft can be started on the board; no set-aside option is added.
- 17d: `stg` rows follow the staging states and belong to an intake file; a suggestion has its own machine and is replaced, so it stays in `mon`.
