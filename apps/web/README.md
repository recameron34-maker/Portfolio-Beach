# @pb/web

The Portfolio Beach web app: React 19, Vite, TanStack Router and Query, Fluent UI v9, AG Grid Community. Phase 0 scope: theme from `config/brand.json`, prototype sign-in with a role switcher, the navigation groups from `docs/06`, the portfolio grid with calculated metrics, the investment one-pager (equity and private credit variants), Data Health, Data Dictionary and the feature-flag admin page. Areas for later phases show a placeholder naming the phase and modules.

```bash
pnpm --filter @pb/web dev        # http://localhost:5173, proxies /api and /health to the API on 3001
pnpm --filter @pb/web test       # formatters, theme, sign-in (jsdom)
pnpm test:e2e                    # Playwright: starts the API over an in-memory seeded database and Vite, runs journey 1
pnpm test:a11y                   # axe-core WCAG 2.1 AA checks on the Phase 0 pages
```

## Rules this app follows
- No hard-coded colors or fonts: `src/app/theme.ts` builds the Fluent theme and the CSS variables from `config/brand.json` (docs/06 section 1). Styles are scoped in `src/styles.css`; tinted panels appear only on the one-pager's deal-details card.
- Numbers and dates follow docs/06 section 3 through `src/lib/format.ts`: $M with one decimal, MOIC with two, IRR with one decimal percent, yields and spreads with two, dates as "Jan 15, 2026" without time zones. Missing values render the single placeholder from `brand.json`; short-period and multiple-root IRRs render "NM".
- The mock credential lives in session storage for the tab only, never local storage (SEC-4.5). Entra ID with MSAL replaces the picker after merge; the role switcher and the banner disappear with it because the API stops reporting `mockIdentity`.
- Every response is parsed with the shared zod contracts; every error is an RFC 9457 problem. A record the user cannot see is a 404 and renders "Investment not found".

## End-to-end tests
`playwright.config.ts` starts `scripts/e2e-api.mjs` (the real API over PGlite seeded with the small synthetic profile, seed 42) and Vite, then runs `e2e/journey1.spec.ts` (critical journey 1: each role sees only permitted records, the walled deal is hidden from a viewer and visible to a wall member, the role switcher changes the acting user) and `e2e/a11y.spec.ts`. In the cloud sandbox the preinstalled Chromium matches Playwright 1.56.1; elsewhere `pnpm exec playwright install chromium` fetches it. Set `PW_CHROMIUM_PATH` to point at an existing browser if downloads are blocked.

## Static preview
`pnpm --filter @pb/web build:preview` builds `dist-preview/` (gitignored): the app in preview mode plus `preview/fixtures.json`: every API response the Phase 0 screens can request (plus the health, vehicle and sponsor reads kept for screens still to come), recorded from the real API over the small synthetic profile (seed 42) for each mock user, including the 404 a viewer gets for the walled deal. If the recordings cannot be loaded the page says so instead of rendering nothing. In preview mode (`VITE_PB_PREVIEW=true`) `src/preview/shim.ts` answers `/api` and `/health` from those recordings, feature-flag changes are simulated in memory for the page session, and the router uses the URL hash so deep links work from a static host. The build emits no source maps and finishes by running the employer-data guard over the output (`scripts/check-employer-data.sh --paths`), since git never sees that directory. `pnpm --filter @pb/web probe:preview` walks journey 1 against the built preview in headless Chromium. The preview is a static bundle of synthetic data for review, not a deployment: docs/16 section 5 rules out cloud deployment from the prototype and routes hosted demos through IT, and this repo only adds the build. The bundle reaches no server and holds no credentials; where it may be shared is the owner's call.
