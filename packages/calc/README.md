# @pb/calc

Financial calculations for Portfolio Beach, specified in `docs/08_CALCULATIONS_SPEC.md`.

- Pure, deterministic functions over exact decimals (`decimal.js`, 34 digits). Money, rates and multiples enter as strings or Decimals; JS numbers are rejected.
- Every function returns `null` (rendered as the missing placeholder) instead of a misleading value, with the null rules from the spec.
- `CALC_VERSION` is stored next to every persisted result (SEC-9.6).

## Layout
| File | Covers |
|---|---|
| `irr.ts` | XIRR: Newton-Raphson with bisection fallback, multiple-root detection, short-period flag |
| `multiples.ts` | Paid-in, DPI, RVPI, TVPI, MOIC, unfunded, holding period |
| `operating.ts` | EV/EBITDA, net debt/EBITDA, margin, YoY, growth since entry, multiple delta |
| `periods.ts` | Same quarter prior year, latest approved period, entry snapshot |
| `units.ts` | Declared-unit conversion to dollars and the unit sanity flag |
| `rollforward.ts` | NAV roll-forward, QTD gain/loss, prior-report tie-out |
| `pme.ts` | Kaplan-Schoar PME and Direct Alpha |
| `attribution.ts` | Value creation attribution by sequential substitution |
| `liquidity.ts` | Takahashi-Alexander cash flow model |
| `credit.ts` | Private credit: all-in coupon, current yield, yield to maturity, coverage, leverage, LTV, DSCR, PIK |
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
