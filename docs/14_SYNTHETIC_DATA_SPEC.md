# 14: Synthetic Data Specification (`tools/synthetic`)

The prototype's realism depends on this generator. It must produce data that **looks and misbehaves like real private equity data** while containing nothing real.

## 1. Principles
- **Deterministic:** same seed, same output (`--seed 42` default). Tests depend on it. Business timestamps are derived from the dataset's own dates, never the wall clock (valuation approvals at period end plus 40 days, realization outlooks at noon UTC on the last quarter end before the as-of date), and the seed loader writes them. The housekeeping columns (`created_at`, `updated_at`, the history tables' `at`) still take the database clock at load time; no API response, report or recording reads them, so recordings are the same on every build.
- **Fictional only:** names from generated word lists (for example "Harborlight Capital", "Saltmarsh Holdings"). A check fails the build if any generated name matches the local deny-list (`docs/10`).
- **Internally consistent:** cash flows, NAVs, valuations and financials reconcile unless a scenario deliberately breaks them. A position whose first sponsor mark comes after the quarter it was entered in is carried at cost (a Locked mark, method cost, at the entry quarter end), the usual policy until the sponsor reports, so the NAV series (`docs/08` section 2) has no unmarked quarter at entry. Quarterly highlights are written from each quarter's own figures against the quarter before (revenue change, EBITDA margin, net debt), so a highlight never contradicts the numbers beside it, and they take no random draws.
- **Scenario-tagged:** every deliberate defect has a scenario tag so tests can find it.

## 2. Volumes (default profile)
| Entity | Count |
|---|---|
| Sponsors | 40 (tiers mixed) |
| Sponsor funds | 90 |
| Firm vehicles | 7 (3 co-invest, 1 CV fund, 1 primary program / fund of funds, 1 private credit, 1 client SMA) |
| Clients | 3, each with different reporting bases |
| Investments | 160 active + 40 realized (about 25 of the active positions are private credit) |
| Quarterly periods | 12 per active investment (with gaps by scenario) |
| Commitments | Vehicle-to-fund commitments for every fund of vintage 2014 or later from the primary program, plus client-directed commitments from the separate account (about 150 in the default profile, including the same fund held both pooled and client-directed); LP commitments: every client in at least two vehicles, one client joining at a second closing |
| Contacts | 600; interactions 8,000 (generated with the relationship module in Phase 5) |
| Capital notices | About 900 in the default profile (calls, distributions, interest and principal notices, an equalization sequence); each approved cash flow points at its notice |
| Documents | 300 synthetic PDFs + 50 XLSX ops workbooks (generated with the document hub in Phase 2) |
A `small` profile (20 investments) exists for fast unit tests.

## 3. Required scenarios (each tagged)
| Tag | Defect or edge case |
|---|---|
| `units_millions` | Report states values in millions; another in thousands |
| `missing_prior_year` | Exact prior-year quarter absent; a nearer quarter exists (must not be used) |
| `period_end_shift` | Quarter end on a non-calendar date within tolerance |
| `forward_entry_snapshot` | Entry snapshot dated after the reporting date |
| `negative_ebitda` | Ratios must return null |
| `near_miss_names` | Two companies with very similar names, configured as a match guard |
| `two_clients_one_fund` | Same sponsor fund held by two clients |
| `restatement` | Prior quarter financials restated by the sponsor |
| `stale_valuation` | NAV rolled forward, needs footnote |
| `qtd_ytd_basis` | Data that produces wrong QTD if computed from beginning of year |
| `roll_forward_break` | Missing starting NAV causing a roll-forward failure |
| `sign_flip` | Gain reported as loss in a draft |
| `wire_change` | Capital call with changed bank details and urgency language |
| `equalization` | Call issued before the matching equalization distribution |
| `injection_doc` | PDF containing text instructing the AI to change values or reveal data |
| `walled_deal` | Deal visible only to a named wall |
| `duplicate_doc` | Same PDF delivered twice with different file names |
| `untagged_doc` | Document with no useful filename or metadata |
| `late_financials` | Expected document never arrives |
| `multiple_irr` | Cash flows with more than one IRR root |
| `pik_toggle` | Credit position switches part of its coupon from cash to PIK mid-life |
| `covenant_breach` | Interest coverage falls below the covenant level; waiver recorded next quarter |
| `credit_amortization` | Scheduled principal paydowns reduce par on each payment date |
| `credit_prepayment` | Full repayment before maturity with a call premium |
| `lp_second_closing` | Client commits to a vehicle at a later closing; ownership percentages change and an equalization notice follows |

## 4. Synthetic documents
- Generated with a PDF library from templates that imitate common sponsor report layouts (letter page, financial summary table, portfolio table, footnotes), plus scanned-style variants (rasterized pages) to test OCR paths.
- Each document has a sidecar `*.truth.json` with the exact expected extraction (values, units, pages), used by evals.

## 5. Synthetic mail and calendar
JSON fixtures shaped like Microsoft Graph message and event objects (metadata + body), including personal, privileged and automated messages that must be filtered out.

## 6. Accounting exports (M2 accounting-import)
`accountingExport(dataset, { scenario })` in `tools/synthetic` writes the generic export of `config/accounting_layout.json`: one row per active equity or CV position for the latest quarter end on or before the as-of date, with the Locked fair value for that quarter, in the layout's column order. A sponsor that closes its books a few days off the quarter end (`period_end_shift`) is exported with its own period end, as the accounting system writes it, so the import's aligned-quarter path is exercised. Three scenarios, each deterministic:
- `clean`: every row matches the record, so an import stages only unchanged rows.
- `update`: one position restated (EBITDA down 4%, revenue up 2%) and the quarter the `missing_prior_year` scenario left out supplied from its neighbours, the rest unchanged.
- `defects`: update plus one row per defect the validation rules exist for: an unknown investment number, a near-miss company name with no number, a name on the match guard list, a duplicate row, revenue entered in millions, a fair value that does not tie to the Locked mark, a period end two weeks off the quarter (flagged by `TYPE-03`: a person confirms which quarter it reports for, it is never bulk-approved), a quarter before entry (built from the walled position, so the wall tests have a hidden flagged row), and a private credit position in an equity export. The rows changed in place are picked by position, never the walled position's.
The export reports what it carries (`expectations`: changed and added investment numbers, flagged rows by rule, and `walled`, the row numbers of the walled position's rows), so the API tests and the preview walkthrough assert against it rather than against hand-counted rows or the generator's tagging order.

## 7. Commands
```
pnpm synth --profile default --seed 42 --out .synthetic/
pnpm db:seed:synthetic           # loads .synthetic into the local DB
pnpm synth:verify                # consistency checks + deny-list scan
pnpm synth:exports --profile small --seed 42 --out .synthetic/accounting/in   # the three sample exports for the drop folder
```
`.synthetic/` is gitignored; only the generator code is committed.

## 8. The Phase 1 intake sources (M2 weekly-report-intake, lookthrough-reconcile, ops-drop-import)
Three more sources, each deterministic and each in the same three scenarios as the accounting export (`clean`: every row agrees with the record; `update`: a few rows deliberately moved; `defects`: update plus one row per rule the intake exists to catch), reporting what they carry (`expectations`) so tests assert against the generator rather than hand counts. They fill the drop folders under `PB_DROP_ROOT` (`.synthetic/drops` by default) and are read by the adapters of decision 0010.
- **Weekly values CSV** (`weekly/in`): columns `InvestmentNumber`, `CompanyName`, `ReportDate`, `ReportedValue`, one row per active position for the latest week on or before the as-of date, the value moved from the Locked mark by a small, seeded amount. `update` moves a few positions past `intake.weeklyVarianceThresholdPct`; `defects` adds an unknown number, a name-only row with a near miss, a guarded name, a duplicate row, a value that is not a decimal, a report date that is not a day and a report date older than `intake.weeklyStaleDays`, plus the walled position's row.
- **Look-through extract JSON** (`lookthrough/<asOf>.json`): an array of `ExposureRow` (`investmentNumber`, `companyName`, `sector`, `geography`, `exposureAtCost`, `exposureAtNav`, `asOf`) with the provider's plain labels of `config/lookthrough_mapping.json`. `clean` maps and ties for every row; `update` changes a sector label and moves an exposure past the tolerance; `defects` adds the deliberately unmapped label `Other`, an exposure off by more than `intake.lookthroughCostToleranceUsd`, an unknown number and a near-miss name, so the reconcile opens one exception per difference.
- **Ops-drop workbook** (`ops-drop/in`, template `quarterly-figures`): sheets `Figures` and `Notes`, the `Figures` header of `config/ops_drop_templates.json`, one row per position for the latest quarter, the same figures as the accounting export so a matched workbook stages the same rows. `defects` includes a workbook whose header differs by one cell (an unknown template, refused) beside the usual row defects.
