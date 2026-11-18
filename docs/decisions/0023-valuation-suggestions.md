# 0023: Valuation suggestions from capital account statements and sponsor reports

- **Status:** Accepted for the prototype, as a first draft for the owner to change
- **Date:** 2026-11-18
- **Deciders:** repo owner (asked for it); built in Claude Code

## Context

The owner asked: "I also would like to find a way to have the site read PCAP statements and financial statements and suggest valuation updates as they come in." And then: "We get company specific PCAP as well, which relate specifically to co-investments. (WE do also get fund PCAPs for our fund commitments)".

A capital account statement is therefore one of two kinds:

- **Position-level:** the sponsor's vehicle reports our capital account for one co-investment or continuation vehicle position. Its ending balance is the sponsor's stated value of our interest, so it is the first source for that position's mark, ahead of the company's financial statements.
- **Fund-level:** our account in a fund we committed to. A commitment has no valuation record today, so these are read and reviewed and raise no suggestion until the owner says how a commitment carries a mark (the first question below).

What the platform already held: extraction runs with their review, schemas, prompts and the prototype extractor; the valuation workflow with its Draft create and edit; the promotion of quarterly figures; the calculations for a value change, a quarter's gain net of flows and a NAV roll-forward; the valuation board's variance rule; and capital account statements that were generated, indexed and classified, with no extraction schema.

Four rules of the build guide shape the design. Every write to a core financial table goes through staging and a person's approval, and an agent never writes a production record (rule 5). A number is never invented, and a missing input is never replaced by the nearest period (rule 10). Thresholds are configuration (rule 9). Financial math is specified and tested before anything uses it (rule 12).

## Options considered

1. **What a suggestion is.** A row of `stg.valuation` (it belongs to an intake file, is keyed on a report date and an investment number, follows the staging states and cannot be replaced by a better source), or a record of its own with its own machine (chosen): `mon.valuation_suggestion`, which a person turns into a draft valuation, puts on the Draft already open, or dismisses.
2. **Which source gives the mark.** A blend of the sources, or one source in a configured order with the others beside it as cross-checks (chosen). A blend hides which document a mark came from; a cross-check shows a disagreement.
3. **What the kind of a statement is.** A field a person sets, a second document type and schema, or the link the document already carries (chosen): linked to a position it is position-level, linked to none it is fund-level. One type, one schema, one review page.
4. **A statement that does not tie, or whose contributions differ from the record.** Hold the value back until someone explains it, or suggest it with a flag (chosen). The person deciding sees the flag in the list, in the workings and in the confirmation.
5. **A report-based mark when cash has moved since the last Locked mark.** Roll the scaled mark forward by the flows, or say it is not calculable (chosen). Scaling assumes our share of the company is unchanged, and a flow since the mark is the usual way that stops being true.
6. **Who may approve a valuation that came from a suggestion.** Name the people who stood behind its figures, or bar them from both approvals (chosen).

## Decision

**The record.** One new table, `mon.valuation_suggestion` (migration 0023): the position and the calendar quarter end, the basis (`capital_account_balance`, `sponsor_equity_value` or `held_multiple`), the method a draft would carry, a value above zero or a reason code (exactly one), the workings (each input with the document page, the reviewer, the record or the Locked mark it came from), the approved run and its document, the source reviewers, and what became of it (Open, Accepted, Dismissed, Superseded). One Open suggestion per position and quarter. Its figures never change: a new suggestion replaces it. No existing table changes, so the accounting import and export read what they read before. Also the method `valuation_method.report_indication` ("Indication from sponsor report") and the switch `valuation.suggestions`, on.

**The calculation** is `docs/08` section 12, in `@pb/calc` (`suggestion.ts`), with golden fixtures 29, 30 and 31 (the last for which marks and flows count), property tests and the Python cross-check, written before anything used it:

- 12.1, a statement: the ending capital balance, times our share when the lines are the whole vehicle's. Two checks change neither the value nor the order of sources: whether the statement's own lines add up, within a tolerance for the unit they were read in, and whether its contributions to date agree with the approved contributions on record.
- 12.2, a sponsor report: the last Locked mark of an earlier quarter, scaled by the change in equity value (enterprise value less net debt) between that quarter and the new one.
- 12.3, a report with no enterprise value: the new EBITDA at the earlier quarter's multiple, then 12.2.
- 12.4, the comparison with the mark on record, with the board's variance flag and no other, and the gain net of flows where the statement allows it.
- 12.5, the cross-check of another source against the suggested value. Nothing is averaged.

A missing input gives a reason and no value: never a zero, never another quarter's figure.

**Sources and their order** (`valuationSuggestions.sourceOrder` in `config/definitions.json`): a position-level statement's ending balance, then the report's equity value, then the multiple held. The first with a value is the suggestion; if none has one, the first on hand gives the reason. The report on hand is the approved quarter on record; the run behind it supplies the page or the reviewer of a figure, never another value.

**When it is derived** (`docs/18` section 14). In the transaction that approves a statement or a report run, as the system actor, behind an advisory lock on the position and quarter. A statement approved while a report-based suggestion is Open replaces it; a report approved after a statement changes only the cross-check; of two approved statements for a quarter the later counts. Open suggestions are derived again, and none is created, when an accounting import is promoted, when a valuation is locked or reopened, and before accept and applyToDraft write anything. One whose figures have moved is replaced or closed, and the command answers 409.

**When none is raised:** a statement linked to no position, or a primary fund position (our account in a fund commitment); a private credit position; a position not held in US dollars; a position not held at the period end; a Locked mark for the quarter or a later one; the same value from the same source already dismissed, or already on a valuation in progress or Locked.

**Who does what.** Operations opens a draft valuation from a suggestion, puts its value and method on the Draft already open for the quarter (the Draft keeps its date), or dismisses it with a reason, through `valuationSuggestionMachine`. The deal team, approvers and auditors read. Viewers, investor relations and platform admins get nothing: no request is sent for them. A suggestion carries its position's wall.

**A suggestion never writes a mark.** Accept and applyToDraft go through the two writes the valuation workflow already makes (the Draft create and the Draft edit), so the Draft is prepared, approved and Locked like any other. The Draft's inputs carry flat `suggestion.` keys that say which suggestion, which inputs and which other sources stood behind the value; a create or an edit sent by a person can neither forge, change nor drop them, so the lock hash seals them with the mark. Whoever approved a run behind an accepted suggestion, or typed one of its figures, can take neither approval of that valuation (a new precondition of `valuationMachine`). The rule follows the mark: it reads every Accepted suggestion whose valuation is a version of the same investment and quarter, so the Draft a reopen starts with the same mark bars the same people.

**Four guards, before any statement could be extracted.** A position-level statement no longer fills a fund's expected-document row. The monitoring board shows the newest run of a schema that writes to the quarterly record, not a statement's. Approving a run whose schema has no record figure promotes nothing and leaves the quarter, its approver and its lineage untouched. A statement that names a position which does not link to exactly one, or whose reference and company name disagree, goes to the review queue for a person, whatever the classifier's confidence.

**Extraction.** The schema `capital_account_statement` and the prompt `capital_account_extraction`: the period end, four commitment lines, the five balance lines of our account and our share of the vehicle. The task text keeps a whole-vehicle balance with no share, and a statement not in US dollars, from being read as ours. Only the prototype extractor has been measured on statements.

**The API.** `GET /api/v1/valuation-suggestions` (Open by default, filters by state, position, quarter and the run that produced them, and what a run's approval did), `GET /api/v1/valuation-suggestions/{id}` and `POST /api/v1/valuation-suggestions/{id}/commands` (operations; idempotent; reads `If-Match`).

**The pages.** A Suggestions tab in the Valuations area with the list, the workings (the rule in a sentence, each input with its source and the page it was read from, the two checks, the other sources of the quarter) and the decisions with their confirmations; a Suggested column on the board's Missing marks card; a Suggested mark panel on the deal's Valuations tab; a line on the version screen and read-only keys in its edit form; what the approval did, on the extraction run page; what a held statement asks of the reviewer, in the review queue.

**The static preview** records nothing: a suggestion exists only once a statement or a report is approved in the session. The derivation, the reads and the commands are simulated with the same pure rules (`controls-suggestion.ts` in `@pb/workflows`, `@pb/calc`), including how an approved run and a quarter on record are read; only the reading of the session and the book is the preview's own. The guide has a walkthrough of the example sequence.

**Synthetic data.** Position-level statements for the `stale_valuation`, `roll_forward_break` and walled positions, for the as-of quarter and the one before, built from the dataset's own rows with no new random draw, so no other document and no row moves. On the `stale_valuation` position the as-of report gives a suggestion by 12.2 and the as-of statement replaces it by 12.1, the two under US$ 10,000 apart.

**Left out for now:** suggestions for fund-level statements (question 1), private credit and positions not in US dollars; relinking a classified document (question 9); tracking position-level statements as expected documents (question 7); reading the company name from page one of a real statement (question 8).

## Consequences (security, cost, operations, migration)

- One migration (0023): the table with its history, forced row-level security, the method term and the flag. Nothing is backfilled and nothing existing changes.
- A suggested number can anchor the person preparing the mark. It therefore shows its workings and its source, and its source reviewers cannot approve the valuation it became.
- The new precondition on both approvals and the kept `suggestion.` keys change existing valuation behaviour: an existing valuation names no source reviewers and carries no such key, so its approvals and edits behave as before.
- A wrong statement on a position (a fund statement, a wrong unit) is flagged by the contributions check, the "read as" line on the review page and the Variance badge. None of them blocks.
- A statement classified to the wrong position, or to none, cannot be relinked yet. The run page says so and says what to do: dismiss the suggestion and start the draft on the board.
- Rule 12.2 assumes our share of the company is unchanged since the last Locked mark.
- No outbox event is written, as for the other workflows: no service of the API writes `ops.outbox` yet. Every derivation, replacement, closing and command is in the audit trail.
- No dependency and no new external service. Cross-checks, the comparison and the badges are worked out when a suggestion is read; only the suggestion is stored.
- Log lines carry the outcome, the basis and the reason code, never a figure.

## SEC IDs affected

- SEC-2.1: every column of the table is classified (`restricted_mnpi`, retention `books_and_records`).
- SEC-5.1 and SEC-5.3: forced row-level security; operations, the deal team, approvers and auditors read inside the position's wall; the system actor inserts; operations accepts or dismisses and the system actor supersedes, never the other's decision. A position-level statement, its run and its suggestion are invisible outside the wall, and the API answers 404.
- SEC-5.6: whoever approved a run behind an accepted suggestion, or typed one of its figures, is refused both approvals of that valuation (the state machine and the API; the list is read as the system actor, so the control never passes because the person asking could not read the suggestion).
- SEC-8.4 and SEC-9.4: every input names its source: the document and page, the reviewer who typed it, the quarter on record or the Locked mark. A value nobody accepted or typed is not on hand.
- SEC-8.10: the switch `valuation.suggestions`. Off, nothing is derived and nothing is accepted; open suggestions can still be read and dismissed.
- SEC-9.1: a suggestion is never a mark. A person opens a Draft from it, and the Draft goes through the valuation workflow.
- SEC-9.2: a suggestion's figures never change; it is replaced, and the table carries history.
- SEC-9.3: the keys a suggestion leaves on a Draft are covered by the lock hash.
- SEC-11.1: every derivation, replacement, closing, command and read of one suggestion is in the audit trail, with the state before and after.
- SEC-11.4: logs carry codes, never figures.

## Verification (what was checked, docs/versions consulted)

- `docs/04` (M3, M4, M9, M10), `docs/05`, `docs/08` (sections 2, 5, 6, 7 and 12), `docs/14`, `docs/18` (sections 1, 6, 7 and 14), CLAUDE.md rules 5, 7, 9, 10, 12, 13 and 14.
- The calculation: `packages/calc` `suggestion.test.ts` with fixtures 29 and 30 (the eight worked examples of `docs/08` section 12 by hand, every reason and its precedence), the same in `apps/worker-py` `calc_check`, and the random cross-check with 0 mismatches.
- Each slice (the calculation, the machine and shared rules, the table, the four guards, the schema and documents, the routes, the commands, the pages, the preview, the browser journey) records its own checks in `docs/SESSION_LOG.md`.
- No external API or fast-moving service is called: nothing outside the repository was consulted.

## Open for the owner

Each is built with the default named here and can change:

1. **How does a fund commitment carry a mark?** It does not yet, so a fund-level statement is read and reviewed and raises no suggestion. Recommended: a position per commitment (deal type primary fund, as closing a primary fund deal already creates), kept out of the company-level exports and report sets; rule 12.1 then applies as written. The alternative, a valuation on the commitment, changes `mon.valuation`, which the accounting export reads.
2. **Order of sources.** Statement, then the report's equity value, then the multiple held: one list in config. The two report rules are a draft set. Equity is enterprise value less net debt; the other choice is the equity a report states.
3. **A statement that does not tie, or whose contributions differ from the record.** Suggested with a flag; the other choice is to hold it back until someone explains it.
4. **Cash flows since the last Locked mark** (report rules). Not calculable; the other choice is to roll the scaled mark forward by the flows.
5. **Method labels.** A statement-based draft carries the existing "Sponsor mark"; a report-based one the new "Indication from sponsor report". The other choice is "Sponsor mark" for both.
6. **Source reviewers.** Refused both approvals; the other choice is to name them and not refuse.
7. **Expected documents.** Position-level statements are not tracked yet; the other choice is one per held co-investment and continuation vehicle position each quarter.
8. **What names a company-specific statement?** Our reference on page one, or the company in the file name, links it; anything else (the sponsor's co-investment vehicle name alone) reads as fund-level or goes to a person. Recommended for real documents: the classifier also reads the company name from page one.
9. **Relinking.** Not built. Recommended next: a command that sends a classified document back to review, with a reason, refused once one of its runs is approved.
10. **Smaller defaults.** No suggestion for a private credit or primary fund position, or one not in US dollars. Operations alone act. An accounting import refreshes suggestions and raises none. Using a value on a Draft keeps the Draft's date. The board's 10% variance flag also decides when two sources differ. The tie tolerances by unit (US$ 2,500 in thousands, 25,000 in millions, 25,000,000 in billions) and the contributions tolerance (2%).
