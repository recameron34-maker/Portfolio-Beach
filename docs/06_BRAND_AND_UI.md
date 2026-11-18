# 06: Brand and UI (prototype uses a neutral Portfolio Beach theme)

The prototype ships with its **own neutral theme**. A deploying firm's brand is applied later as a theme file in configuration. Never hard-code colors or fonts; use tokens from `config/brand.json`.

## 1. Portfolio Beach default theme (placeholder, change freely)
The look is called the ledger look (decision 0026): ink and neutral greys, one cobalt accent, one sans family with tabular figures.

| Token | Value | Use |
|---|---|---|
| `brand.primary` | #1E3A5F | Ink blue: links, primary buttons, the wordmark's mark |
| `brand.accent` | #4C72D9 | Cobalt: focus ring, current tab underline, current step, selected row edge, chart series 1. Never text |
| `brand.sand` | #EEF0F3 | Neutral panel grey (the key keeps its name for the formulas that read it) |
| `ui.bg` | #FFFFFF | Page |
| `ui.text` | #16191D | Text and every figure |
| `ui.muted` | #68707A | Secondary text, on the page background only |
| `ui.border` | #DCE0E5 | Section rules |
| `status.good / watch / bad` | #2E7D32 / #B7791F / #C62828 | Status (meanings fixed) |
| `chartSeries` | #4C72D9, #D9782B, #2A9D8F, #C9A21C, #C05C86, #4E9A3A, #7A5BD0, #D94A3F | Charts, in this order: cobalt first, orange second |

Fonts: **IBM Plex Sans** 400, 500 and 600 for everything (`fonts.ui`, and `fonts.display`, which is the same stack), bundled with the app from IBM's own unmodified files (`apps/web/src/app/fonts/`, SIL Open Font License 1.1), with Segoe UI and the system face behind it; **IBM Plex Mono** 400 (`fonts.mono`, `--pb-font-mono`) only for hashes, wire digits, lock text and a document's page text. No serif. Every digit has the same width, so figures line up in columns; identifiers such as INV-0001 use the sans. Check WCAG AA contrast for all pairs (`apps/web/src/lib/theme.test.ts`).

Type scale (`styles.css :root`, a size and a line height each; the weight is set where it is used): `--pb-text-xs` 11/16 (axis ticks only), `--pb-text-sm` 12/16 (labels, table headers, sub-lines, status words, crumbs), `--pb-text-md` 13/20 (body, cells, navigation, tabs, buttons, inputs), `--pb-text-lg` 14/20 (section titles), `--pb-text-xl` 16/24 (dialog titles), `--pb-text-title` 20/28 (page titles), `--pb-text-fig` 22/28 (key figures; 20/26 under 760px), `--pb-text-prose` 14/22 (commentary and descriptions, at most 72 characters a line). Weights 400, 500 and 600 only. No uppercase lettering and no tracking, except a slight tightening on titles and figures.

Shape and space: radii `--pb-radius-sm` 2px (identifiers, focus outlines), `--pb-radius` 4px (buttons, inputs, notices, menus), `--pb-radius-lg` 6px (dialogs, popovers). Shadows only on what floats over the page: `--pb-shadow-2` (tooltips, menus) and `--pb-shadow-3` (dialogs, the phone drawer). Spacing `--pb-space-1` to `--pb-space-7` (4, 8, 12, 16, 24, 32, 48px); the one value off the scale is a table cell's vertical padding, `--pb-cell-py` 6px, which gives a 32px row.

Derived tokens (`apps/web/src/app/theme.ts`, decision 0007) are formulas over the values above and are the only other colours the web app may use: tints for hover and selection, inks for status text, the sign-in scene. Colour roles: figures and titles in `--pb-text`; tone is shown only through the ink tokens and dots. Usage rules: `--pb-muted` only on the page background; secondary text on any tinted surface uses `--pb-muted-strong`; the accent is never text (use `--pb-accent-ink` when accent-coloured text is unavoidable); status colours as text only through `--pb-good-ink`, `--pb-watch-ink` and `--pb-bad-ink`, with the raw values kept for dots, borders and fills. Chart series come from `chartSeries` (validated for colour-vision safety) and are never used for text.

## 2. Layout rules
- White background, white cards with thin borders; brand color only for headers, table header rows and key numbers.
- Tinted panels only on the deal one-pager tab. Always scope styles to a feature folder.
- Section headers: small uppercase label with an accent underline; no large decorative headline text.
- Navigation groups: Home, Pipeline, Portfolio, Sponsors, Documents, Valuations, Capital Activity, Reporting, Analytics, Assistants, Admin.
- Each role sees its own areas first (decision 0021, `config/role_focus.json`): the navigation leads with the role's group under the role's name, then "More" and "Data"; tabs inside an area follow the role's order; the home page leads with "Your work" and then the sections that role uses. Nothing is hidden: a link the role's list leaves out keeps its usual place. Focus never hides a tab; access does: a tab is left out only for a role that cannot read what it lists, as the Suggestions tab of the Valuations area is for the roles that do not read valuation suggestions (decision 0023).
- Deal workspace tabs: Overview (one-pager), Performance, Sponsor & Contacts, Diligence, Closing, Valuations, Documents, Tasks, Activity. Reporting Period selector shared across tabs.
- One-pager sections: header banner (company, vehicle, as-of period, investment date), Business Description, Investment Summary at Entry, Deal Details (CV fields shown only for CV deals), Thesis, Sourcing Angle, stat tiles (Invested Capital, Current NAV, Gross MOIC, Gross IRR), Financial Performance table (At Entry, Prior Year, LTM / Current, YoY), Business Highlights, Deal Status.
- Private credit one-pager: the Deal Details section becomes Credit Terms (facility, seniority, coupon split cash / PIK, floor and spread, OID, maturity, call protection, covenants); stat tiles are Funded, Par, Fair Value, Current Yield and Gross IRR; the performance table adds Interest Coverage, Leverage Through Tranche, LTV and Covenant Status. Equity-only fields (EV / EBITDA multiples) are hidden.
- Every AI-generated text shows an "AI draft" badge until approved.

## 3. Number and date display
- $M with one decimal in tables; multiples 1 decimal + "x"; MOIC 2 decimals; IRR 1 decimal %; yields and spreads 2 decimals % (spreads may also show in basis points); coverage ratios 1 decimal + "x"; LTV 1 decimal %.
- Dollars to the cent ("$12,450,950.25") only where two figures are compared with each other and a rounded million would hide the difference between them: what a report check expected and what it found (decision 0024). Worked from the digits of the decimal string, never through a float.
- Missing or not meaningful: a single `MISSING` constant (a hyphen or "NM"); never 0, Infinity or -100%.
- Prior Year means the same fiscal quarter one year earlier only.
- Dates: "Jan 15, 2026"; investment dates "January 2026"; UTC-safe formatter.

## 4. Generated documents
Template-driven (pptx, docx, xlsx) with stable chart sizes and positions between periods; change logs stored outside the output; disclosures inserted from a disclosure library.

## 5. Motion, and the co-investment map
- Motion is decoration: nothing a reader needs is said only by an animation, and nothing moves under the reduced motion setting (`prefers-reduced-motion`, or a slow display). Every animated or transitioned selector is repeated, exactly as it is declared, in a reduced motion block at the foot of its own stylesheet, where it is switched off (a media block adds no specificity, so a shorter selector would lose): the app's in `styles.css` ("Motion policy", which also stops Fluent's spinner), the map's at the foot of `pages/analytics/map/map.css`, the charts' at the foot of `components/charts/charts.css`, the pipeline pages' at the foot of `pages/pipeline/pipeline.css`, and each other stylesheet that animates at its own foot. `apps/web/src/components/motion.test.ts` reads every stylesheet of the web app and fails on a selector left moving.
- Durations and easing come from the tokens in `styles.css :root`, mirrored for script in `apps/web/src/components/motion.ts` (`MOTION`, `EASE`, `useReducedMotion()`), which a test holds to the stylesheet: `--pb-dur-instant` 80ms (a press, a tooltip), `--pb-dur-fast` 120ms (colour, border, a chevron, every exit), `--pb-dur` 180ms (small entrances, a status line), `--pb-dur-enter` 220ms (a page, section or dialog arriving), `--pb-dur-slow` 320ms (a bar growing, a step filling, the radar opening), `--pb-dur-draw` 480ms (a line drawing), `--pb-stagger` 24ms between siblings, `--pb-rise` 4px of travel; `--pb-ease` (decelerate, entrances and hovers), `--pb-ease-inout` (lines drawing, camera moves), `--pb-ease-exit` (exits only). Nothing overshoots.
- What moves: each new block of a page rises 4px into place once, a step behind the one before; the figures strip arrives cell by cell; the result of the reader's own command drops in beside the button and the row it changed washes once; a table whose rows are being replaced dims while it is busy; loading appears only if it lasts and pulses until replaced, the app's only loop. What never moves: a figure being read (no count-up), table rows on a refresh, sort or filter, anything per keystroke, the navigation, titles and the tab row, focus rings. An entrance plays once; only a marker under the pointer, in focus or selected keeps moving (its ripple).
- The co-investment map (decision 0017) uses the sign-in scene's colours the way the scene does: sky and sea for water, sand for land, the brand primary for the coast line. Markers take the chart series by deal type; a marker holding more than one type takes the brand primary. No other colour is introduced.
- The radar chart (decision 0018) takes the first chart series. Its web fades in, its shape opens from the centre and its points land in turn, once. A measure with no score is a dashed spoke with the missing-value placeholder and a gap in the shape, never a point at the centre. The score is printed at every label.
- A map is never the only way to the information: the same positions are in a table under it, and positions it cannot place are listed with the reason.

## 6. Words on the page
The owner asked on 2026-11-12 that the product not "come across as AI generated". What gave it away was mostly its wording, so these are rules:
- **A page never cites the build guide.** No document path ("docs/18 section 4"), control number ("SEC-12.3"), module or phase number ("M8", "Phase 4"), configuration key or file path in anything a person reads. Those belong in comments, test names, documents and pull requests. `apps/web/src/lib/copy-guard.test.ts` reads the page source and fails on one.
- **The API keeps its citations.** A refusal from the API still names the control behind the rule, for the audit trail and the engineer, and tests pin that. The page removes the reference when it shows the sentence (`lib/references.ts`).
- **Say a thing once.** A subtitle does not repeat the tabs under it or a notice beside it. A page title needs a subtitle only when the subtitle tells the reader something the title does not: the as-of date, whose view it is.
- **Not built is "Not built yet".** A planned page says what it will hold. Which phase of the build brings it is the roadmap's business.
- **Quiet beside content.** An empty state inside a card that holds other things is one muted note, with no frame and no mark. The framed version with the horizon mark is for a card that holds nothing else.
- **A badge is for a state that matters.** A step that is simply still ahead gets no badge (the stage strip names only the current step and the ones done). On the pipeline board a deal's type is a line of text, and only an aging deal carries a badge.
- **The work comes first.** Home opens on the portfolio's figures and what needs attention. The preview's walkthroughs sit after it.

