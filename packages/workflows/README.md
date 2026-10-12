# @pb/workflows

Typed transition tables for every state machine in `docs/18_WORKFLOWS_AND_STATE_MACHINES.md`: valuation, staging records, capital notice and funding, deal stage, reporting package, document classification, extraction run, deal change request and data exception.

- `attempt(machine, from, command, ctx)` is pure. It returns the next state or a typed refusal (`forbidden`, `role`, `precondition`). The API persists the state, writes `audit.event` and emits the outbox event; tests call the same function.
- `forbiddenPairs(machine)` enumerates every (state, command) pair the table does not list, and the test suite rejects each one even for an actor holding every role.
- Preconditions encode segregation of duties (preparer never approves), required reasons, the IC gate with an audited Approver override, the closing checklist and allocation tie-out, and the wire controls on trade tickets.
- `requireReason` is used as the precondition itself where a reason is all a transition needs (send back, reopen, reject, resolve, wont_fix), so the web's `commandOptions` can tell the page to ask for one.

Changing a workflow means changing the table and `docs/18` together; the generated tests fail on any transition that one has and the other lacks.
