# 0026: The ledger look (one designed visual language, with motion)

- **Status:** Accepted for the prototype
- **Date:** 2026-11-18
- **Deciders:** repo owner (the direction); the UI session (the values, from eight reviews of 174 screenshots)

## Context

The owner asked, on 2026-11-18, that the app "look less like a standard anthropic build, throughout".

What made it read as a generated interface: a teal and sand palette with a beach on the sign-in page, a Georgia title on every page, an uppercase letter-spaced label with a teal underline over every card, rounded white cards nested three deep, filled teal table headers that outshout the figures, a pill for every state, notices with a coloured bar down the left, and the same generous padding where figures are compared. The roadmap line "A UI pass with motion" (`docs/09`, asked 2026-11-12) asked for motion in the same pass.

What must not move: the colour pipeline of decision 0007 (`config/brand.json`, the formulas of `apps/web/src/app/theme.ts`, CSS variables) and its AA test; every request, figure, role check and missing-value placeholder; the rules of `docs/06` section 6 on the words a page uses.

## Options considered

1. **Keep the look and retune it.** New colours on the same cards, labels and pills. The tells are in the shapes, not only the colours, so this changes too little.
2. **A system font stack.** No files to ship, but three different faces on three platforms, and screenshots that never match what a reader sees.
3. **Inter or Geist.** The faces most generated interfaces default to; Inter is also the capture machine's own system face. Choosing one would keep the tell this pass removes.
4. **IBM Plex Sans and Mono, bundled with the app** (chosen). A face designed for dense business software, every digit the same width, a mono of the same family for hashes and wire digits, an open licence, and IBM's own unmodified files, so the Reserved Font Name may be used.

Set aside, with the reason: the shell review's cobalt `#3258C9` (two "forbidden pair" assertions of `lib/theme.test.ts` would fail); Fontsource subsets (modified files would have to drop the Plex name); tone colouring a key figure (a dot before the label keeps the meaning and leaves every figure in ink).

## Decision

**Colour** (`config/brand.json`; every derived token is still a formula of decision 0007, none changed):

| Token | Old | New | Use |
|---|---|---|---|
| `brand.primary` | #0F4C5C | #1E3A5F | Ink blue: links, primary buttons, the wordmark's mark |
| `brand.accent` | #2A9D8F | #4C72D9 | Cobalt: focus ring, current tab, current step, selected row edge, chart series 1. Never text |
| `brand.sand` | #F4EBD9 | #EEF0F3 | Neutral panel grey (key kept: `theme.ts`, the site and the map read it) |
| `ui.text` | #1F2328 | #16191D | Text and every figure |
| `ui.muted` | #6B7280 | #68707A | Secondary text on the page background only |
| `ui.border` | #E5E7EB | #DCE0E5 | Section rules |
| `ui.bg`, `status.*` | unchanged | unchanged | Page; status meanings fixed |
| `chartSeries` | teal first | #4C72D9, #D9782B, #2A9D8F, then unchanged | Series 1 and 3 swapped: the same set, so the colour-vision check holds; the first pair becomes blue and orange |

Contrast, measured with the formulas of `theme.ts`: text on page 17.63; muted on page 5.02; muted-strong (#555c64) on page 6.77, on surface-2 6.38, on primary-tint-8 5.88; primary on page 11.50; accent-ink (#355098) on page 7.63 and on accent-tint-10 6.75; page colour at 72% on primary 6.81. Below 4.5 and never text, as the test documents: accent on page 4.45 (above 3, so a focus ring or a mark), muted on sand 4.39, accent on primary 2.58 (decorative only). Derived values: primary-deep #182e4c, primary-tint-4 #f6f7f9, primary-tint-8 #edeff2, primary-tint-12 #e4e7ec, accent-tint-10 #edf1fb, sand-pale #f7f8f9, sand-edge #dbdde0, surface-2 #f8f8f8, hairline #eaecef, border-strong #c2c5ca.

**Type.** IBM Plex Sans 400, 500 and 600 for everything (`fonts.ui` and `fonts.display`, the same stack: `"IBM Plex Sans", "Segoe UI", system-ui, sans-serif`), and IBM Plex Mono 400 (`fonts.mono`, `"IBM Plex Mono", "Cascadia Mono", Consolas, monospace`) only for hashes, wire digits, lock text and a document's page text. No serif anywhere. The files are IBM's own split web files from the npm packages `@ibm/plex-sans@1.1.0` and `@ibm/plex-mono@1.1.0` (both published 2024-11-11; the sans 2.0.0 was published the day this was written and is too new to take), font version 3.005 for the sans and 2.004 for the mono, under the SIL Open Font License 1.1 ("Copyright 2017 IBM Corp. with Reserved Font Name Plex"), unmodified, so the name may be used. They sit in `apps/web/src/app/fonts/` with the licence, and `apps/web/src/app/fonts.css` declares them with IBM's own Latin1 and Latin2 ranges, `font-display: swap` and no `local()` source:

| File | Bytes | SHA-256 |
|---|---|---|
| IBMPlexSans-Regular-Latin1.woff2 | 20,984 | b5ad7bd39f996144915f0ad9849a90183b27d8c28ad97ed98af5b1bebc51f6b1 |
| IBMPlexSans-Regular-Latin2.woff2 | 15,212 | fcfa82e0d46ed01a8df38610b451860ca7e7518770c52fdd2a1d136247c40f28 |
| IBMPlexSans-Medium-Latin1.woff2 | 21,960 | b5610af04d0d4b5a14a621d96d974b993e945a065db1a8861918f69ef9321934 |
| IBMPlexSans-Medium-Latin2.woff2 | 15,372 | 46fbe4f398e7ff3cc7773a1156b1efef0f81e4d034f682369c221de587f443ca |
| IBMPlexSans-SemiBold-Latin1.woff2 | 22,260 | fff0ab3a88b0b4aa0b693e4f0201359a15183b08e3fa5696d1918d8f0ade8ad5 |
| IBMPlexSans-SemiBold-Latin2.woff2 | 15,624 | 2bc85a8e53540c4c211f7af36e806bb045ba7da8946bb221d87144c12c83d577 |
| IBMPlexMono-Regular-Latin1.woff2 | 17,268 | 10d3c7fa7eaf48e78db24f317b64f008a75e00f63a68bb3c2afc6ef51e58674f |
| IBMPlexMono-Regular-Latin2.woff2 | 13,312 | 151a2b0dfb8271b5273f71da83e9e68c85e1939e4f016f6ab2dfac98ea9f117e |
| LICENSE.txt | 4,456 | 7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da (as IBM ships it, with CRLF line ends; the repository stores it with LF) |

The type scale (`styles.css :root`, a size and a line height each): 11/16 axis ticks, 12/16 labels and table headers, 13/20 body and cells, 14/20 section titles, 16/24 dialog titles, 20/28 page titles, 22/28 key figures (20/26 on a phone), 14/22 prose at most 72 characters a line. Weights 400, 500 and 600 only. No uppercase lettering and no tracking, except a slight tightening on titles and figures. The page sets tabular, lining figures, which Plex has already.

**Shape and space.** Radii 2px (identifiers, focus outlines), 4px (buttons, inputs, notices, menus), 6px (dialogs, popovers); Fluent's own radii follow (2, 4, 4 and 6px) and its body size is 13/20. Shadows only on what floats over the page (tooltips and menus; dialogs and the phone drawer); sections, figures and steps carry none. Spacing on a 4px scale (4, 8, 12, 16, 24, 32, 48); the one value off it is a table cell's 6px vertical padding, which gives a 32px row.

**Surfaces, status and the shell** (built by the slices that follow this record, `docs/handoff/ui-pass-plan.md` section 2): flat sections divided by hairline rules instead of cards; quiet, dense tables with an unfilled header as the main surface; one strip of key figures; state as a small dot and a word; notices as a dot and a sentence on a quiet band; page headers with a trail of where a record sits and the actions on the right; a full-height navigation rail and a wordmark drawn for the product; a sign-in page without the beach; a neutral map.

**Motion.** Quick, short, decelerating, never overshooting, and played once. Tokens in `styles.css :root`, mirrored in `apps/web/src/components/motion.ts`: 80ms (press, tooltip), 120ms (colour, border, chevrons, every exit), 180ms (small entrances), 220ms (page, section and dialog entrances), 320ms (bars, steps, the radar), 480ms (a line drawing), a 24ms stagger and a 4px rise; three curves, decelerate `cubic-bezier(0.2, 0, 0, 1)`, symmetric `cubic-bezier(0.45, 0, 0.55, 1)` and accelerate for exits `cubic-bezier(0.4, 0, 1, 1)`. Each new block of a page rises 4px into place once; the figures strip arrives cell by cell; the result of the reader's own command drops in and the row it changed washes once; a busy table dims; loading pulses, the only loop. Figures being read never move. Every animated selector is repeated exactly in a reduced-motion block (`(prefers-reduced-motion: reduce), (update: slow)`) at the foot of its stylesheet, Fluent's spinner included, and a test fails on one left moving.

## Consequences (security, cost, operations, migration)

- The website reads `brand.json` through `apps/site/scripts/lib/tokens.mjs`, so its colours and text face follow at once; `apps/site/src/styles/site.css` imports the web app's `fonts.css`, so the site renders Plex from the same eight files. Its own restyle comes later in the pass.
- The static preview carries the eight files in its `assets/` folder: 141,992 bytes in all, fetched only for the ranges a page uses. Nothing is loaded from another origin.
- The site's screenshots, tour videos and brochures, and the published demo, show the old look until they are made again.
- No data, permission, route or request changes. No new dependency: the fonts are files, and `motion.ts` uses React only.
- The scene tokens `sky`, `sea` and `sea-deep` stay as formulas because the test and the site's checker read them; nothing paints with them once the sign-in page and the map are restyled.

## SEC IDs affected

None. The pass changes how pages look and move, not what they request, show or allow.

## Verification (what was checked, docs/versions consulted)

- The font files: fetched from the npm registry as `@ibm/plex-sans@1.1.0` and `@ibm/plex-mono@1.1.0`, publication dates read from the registry, each copied file's SHA-256 compared with the file in the package; read with fontTools 4.68: name table version (3.005 sans, 2.004 mono), every digit advancing 600 units, U+2212 and U+00B7 present in the Latin1 files.
- The palette: the formulas of `theme.ts` and every assertion of `apps/web/src/lib/theme.test.ts` replayed over the new values (all AA pairs pass, every forbidden pair still under 4.5), then `theme.test.ts` itself, unchanged but for one added line that checks `--pb-font-mono`.
- The motion: `components/motion.test.ts` holds the tokens of `motion.ts` to `styles.css` and reads every stylesheet of the web app for a selector left moving under reduced motion (it fails on a shorter selector, checked with a fixture); the accessibility spec waits for every finite animation before axe scans and reads, under emulated reduced motion, that a page's sections and a pending page's skeleton do not animate.
- Fluent UI: the installed `@fluentui/react-dialog` 9.18.6 types `surfaceMotion` as a presence slot over Scale parameters (`outScale`, `duration`, `easing`, `exitDuration`, `exitEasing`), which `dialogSurfaceMotion()` returns; `@fluentui/react-spinner` 9.8.7 keeps its ring turning under its own reduced-motion rule, so the policy stops it.

## Supersedes

- Decision 0007: the sign-in scene and the serif page title. Its formulas and its usage rules stand.
- Decision 0017: the sentence on the map's palette (the scene's sky, sea and sand). The map becomes neutral: land in the border grey on a white page, a thin coast, markers in the chart series.
