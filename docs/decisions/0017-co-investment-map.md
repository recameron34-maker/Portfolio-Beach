# 0017: The co-investment map

- **Status:** Accepted for the prototype
- **Date:** 2026-11-12
- **Deciders:** repo owner (asked for the map and how it should feel); built in Claude Code

## Context

The owner asked for "a 'co-investment map' or something similar that allows you to pull up an interactive map illustrating the HQs of all co-investment / single asset CV investments", and then: "I want it to be drawn and animated, pleasing to the eye and fun to interact with".

Three rules of the build guide shape the answer. The app carries no charting library and draws its own SVG (`docs/13`). The static preview makes no request to another origin, so a map built on a tile service would be blank there. And a figure or a place is never invented (rule 10): until now the data model held a company's region, not where its head office is.

## Options considered

1. **A tile map (a mapping library and a tile service).** The familiar slippy map. It needs a request to another origin for every tile, which the static preview cannot make and a firm's network may not allow, and it brings a library the build guide says to do without. It would also look like every other map, not like this product.
2. **A drawn world in the app's own SVG (chosen).** The outline is data shipped with the app; the projection is a dozen lines; everything that moves is CSS or a few lines of arithmetic. It works offline and in the preview, takes the product's own colours, and can be animated freely.
3. **A list by country with no map.** Honest and simple, and not what was asked for. It survives as the table under the map, which is how a reader who cannot use a map gets the same information.

## Decision

**A head office on the company.** Migration 0018 adds `hq_city`, `hq_country` (ISO 3166-1 alpha-2), `hq_latitude` and `hq_longitude` to `core.portfolio_company`, recorded whole or not at all (a check constraint). They follow the table's policies and history. Classified internal, as the company's name is. The portfolio row of the API (`investmentSummary`) carries `hq` as an object or null, so the map reads the list the portfolio grid already reads and needs no endpoint of its own.

**Never placed by a guess.** A position whose company has no head office recorded is not on the map. It is counted on a tile and listed in its own table under the map, with the reason in words.

**The world is drawn from public domain data, at build time.** `apps/web/scripts/build-world-map.mjs` reads the `world-atlas` package (Natural Earth 1:110m, public domain; the package is a development dependency only) and writes `world.generated.json`: the coastlines and the borders two countries share, as steps in hundredths of a degree, 22 KB compressed. Antarctica is left off. A test fails when the file and the package disagree. The app projects those lines itself with the Equal Earth projection (equal area, so no region is flattered), written out in `projection.ts` and tested against the projection's published values.

**Which positions.** Co-investments and single-asset continuation vehicles, held, by default: one company each, so one head office each. Chips switch each deal type, the status (held, realized, all), a vehicle and a sector.

**How it behaves.**

- The coast draws itself once when the map opens, the land washes in and the markers drop in from west to east.
- A marker is one city, or several cities too close to tell apart at the current zoom; they part as the map comes closer. Its size follows how many positions it holds, its colour the deal type (the chart series), and it shows its count.
- Hovering or focusing a marker shows where it is and ripples it. Choosing it flies the map there and lists its positions beside the map, each with its sponsor, vehicle, NAV and MOIC as the API gave them, and a link to the deal.
- The reader moves by dragging, the zoom buttons, a double click, the keyboard (arrows, plus and minus, 0 for the world, Escape to let go) or Ctrl with the wheel (a plain wheel scrolls the page; a hint says so).
- Region buttons fly to North America, Europe and Asia Pacific. "Play tour" visits every city from west to east and returns to the world; taking hold of the map stops it.
- "Show" on a row of the table flies to that company's city.

**Motion is decoration, and can be switched off.** With the reduced motion setting on, nothing animates: the map is simply there and every move is instant (`docs/06` section 5).

**No money is added up in the browser.** The tiles count positions, cities and countries. Every money figure on the page is one the API returned for one position.

## Consequences

- One development dependency (`world-atlas` 2.0.2, ISC; its data is public domain). No runtime dependency, no request to another origin, no paid service.
- The map and its outline load on demand, as their own chunk, so no other page carries them.
- The synthetic generator gives each company a real city of its region from a stream of its own, so no other seeded value moved; about one company in ten has none, to keep the unplaced case in view (`docs/14` section 11).
- A real deployment needs head offices entered or imported for its companies; until then every position sits in the "no head office recorded" table. Nothing here geocodes an address.
- Country names come from the browser (`Intl.DisplayNames`); a code it does not know is shown as the code.
- The site's screenshots and recordings do not show the map yet; that is a media regeneration for a later session.

## Verification

```
packages/db guards                        whole-or-nothing, range and country code constraints refuse bad rows
tools/synthetic                           every head office is a listed city of the company's region; other values unchanged
packages/contracts, apps/api              the portfolio row carries the head office whole or null
apps/web projection.test.ts               the projection's published values, symmetry, the frame
apps/web world.test.ts                    the file equals what the script writes; land under cities, sea under oceans
apps/web map-model.test.ts, MapTab.test   filters, grouping, clustering, the view, the panel, keyboard, tour, partial page
apps/web e2e/map.spec.ts                  the real API: counts, tables, a marker to a deal, the wall; accessibility scan
```

## SEC IDs affected

SEC-2.1 (four new columns classified), SEC-5.3 (the map shows only positions the reader may see; the walled position is absent for a non-member, tested).
