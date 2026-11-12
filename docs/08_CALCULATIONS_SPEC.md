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
| Gain (deal level, `totalGain`) | realized proceeds + unrealized value - invested capital, the money behind the gross MOIC | invested = 0, or NAV not calculable |
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
| Equity value | EV - net debt | EV or net debt missing |
| Growth since entry of EBITDA, EV and equity value (`sinceEntryMeasures`) | current / entry_snapshot - 1, each by the growth since entry rule above | entry snapshot missing or <= 0, or current missing |
| Net leverage change since entry | current net debt/EBITDA - entry net debt/EBITDA, in turns | either side null |
| Net debt change since entry | current net debt - entry net debt, in money (negative when debt was paid down) | either side missing |
| Indexed level (`indexedLevel`) | current / base x 100, so lines that start together at entry start at 100 | base missing or <= 0, or current missing |

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

**The report QA rules** (`runReportQa` in `packages/report-engine`, the release gate of M14). The engine reads one snapshot of a reporting package: a line per position (the NAV the quarter starts from, contributions and distributions in the quarter, the gain or loss and the end NAV as the package shows them, beside the figures on record) and what the package says about itself (preliminary or final, gross or net, its movers, commentary, footnotes and client lines). It answers one finding per rule and entity, with what was expected, what was found and whether it passed. It changes nothing and writes nothing; a failed finding blocks release unless an approver overrides it with a reason (`docs/18` section 5). Money is compared within `rollForwardToleranceUsd`; nothing is rounded before it is compared.

| Rule | Checks | Fails when | Scenario it catches (`docs/14`) |
|---|---|---|---|
| `QA-RDY-01` data readiness | every position has an end NAV to report | a position has none | |
| `QA-STALE-01` stale mark | a position whose end NAV is a mark for an earlier period carries the stale-valuation footnote | the mark is older than the period and the footnote is missing | `stale_valuation` |
| `QA-ASOF-01` as-of date | no figure in the package is dated after the package's as-of date | a line's latest figure is dated later | `forward_entry_snapshot` |
| `QA-QTD-01` quarter basis | the NAV a line starts from is the Locked mark at the end of the prior quarter | it is any other figure (the start of the year, say), or the record has no such mark for a position held before the quarter | `qtd_ytd_basis`, `roll_forward_break` |
| `QA-RF-01` roll-forward | `begin_nav + contributions - distributions + gain_loss = end_nav` | the difference is over the tolerance, or a term is missing | `roll_forward_break` |
| `QA-SIGN-01` sign sanity | the gain or loss shown has the sign of `end_nav - begin_nav - contributions + distributions`; contributions and distributions are not negative | a gain is shown as a loss or the reverse (beyond the tolerance), or a flow total is negative | `sign_flip` |
| `QA-TIE-01` prior report | a line's begin NAV equals the end NAV of the same position in the last released package | they differ over the tolerance and no explanation is recorded | `restatement` |
| `QA-MOV-01` movers | the movers shown are the movers worked out from the lines as they now stand (largest value change by size first, ties by position number, `reporting.weeklyMoversCount` of them), and every commentary blurb was written against that list | the list differs, or a blurb names a list that has since changed | |
| `QA-LBL-01` labels | the package says preliminary or final, and gross or net | either label is missing, or it says final while a position's mark is stale | |
| `QA-CLI-01` client lines | a client line's NAV is its position's end NAV times the client's ownership share | it differs over the tolerance, or names a position the package does not carry | `two_clients_one_fund` |

**The package snapshot** (`buildPackageSnapshot` in `packages/report-engine`): the lines the QA rules read, built from Locked marks and approved cash flows and from nothing else. The period is a calendar quarter; `quarter_start` is the quarter end before it.

- **Which positions:** every position entered on or before the period end and not exited on or before `quarter_start`.
- **Flows of the quarter:** approved flows dated after `quarter_start` and on or before the period end. Contributions are paid-in capital; distributions are distributions, interest, principal and recallable distributions (`summarizeFlows`, section 1). Fees and expenses paid outside the position are in neither.
- **Begin NAV:** the Locked mark whose period is `quarter_start`. A position entered after `quarter_start` has none and starts from zero. A held position with no such mark has no begin NAV, and none is taken from another period.
- **End NAV:** the Locked mark for the period. A position exited in the quarter with no mark for the period ends at zero. Otherwise, with no mark for the period, the last earlier Locked mark is rolled forward: `last_mark + contributions - distributions` over the flows dated after that mark's period and on or before the period end. The line records the period of the mark it came from, which is what makes it stale: it takes the stale-valuation footnote, and its package cannot be labelled final. With no Locked mark at all there is no end NAV.
- **Gain or loss:** `end_nav - begin_nav - contributions + distributions` (the QTD formula above), and nothing when either NAV is missing.
- **Movers, footnotes and client lines:** the movers are ranked from the lines as built; every stale line gets the footnote; a client line is the position's end NAV times the client's ownership share of the position's vehicle.

- A position entered during the quarter has no begin NAV by design: its line starts from zero, `QA-QTD-01` and `QA-TIE-01` pass it over, and the roll-forward runs from zero.
- A rule that cannot be checked for want of a figure fails and says which figure is missing. It never passes by default and never substitutes another period (rule 10).

## 8. Analytics (M20)
- **KS-PME:** (sum of distributions compounded to the end date with the index + NAV) / (sum of contributions compounded the same way). Index levels come from the benchmark adapter.
- **Direct Alpha:** IRR of the index-adjusted cash flows (each flow multiplied by index_end / index_t), expressed as a continuously compounded rate: `ln(1 + irr)`.
- **Value creation attribution** (per deal, entry to current): equity value change split into revenue growth, margin change, multiple change and net debt change using sequential substitution in that fixed order; document the order because the result depends on it.
- **EBITDA bridge** (`valueCreationBridge`, per company, entry snapshot to current quarter): the attribution above with its revenue and margin steps taken together, so there is one rule. Equity value = EBITDA x multiple - net debt, where multiple = EV / EBITDA, changed one input at a time in the fixed order **EBITDA, multiple, net debt**:
  - EBITDA growth = (EBITDA_1 - EBITDA_0) x EV_0 / EBITDA_0
  - multiple expansion = EBITDA_1 x (EV_1 / EBITDA_1 - EV_0 / EBITDA_0), which is (EV_1 - EV_0) - EBITDA growth
  - debt paydown = net debt_0 - net debt_1 (positive when net debt fell)

  The three sum to the change in equity value, (EV_1 - net debt_1) - (EV_0 - net debt_0), exactly (for amounts below ten trillion): EBITDA growth is held to 20 decimal places, debt paydown is exact, and multiple expansion takes the remainder. Each driver's share is driver / total (no shares when the total is zero). With a positive revenue at both ends, EBITDA growth opens into revenue growth, (revenue_1 - revenue_0) x EV_0 / revenue_0 (growth at the entry margin and multiple, the attribution's first step), and margin change, the rest of EBITDA growth (its second step). No bridge when an EBITDA is at or below zero (`non_positive_ebitda`): the multiple is then undefined. The caller supplies the two other reasons, no entry snapshot and no current quarter.
  - Worked example (fixtures 13 and 19): entry EBITDA 40, EV 400, net debt 150 (10.0x, equity 250); now EBITDA 65, EV 715, net debt 120 (11.0x, equity 595). EBITDA growth (65 - 40) x 10.0 = 250; multiple expansion (715 - 400) - 250 = 65, which is 65 x (11.0 - 10.0); debt paydown 150 - 120 = 30; total 250 + 65 + 30 = 345 = 595 - 250. Shares 72.5%, 18.8% and 8.7%. With revenue 200 at entry and 260 now, EBITDA growth opens into revenue growth (260 - 200) x 400 / 200 = 120 and margin change 250 - 120 = 130, the two revenue-side parts of fixture 13.
- **Our gain by driver** (`entryStake`, `gainByDriver`, per position): our own gain on the position (`totalGain`: distributions + NAV - invested, section 2) set against the company's bridge at our entry stake.
  - stake = our invested capital in the position / the company's equity value at entry (EV_0 - net debt_0).
  - our share of a driver = stake x the driver in money, computed as invested x driver / entry equity value and held to the ten places a result travels with (section 1), for EBITDA growth, multiple expansion and debt paydown; with a revenue split on the bridge, the revenue part the same way and the margin part as the rest of the EBITDA part.
  - other = gain - the three shares: the part of our gain that the company's equity value change at our entry stake does not explain (our mark against the company's value, fees, the timing of flows, follow-on investments and realizations). It is a real figure, shown and summed ("Mark and timing" on the pages), never hidden.

  The four parts sum to the gain exactly, whatever the stake, and because each is held to the places it travels with, the parts a reader receives are the parts that were summed. A company whose equity value did not move is no special case: its drivers cancel and other carries the gain. Not calculable when the gain is not calculable or nothing was invested (`no_gain`), when the company has no bridge (the bridge's own reason), or when the company's equity value at entry is not positive (`non_positive_entry_equity`: a stake in nothing has no size). The rule lives in one function so it can change in one place. It replaces gain x driver / company total, which blew up when a company's equity value barely moved.
  - Worked example (fixture 21): the company above in millions (equity value 250,000,000 at entry; EBITDA growth 250,000,000, multiple expansion 65,000,000, debt paydown 30,000,000). We invested 10,000,000, a stake of 4%, received 2,000,000 and hold a NAV of 22,500,000, a gain of 14,500,000. EBITDA growth 4% x 250,000,000 = 10,000,000; multiple expansion 4% x 65,000,000 = 2,600,000; debt paydown 4% x 30,000,000 = 1,200,000; other 14,500,000 - 13,800,000 = 700,000.
  - A company whose equity value is nearly flat (fixture 21, case 2): equity 400,000,000 to 402,000,000 (EBITDA growth 120,000,000, multiple expansion -90,000,000, debt paydown -28,000,000); our 40,000,000 is a stake of 10% and our mark is up 8,000,000. Our shares are 12,000,000, -9,000,000 and -2,800,000 (200,000 in all) and other is 7,800,000. The old rule gave 480,000,000, -360,000,000 and -112,000,000.
- **Entry and current quarter of a position** (the API, `apps/api/src/analytics/value-creation.ts`): entry is the approved row flagged `is_entry_snapshot`, dated on or before the as-of date; an approved snapshot dated after it has its own reason (`entry_snapshot_forward_dated`), apart from no snapshot at all (`no_entry_snapshot`). Current is the latest approved quarter on or before the as-of date, or on or before the exit date of a position realized by then: a realized position's bridge, and its series by quarter, stop at its exit.
- **Entry metric bands** (`turnBands`, `bandIndexOf`): ascending edges from config (`analytics.entryMultipleBands`, `analytics.entryLeverageBands`, in turns) cut the line into one more band than edges: below the first edge, each interval closed below and open above, and at or above the last edge, so every value sits in exactly one band and a value on an edge belongs to the band that starts there. Labels are in turns: "Under 8.0x", "8.0x to 10.0x", "14.0x and over". Edges that are empty, repeated or out of order are refused. A position with no entry figure (no entry snapshot, entry EBITDA at or below zero) is counted in an explicit "Not calculable" cohort, never dropped.
- **Cohort average** (`weightedAverage`): sum of weight x value / sum of weights, such as the invested-weighted EBITDA growth of a band; null for nothing to average or weights that sum to zero. A cohort's MOIC and IRR are the pooled metrics of sections 2 and 3 over its positions.
- **Pooled returns** (`pooledReturns`): the one rule behind every pooled view (a vehicle, a sponsor, a client slice, the whole portfolio, an entry metric cohort). The caller sums the contributions, the distributions and the NAV of the positions still held; DPI, RVPI, TVPI and MOIC are over those sums, and the IRR runs over the pooled signed flows (fees and expenses included) with the summed NAV as the terminal flow on the as-of date (a NAV of zero adds none). No NAV, RVPI, TVPI, MOIC or IRR while a held position has no Locked mark (`no_valuation`); no figure at all for a pool of no position.
- **Roll-up of the value creation views** (`valueCreationRollup`): a function of the position rows as they travel (decimal strings at ten places, each row with its signed dated flows) that answers the roll-up as it travels, so the API rolls up the whole book and a page rolls up a filtered set by one rule and the two cannot disagree on a figure.
  - Portfolio: over the rows whose gain is split, the sums of invested, NAV, distributions and gain and of each part of the gain (other included), so the four parts sum to the portfolio gain exactly and invested + gain = NAV + distributions. The revenue and margin parts are a total only when every row summed carries them. The rows left out are counted by reason, in the order of `VALUE_CREATION_REASONS`.
  - Cohorts: for each band of an entry metric, in order, the rows keyed to it, pooled by `pooledReturns` (invested is the sum of the rows' invested capital, distributions the sum of their positive flows, NAV the sum over the held rows), with the invested-weighted EBITDA growth of the rows that have both figures, weighing the growth as the row carries it. A band that holds no row keeps its place with a count of 0 and no figure.
  - A filter is a subset of the rows, so a filtered view is exact: the same function over fewer rows. A filter that leaves no row has no figure, never a zero.
  - Worked example (fixture 23): five positions as of 2023-06-30. Two held positions of 1,000,000 each, entered 2021-06-30, one of which has distributed 200,000, with NAVs of 1,300,000 and 920,000, pool to a MOIC of (200,000 + 2,220,000) / 2,000,000 = 1.21 and, 730 days on, an IRR of 10% ((1 + r)^2 = 1.21).
- **Deal fit measures** (`dealFit`, per opportunity; a draft set the owner asked for on 2026-11-12, decision 0018): seven scores from 0 to 100, higher meaning a better fit with the portfolio, each a rule over recorded figures that a reader can check by hand. The thresholds are config (`dealFit` in `config/definitions.json`), never code. A measure whose input is missing has no score and says why; it is never guessed and never counted as zero.
  - The line every score sits on: `score(v; zero, full) = 100 x (v - zero) / (full - zero)`, held between 0 and 100 and rounded half up to the ten places a result travels with. `full` may lie below `zero`, so the score falls as `v` rises.
  - **Sponsor relationship:** the score config gives the sponsor's tier (core 100, active 70, new 40, watch 15). A tier config does not score has none.
  - **Track record:** the pooled gross MOIC of our positions with the sponsor (`pooledReturns`, section 2), scored from `trackRecord.zeroAtMoic` (1.0x) to `trackRecord.fullAtMoic` (2.5x). No position with a calculable MOIC has none.
  - **Fund relationship:** `fundRelationship.fund` (100) when the firm has a commitment to the deal's own sponsor fund, `fundRelationship.otherFund` (60) when only to another fund of the sponsor, `fundRelationship.none` (0) when to none: the fund-fit flag of M5 as a score.
  - **Sector room, sponsor room, geography room:** the share of held NAV already in the deal's sector (with its sponsor, in its geography), scored from its cap down to nothing: `score(share; cap, 0)`, so 100 with nothing held and 0 at the cap or over it. Caps are `caps.sector` (25%), `caps.sponsor` (20%) and `caps.geography` (70%). Nothing recorded on the deal, or no NAV held, has none.
  - **Size fit:** `r` = target commitment / the median invested capital of the held positions of the deal's type (`median`: the middle value, or the mean of the two middle values). 100 for `r` from `size.low` (0.5) to `size.high` (1.5); `score(r; 0, low)` below it; `score(r; limit, high)` above it, so 0 at `size.limit` (3) and beyond. No target commitment, a target in another currency than the positions (never converted), or no held position of the type has none.
  - Worked example (fixture 24, case 1): an active sponsor, 70; MOIC 1.75 is (1.75 - 1) / 1.5 = 0.5, 50; a commitment to the deal's own fund, 100; a sector at 10% of NAV against a 25% cap leaves 1 - 0.4, 60; the sponsor at 5% against 20% leaves 75; the geography at 35% against 70% leaves 50; a target of 20,000,000 against a median of 16,000,000 is 1.25 times, inside the band, 100.
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
19. EBITDA bridge: the worked example of section 8, a multiple that does not terminate with net debt rising, a falling margin with a contracting multiple, a total of zero (no shares), a missing or zero revenue (no split) and an EBITDA at or below zero (no bridge, with the reason).
20. Measures since entry: growth of EBITDA, EV and equity value, the multiple, net leverage and net debt changes and the indexed levels, with every null case.
21. Our gain by driver: the worked example of section 8, a company whose equity value is nearly flat while our mark is well up (other carries the gain), shares that do not terminate, a loss on a company that grew, a company total of exactly zero, an entry equity value at or below zero and no invested capital.
22. Entry bands and the cohort average: the labels, a value on an edge, below the first and above the last edge, refused edges, and the weighted average with its null cases.
23. Roll-up of the value creation views: the portfolio sums and the cohorts by two entry metrics over five positions (a realized one, one with no bridge and a fee, one with no Locked valuation), each pooled IRR a closed form; a filter that leaves two positions; a filter that leaves none.
24. Deal fit measures: six opportunities by hand (a score at each end of its line and between, a share over its cap, a tier config does not score, every missing input with no score), a score that does not terminate (66.6666666667), and the median of one, two, three, four and no values.
25. Report QA: one package snapshot per rule, passing and failing, each scenario of the table above (a stale mark with and without its footnote, a figure after the as-of date, a quarter table started from the year, a missing starting NAV, a gain shown as a loss, a restated prior mark with and without an explanation, a superseded movers list, final with a stale mark, a client line off its share).
26. Package snapshot: six positions by hand (held with flows in and out of the quarter, entered in the quarter, exited in it, exited before it, a stale mark rolled forward one quarter and two, a mark with no starting NAV), the client lines of two clients, and the same positions read by the QA rules.
Property-based tests (fast-check / Hypothesis): IRR of flows scaled by k is unchanged; TVPI = DPI + RVPI; NPV at the solved IRR is within tolerance; par after PIK capitalization is never below par before it; prior x (1 + value change) gives back the current value, the change has the sign of current - prior, and scaling both values leaves it unchanged. The bridge drivers sum to the equity value change exactly and their shares sum to one; the EBITDA step equals the revenue step plus the margin step of the four-driver attribution, and the multiple and net debt steps equal its own; the parts of our gain by driver, other included, sum to the gain exactly for any stake, and scaling the stake scales the driver parts linearly; the roll-up's parts sum to its gain, every row sits in exactly one cohort of each entry metric, and the roll-up adds up over any split of the rows (which is what makes a filtered view exact); the bands hold every value exactly once; a weighted average lies between its smallest and largest value. The random cross-check also recomputes value changes, the bridge with the gain split at our stake, the measures since entry, the bands and the roll-up in Python.

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
