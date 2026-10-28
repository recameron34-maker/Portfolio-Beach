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

## 2. Staging records (`stg.*.status`)
new > validated | flagged; flagged > validated (after edit) | rejected; validated > approved (reviewer) > promoted (system, single transaction). rejected is terminal.

## 3. Capital notice and funding
| State | Next | Notes |
|---|---|---|
| Received | Extracted | Document indexed |
| Extracted | Reviewed | Human checks amounts and dates; bank fields never extracted |
| Reviewed | TicketDrafted | Trade ticket created |
| TicketDrafted | TicketApproved | A trade ticket exists; approver differs from preparer; wire instruction verified and unchanged within the hold window |
| TicketApproved | Funded | The ticket is Approved; Operations confirms |
| Funded | Reconciled | Cash Flow row promoted; unfunded recalculated |
Any wire instruction change returns the ticket to TicketDrafted and requires callback verification.
Preconditions added in Phase 3: a ticket can be approved only once a trade ticket record exists (`draftTicket` creates it; the instruction it is approved against follows section 11), and funding is confirmed only against an Approved ticket (SEC-12.3).

## 4. Deal stage (`deal.opportunity.stage`)
Sourced > Screening > Prescreen > Diligence > IC > Approved > Closing > Closed. Any stage > Passed (reason code required). Diligence > IC requires required tasks done (or audited override). Closing > Closed requires the closing checklist complete and allocation tie-out (M22). Passed > Screening allowed (reopen) with reason.
Precondition added in Phase 3: Approved > Closing requires the closing record ready, a close date and a commitment amount given with the command (docs/04 M8); the command opens the closing of section 12 and its checklist from `config/closing_checklist.json`.

## 5. Reporting package (`rpt.package.state`)
Draft > Generated > QAFailed | QAPassed; QAFailed > Generated (after fix); QAPassed > InReview > Approved > Released. Released is immutable; corrections create a new package version with a reason.

## 6. Document classification
Received > Classified (confidence >= threshold) | NeedsReview; NeedsReview > Classified (human). Duplicate (same hash) > linked to the original, not reprocessed.

## 7. Extraction run
Queued > Running > Succeeded | Failed | NeedsRetry; NeedsRetry > Running (max 1 automatic retry for schema failure, 3 for transient errors); Failed is surfaced as a Data Exception.

## 8. Deal change request
Submitted > Routed > InProgress > Applied | Rejected; quarter-end job lists any not Applied.

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
| Proposed | Verified | Operations, Approver (not the proposer) | Callback to an independently sourced number confirmed the instruction; the call is logged with date, number source and result |
| Proposed | Rejected | Operations, Approver | Reason required |
| Verified | Superseded | System actor, Operations | A newer Verified version exists for the counterparty |
Rejected and Superseded are terminal; a corrected instruction is a new Proposed version. One active version per counterparty, always Verified. A new version proposed for a counterparty whose notice has an approved ticket fires `wireChanged` on that notice (section 3).

## 12. Closing (`deal.closing.state`, M8)
| From | To | Who | Preconditions |
|---|---|---|---|
| (new) | Open | Deal Team, Operations | Created when the opportunity advances Approved > Closing with a close date and a commitment (section 4); checklist items from `config/closing_checklist.json` |
| Open | OpsConfirmed | Operations | Every required checklist item received or waived; allocations tie to the closing commitment (M22) |
| OpsConfirmed | Open | Operations | Reason required; the close date change is audited and the closing needs confirmation again |
No state is terminal. The close date on the closing record is the single source for every report (docs/04 M8). The opportunity's Closing > Closed step (section 4) reads its checklist and tie-out gates from this record.
