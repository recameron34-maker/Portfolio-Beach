# @pb/synthetic

Deterministic synthetic private equity data per `docs/14_SYNTHETIC_DATA_SPEC.md`. Same seed, same bytes. Every name is assembled from fictional word lists; the local deny-list (`config/local/denylist.txt`, never committed) is scanned by `synth:verify` so a collision with a real name fails the build.

```bash
pnpm synth --profile small --seed 42 --out .synthetic/      # 20 investments, fast
pnpm synth --profile default --seed 42 --out .synthetic/    # 200 investments (160 active, 40 realized)
pnpm synth:verify --in .synthetic/dataset.json              # consistency, scenario coverage, deny-list
pnpm db:seed:synthetic .synthetic/dataset.json              # load into the local database
pnpm synth:exports --profile small --seed 42 --out .synthetic/accounting/in   # the three accounting exports
pnpm synth:drops --profile small --seed 42 --root .synthetic/drops            # the weekly and look-through drops
```

`.synthetic/` is gitignored; only the generator is committed.

## What it produces
The dataset follows the contract in `packages/db/src/seed.ts` (`syntheticDatasetSchema`): users (one or more per role, with client entitlements for investor relations), sponsors and funds with aliases, portfolio companies and holdings, seven firm vehicles (three co-invest funds, a CV fund, the primary program, a private credit vehicle and a client separate account), three clients with LP commitments whose ownership sums to 100% per closed vehicle, vehicle-to-fund commitments (including a fund held both pooled and client-directed), investments across co-invest, CV and private credit, entry snapshots and quarterly operating data, credit terms and credit metrics, locked valuation versions, capital notices with the cash flows they created, realization outlooks, match guards and a wall.

The generator's output (`GeneratedDataset`) also carries `companyAliases` (`{ id, portfolioCompanyId, alias }`, `core.company_alias`): about a third of the companies get one or two names an outside file is likely to use, a shortened form ("Meridian Data" for "Meridian Data Partners") or an abbreviation ("MDP"). No alias equals or near-misses another name on record by the validation library's own rule, none is a stem two names share (a prefix of another name on record, or another company's shortened or abbreviated form, since an exact match on it would be ambiguous), a company on the match guard list gets none, and the first active equity position outside the wall always has one, so every sample drop has a row that links by alias. The aliases draw from their own seeded stream, so adding them moved no other value. A seed schema from before the alias table strips the field on parse; a later one inserts it.

Internal consistency: cash flows reconcile to entry cost and exits, valuations derive from the operating data and the vehicle's ownership share, every locked valuation has a hash and an approver different from the preparer, and every child row points at a real parent.

## Sample intake sources (docs/04 M2)
Each source is a pure function of the dataset, byte-identical for a seed, in three scenarios (`clean`, `update`, `defects`) and reports what it carries (`expectations`), so tests and the preview assert against the generator rather than hand counts. Every threshold is read from `config/definitions.json` (`intake`) through `settings.ts`; a key the file does not carry yet takes the value docs/04 names.

- `accountingExport` (`accounting-export.ts`): the generic export of `config/accounting_layout.json`, `pnpm synth:exports`.
- `weeklyValues` (`weekly-values.ts`): `weekly-values-<reportDate>-<scenario>.csv`, columns `InvestmentNumber, CompanyName, ReportDate, ReportedValue`, one row per active equity or CV position with a Locked mark on or before the report date, the value equal to that mark. A row's prior is the latest Locked mark on or before the report date, never a mark locked for a later date (a report dated 2025-06-27 compares with the 2025-03-31 mark, not the 2025-06-30 one), and the weekly intake computes its prior the same way. The report date is the Friday on or before the as-of date by default; `reportDate` may name any day from `intake.weeklyStaleDays` before the as-of date up to the as-of date, and another throws. `update` moves three positions inside `intake.weeklyVarianceThresholdPct`; `defects` adds one row per rule (`WK-BOUND-01` in place, then `WK-XREF-01` twice, `WK-DUP-01`, `WK-REQ-01`, `WK-TYPE-02`, `WK-TYPE-04` and `WK-RANGE-01` each on its own day inside that window, `WK-TYPE-01`, `WK-STALE-01` on a Friday more than `intake.weeklyStaleDays` before the as-of date, and `WK-PERIOD-01` on the Friday after the as-of date, built from the walled position). Written to `<root>/weekly/in`.
- `lookthroughExtract` (`lookthrough-extract.ts`): `ExposureRow[]` in the provider's vocabulary (`PROVIDER_LABELS` maps the taxonomy codes onto its labels; `Other` is the deliberately unmapped sector), one row per active position with exposure at cost (invested capital, as the API computes it) and at NAV (the latest Locked mark on or before the as-of date). `update` moves three NAVs inside `intake.lookthroughNavTolerancePct`; `defects` adds a NAV and a cost beyond their tolerances, an unmapped and a wrong sector label, an unknown number, a near miss, a duplicate and an as-of a quarter old (built from the walled position). Written to `<root>/lookthrough/<asOf>.json` and `<asOf>-defects.json`.
- `opsDropSheets` (`ops-drop.ts`): the `Figures` and `Notes` sheets of the `quarterly-figures` workbook template, the accounting export's rows under the template header, plus an `unknown-template` scenario whose header differs in one cell so the import refuses it. The XLSX writer wraps the sheets into a file in a later step; nothing is written by the CLI yet.

In `weeklyValues` and `lookthroughExtract` one row carries one of the company's aliases and no number (`expectations.aliased`); the accounting export and the ops-drop sheets carry no alias row. In every source the walled position's rows are listed in `expectations.walled`.

## Scenario tags
`dataset.scenarios` maps each tag to the ids that carry it. Data-level tags (all present in every profile): `missing_prior_year`, `period_end_shift`, `forward_entry_snapshot`, `negative_ebitda`, `near_miss_names`, `two_clients_one_fund`, `restatement`, `stale_valuation`, `roll_forward_break`, `wire_change`, `equalization`, `walled_deal`, `multiple_irr`, `pik_toggle`, `covenant_breach`, `credit_amortization`, `credit_prepayment`, `lp_second_closing`.

Document-level tags (`units_millions`, `qtd_ytd_basis`, `sign_flip`, `injection_doc`, `duplicate_doc`, `untagged_doc`, `late_financials`) arrive with the synthetic PDF generator in Phase 2; contacts, interactions and mail fixtures arrive with the relationship module in Phase 5.
