# @pb/synthetic

Deterministic synthetic private equity data per `docs/14_SYNTHETIC_DATA_SPEC.md`. Same seed, same bytes. Every name is assembled from fictional word lists; the local deny-list (`config/local/denylist.txt`, never committed) is scanned by `synth:verify` so a collision with a real name fails the build.

```bash
pnpm synth --profile small --seed 42 --out .synthetic/      # 20 investments, fast
pnpm synth --profile default --seed 42 --out .synthetic/    # 200 investments (160 active, 40 realized)
pnpm synth:verify --in .synthetic/dataset.json              # consistency, scenario coverage, deny-list
pnpm db:seed:synthetic .synthetic/dataset.json              # load into the local database
```

`.synthetic/` is gitignored; only the generator is committed.

## What it produces
The dataset follows the contract in `packages/db/src/seed.ts` (`syntheticDatasetSchema`): users (one or more per role, with client entitlements for investor relations), sponsors and funds with aliases, portfolio companies and holdings, seven firm vehicles (three co-invest funds, a CV fund, the primary program, a private credit vehicle and a client separate account), three clients with LP commitments whose ownership sums to 100% per closed vehicle, vehicle-to-fund commitments (including a fund held both pooled and client-directed), investments across co-invest, CV and private credit, entry snapshots and quarterly operating data, credit terms and credit metrics, locked valuation versions, capital notices with the cash flows they created, realization outlooks, match guards and a wall.

Internal consistency: cash flows reconcile to entry cost and exits, valuations derive from the operating data and the vehicle's ownership share, every locked valuation has a hash and an approver different from the preparer, and every child row points at a real parent.

## Scenario tags
`dataset.scenarios` maps each tag to the ids that carry it. Data-level tags (all present in every profile): `missing_prior_year`, `period_end_shift`, `forward_entry_snapshot`, `negative_ebitda`, `near_miss_names`, `two_clients_one_fund`, `restatement`, `stale_valuation`, `roll_forward_break`, `wire_change`, `equalization`, `walled_deal`, `multiple_irr`, `pik_toggle`, `covenant_breach`, `credit_amortization`, `credit_prepayment`, `lp_second_closing`.

Document-level tags (`units_millions`, `qtd_ytd_basis`, `sign_flip`, `injection_doc`, `duplicate_doc`, `untagged_doc`, `late_financials`) arrive with the synthetic PDF generator in Phase 2; contacts, interactions and mail fixtures arrive with the relationship module in Phase 5.
