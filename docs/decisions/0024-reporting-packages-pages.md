# 0024: The Reporting, Packages pages (the release gate in the web app and the static preview)

- **Status:** Accepted for the prototype
- **Date:** 2026-11-18
- **Deciders:** repo owner (the roadmap line); built in Claude Code

## Context

The roadmap's Phase 4 line, in the owner's words: "The Reporting, Packages pages: the findings with expected and found, and the release gate; the preview's simulated routes."

What the platform already held: the report QA rules (`runReportQa`, `docs/08` section 7), the package record (`rpt.package` and `rpt.qa_result`, migrations 0019 and 0020), the snapshot builder (`buildPackageSnapshot`), the four routes of `/api/v1/report-packages` and the package machine (`reportingPackageMachine`, `docs/18` section 5). No page showed a package, and the static preview answered none of the four routes.

The rules of the build guide that shape the design: nothing is built twice (rule 7); a number is never invented and a missing one is never replaced (rule 10); the web reaches the API through the contracts (rule 11); every state change goes through a transition table (rule 14); page copy is plain language and never names a rule code, an identifier or the build guide (rule 16, `docs/06` section 6).

## Options considered

1. **Where the preview's packages come from.** Recorded at build time, or simulated in the page session (chosen). The synthetic book seeds no package and this work adds no row, so there is nothing to record: all four routes are simulated, and a package exists once investor relations starts one.
2. **How the preview builds what a package shows.** Its own mapping from the recordings to a snapshot, a second copy of the API's, or one shared rule (chosen): `snapshotRequestOf` in `@pb/report-engine`, which the API and the preview both call, so the same record gives the same package whoever generates it. For the same reason the API's private canonical JSON is gone in favour of `canonicalJson` of `@pb/contracts`, and how a flow type reads as a contribution or a distribution is `flowKindOf` in `@pb/calc`.
3. **Money in the Checks card.** US$ millions as in every table, or dollars to the cent (chosen, for Expected and Found only). A check compares two figures, and a rounded million hides the difference the check is about. Positions and Client share stay in US$ millions.
4. **A totals row under Positions and Client share.** Added up by the page, or none (chosen). The page does no arithmetic: a total appears once the report engine works one out and a test holds it.
5. **The gate as steps.** One step per state of the machine (seven), or six with the outcome of the checks said on one step (chosen): "QA failed", "QA passed" or "QA passed by override".
6. **Which failing package the browser journey starts.** The one over the stale mark, whose label check reads "expected Preliminary, found Final", or the one over the position with no Locked mark at the start of the quarter (chosen). The specs share one API and the valuation journey locks the stale position's mark, which mends the label check; nothing mends the missing start mark.

## Decision

**No new table, column, policy or migration.** `rpt.package` and `rpt.qa_result` are used as migrations 0019 and 0020 built them. No table the accounting import or export reads is touched.

**One contract change.** `GET /report-packages/{id}` answers `changeLog`: the generation runs of the package in run order, each with when, who (a person, resolved from the stored user id), the run number and the counts of lines, findings and failed findings. It lists generation runs only; every other step is in the audit trail, and the page says so.

**The pages** (`apps/web/src/pages/reporting/packages/`, routes `/reporting/packages` and `/reporting/packages/$id`, a Packages tab after Weekly report):

- **The list:** the packages of the clients the reader sees, newest quarter first, filtered by client and state, with the state as a badge and the checks in a few words ("Not run", "All 103 passed", "4 of 103 failed", "4 failed, overridden").
- **Starting one** (investor relations): a client, a quarter that has ended on the as-of date the clients read answers (the latest eight, `reporting.packageQuarterChoices`), a basis and a label. There is no as-of field: the API uses its own date. A basis that is not on the client's record is said and still allowed. With one in progress for the client, quarter and basis the form sends nothing and links to it; with a Released one it asks for the reason of the new version.
- **The package:** the release gate as six steps with what happens next and who does it, the commands, who prepared, approved and released, and once approved the SHA-256 of the content in full; the checks of the latest run, the ones that did not pass first, with what each expected and found, the passed ones behind a toggle, and an override said once with its reason, approver and time; the positions, footnotes and client share as stored; the tie-out explanations; the generation runs.
- **The commands** (`PackageActions.tsx`): one button per step a person may take from the state, live for the roles the transition table names and disabled with the role it needs for everyone else. Every command carries the row version the page shows (`If-Match`). Override asks an approver for the reason and says how many failed checks it is recorded against. Regenerate asks for explanations only when a tie-out failed for a position with none on record. Approve is offered to every approver, and the refusal the preparer gets from the API is shown. A refused command reads the package again, so a stale page lands on what stands now.
- **Words.** No rule code and no identifier reaches a page: each QA rule has a plain name, a finding is about the whole package, one of its two labels or a position (its number and, when the reader's own positions list has it, the company), and a footnote is a sentence. A missing figure is the placeholder with the reason beside it, never zero: a held line with no Locked mark at the start of the quarter reads "Not calculable: no locked mark at the start of the quarter" for its begin NAV and its gain.
- **Role focus** (`config/role_focus.json`): Packages is the first Reporting tab for investor relations and approvers, and "Client packages" is in both work lists. No landing page changes.

**The static preview** (`apps/web/src/preview/routes/reportPackages.ts`). The four routes are simulated over the packages started in the page session, cleared by a reload or the reset. The contract's roles apply (403), and a package is read within the clients the reader reads (404 otherwise). Generating builds the snapshot by the shared rule from the acting credential's own recordings: the client's commitments, and the one-pager of every position the book names that the credential may open, so a position behind a wall the preparer is not on is absent, as it is from the API. Marks are the versions as they stand in the session, so a mark locked there counts; flows are the recorded ones. The findings are `runReportQa`'s, the outcome is stated by the system step through the machine, the row version moves by two, and an approval hashes the content with the text the API hashes (503 where the browser offers no SHA-256, never an invented hash).

**Synthetic data.** No new row. `failingPackageCase(dataset)` in `tools/synthetic` names a package that fails the gate, for tests and the browser journey: an investor relations user, a client they are entitled to, the failing position and its scenario (`roll_forward_break` first, else `stale_valuation`).

**Left out:** the template engine and the files a package becomes; net figures; a way back from QA passed or In review; a total across positions.

## Consequences (security, cost, operations, migration)

- No migration, no new dependency outside the workspace (`@pb/report-engine` becomes a dependency of `@pb/web`, which the preview needs), no new external service.
- The API's behaviour is unchanged by the shared pieces: the stored content gives the same bytes under the shared canonical JSON, so a hash taken before still verifies. The API now reads every Released package of the client and basis and lets the shared rule pick the prior release, where it read the latest one itself.
- A package is the reading of whoever generated it. The page says so under Positions and never calls a package complete.
- A net package shows gross figures under a standing notice. Before any file is produced from a package, the template engine must refuse a net package or carry net figures: gross figures must never be printed under a net label.
- A package that reaches QA passed or In review can only go forward. One that should not be released stays where it is and blocks a new one for its client, quarter and basis.
- In the preview a flow reconciled in the session is not in a package generated afterwards: flows come from the recordings. Marks locked in the session are read.
- The whole browser suite gains one journey of about 45 seconds.

## SEC IDs affected

- SEC-5.1: the page disables what a role cannot use and names the role it needs; the API and the database decide. The preview applies the contract's roles.
- SEC-5.2: a package of a client the reader is not entitled to answers 404 and reads "Package not found", in the API and in the preview; a viewer and a platform admin are told whom packages are for.
- SEC-5.3: a package holds only the positions its preparer could read. Nothing on a page says whether a walled position exists.
- SEC-5.6: the preparer never approves. The page offers Approve to every approver and shows the API's refusal; it does not judge in the browser.
- SEC-9.3: the content hash is shown in full once a package is approved, with what it covers; a Released package offers no command and the API refuses any.
- SEC-9.5: while a check fails the page offers no Submit; an approver's override needs a reason, which is recorded against every failed check of the run with their name.
- SEC-11.1: every command is audited by the API. In the preview each result says "simulated in this preview, not audited".

## Verification (what was checked, docs/versions consulted)

- `docs/04` M14, `docs/05`, `docs/06` (sections 2, 3 and 6), `docs/08` section 7, `docs/12`, `docs/14` section 3, `docs/17` section 3, `docs/18` section 5; CLAUDE.md rules 7, 9, 10, 11, 14, 15 and 16.
- No new financial rule: `docs/08` section 7 is used as written, so there is no new golden fixture and no new Python case. The shared pieces have their own tests (`flowKindOf` in `packages/calc`, `snapshotRequestOf` in `packages/report-engine`), and the API suite passed unchanged after the refactor.
- The preview against the API: the simulated routes mirror `apps/api/src/test/report-packages.test.ts` (403, 404, 409, 412, 422; the findings equal `runReportQa` over the content; a walled position absent; a mark locked in the session read on regenerate; a tie-out that passes once explained). The probe compares, in the built bundle, the findings with the engine run over the content shown, and the hash with the SHA-256 of that content.
- In a browser over the real API: `apps/web/e2e/report-packages.spec.ts`, alone and after the valuation journey.
- No external API or fast-moving service is called: nothing outside the repository was consulted.

## Decided in the build, and what was set aside

The owner's instruction of 2026-11-18 (CLAUDE.md section 4) is that design questions are decided by the build and recorded with the reason and the alternative set aside. These are the questions the design raised.

1. **A position behind a wall the preparer is not on.** It is left out of the package, as the API already did, and the Positions card states the rule. Set aside: building the package as the system from the whole book, which would put a walled position's figures in front of a preparer outside the wall; refusing to generate, or counting what was left out, either of which tells the preparer that a walled position exists (SEC-5.3). What this leaves to people: the package of a client whose vehicle holds a walled position is prepared by someone on that wall. Who is on a wall is not the build's to change.
2. **Net packages.** Allowed, with the notice "Net figures are not worked out yet. These figures are gross of fees and carry." Set aside: refusing a net package, which would leave a client whose record says net with no package in the prototype. The guard for later is in Consequences.
3. **A basis that is not on the client's record.** The start form says "Not on this client's record" and does not block. Set aside: a refusal, since a client's record can lag a new mandate and the person starting the package sees the warning before anything is stored.
4. **No totals row.** None until a tested total exists in the report engine. Set aside: a sum in the page, which would be financial math with no specification and no test.
5. **Expected and Found to the cent,** in the Checks card only. Set aside: US$ millions there, which hides the difference a check is about; `docs/06` section 3 records the exception.
6. **The browser journey is a packages journey, not critical journey 5.** `docs/12` defines journey 5 as fix data, regenerate with identical layout, release, which needs the template engine. The Phase 4 exit stays unticked.
7. **Flows in the preview** come from the recordings, so one reconciled in the session is not in a regenerated package. Set aside: rebuilding the one-pager's flows in the simulation, a second copy of the API's read for a case the preview's walkthrough does not show.

## Still open

Two things this work did not decide, because each changes the API or the workflow, not a page. Both are recommended as the next slices of Phase 4, ahead of the template engine.

1. **Who reads the lines of a package.** Every role that reads all clients reads every line of a package, whatever walls that reader is outside. It is latent today: no investor relations user is on a wall, so no package holds a walled line. Recommended: a package inherits the walls of the positions it holds and answers 404 outside them. That narrows access and keeps the hash true to what every reader sees, where hiding single lines from some readers would not. It needs a policy migration and its rows in the access matrix.
2. **A way back.** Recommended: "send back with a reason", by an approver, from In review and from QA passed to Draft, as a transition of `docs/18` section 5 with its rejection tests. Until then a package that should not go out blocks its client, quarter and basis.
