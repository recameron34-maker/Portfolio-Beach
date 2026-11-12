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
