# @pb/calc

Financial calculations for Portfolio Beach, specified in `docs/08_CALCULATIONS_SPEC.md`.

- Pure, deterministic functions over exact decimals (`decimal.js`, 34 digits). Money, rates and multiples enter as strings or Decimals; JS numbers are rejected.
- Every function returns `null` (rendered as the missing placeholder) instead of a misleading value, with the null rules from the spec.
- `CALC_VERSION` is stored next to every persisted result (SEC-9.6).

## Layout
| File | Covers |
|---|---|
| `decimal.ts` | The private Decimal (34 digits, half up), input checks and `toDecimalString`, the contract decimal string |
| `irr.ts` | XIRR: Newton-Raphson with bisection fallback, multiple-root detection, short-period flag |
| `multiples.ts` | Paid-in, DPI, RVPI, TVPI, MOIC, gain, unfunded, holding period, value change |
| `operating.ts` | EV/EBITDA, net debt/EBITDA, margin, YoY, growth since entry, multiple delta |
| `periods.ts` | Same quarter prior year, latest approved period, entry snapshot |
| `units.ts` | Declared-unit conversion to dollars and the unit sanity flag |
| `rollforward.ts` | NAV roll-forward, QTD gain/loss, prior-report tie-out |
| `pme.ts` | Kaplan-Schoar PME and Direct Alpha |
| `attribution.ts` | Value creation attribution by sequential substitution |
| `bridge.ts` | EBITDA bridge (EBITDA growth, multiple expansion, debt paydown), measures since entry, our entry stake and our gain by driver at that stake with the remainder (`other`) |
| `cohorts.ts` | Entry metric bands in turns, the cohorts they are listed under and the weighted average of a cohort |
| `pooled.ts` | Pooled returns over a set of positions: the multiples over the sums, the IRR over the pooled flows with its flag |
| `rollup.ts` | The roll-up of the value creation views over position rows as they travel: the portfolio sums and the cohorts; the API calls it for the whole book and a page for a filtered set |
| `terms.ts` | The names the value creation views, the base case comparison and the valuation suggestions share with the API contract: the not-calculable reasons in order, the key of the cohort with no entry figure, the plan metrics, the statuses against plan, the forms of a base case and the reasons its progress and its path have no figure; the bases of a suggested mark with their methods, the reasons a source gives no value in the order they are decided, and the reasons a statement's contributions are not checked |
| `liquidity.ts` | Takahashi-Alexander cash flow model |
| `credit.ts` | Private credit: all-in coupon, current yield, yield to maturity, coverage, leverage, LTV, DSCR, PIK |
| `underwriting.ts` | Performance against the sponsor's underwritten base case: the plan at a date (a plan figure, or a flagged straight line between two), the variance of the current quarter against it and its status by a tolerance; the planned EBITDA bridge and the share of each driver earned; the gross IRR against the underwritten IRR and the gross MOIC against the underwritten path. `underwritingComparison` answers all of it over rows as they travel: the API calls it, and so does a page that works the comparison out in the browser |
| `suggestion.ts` | Valuation suggestions: the mark a position-level capital account statement gives (its ending balance at our share, with the tie-out of its lines by the unit read and its contributions against the record), the mark a sponsor's report gives (our last Locked mark scaled by the change in equity value, with the earlier multiple held when the report states no enterprise value), a value beside the mark on record (change, the board's variance flag, the change net of the quarter's flows) and beside another source; which Locked marks and cash flows count for a quarter. A value is the exact figure to the cent, above zero, or a reason |
| `fixtures/` | Golden files shared with the Python cross-check |

## Commands
```bash
pnpm --filter @pb/calc test          # golden fixtures + property tests
pnpm --filter @pb/calc build         # emits dist/ (needed by cross-check)
pnpm --filter @pb/calc cross-check   # random cases recomputed by apps/worker-py; must report 0 mismatches
```

## Key decisions
- The IRR bracket scan (locating sign changes of NPV before solving) runs in floating point for speed; every returned rate is solved in exact decimals inside the bracket found.
- Period selection is date-based with a configurable tolerance; it never falls back to the nearest period.
- The parts of our gain by driver are held to the ten places a result travels with, and the remainder takes what is left, so the parts a reader receives sum to the gain exactly and a roll-up over travelling rows loses nothing.
- A suggested mark is rounded once: the quotient is worked out in arithmetic wide enough to be exact for any figures the record can hold, then rounded half up to the cent, so the Python cross-check agrees on it to the letter. The variance flag is one function (`atOrAboveVarianceFlag`), which the valuation board calls too.
- The package declares `sideEffects: false`: a bundle takes only the modules it imports from, so the web app's entry chunk does not carry the roll-up or the IRR solver, which load with the analytics tabs that use them.
