# 14: Synthetic Data Specification (`tools/synthetic`)

The prototype's realism depends on this generator. It must produce data that **looks and misbehaves like real private equity data** while containing nothing real.

## 1. Principles
- **Deterministic:** same seed, same output (`--seed 42` default). Tests depend on it.
- **Fictional only:** names from generated word lists (for example "Harborlight Capital", "Saltmarsh Holdings"). A check fails the build if any generated name matches the local deny-list (`docs/10`).
- **Internally consistent:** cash flows, NAVs, valuations and financials reconcile unless a scenario deliberately breaks them.
- **Scenario-tagged:** every deliberate defect has a scenario tag so tests can find it.

## 2. Volumes (default profile)
| Entity | Count |
|---|---|
| Sponsors | 40 (tiers mixed) |
| Sponsor funds | 90 |
| Firm vehicles | 6 (3 co-invest, 1 secondaries/CV, 1 primary program, 1 client vehicle) |
| Clients | 3, each with different reporting bases |
| Investments | 160 active + 40 realized |
| Quarterly periods | 12 per active investment (with gaps by scenario) |
| Commitments | 420 (including the same fund held by two clients) |
| Contacts | 600; interactions 8,000 |
| Capital notices | 900 (calls, distributions, equalization sequences) |
| Documents | 300 synthetic PDFs + 50 XLSX ops workbooks |
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

## 4. Synthetic documents
- Generated with a PDF library from templates that imitate common sponsor report layouts (letter page, financial summary table, portfolio table, footnotes), plus scanned-style variants (rasterized pages) to test OCR paths.
- Each document has a sidecar `*.truth.json` with the exact expected extraction (values, units, pages), used by evals.

## 5. Synthetic mail and calendar
JSON fixtures shaped like Microsoft Graph message and event objects (metadata + body), including personal, privileged and automated messages that must be filtered out.

## 6. Commands
```
pnpm synth --profile default --seed 42 --out .synthetic/
pnpm db:seed:synthetic           # loads .synthetic into the local DB
pnpm synth:verify                # consistency checks + deny-list scan
```
`.synthetic/` is gitignored; only the generator code is committed.
