# 06: Brand and UI (prototype uses a neutral Portfolio Beach theme)

The prototype ships with its **own neutral theme**. A deploying firm's brand is applied later as a theme file in configuration. Never hard-code colors or fonts; use tokens from `config/brand.json`.

## 1. Portfolio Beach default theme (placeholder, change freely)
| Token | Value | Use |
|---|---|---|
| `brand.primary` | #0F4C5C | Header, section headings, table headers |
| `brand.accent` | #2A9D8F | Active states, focus, highlights |
| `brand.sand` | #F4EBD9 | Subtle panels (one-pager tab only) |
| `ui.bg` | #FFFFFF | Background |
| `ui.text` | #1F2328 | Body text |
| `ui.muted` | #6B7280 | Secondary text |
| `ui.border` | #E5E7EB | Card borders |
| `status.good / watch / bad` | #2E7D32 / #B7791F / #C62828 | Status |
Fonts: system UI stack (`"Segoe UI", system-ui, sans-serif`); serif accent for page titles (`Georgia, serif`). Check WCAG AA contrast for all pairs.

Derived tokens (`apps/web/src/app/theme.ts`, decision 0007) are formulas over the values above and are the only other colours the web app may use: tints for hover and selection, inks for status text, the sign-in scene. Usage rules: `--pb-muted` only on the page background; secondary text on any tinted surface uses `--pb-muted-strong`; the accent is never text (use `--pb-accent-ink` when accent-coloured text is unavoidable); status colours as text only through `--pb-good-ink`, `--pb-watch-ink` and `--pb-bad-ink`, with the raw values kept for dots, borders and fills. Chart series come from `chartSeries` (validated for colour-vision safety) and are never used for text.

## 2. Layout rules
- White background, white cards with thin borders; brand color only for headers, table header rows and key numbers.
- Tinted panels only on the deal one-pager tab. Always scope styles to a feature folder.
- Section headers: small uppercase label with an accent underline; no large decorative headline text.
- Navigation groups: Home, Pipeline, Portfolio, Sponsors, Documents, Valuations, Capital Activity, Reporting, Analytics, Assistants, Admin.
- Deal workspace tabs: Overview (one-pager), Performance, Sponsor & Contacts, Diligence, Closing, Valuations, Documents, Tasks, Activity. Reporting Period selector shared across tabs.
- One-pager sections: header banner (company, vehicle, as-of period, investment date), Business Description, Investment Summary at Entry, Deal Details (CV fields shown only for CV deals), Thesis, Sourcing Angle, stat tiles (Invested Capital, Current NAV, Gross MOIC, Gross IRR), Financial Performance table (At Entry, Prior Year, LTM / Current, YoY), Business Highlights, Deal Status.
- Private credit one-pager: the Deal Details section becomes Credit Terms (facility, seniority, coupon split cash / PIK, floor and spread, OID, maturity, call protection, covenants); stat tiles are Funded, Par, Fair Value, Current Yield and Gross IRR; the performance table adds Interest Coverage, Leverage Through Tranche, LTV and Covenant Status. Equity-only fields (EV / EBITDA multiples) are hidden.
- Every AI-generated text shows an "AI draft" badge until approved.

## 3. Number and date display
- $M with one decimal in tables; multiples 1 decimal + "x"; MOIC 2 decimals; IRR 1 decimal %; yields and spreads 2 decimals % (spreads may also show in basis points); coverage ratios 1 decimal + "x"; LTV 1 decimal %.
- Missing or not meaningful: a single `MISSING` constant (a hyphen or "NM"); never 0, Infinity or -100%.
- Prior Year means the same fiscal quarter one year earlier only.
- Dates: "Jan 15, 2026"; investment dates "January 2026"; UTC-safe formatter.

## 4. Generated documents
Template-driven (pptx, docx, xlsx) with stable chart sizes and positions between periods; change logs stored outside the output; disclosures inserted from a disclosure library.

## 5. Motion, and the co-investment map
- Motion is decoration: nothing a reader needs is said only by an animation, and nothing moves under the reduced motion setting (`prefers-reduced-motion`, or a slow display). Every animated selector is listed again in a reduced motion block where it is switched off: the app's in `styles.css` ("Motion policy"), the map's at the foot of `pages/analytics/map/map.css`, the charts' at the foot of `components/charts/charts.css` and the pipeline pages' at the foot of `pages/pipeline/pipeline.css`.
- Durations and easing come from the tokens (`--pb-dur-fast`, `--pb-dur`, `--pb-ease`, `--pb-ease-inout`). An entrance plays once; only a marker under the pointer, in focus or selected keeps moving (its ripple).
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

