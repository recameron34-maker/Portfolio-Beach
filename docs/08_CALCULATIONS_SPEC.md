# 08: Calculations Specification (`packages/calc`)

All financial math lives in `packages/calc` (TypeScript) and is cross-checked by an independent Python implementation in `apps/worker-py/calc_check`. Every function is pure, deterministic, uses a decimal library (never JS `number` for money), and returns `null` (rendered as the missing placeholder) instead of a misleading value. Each function records `CALC_VERSION` with persisted results.

## 1. Inputs and conventions
- Cash flows: `{date, amount}` from the investor's perspective: contributions negative, distributions positive. Terminal value (NAV) is a positive flow on the valuation date.
- Dates are calendar dates (no time). Day count for XIRR: actual/365 (configurable to actual/365.25).
- Rounding: keep full precision internally; round only for display (`docs/06`). Use round half away from zero at display.

## 2. Return metrics
| Metric | Formula | Returns null when |
|---|---|---|
| Paid-in (PI) | sum of contributions (absolute) | no contributions |
| DPI | distributions / PI | PI = 0 |
| RVPI | NAV / PI | PI = 0 |
| TVPI | (distributions + NAV) / PI | PI = 0 |
| MOIC (gross, deal level) | (realized proceeds + unrealized value) / invested capital | invested = 0 |
| Unfunded | commitment - contributions + recallable distributions | commitment missing |
| Holding period (years) | (exit or as-of date - first contribution date) / 365 | no contribution |

## 3. IRR (XIRR)
- Solve NPV(r) = sum(amount_i / (1 + r)^((d_i - d_0)/365)) = 0.
- Algorithm: Newton-Raphson from 0.1, with **bisection fallback** on [-0.9999, 100] when Newton fails to converge or leaves the bracket. Tolerance 1e-10 on NPV, max 200 iterations.
- Return `null` when: fewer than 2 flows; all flows the same sign; no sign change that yields a root; or multiple roots detected (more than one sign change and NPV sign test finds several brackets). In the multiple-root case, return `{value: null, reason: "multiple_irr"}`.
- Periods under 1 year: report IRR but flag `short_period: true` so the UI can show "NM" per config (`irr.minHoldYearsForDisplay`).
- Gross vs. net is a label on inputs, not a different algorithm.

## 4. Operating metrics
| Metric | Formula | Null when |
|---|---|---|
| EV/EBITDA | EV / EBITDA (LTM) | EBITDA <= 0 or missing |
| Net debt/EBITDA | net debt / EBITDA | EBITDA <= 0 or missing |
| EBITDA margin | EBITDA / revenue | revenue <= 0 or missing |
| YoY growth | current / prior_same_quarter - 1 | prior missing or prior <= 0 |
| Growth since entry | current / entry_snapshot - 1 | entry snapshot missing or <= 0 |
| Entry vs current multiple delta | current EV/EBITDA - entry EV/EBITDA | either side null |

## 5. Period selection rules
- **Same quarter prior year:** fiscal quarter and fiscal year minus one; match on quarter, tolerating period-end dates up to 7 days apart (config). Never fall back to the nearest available period.
- **Latest period:** the most recent period with **approved** data, ignoring entry snapshots and any period after the selected reporting date.
- **Entry snapshot:** the row flagged `is_entry_snapshot`, never the earliest date.

## 6. Units
`toDollars(value, unit)`: `USD` x1, `USD_K` x1,000, `USD_M` x1,000,000, `USD_B` x1,000,000,000. Any other unit throws. Sanity check: a converted value for revenue or EBITDA outside configured bounds raises a validation flag (catches millions entered as dollars).

## 7. NAV roll-forward and report QA math
- Roll-forward: `begin_nav + contributions - distributions + gain_loss = end_nav` within $1 tolerance (config).
- QTD gain/loss = `end_nav - begin_nav_of_quarter - contributions_qtd + distributions_qtd`.
- Prior-report tie-out: this report's `begin_nav` equals last released report's `end_nav` for the same position, or a recorded explanation exists.

## 8. Analytics (M20)
- **KS-PME:** (sum of distributions compounded to the end date with the index + NAV) / (sum of contributions compounded the same way). Index levels come from the benchmark adapter.
- **Direct Alpha:** IRR of the index-adjusted cash flows (each flow multiplied by index_end / index_t), expressed as a continuously compounded rate: `ln(1 + irr)`.
- **Value creation attribution** (per deal, entry to current): equity value change split into revenue growth, margin change, multiple change and net debt change using sequential substitution in that fixed order; document the order because the result depends on it.
- **Liquidity forecast (Takahashi-Alexander):** contributions `C_t = RC_t x unfunded_t`; distributions `D_t = RD_t x NAV_t`; NAV grows at `G`; parameters per strategy in config.

## 9. Required test fixtures (golden files)
`packages/calc/fixtures/*.json`, each with inputs, expected outputs and a note on where the expected value came from (hand calculation or spreadsheet XIRR). Minimum cases:
1. Simple 2-flow IRR (known closed form).
2. Multiple calls and distributions over 6 years.
3. All negative flows (expect null).
4. Two sign changes with multiple roots (expect null + reason).
5. Very short hold (flagged short_period).
6. Large distribution then recall (recallable).
7. Zero and negative EBITDA (ratios null).
8. Prior year missing; prior year present with a 3-day period-end shift.
9. Forward-dated entry snapshot ignored by latest-period selection.
10. Units: thousands, millions, billions, unknown unit throws.
11. Roll-forward pass and a $1.01 mismatch fail.
12. KS-PME and Direct Alpha worked example with a synthetic index.
13. Attribution worked example that sums exactly to total value change.
Property-based tests (fast-check / Hypothesis): IRR of flows scaled by k is unchanged; TVPI = DPI + RVPI; NPV at the solved IRR is within tolerance.
