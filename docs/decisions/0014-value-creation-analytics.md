# 0014: Value creation and entry metric analytics

- **Status:** Accepted for the prototype
- **Date:** 2026-11-12
- **Deciders:** repo owner (asked for the analytics); built in Claude Code

## Context

The owner asked for "robust analytics capabilities, with things such as being able to compare valuation growth vs underlying EBITDA growth, debt paydown, and multiple expansion, as well as performance tracking based on entry metrics such as net leverage and entry purchase multiple". The build guide places value creation attribution in M20 (Phase 6) and in-app analytics in M13 (Phase 4); docs/08 section 8 defines the attribution, and `valueCreationAttribution` with its golden fixture already existed in `@pb/calc`, unused. Every equity and continuation vehicle position has an entry snapshot in `mon.quarterly_performance`. This pulls that part of M20 forward at the owner's request; the rest of Phase 4 and Phase 6 is unchanged.

## Options considered

1. **A bridge on the docs/08 four drivers only** (revenue, margin, multiple, net debt). Needs revenue everywhere and does not speak the owner's three drivers.
2. **A bridge on EBITDA, multiple and net debt, opening EBITDA into revenue and margin where revenue exists.** The owner's words, and provably the same rule as docs/08: the EBITDA step equals the revenue step plus the margin step.
3. **For the portfolio roll-up, our gain split by each company's driver shares.** Built first and rejected: when a company's equity value barely moved the shares explode (one seeded position's 8.2M gain read as +91.4M, -125.7M and +42.5M) and distort the headline.
4. **For the roll-up, our entry stake times the company's drivers, with an explicit remainder.** Well behaved, ties exactly to our gain, and the remainder is itself information (our mark against the company's value, timing, follow-ons, realizations).

## Decision

Options 2 and 4.

- **The math (`@pb/calc`, tests first):** `valueCreationBridge` (order EBITDA, multiple, net debt; the parts sum to the equity value change exactly), the measures since entry, `gainByDriver` (stake = our invested capital over the company's equity value at entry; each driver part is the stake times the company's driver; `other` is our gain less those parts, shown as "Mark and timing"), entry bands in turns from config, and `valueCreationRollup` with `pooledReturns` (portfolio sums and cohorts), one function the API calls for the whole book and the page calls for a filtered set. Golden fixtures 19 to 23 with hand calculations, property tests and the Python cross-check (400 cases, 0 mismatches). docs/08 sections 2, 4, 8 and 9 state all of it.
- **The API:** `GET /analytics/value-creation`, its CSV export and `GET /investments/{id}/value-creation`, under the caller's row-level security like the analytics summary, reads audited. Entry is the approved entry snapshot on or before the as-of date; current is the latest approved quarter on or before the earlier of the as-of date and the exit. A figure that cannot be computed carries a reason and is never a number: no entry snapshot, entry snapshot forward-dated, no current quarter, missing figures, non-positive EBITDA, non-positive entry equity, no gain. Credit and fund positions are counted as left out, not dropped silently.
- **The pages:** Analytics gains "Value creation" (tiles for our gain and its four parts, a bridge that opens EBITDA growth into revenue and margin, valuation growth against EBITDA growth per company with a choice of our mark, company equity value or enterprise value, a sortable table, CSV) and "Entry metrics" (performance by entry purchase multiple band and entry net leverage band, entry multiple against MOIC). Both filter by vehicle, sponsor, sector, deal type, entry year and status, kept in the address, and every figure is recomputed exactly through the shared roll-up. Each deal's Performance tab gains a value creation card (the company's bridge, indexed lines by quarter, entry against current). Every chart has a table twin.
- **Config:** `analytics.entryMultipleBands` [9, 11, 13] and `analytics.entryLeverageBands` [4, 5, 6], chosen so the seeded book fills every band (the generator draws entry multiples of 8x to 14x and entry leverage of about 3x to 7x).
- **The static preview:** the routes are recorded for every credential; the filters work in the page over the recorded answer; a simulated route narrows the recorded CSV.

## Consequences (security, cost, operations, migration)

- No migration and no new table. Three read routes, audited; nothing a caller could not already read row by row (SEC-5 unchanged).
- The roll-up and the IRR solver load in an on-demand chunk of about 22 kB; `@pb/calc` is marked free of side effects so the entry chunk does not carry them.
- `pooledPositionMetrics` in the API now delegates to calc's `pooledReturns`, so every pooled figure shares one rule.
- The synthetic book marks most NAVs at our stake of company equity, so on the seed "Mark and timing" is the largest part (mostly distributions and realized exits) and nearly every mark sits above the EBITDA line. The generator was not changed; varying it would move golden figures across the repo and is the owner's call.

## SEC IDs affected

SEC-5.1 and SEC-5.3 (the views read under row-level security and the walls), SEC-11.1 (reads and exports audited).

## Verification (what was checked, docs/versions consulted)

- docs/04 (M13, M20), docs/08 (sections 2, 4, 8, 9), docs/06 (number display and the missing-value placeholder), CLAUDE.md rules 10 and 12.
- On the seeded book as a wall member: gain 162,534,642.07 = EBITDA growth 59,180,824.24, multiple expansion -7,933,433.45, debt paydown 32,856,365.54, mark and timing 78,430,885.74, summing exactly. The position that distorted the first rule now reads 3.07M, -4.22M, 1.42M and 7.94M against its 8.22M gain.
- An API test proves the page's roll-up over the rows equals the API's answer field for field, for two users and three dates; the preview probe repeats it on the recorded answers.
- Gates on the merged tree are in docs/SESSION_LOG.md, Session 9.

## Open for the owner

- Whether the seed should be varied so some marks trail earnings and "Mark and timing" is smaller.
- The stake counts all capital invested by the as-of date (follow-ons included) over entry equity.
- Entry metrics has no headline tile of its own (a pooled MOIC and IRR for the filtered set would be a small addition).
- The export's audit entry records the as-of date and row count, not which filters were set.
