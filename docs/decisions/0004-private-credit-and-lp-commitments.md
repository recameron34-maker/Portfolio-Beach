# 0004: Private credit positions and the two-layer commitment model
- **Status:** Accepted
- **Date:** 2026-10-07
- **Deciders:** repo owner
## Context
The team invests on behalf of several clients through pooled vehicles (fund of funds / primary program, co-invest funds, GP-led single-asset CV funds) and also holds private credit positions. The original guide covered co-investments, CVs and primaries, modeled commitments as a single `core.commitment` row keyed by client, vehicle and sponsor fund, and had no credit data or metrics.
## Options considered
1. Treat credit positions as equity investments with extra JSON fields. Simple, but coverage, LTV, PIK and maturity logic would live in untyped JSON and could not be constrained or tested properly.
2. Separate credit tables (`mon.credit_terms`, `mon.credit_performance`) keyed to the same `core.investment`, with the deal type deciding which monitoring tables apply. (**chosen**)
3. A separate "credit module" with its own investment table. Rejected: it would duplicate linking, documents, valuation and reporting.

For commitments: (a) keep one table and overload it, or (b) split into `core.commitment` (vehicle to sponsor fund, optional client for SMA) and `core.lp_commitment` (client to vehicle, with ownership percentage). (**b chosen**)
## Decision
- Investment deal types: `co_invest_equity`, `cv_single_asset`, `cv_multi_asset`, `primary_fund`, `private_credit`. Vehicle types: `co_invest`, `cv`, `primary_program`, `private_credit`, `client_sma`.
- Credit terms and per-period credit metrics in their own tables (`docs/03`); credit formulas in `docs/08` section 10; credit scenarios in `docs/14`; credit UI rules in `docs/06`.
- Client views are a look-through of vehicle positions by `lp_commitment.ownership_pct`, computed at read time. Positions are stored once.
- Cash flow types gain `principal`; PIK capitalization changes par and is never a cash flow.
## Consequences
Phase 0 schema and the synthetic generator include the credit tables and LP commitments from the start. Reporting and analytics modules must branch on deal type. Ownership percentages that do not sum to 100% after a final close surface as data exceptions rather than silently misallocating.
## SEC IDs affected
SEC-2.1 (new Restricted columns classified), SEC-5.2 (client entitlements now key off `lp_commitment`), SEC-9.6 (new calculations under golden tests)
## Verification
Formulas follow standard private credit practice (current yield, YTM as XIRR of contractual flows, coverage and leverage through the tranche, LTV, DSCR). Each has a golden fixture and null-case tests in `packages/calc` and the Python cross-check.
