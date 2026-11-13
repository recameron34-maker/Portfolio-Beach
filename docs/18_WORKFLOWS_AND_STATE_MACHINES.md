# 18: Workflows and State Machines

States are Postgres enums. Transitions happen only through API commands that check role, segregation of duties and preconditions, write `audit.event`, and emit an outbox event. Any transition not listed is **forbidden** and must have a test proving it is rejected.

## 1. Valuation (`mon.valuation.state`)
| From | To | Who | Preconditions |
|---|---|---|---|
| (new) | Draft | Operations | Investment active |
| Draft | OpsPrepared | Operations | Inputs complete; validation passed |
| OpsPrepared | Draft | Operations, Deal Team | Reason required |
| OpsPrepared | DealTeamApproved | Deal Team (not the preparer) | |
| DealTeamApproved | Locked | Approver (not the preparer) | Lock hash computed over inputs + value |
| Locked | Reopened | Operations, Approver | Reason; creates a new version in Draft; alerts prior approvers |
Reports read Locked only. One Locked version per investment and period (unique partial index).
A Draft is the only state that can be edited: operations may correct its method, inputs and fair value (`PATCH /valuations/{id}`, audited as `valuation.edit`, no approval row), which is how a reopened version takes its corrected mark; every other state answers 409. The lock hash is the SHA-256 of the lock text: the investment, the period end, the version, the method, the method inputs (keys sorted at every depth) and the fair value.

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

## 6. Document classification
Received > Classified (confidence >= threshold) | NeedsReview; NeedsReview > Classified (human). Duplicate (same hash) > linked to the original, not reprocessed.

## 7. Extraction run
Queued > Running > Succeeded | Failed | NeedsRetry; NeedsRetry > Running (max 1 automatic retry for schema failure, 3 for transient errors); Failed is surfaced as a Data Exception.

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
