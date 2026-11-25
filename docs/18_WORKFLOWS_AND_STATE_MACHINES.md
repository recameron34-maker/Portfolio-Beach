# 18: Workflows and State Machines

States are Postgres enums. Transitions happen only through API commands that check role, segregation of duties and preconditions, write `audit.event`, and emit an outbox event. Any transition not listed is **forbidden** and must have a test proving it is rejected.

## 1. Valuation (`mon.valuation.state`)
| From | To | Who | Preconditions |
|---|---|---|---|
| (new) | Draft | Operations | Investment active |
| Draft | OpsPrepared | Operations | Inputs complete; validation passed |
| OpsPrepared | Draft | Operations, Deal Team | Reason required |
| OpsPrepared | DealTeamApproved | Deal Team (not the preparer, nor a source reviewer) | |
| DealTeamApproved | Locked | Approver (not the preparer, nor a source reviewer) | Lock hash computed over inputs + value |
| Locked | Reopened | Operations, Approver | Reason; creates a new version in Draft; alerts prior approvers |
Reports read Locked only. One Locked version per investment and period (unique partial index).
A Draft is the only state that can be edited: operations may correct its method, inputs and fair value (`PATCH /valuations/{id}`, audited as `valuation.edit`, no approval row), which is how a reopened version takes its corrected mark; every other state answers 409. The lock hash is the SHA-256 of the lock text: the investment, the period end, the version, the method, the method inputs (keys sorted at every depth) and the fair value.
A version that carries a suggested mark (section 14) has source reviewers: whoever approved an extraction run behind a suggestion accepted onto the version, and whoever typed one of its figures over what was read. None of them takes either approval (`sourceReviewers`; SEC-5.6), so the figures and the mark are never judged by the same person. The list follows the mark, not the one row: it is the union over every Accepted suggestion whose valuation is a version of the same investment and quarter, so the Draft a reopen starts, which copies the mark and the suggestion's keys while the suggestion still names the version it was accepted onto, bars the same people at both approvals. The preparer is judged first, then the source reviewers, then the lock hash. A version with no suggestion on it names nobody and the rule of the table alone stands; a source reviewer may still prepare, send back and reopen. The keys a suggestion writes on a Draft's inputs (`suggestion.` and what follows) are kept by every edit whatever its body sends, and a create sent by a person stores none of them, so nobody forges, changes or drops them and the lock hash seals them with the mark. They are part of the valuation: every role that reads the version reads them, as it reads the lock text that covers them, while the suggestion itself is read by the four roles of section 14 (decision 0023, question 11). `accept` and `applyToDraft` write through the two writes of this section and no other (`createDraft` and `editDraft` of `apps/api/src/valuations/workflow.service.ts`), each audited as `valuation.create` or `valuation.edit` with the suggestion it came from.

## 2. Staging records (`stg.*.status`)
new > validated | flagged; flagged > validated (after edit) | rejected; validated > approved (reviewer) > promoted (system, single transaction). rejected is terminal.

## 3. Capital notice and funding
| State | Next | Notes |
|---|---|---|
| Received | Extracted | Document indexed |
| Extracted | Reviewed | Human checks amounts and dates; bank fields never extracted |
| Reviewed | TicketDrafted | Trade ticket created |
| TicketDrafted | TicketApproved | A trade ticket exists; approver differs from preparer; wire instruction verified and unchanged within the hold window; inside the hold window after a verified change, the approver is a third person (below) |
| TicketApproved | Funded | The ticket is Approved; Operations confirms |
| Funded | Reconciled | Cash Flow row promoted for the ticket's amount; unfunded recalculated |
Any wire instruction change returns the ticket to TicketDrafted and requires callback verification.
Preconditions added in Phase 3: a ticket can be approved only once a trade ticket record exists (`draftTicket` creates it; the instruction it is approved against follows section 11), and funding is confirmed only against an Approved ticket (SEC-12.3).
The hold window (`capitalActivity.wireChangeHoldDays`, counted from the day a version is proposed) works in two steps (SEC-12.3 "recently changed without a second approval"). While a new or changed version waits for its callback, nobody can approve the ticket (`wireChangedWithinHold`). Once a second person's callback has verified it, it is the active instruction, and for the rest of the window the approver must be a person other than its proposer (`wireProposedByWithinHold`) and other than the person whose callback verified it (`wireVerifiedByWithinHold`): three people touch a recently changed instruction. Both keys are null when the active instruction was proposed before the window, and the rule of the table alone stands. The ticket shows the same check as the release blocker `verifier_within_hold`.
The reconciliation books what was approved and funded: the cash flow carries the ticket's amount (`draftTicket` may name an amount other than the notice's), signed by the notice type; when the two amounts differ the audit event names both and the notice detail says "Funded amount differs from the notice amount."
A new instruction version sweeps every open notice of its counterparty as one system step, walled notices included (SEC-5.3: the proposer need not see them): each is flagged, a TicketApproved one goes back to TicketDrafted through `wireChanged`, and each change writes its own audit event.

## 4. Deal stage (`deal.opportunity.stage`)
Sourced > Screening > Prescreen > Diligence > IC > Approved > Closing > Closed. Any stage > Passed (reason code required). Diligence > IC requires required tasks done (or audited override). Closing > Closed requires the closing checklist complete and allocation tie-out (M22). Passed > Screening allowed (reopen) with reason.
Precondition added in Phase 3: Approved > Closing requires the closing record ready, a close date and a commitment amount given with the command (docs/04 M8); the command opens the closing of section 12 and its checklist from `config/closing_checklist.json`.
Rules made exact by the Phase 3 review:
- **IC > Approved** reads the latest IC decision recorded since the deal last entered IC, and it must be an approval. A decision from before a pass stays on record and no longer opens Approved; from a reopen until the deal is at IC again no decision counts. Diligence tasks done or waived before a pass stay done (the work was done); the gates show how many of those required for IC predate the reopen (`carriedOver`).
- **The allocation tie-out** sums received amounts only. A requested amount never stands in for a received one: a line with no received amount keeps the tie-out false, and the confirmation's refusal says on how many lines one is missing.
- **Closing > Closed** also requires the closing confirmed by operations (section 12); the gates show it as `closing.confirmed`.
- **A deal that reaches Closing again** (passed, reopened and approved again) keeps its closing record: the new close date and commitment are written and audited with the values before and after, and a confirmed closing returns to Open through the reopen row of section 12 as a system step, so operations confirm again before the deal can close. Items already received stay received.
- **The conversion on Closing > Closed** copies every wall of the opportunity to the new position in the same transaction, as the system actor (SEC-5.3). If the walls cannot be carried, the conversion is refused and nothing is written.

## 5. Reporting package (`rpt.package.state`)
Draft > Generated > QAFailed | QAPassed; QAFailed > Generated (after fix); QAPassed > InReview > Approved > Released. Released is immutable; corrections create a new package version with a reason.

| From | To | Who | Preconditions |
|---|---|---|---|
| (new) | Draft | Investor relations, entitled to the client | One package in progress per client, quarter and basis; a new version after a Released one needs a reason |
| Draft | Generated | Investor relations, entitled to the client | `generate`: builds the snapshot and runs the QA rules in the same step |
| Generated | QAFailed, QAPassed | System actor | `qaFail`, `qaPass`: the outcome of the QA rules; no person states it |
| QAFailed | Generated | Investor relations, entitled to the client | `regenerate` |
| QAFailed | QAPassed | Approver (not whoever started the package, nor anyone who ran one of its generations) | `overrideQa`: reason required; recorded against every failed finding of the run |
| QAPassed | InReview | Investor relations, entitled to the client | `submit`: the submitter is recorded (`rpt.package.submitted_by`) |
| InReview | Approved | Approver (not whoever started the package, nor anyone who ran one of its generations, nor whoever submitted it) | `approve`: locks the content with its hash |
| Approved | Released | Investor relations entitled to the client, or Operations | `release` |

**Segregation of duties (SEC-5.6).** A package's figures are the reading of whoever generated it, so preparing a package is starting it or running any of its generations (the change log names each run's person). None of those people overrides its failed checks or approves it. Whoever submitted it does not approve it either, so the hand-over to review is always between two people. One function builds the record the machine reads, for the API and for the static preview (`packageCommandRecord` in `packages/workflows/src/controls-package.ts`: `preparedBy`, `generatedBy`, `submittedBy`), and the table row holds the reviewer apart from all three (migrations 0019 and 0024). A package from before migration 0024 has no submitter on record, and that rule bars nobody on it.

**Entitlement (SEC-5.2).** A step the table gives to investor relations is taken for a client the person is entitled to, whatever second role lets them read the package: a person who holds investor relations beside approver or operations, without the entitlement, gets 404 for `generate`, `regenerate` and `submit`, and for `release` unless they hold operations (`packageStepIsInvestorRelations`). An approver overrides and approves for every client, and operations release for every client.

## 6. Document classification
Received > Classified (confidence >= threshold) | NeedsReview; NeedsReview > Classified (human). Duplicate (same hash) > linked to the original, not reprocessed.

**Review rule of a capital account statement** (decision 0023; `statementHold` in `packages/validation/src/documents.ts`, shared by the API and the static preview). A statement is one of two kinds, and the kind is its link, not a field: linked to a position it is our capital account for that one co-investment or continuation vehicle; linked to no position it is our account in a fund we committed to. Classified is terminal, so a statement the classifier would link wrongly, or read as a fund's, is stopped first. A statement that names a position (a company in the file name, our reference on page one) goes to NeedsReview whatever the confidence when what it names does not come to exactly one position:
- a reference that is no investment number on record, whatever the name says;
- with no reference, a company name that links to no position or to several (never fuzzy);
- a reference that links to one position and a company name that is exactly another's.

A reference that links wins over a name that links to nothing, and picks one of several positions the name fits. A statement that names no position is a fund statement and is never held by this rule. The held document keeps the links it names (so the wall of a position it names still holds) and its evidence keeps the reason in words, never a company or a number. The reviewer chooses the position, or leaves it empty for a fund statement. Only a statement linked to no position fills a fund's expected-document row (`expectedParentOf`).

## 7. Extraction run
Queued > Running > Succeeded | Failed | NeedsRetry; NeedsRetry > Running (max 1 automatic retry for schema failure, 3 for transient errors); Failed is surfaced as a Data Exception.
Approval of a Succeeded run promotes the accepted record figures into the quarter on record. A schema with no record figure (no field with a target column: a capital account statement) is reviewed and approved the same way and promotes nothing: it needs no linked position, the quarter on record keeps its figures, its approver and its lineage, and its runs never answer for a position on the monitoring board (`promotesToRecord` in `packages/ai`).

## 8. Deal change request
Submitted > Routed > InProgress > Applied | Rejected; quarter-end job lists any not Applied.
Preconditions checked by the API: the owner named at Routed must be able to open the request (inside the wall of the position when it has one); the applied-in period at Applied is a quarter end on or after the effective date and no later than the quarter end the clock is in. The quarter-end job runs over every request, the ones its runner cannot see included: it opens one exception per unapplied request (read under the request's own wall) and tells the runner how many it could not show.

## 9. Data exception (`ops.data_exception.state`)
| From | To | Who | Preconditions |
|---|---|---|---|
| (new) | open | Intake or job (system actor) | Opened by a validation rule, an unresolved link or a look-through difference |
| open | acknowledged | Operations | |
| open, acknowledged | resolved | Operations | Reason required |
| open, acknowledged | wont_fix | Operations | Reason required |
resolved and wont_fix are terminal; a problem that comes back opens a new exception. Setting the external ticket number (`external_ticket`) is a plain update, not a transition.

## 10. Implementation notes
- Model each machine as a typed transition table in `packages/workflows` shared by API and tests.
- Long-running flows (capital notice, extraction batches, report generation) run in the workflow engine with durable timers for reminders (T-3, T-1, due date).

## 11. Wire instruction (`mon.wire_instruction.state`, SEC-12.2)
| From | To | Who | Preconditions |
|---|---|---|---|
| (new) | Proposed | Operations, system actor | A new or changed instruction is a new version for its counterparty (a sponsor fund or an investment); bank details typed by a person from a verified source, never from a document or a model (SEC-12.1) |
| Proposed | Verified | Operations, Approver (not the proposer) | Callback to an independently sourced number confirmed the instruction; the call is logged with date, number source and result; no newer version of the counterparty is already Verified (`olderThanVerified`: an older Proposed version is rejected instead) |
| Proposed | Rejected | Operations, Approver | Reason required; a failed callback is logged whole (number source and result together, by a person other than the proposer) or not at all |
| Verified | Superseded | System actor, Operations | A newer Verified version exists for the counterparty (computed from the two version numbers when the newer one is verified) |
Rejected and Superseded are terminal; a corrected instruction is a new Proposed version. One active version per counterparty, always Verified. A new version proposed for a counterparty whose notice has an approved ticket fires `wireChanged` on that notice (section 3). The register's rows, masked or not, are read by Operations, Approvers, Auditors and Platform Admins only; a notice or a ticket shown to any other role carries the alerts, the hold and the release check without the instruction itself.

## 12. Closing (`deal.closing.state`, M8)
| From | To | Who | Preconditions |
|---|---|---|---|
| (new) | Open | Deal Team, Operations | Created when the opportunity advances Approved > Closing with a close date and a commitment (section 4); checklist items from `config/closing_checklist.json` |
| Open | OpsConfirmed | Operations | Every required checklist item received or waived; allocations tie to the closing commitment (M22) |
| OpsConfirmed | Open | Operations | `changeCloseDate`: reason required; the close date change is audited and the closing needs confirmation again |
| OpsConfirmed | Open | Operations, system actor | `reopen`: reason required; the confirmation is cleared and the closing needs confirmation again. The system actor's use is the step of section 4 when a deal reaches Closing again |
No state is terminal. The close date on the closing record is the single source for every report (docs/04 M8). The opportunity's Closing > Closed step (section 4) reads its checklist and tie-out gates and the confirmation from this record.
What operations confirmed stays as confirmed: while the closing is OpsConfirmed, a change to a checklist item or to the allocation lines is refused (422); they change again after a close date change or a reopen. While the closing is Open, `changeCloseDate` is a plain, audited date change with no transition. Once the deal converted (the closing names its investment) the close date is the position's entry date: `changeCloseDate` and `reopen` are refused (422) and a correction goes through a deal change request (section 8).

## 13. Underwritten base case (`mon.underwriting_case.state`, decision 0022)
| From | To | Who | Preconditions |
|---|---|---|---|
| (new) | Draft | Deal Team | The position is a co-investment, a continuation vehicle or a private credit position (a primary fund has no base case); no other Draft exists for the position; from version 2 a reason for the revision; a case date that is a Confirmed case's (a correction) or later than every Confirmed case's (a re-underwriting) |
| Draft | Confirmed | Deal Team, Approver (not the person who last changed the figures) | `confirm`: the case names its source, a document of the position or a note on where the model is held (SEC-9.4); an equity case has its plan, two points or more with the last on the planned exit |
| Draft | Withdrawn | Deal Team | `withdraw`: reason required |
| Confirmed | Superseded | System actor | `supersede`: a later version with the same case date is being confirmed (`correctedBySameDate`). A step of that confirmation, in the same transaction and before it, so the position never holds two Confirmed cases for one date; nobody sends it |
| Confirmed | Withdrawn | Approver | `retire`: reason required; for a case confirmed in error |
Superseded and Withdrawn are terminal: a revision is always a new version, and nothing is deleted. Only a Confirmed case is compared with the actuals (`docs/08` section 11); the entry case, the Confirmed one with the earliest case date, unless the reader picks another, so a later version dated after it is a re-underwriting and both stay Confirmed.
A Draft is the only state that can be edited, by the deal team: an edit replaces the figures and the plan points together and makes its editor the person who last changed the figures (`entered_by`, with `entered_at`), so whoever edits a Draft cannot confirm it and the person who entered it before them can. Every other state answers 409. Withdrawing takes no second person. The database holds the same line (migrations 0021 and 0022): a case starts as a Draft; inside a user transaction a new case and an edit name the person acting, a plan point is written only by the person the Draft names, and a confirmation names the person confirming and changes nothing else; a Confirmed case keeps its figures; a terminal case never changes.

## 14. Valuation suggestion (`mon.valuation_suggestion.state`, decision 0023)
| From | To | Who | Preconditions |
|---|---|---|---|
| (new) | Open | System actor | Derived when a capital account statement or a sponsor report run is approved for a position and quarter, in the approval's own transaction; one Open suggestion per position and quarter at most; none while a "none when" rule below applies |
| Open | Accepted | Operations | `accept`: the suggestion has a value; no version for the position and quarter is in progress (`versionInProgress`: a Draft, OpsPrepared or DealTeamApproved one). Opens a draft valuation at the suggested value, for the suggestion's period end, through the "(new) to Draft" row of section 1 |
| Open | Accepted | Operations | `applyToDraft`: the suggestion has a value; a Draft is open for the position and quarter (`draftOpen`). Puts the value and its method on that Draft, which keeps its own date |
| Open | Dismissed | Operations | `dismiss`: reason required |
| Open | Superseded | System actor | `supersede`: with its reason, one of `better_source`, `figures_changed`, `mark_locked` and `position_closed`. A step of the derivation that replaces or closes the suggestion, in the same transaction; nobody sends it |
Accepted, Dismissed and Superseded are terminal: a suggestion is never reopened, and a later approval writes a new one. "Not calculable" is data, not a state: a suggestion with a reason in place of a value is Open like any other and can only be dismissed or superseded. Accepting writes no mark. The Draft it opens, or the Draft it is put on, is prepared, approved and Locked by the valuation workflow of section 1, where the suggestion's source reviewers can take neither approval. Deal team, approvers and auditors read suggestions; viewers, investor relations and platform admins are given nothing. A suggestion sits behind the wall of its position.

**Sources and their order.** A suggestion rests on one source, never a blend (`docs/08` section 12): the ending balance of a position-level capital account statement, the equity value the sponsor's report states, or that report with the earlier multiple held. `valuationSuggestions.sourceOrder` in `config/definitions.json` is the order they are tried in. The first source on hand with a value is the suggestion; when none has one, the first on hand gives the reason. The others sit beside it as cross-checks. One pure function decides it for the API and for the static preview (`selectSuggestion` in `packages/workflows/src/controls-suggestion.ts`).

**None when** (`suggestionBar`, then the suggestions decided before), in this order:
- the statement is linked to no position, or to a primary fund position: our account in a fund commitment has no valuation record (`fund_commitment`);
- the position is private credit (`private_credit`);
- the position is not held in US dollars: nothing is converted (`not_usd`);
- the position is inactive, or was not held at the period end (`not_held`);
- a mark for that quarter or a later one is Locked (`mark_locked`);
- the same basis, value and inputs were dismissed (`dismissed`);
- or are on a valuation version in progress or Locked (`on_valuation`).

**What a derivation does** (`derivationStep`). It runs as the system actor when a statement or a report run is approved, and may then open a suggestion. Everywhere else it only refreshes the Open one and never creates one: when an accounting import is promoted, when a valuation is locked or reopened, and again inside `accept` and `applyToDraft` before anything is written.
- One of the first five "none when" rules applies: an Open suggestion is superseded (`mark_locked` for a Locked mark, `position_closed` for the others) and nothing is written.
- No source is on hand: nothing is written, and an Open suggestion left without one is superseded (`figures_changed`).
- The Open suggestion has the same basis, value and inputs as the sources now give: nothing.
- The same basis, value and inputs were dismissed, or are on a version in progress or Locked: nothing is written, and an Open suggestion that says something else is superseded (`figures_changed`).
- Otherwise the suggestion is written. With one Open, that one is superseded and names its replacement: `better_source` when the new basis comes earlier in the order of sources, `figures_changed` otherwise. A statement approved while a report-based suggestion is Open therefore supersedes it; a report approved after a statement changes only the cross-check; of two approved statements for a quarter the later counts.
Two suggestions are the same when their basis, their value (or their reason for none) and their inputs agree, key by key, figure by figure and period by period. Where a figure was read from and who typed it are not part of it, so the same balance read from a second copy of a statement is not raised again after a dismissal.

**The sources on hand** (`apps/api/src/suggestions/sources.ts`). The statement on hand is the latest approved run of a position-level capital account statement whose own period end is the quarter, with the lines a person accepted or typed: a line nobody decided is not on hand, so nothing is suggested from a value no person stood behind. A share of the vehicle that was read and that nobody accepted or typed (left undecided, or rejected) leaves every line as the whole vehicle's: none of them is on hand, and the missing share is never read as 100% (`shareLeftOpen`). The approval of such a run is refused (409) while one of those lines is accepted (`openShareRefusal`): the reviewer accepts or corrects the share, or rejects the lines it scales. The report on hand is the approved quarter on record (never an entry snapshot). Its figures are the record's; a figure is cited to the page of the document, or to the reviewer who typed it, when the run the quarter names as its source read that very figure, and to the record otherwise (an accounting import restated it, or nothing was extracted). A suggestion names the approved run its value was read by: the statement's run for a statement-based one, the run the quarter on record names for a report-based one; when the record names none, the run whose approval caused the derivation, and on a refresh the run of the suggestion it replaces. Its source reviewers are the approver of each run an input came from, the figures of the earlier quarter included, and whoever typed one.

**When it runs** (`apps/api/src/suggestions/derivation.service.ts`). Always as the system actor, inside the transaction of what caused it, behind an advisory lock on the position and quarter. Approving a statement or a report derives the suggestion of the run's quarter and then derives again the other Open suggestions of the position, since this quarter's figures are the earlier quarter of a later one. An accounting import refreshes every Open suggestion of the position inside the one promotion write (`promoteQuarterlyPerformance`), whoever approves it; so do a valuation `lock` and `reopen`. A cash flow approved later derives nothing by itself: the next approval for the position, or `accept`, finds it. Two derivations racing for one position and quarter end with one of them refused: 409, "Another approval for this position and quarter is in progress. Try again."

**What a run did.** `GET /valuation-suggestions?extractionRunId=` answers the suggestions that run produced and `runOutcome`: `opened`, `replaced`, `unchanged` (the Open suggestion already says the same), or `none` with the "none when" rule that applies. A run with no suggestion of its own has no stored outcome: the answer is the decision a derivation would take now, read under the caller's own access and writing nothing.

**At accept.** `accept` and `applyToDraft` lock the row and derive again. If the basis, the value or an input differs, or no suggestion applies any more, the suggestion is superseded, any replacement is written, the transaction commits and the answer is 409, "The figures behind this suggestion changed. It has been replaced or closed." With the flag `valuation.suggestions` off nothing is derived and both commands answer 409; reads and `dismiss` still work.

**The commands** (`POST /valuation-suggestions/{id}/commands`, operations, idempotent, `If-Match` on the suggestion's row version). A command takes the advisory lock of the position and quarter, then the row. In the order it answers: 404 for a suggestion the caller cannot see; 412 for a stale `If-Match`; 409 for a command the state does not allow (a decided suggestion); 409 while the switch is off (`accept` and `applyToDraft`); 409 once the figures have moved; 422 for a precondition, in the valuation workflow's words (no value, a version already in progress, no Draft open). The Draft's inputs take the keys `suggestion.id`, `.basis`, `.value`, `.periodEnd`, `.documentId`, `.page`, `.runId`, `.input.<key>` for each input and `.crossCheck.<basis>` for each other source with a value, as text, in place of any an earlier suggestion left. A Draft can take a second suggestion after the first: both stay Accepted on it and the source reviewers of both are barred.
