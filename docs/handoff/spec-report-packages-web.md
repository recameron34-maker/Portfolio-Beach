# Spec: Reporting, Packages (web and static preview)

> **State of the repository when this build starts (2026-11-18, head 44104ff).** Read this before the rest.
> - Numbers: decision records 0022 (the base case) and 0023 (valuation suggestions) are taken. This spec's decision record is **0024**: where the text below says decision 0022, read 0024. Migrations run to 0023, `docs/08` sections to 12, golden fixtures to 31, `docs/18` sections to 14, capability rows to E15; this spec adds none of those.
> - Two features were built on the branch after this spec was written: the base case card (decision 0022) and valuation suggestions (decision 0023). What they changed that this spec touches:
>   - `config/role_focus.json` and the Valuations tabs gained a Suggestions tab: keep every entry that is there and add to it.
>   - `apps/web/src/preview/routes/valuations.ts`: create and edit are split into `openDraft` and `correctDraft`; the preview book carries `currency` per position; `generatedWorld` in `preview/test-fixtures.ts` takes a fourth argument.
>   - `@pb/workflows` holds more shared rules and lists (`VALUATION_IN_FLIGHT_STATES`, `quarterVersions`, `EQUITY_DEAL_TYPES`, the suggestion controls). Check there before writing a helper.
>   - The browser specs share one API process and one dataset: `journey3` locks the only position with no mark for the quarter and `suggestions.spec.ts` reopens it. A new journey must not depend on the order the specs run in, and must leave the data other specs read as it found it, or say why it cannot.
>   - Baselines to compare against: vitest 274 files and 5,552 tests; the preview probe 223 checks; the whole browser suite 71 tests (about 20 minutes); `pnpm openapi:generate` 95 paths.
> - Where the text names a file line, find the function by name: the lines have moved.

## 1. Goal
Owner (roadmap, Phase 4): "The Reporting, Packages pages: the findings with expected and found, and the release gate; the preview's simulated routes."
A person sees the client packages they may read, starts one (investor relations), reads its positions, footnotes, client share and checks, and moves it through the gate: Draft, Generated, QA, In review, Approved, Released. The static preview does the same with no server.

## 2. What exists and is reused
- API side: `packages/contracts/src/reporting.ts`, `routes-reporting.ts`; `apps/api/src/packages/*`; `reportingPackageMachine`; `buildPackageSnapshot`, `runReportQa`, `QA_RULES` (`packages/report-engine`).
- Page pattern: `pages/capital` (`WireRegister.tsx`, `WireInstruction.tsx`, `api.ts`); `components/WorkflowActions.tsx`; `lib/states.ts`; `lib/workflow.ts`; `describeActionError` (`ApiError` already strips build guide references).
- Preview pattern: `preview/routes/wires.ts`, `valuations.ts`, `common.ts`; `overlay.ts`; `hash.ts`.
- Would be duplicates, so they are shared first:
  - Canonical JSON: the service keeps a private copy (`packages.service.ts:67`); `@pb/contracts` already exports `canonicalJson` (`lock.ts`). The API switches to it; stored content gives the same bytes.
  - `kindOf` (`apps/api/src/portfolio/metrics.ts:63`) moves to `@pb/calc` as `flowKindOf`.
  - The mapping from record rows to a snapshot request and the pick of the prior release (`packages.service.ts:298-370`) move to `@pb/report-engine` as the pure `snapshotRequestOf(source)`; the API and the preview both call it.
  - `StageStrip`, private to `pages/pipeline/Opportunity.tsx`, is lifted to `components/StepStrip.tsx`.
- Gaps: the detail answer has no change log (section 6); `@pb/report-engine` is not a dependency of `@pb/web`; no formatter shows dollars to the cent.

## 3. Behaviour
- Readers: investor relations (entitled clients only); operations, deal team, approver, auditor (every client). Viewer and platform admin see "not visible to your role". Another client's package is "Package not found".
- List: newest period first; filters by client and state.
- Start (investor relations only): client, quarter (the latest `reporting.packageQuarterChoices` quarter ends on or before the as-of date the clients read answers), basis (one not on the client's record shows "Not on this client's record" and is still allowed), label. No as-of field: the API uses its own date. With one in progress for the same client, quarter and basis, Start is disabled and links to it. With a Released one, "Reason for the new version" is required.
- Next step by state: Draft, Generate (investor relations). QA failed, Regenerate (investor relations) or Override QA with a reason (approver). QA passed, Submit (investor relations). In review, Approve (approver). Approved, Release (investor relations or operations). Released, Start a corrected version (investor relations).
- Deal team and auditor read only. A button a role cannot use is disabled with "Needs investor relations" and the like (`blockedTitle`).
- Approve is offered to every approver; the API refuses the preparer and the page shows that refusal.
- There is no way back from QA passed or In review. The page says so.
- Regenerate opens a dialog only when a tie-out check failed for a position with no recorded explanation.

## 4. Data model
No new table, column, policy or migration. Reused as built in 0019 and 0020: `rpt.package`, `rpt.qa_result`, their row-level security, classification and history. No accounting import or export table is touched. Config only: `reporting.packageQuarterChoices: 8` in `config/definitions.json`; `config/role_focus.json` (section 7).

## 5. Calculations
No new rule; `docs/08` section 7 is reused unchanged. The page does no arithmetic: it shows stored figures and has no totals row. Three stored lines, as the page must show them:
1. Held, marked for the quarter. Begin 11,900,000.00; contributions 300,000.00; distributions 0.00; end 12,450,950.25. Gain: 12,450,950.25 - 11,900,000.00 - 300,000.00 + 0.00 = 250,950.25.
2. No Locked mark for the quarter. Last mark (prior quarter end) 4,200,000.00; contributions 0.00; distributions 125,000.50. End: 4,200,000.00 + 0.00 - 125,000.50 = 4,074,999.50. Gain: 4,074,999.50 - 4,200,000.00 - 0.00 + 125,000.50 = 0.00. Footnoted; a client owning 20% shows 814,999.90. Labelled final, the label check fails: expected preliminary, found final.
3. Entered in the quarter: contributions 8,000,000.00, end 8,310,000.00, gain 310,000.00; the begin cell reads "New this quarter".
Edge cases: a held line with no Locked mark at the quarter start has no begin NAV and no gain; both show the missing-value placeholder, titled "Not calculable: no locked mark at the start of the quarter". No end NAV: placeholder, and no client line. Never zero, never another quarter's figure.

## 6. API
Routes, roles and bodies as in `REPORTING_ROUTES`: `GET /report-packages`, `GET /report-packages/{id}`, `POST /report-packages` (201, investor relations), `POST /report-packages/{id}/commands`. Both POSTs are idempotent (the web client adds the key); every command carries `If-Match: "<rowVersion>"`.
- One contract change: `reportPackageDetail.changeLog: { at, by: person, runNo, lines, findings, failed }[]`, in run order; the service resolves each stored user id to a person. It lists generation runs only. OpenAPI is regenerated.
- Machine `reporting_package`. A person's commands: generate, regenerate (optional `explanations` by position number), overrideQa (`reason`), submit, approve, release. `qaPass` and `qaFail` are the service's. Generated never rests: a generate answer is already QA passed or QA failed.
- Row version: plus two on generate and regenerate (two writes), plus one otherwise.
- Errors: 400 (not a quarter end; as-of before the period), 403 role, 404 unseen package or "Client not found", 409 transition or "already in progress", 412 stale, 422 "a new version needs a reason" or the preparer approving.

## 7. Web
Routes `/reporting/packages` and `/reporting/packages/$id`. `REPORTING_TABS` (`app/nav.ts`) gains `{ to: '/reporting/packages', label: 'Packages' }` after Weekly report. Files in `pages/reporting/packages/`: `api.ts`, `packages.ts`, `Packages.tsx`, `StartPackageForm.tsx`, `PackageDetail.tsx` (read only cards), `PackageActions.tsx` (commands and dialogs).
- `api.ts`: list and detail queries, start and command mutations; success sets the detail and invalidates both keys and `['audit']`.
- `packages.ts` (pure): `RULE_WORDS: Record<QaRule, { name, kind }>`, footnote and entity words, `gateSteps`, `personCommands` (`commandOptions` minus service-only options), `checksSummary`, `quarterChoices` (dates from `@pb/calc`).
- No identifier reaches the page. Rule names: End NAV on record; Stale mark footnoted; Nothing dated after the as-of date; Quarter starts from the prior locked mark; NAV roll-forward; Gain or loss sign; Ties to the last released package; Movers list; Preliminary or final, gross or net; Client share of NAV. Entities: "Whole package", "Preliminary or final label", "Gross or net label", the position; a client line shows the position only (the client id is dropped). Footnote `stale_valuation`: "Carried at the mark of {date}, rolled forward for cash flows since." A position shows its number and, when the reader's own positions list has it, the company name.
- List: `PageHeader` "Client packages", `TabNav`; columns Client, Quarter, Basis, Label, Version, State (badge, new `packageTone`), Checks ("Not run", "All 126 passed", "3 of 126 failed", "3 failed, overridden"), Prepared by.
- Detail cards:
  1. Release gate: `StepStrip` over the six steps. QA failed and QA passed both sit on QA, worded "QA failed", "QA passed" or "QA passed by override"; Generated, if ever received, is current with no actions. Then a sentence on what happens next, `CommandButtons`, who prepared, approved and released, and once approved "Content hash (SHA-256)" in full: "Taken over everything this package shows, as approved."
  2. Checks, failed first, passed behind a toggle: Result (Failed, Overridden, Passed), Check, About, Expected, Found, Detail, and the override's reason, approver and time. Money to the cent (`formatUsdExact`, new); dates and labels as words.
  3. Positions: Position, Begin NAV, Contributions, Distributions, Gain or loss, End NAV, Mark ("Rolled forward from {date}"). Under the header: "Built from the positions {preparer} could read when it was generated. A position behind an information wall the preparer is not on is not included."
  4. Footnotes. 5. Client share: Position, Ownership, Client NAV. 6. Tie-out explanations. 7. Change log: "Generation runs. Every other step is in the audit trail." 8. `ActionLogCard`.
- Override dialog (`ReasonDialog`): "The reason is recorded against all {n} failed checks of this run, with your name."
- Explanations dialog: one optional box (3 to 500 characters) per failed tie-out position without an explanation; "An explanation stays on the package and cannot be removed."
- Net packages carry: "Net figures are not worked out yet. These figures are gross of fees and carry."
- States: `PageSkeleton`; empty "No packages yet"; a Draft's cards read "Not generated yet"; 404 "Package not found"; `UnavailableState` for 403 and outages; refusals in `ActionStatus`.
- `config/role_focus.json`:
  - `investor_relations.tabs["/reporting"]` and new `approver.tabs["/reporting"]`: `["/reporting/packages", "/reporting", "/reporting/clients", "/reporting/disclosures"]`.
  - `investor_relations.work`, first: `{ "to": "/reporting/packages", "label": "Client packages", "what": "Start a client's quarterly package, run the checks and release it" }`.
  - `approver.work`, after Trade tickets: the same link with `"what": "Decide on failed checks and approve the packages in review"`.
  - Operations and auditor get no work link (they use the Reporting tab). No landing change.

## 8. Static preview
Nothing is recorded: no package is seeded, so all four routes are simulated in `preview/routes/reportPackages.ts` over `state.reportPackages` (a map in `PreviewState`, memory only, cleared by reset). `@pb/report-engine` becomes a dependency of `@pb/web`. The dispatcher applies the contract's roles (403). A package is visible when `seesAllClients(actor.roles)` or `actor.clientIds` holds its client, else 404. Start mirrors the service (400, 404, 409, 422); its as-of date is the recordings' date.
Generate and regenerate, in the API's order:
1. 404, `staleIfMatch`, `attempt(reportingPackageMachine, ...)`.
2. Shares: the client's `vehicles` (`vehicleId`, `ownershipPct`) in the credential's recorded `GET /clients`.
3. Positions: each id in `book.investments`, or created this session, that `canOpen` allows and whose one-pager (the credential's recorded `GET /investments/{id}`) sits in one of those vehicles. Marks from `versionsNow`, so a mark locked this session counts; flows from the one-pager's `cashFlows`. The book gives ids only, and nothing is added to it; no book answers 503.
4. Prior release: the session's Released packages of the same client and basis; `snapshotRequestOf` picks the latest earlier quarter. So a package released in the session is the prior release for the next, until reload or reset.
5. `buildPackageSnapshot`, `runReportQa` (settings from `config/definitions.json`), then `qaPass` or `qaFail` as `SYSTEM_ACTOR`; findings sorted as the API sorts; change log entry; row version plus two.
Override stamps every failed finding of the run. Approve stores `sha256Hex(canonicalJson(content))` and answers 503 where SubtleCrypto is missing, never an invented hash.

## 9. Synthetic data
No new rows. `failingPackageCase(dataset)` in `tools/synthetic` returns an investor relations user, one of their clients, a position number and the scenario: the first client committed, with a share, to the vehicle of the `roll_forward_break` position, else of `stale_valuation`. A generator test proves one exists for seed 42, small. Edges: `stale_valuation` (footnote; final fails), `roll_forward_break` (no begin NAV), `walled_deal` (line absent), `two_clients_one_fund` (client lines).

## 10. Tests
- Calc and engine: `flowKindOf`; `snapshotRequestOf` (Locked only, flows to the as-of date, null shares skipped, prior pick). No new golden file or Python check: no new math.
- Db: none; access matrix unchanged.
- API: suite green after the refactor; hash equals `sha256(canonicalJson(content))`; row version steps; `changeLog` shape and names.
- Web: every `QA_RULES` entry and `STALE_FOOTNOTE` has words; no `QA-` code or uuid in rendered text; each role and state; the three lines of section 5; 403, 404, 412, the preparer's refusal; role focus and copy guard tests.
- Preview: mirrors `report-packages.test.ts` (403, 404, 409, 412, 422; findings equal `runReportQa` over the content); a walled position is absent; a mark locked in the session is read on regenerate; a tie-out break in a hand-built world (release a quarter, drop the next start mark) passes once explained; forbidden moves in `workflows.test.ts`; `plan.test.ts` lists the two GETs as simulated.
- Browser: `apps/web/e2e/report-packages.spec.ts`, the packages journey over `failingPackageCase`: investor relations starts a final package and generates; the failed check shows expected and found, and Submit is not offered; `head.one` overrides with a reason; investor relations submits; `head.one` approves and the hash shows; investor relations releases and the page is read only.

## 11. Slices
1. Shared, no behaviour change: API on `canonicalJson` of `@pb/contracts`; `flowKindOf`; `snapshotRequestOf`; hash and row version tests.
2. `changeLog` in contract and API; OpenAPI.
3. Preview: state, four routes, web dependency, tests.
4. `StepStrip` lifted; `packages.ts`, `packageTone`, `formatUsdExact`, config key; tests.
5. List page, start form, `api.ts`, tab, router, `role_focus.json`.
6. Detail page, read only cards.
7. Detail commands: buttons, override, explanations, If-Match.
8. `failingPackageCase`, the packages journey, probe walk, roadmap line, decision 0022, session log.

## 12. Risks and owner questions (default chosen)
1. A position behind a wall the preparer is not on is left out of the package (open in the session log). Default: API unchanged; the page states the rule and never calls a package complete.
2. The reverse: a package's lines are read by every role that reads all clients, whatever their own walls. Latent: no investor relations user is on a wall. Default: no change; decide with question 1.
3. No way back from QA passed or In review, and a stuck package blocks a new one for that client, quarter and basis. Default: no new command; propose "send back with a reason" for `docs/18`.
4. Net packages show gross figures. Default: allowed, with the notice.
5. The API does not check the basis against the client's record. Default: the page warns, nothing blocks.
6. No totals row. Default: none until a tested total exists in the report engine.
7. Expected and Found to the cent departs from "$M in tables". Default: cents, Checks card only.
8. The brief calls the browser test journey 5; `docs/12` defines that as fix data, regenerate with identical layout, release, which needs the template engine. Default: a packages journey; the Phase 4 exit stays unticked.
9. A flow reconciled in the preview session is not in a regenerated package (flows come from recordings). Default: accept.

## Review points not taken
- 3, in part: `canonicalJson` is not moved; a shared one already exists in `@pb/contracts` and the API's copy is deleted in its favour.
- 11, in part: `routes/index.test.ts` holds a floor on idempotent routes, not a list, so it needs no edit.
- 12, suggestion: no API wall scenario is added now; it would pin behaviour the owner has not decided (risk 2).
