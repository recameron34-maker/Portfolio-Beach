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
| TicketDrafted | TicketApproved | Approver differs from preparer; wire instruction verified and unchanged within the hold window |
| TicketApproved | Funded | Operations confirms |
| Funded | Reconciled | Cash Flow row promoted; unfunded recalculated |
Any wire instruction change returns the ticket to TicketDrafted and requires callback verification.

## 4. Deal stage (`deal.opportunity.stage`)
Sourced > Screening > Prescreen > Diligence > IC > Approved > Closing > Closed. Any stage > Passed (reason code required). Diligence > IC requires required tasks done (or audited override). Closing > Closed requires the closing checklist complete and allocation tie-out (M22). Passed > Screening allowed (reopen) with reason.

## 5. Reporting package (`rpt.package.state`)
Draft > Generated > QAFailed | QAPassed; QAFailed > Generated (after fix); QAPassed > InReview > Approved > Released. Released is immutable; corrections create a new package version with a reason.

## 6. Document classification
Received > Classified (confidence >= threshold) | NeedsReview; NeedsReview > Classified (human). Duplicate (same hash) > linked to the original, not reprocessed.

## 7. Extraction run
Queued > Running > Succeeded | Failed | NeedsRetry; NeedsRetry > Running (max 1 automatic retry for schema failure, 3 for transient errors); Failed is surfaced as a Data Exception.

## 8. Deal change request
Submitted > Routed > InProgress > Applied | Rejected; quarter-end job lists any not Applied.

## 9. Implementation notes
- Model each machine as a typed transition table in `packages/workflows` shared by API and tests.
- Long-running flows (capital notice, extraction batches, report generation) run in the workflow engine with durable timers for reminders (T-3, T-1, due date).
