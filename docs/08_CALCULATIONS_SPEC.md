# 08: Calculations Specification (`packages/calc`)

All financial math lives in `packages/calc` (TypeScript) and is cross-checked by an independent Python implementation in `apps/worker-py/calc_check`. Every function is pure, deterministic, uses a decimal library (never JS `number` for money), and returns `null` (rendered as the missing placeholder) instead of a misleading value. Each function records `CALC_VERSION` with persisted results.

## 1. Inputs and conventions
- Cash flows: `{date, amount}` from the investor's perspective: contributions (fundings) negative, distributions, interest, principal and fees received positive. Terminal value (NAV, or fair value plus accrued interest for credit) is a positive flow on the valuation date.
- Dates are calendar dates (no time). Day count for XIRR: actual/365 (configurable to actual/365.25).
- Rounding: keep full precision internally; round only for display (`docs/06`). Use round half away from zero at display.
- Results travel as decimal strings rounded half up to ten places, with no exponent and no trailing zeros (`toDecimalString`); the API and the preview simulation both render through it, so the same inputs give the same string.

## 2. Return metrics
| Metric | Formula | Returns null when |
|---|---|---|
| Paid-in (PI) | sum of contributions (absolute) | no contributions |
| DPI | distributions / PI | PI = 0 |
| RVPI | NAV / PI | PI = 0, or NAV not calculable |
| TVPI | (distributions + NAV) / PI | PI = 0, or NAV not calculable |
| MOIC (gross, deal level) | (realized proceeds + unrealized value) / invested capital | invested = 0, or NAV not calculable |
| Unfunded | commitment - contributions + recallable distributions | commitment missing |
| Holding period (years) | (exit or as-of date - first contribution date) / 365 | no contribution |
| NAV (a set of positions) | sum of each held position's latest Locked mark; realized positions hold 0 | any held position has no Locked mark on or before the as-of date (never counted as 0) |
| NAV series (one point per calendar quarter end) | at each quarter end, the NAV above over the positions held then (entered on or before it, not exited by it), each at its latest Locked mark for that quarter or an earlier one. A mark within the prior-year tolerance (section 5) of a quarter end counts for that quarter, so a sponsor that closes its books a few days early lands on it; a position whose sponsor missed a quarter is carried at its earlier mark. Only marks on or before the as-of date count, and the series ends at the last quarter end on or before it (`lockedNavSeries`) | a position held at that quarter end has no Locked mark for it or an earlier quarter (the chart shows a gap, never a partial sum) |
| Value change (`valueChange`) | (current value - prior value) / prior value, such as a Locked fair value against the previous quarter end's (valuation board, weekly report movers, watchlist markdown) | either value missing, or prior = 0 |

## 3. IRR (XIRR)
- Solve NPV(r) = sum(amount_i / (1 + r)^((d_i - d_0)/365)) = 0.
- Algorithm: Newton-Raphson from 0.1, with **bisection fallback** on [-0.9999, 100] when Newton fails to converge or leaves the bracket. Tolerance 1e-10 on NPV, max 200 iterations.
- Return `null` when: fewer than 2 flows; all flows the same sign; no sign change that yields a root; or multiple roots detected (more than one sign change and NPV sign test finds several brackets). In the multiple-root case, return `{value: null, reason: "multiple_irr"}`.
- Periods under 1 year: report IRR but flag `short_period: true` so the UI can show "NM" per config (`irr.minHoldYearsForDisplay`).
- Gross vs. net is a label on inputs, not a different algorithm.
- No IRR while the NAV that ends the flows is not calculable (flag `no_valuation`): flows without their terminal value would give an invented rate.

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
14. Private credit: all-in coupon, current yield and yield to maturity for a unitranche loan with a floor, OID and a bullet maturity.
15. PIK: par roll-forward over four quarters with PIK capitalized; cash-on-cash excludes PIK.
16. Credit ratios: interest coverage, leverage through the tranche, LTV and DSCR, including the null cases (EBITDA, interest or EV at or below zero).
17. Takahashi-Alexander liquidity forecast over the fund life (section 8).
18. Value change: up, down, unchanged, a full write-down, a repeating decimal, a zero prior and a missing current or prior value (null).
Property-based tests (fast-check / Hypothesis): IRR of flows scaled by k is unchanged; TVPI = DPI + RVPI; NPV at the solved IRR is within tolerance; par after PIK capitalization is never below par before it; prior x (1 + value change) gives back the current value, the change has the sign of current - prior, and scaling both values leaves it unchanged. The random cross-check also recomputes value changes in Python.

## 10. Private credit metrics
Inputs come from `mon.credit_terms` and `mon.credit_performance` (`docs/03`). All rates are annual decimals.
| Metric | Formula | Null when |
|---|---|---|
| All-in coupon | max(base_rate, floor) + spread, split into cash_coupon and pik_coupon as the terms state | base rate missing |
| Current yield | annual cash interest (cash_coupon x par) / fair value | fair value <= 0 |
| Yield to maturity (YTM) | XIRR of {-fair_value on the as-of date, remaining contractual cash interest and scheduled principal, par (plus capitalized PIK) at maturity}; uses the XIRR rules in section 3 | maturity missing or past, fair value <= 0 |
| Cash-on-cash | cash interest received LTM / average funded amount over the period | funded = 0 |
| Interest coverage | EBITDA LTM / cash interest expense LTM (borrower level) | EBITDA <= 0 or interest <= 0 |
| Leverage through the tranche | net debt senior to and including the tranche / EBITDA LTM | EBITDA <= 0 |
| LTV | net debt through the tranche / enterprise value | EV <= 0 |
| DSCR | (EBITDA LTM - cash taxes - maintenance capex) / (cash interest + scheduled principal, LTM) | debt service <= 0 |
| Par roll-forward | par_begin + fundings + PIK capitalized - principal repaid = par_end within $1 (config) | |
Credit MOIC and IRR use the cash flows in section 1 with fair value plus accrued interest as the terminal value. PIK is income only once capitalized into par; it is never counted as cash received. Rates and coupons stay as decimals internally and are formatted per `docs/06`.
