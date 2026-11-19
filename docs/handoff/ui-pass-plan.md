# UI pass plan: the ledger look, with motion

Written 2026-11-18 for the UI session on branch `claude/gifted-tesla-eg7s85`. It merges the eight reviews (seven areas and the design system), checked against the code at `5503e38` and the 174 screenshots in `scratchpad/ui/shots/before`. Every path below is relative to `/home/user/Portfolio-Beach` unless it names the scratchpad.

## 0. Intent, what is kept, and the order

**Intent.** The owner asked that the build "look less like a standard anthropic build, throughout". Today the app reads as a generated interface: a teal and sand palette with a beach on the sign-in page, a Georgia title on every page, an uppercase letter-spaced label with a teal underline over every card, rounded white cards nested three deep, filled teal table headers that outshout the figures, a pill for every state, notices with a coloured bar down the left, and the same generous padding where figures are compared. The pass replaces that with one designed language, called here the ledger look: one sans family (IBM Plex Sans, bundled with the app) with tabular figures and a short type scale; ink and neutral greys with one cobalt accent; flat sections divided by hairline rules instead of cards; dense, quiet tables as the main surface; a strip of key figures instead of tile boxes; state as a small dot and a word; page headers with a trail of where the page sits and the actions on the right; a navigation rail and a wordmark drawn for this product. Motion is short, calm and once: content settles 4px into place when it arrives, a chart draws or grows from its baseline the first time it is seen, the result of the reader's own command drops in beside the button, and nothing loops except a loading pulse.

**What is kept.** The colour pipeline (`config/brand.json`, then the formulas of `apps/web/src/app/theme.ts`, decision 0007, then CSS variables) and its AA test, which passes unchanged with the new values (checked, section 2.1). Every request, figure, role check, missing-value placeholder and its reason, table twin, chart summary, keyboard path, test id and class name a test selects. Role focus (it orders, never grants). The Badge's dot and word. The role switcher's combobox semantics that the end-to-end fixtures drive. The Reporting, Packages pages' logic (restyled only). The `docs/06` section 6 copy rules, now enforced on rendered text as well as source.

**The order.** Fourteen slices, each committed alone with every check passing, then a closing step. Four foundation slices set the language (tokens, type and motion; sections, headers, tables and figures; status, notices, states, steps, tabs and controls; the shell and sign-in). Six area slices carry it through (Home and admin; Portfolio; Pipeline; data operations; Valuations and capital; Reporting). Two slices take the charts and then the analytics pages and the map. Slice 13 restyles the website; slice 14 fixes every line of page copy that names the build and extends the guards; the close runs every gate and the whole browser suite and writes the record. Fourteen is two over the aim of twelve: the 800-line limit per slice wins, and the website and the copy guards are unrelated jobs that should not share a commit.

| # | Slice | Plan findings | Est. changed lines |
|---|---|---|---|
| 1 | Tokens, type and the motion system, with the reduced-motion guard | P01 to P05 | 600 (plus 8 font files) |
| 2 | Sections, page headers, tables and figures | P06 to P12 | 700 |
| 3 | Status, notices, states, steps, tabs and controls | P13 to P23 | 780 (twelve dialog files) |
| 4 | The shell and the sign-in page | P24 to P27 | 720 |
| 5 | Home, admin and data pages, assistants | P28 to P35 | 750 |
| 6 | Portfolio and the deal workspace | P36 to P45 | 760 |
| 7 | Pipeline and sponsors | P46 to P54 | 700 |
| 8 | Documents, extraction, monitoring and the data intakes | P55 to P65 | 760 |
| 9 | Valuations and capital activity | P66 to P76 | 730 |
| 10 | Reporting, restyled only | P77 to P87 | 540 |
| 11 | The chart library | P88 to P93 | 660 |
| 12 | Analytics pages and the co-investment map | P94 to P104 | 680 |
| 13 | The website | P105 | 650 (about 330 of them deletions: the hero and scene section of `site.css`, `scene.ts`) |
| 14 | Page copy that names the build, and the guards | P106 | 600 |
| Close | Every gate, the whole browser suite, all shots, the record | none | docs only |

## 1. Ground rules for every slice

### 1.1 Files the pass may change

- `apps/web/src/components/**`, the `.tsx` and `.css` files under `apps/web/src/pages` and `apps/web/src/app`, `apps/web/src/styles.css`, and `apps/site` for the website's look (`apps/site/src/**`; under `apps/site/scripts`, only `lib/tokens.mjs`, and only to add tokens).
- `config/brand.json` colours and fonts (the owner's direction of 2026-11-18). No other config file.
- `docs/06_BRAND_AND_UI.md` sections 1, 2, 5 and 6; a new decision record `docs/decisions/0026-the-ledger-look.md` (0025 is reserved by the handoff for "who decides what"; check the folder before using 0026); one status line each in decisions 0007 and 0017; `docs/SESSION_LOG.md`.
- Tests anywhere under `apps/web` (`src/**/*.test.*`, `src/test/`, `e2e/`) and `apps/site/src/site.test.ts`, when they assert words or structure the slice changes, or to strengthen a guard.

**Named exceptions** (each the smallest way to reach the goal; if the orchestrator holds one closed, use the fallback):

| File | What changes, and only that | Fallback |
|---|---|---|
| `apps/web/src/app/theme.ts` | `cssVariables()` emits `--pb-font-mono`; `createTheme()` sets `fontFamilyMonospace`, the four Fluent radii and `fontSizeBase300`/`lineHeightBase300`. No derived formula changes. | Declare `--pb-font-mono` in `app/fonts.css`; skip the Fluent radius and size values. |
| `apps/web/src/app/nav.ts` | Three labels to sentence case: `Capital activity`, `Data health`, `Data dictionary`. | Leave the words, note for the owner. |
| `.ts` files under `pages` | Copy strings only: `valuations/board.ts` `VARIANCE_TITLE`, `monitoring/monitoring.ts` `thresholdsLine`, `weekly/weekly.ts` `WEEKLY_META`, `intake/intake.ts` `INTAKE_META`, `admin/roles.ts` service sentence; and `extraction/extraction.ts` `valueText`, where the sign moves before the dollar sign (string order, no arithmetic). | None needed. |
| New files | `apps/web/src/app/fonts/` (8 `.woff2` and `LICENSE.txt`), `apps/web/src/app/fonts.css`, `apps/web/src/components/Wordmark.tsx`, `apps/web/src/components/motion.ts` and its test, `apps/web/src/components/charts/SharedScale.tsx`, `apps/web/src/pages/rendered-copy.test.tsx`. | |
| `apps/web/src/lib/copy-guard.test.ts` | A test, so editable; named here because it gains one string-only exception: the line of `lib/assistant.ts` that holds `MOCK_ASSISTANT_LINE` (slice 14). | None needed. |

**New component APIs** (in `components/ui.tsx` unless named; each with its props, so no slice assumes one exists): `Subhead({ children })` (slice 2); `PageHeader` gains `crumbs?: { label: string; to?: string }[]` (slice 2); `TableWrap` gains `tall?: boolean` and `busy?: boolean` (slice 2); `StatTile` gains the `data-zero` attribute, no new prop (slice 2); `Card` gains `panel?: boolean` (slice 2); `SectionHeader` gains `actions?: ReactNode` (slice 2); `Notice({ tone: 'info' | 'good' | 'watch' | 'bad'; children; testId? })` (slice 3); `RowsSkeleton({ rows: number })` (slice 3); `CommandButtons` gains `primary?: string` and `showBlockedReason?: boolean` (slice 3, `WorkflowActions.tsx`); `TabNav` gains `className?: string`, appended after `pb-tabs` (slice 6, for the sticky deal tab bar); `CheckList({ label: string; testId?: string; rows: { check: ReactNode; tone?: Tone; result: ReactNode; detail?: ReactNode; action?: ReactNode }[] })` (slice 5); `PageContext({ items: ReactNode[]; controls?: ReactNode; note?: ReactNode })` (slice 12); `Wordmark({ size?: number })` (`components/Wordmark.tsx`, slice 4); `SharedScale({ children })` (`components/charts/SharedScale.tsx`, slice 11); `ChartFigure` gains `hideCaption?: boolean` (slice 11). There is no `FilePicker`: the file inputs keep their native element (slice 8).

### 1.2 Files the pass leaves alone

`packages/`, `apps/api`, `apps/worker-py`, `tools/`, every migration, `docs/08`, `docs/18`, `apps/web/src/preview/routes`, `apps/web/scripts`, every production module in `apps/web/src/lib` (`grid.ts`, `format.ts`, `references.ts`, `unavailable.ts`, `states.ts`, `tiles.ts`, `preview-guide.ts`, `workflow-spec.ts`, `role-focus.ts`, `media.ts` are read, never edited), `apps/web/index.html`, every value in `config/` other than `brand.json`, `apps/web/src/pages/analytics/map/use-map-view.ts` (a `.ts` file under pages that holds no copy string; the map's motion is set from its callers, slice 12), `apps/site/scripts/check-site.mjs` (a checker, not the look; it reads the site's scene tokens, so they stay in `tokens.mjs`, slice 13). No page changes the requests it sends, the figures it shows, who is offered which action, or how an access rule is read. No arithmetic on money in a page. No control the reader uses today moves behind an extra click at desktop widths; under 760px, secondary controls may fold into one disclosure.

### 1.3 Checks after every slice (handoff section 11)

```bash
cd /home/user/Portfolio-Beach
SCRATCH=/tmp/claude-0/-home-user/9593e3d3-c421-5b4a-b2b1-7c7ce8f36ae0/scratchpad/ui
pnpm typecheck && pnpm lint
pnpm exec vitest run --project web
bash scripts/check-style.sh && pnpm check:employer-data
pnpm --filter @pb/api build && pnpm --filter @pb/web build:preview
( cd apps/web && node scripts/probe-preview.mjs )
( cd apps/web && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome \
    PB_E2E_API_PORT=3141 PB_E2E_WEB_PORT=5184 PB_E2E_DIR=$(mktemp -d -p "$SCRATCH") \
    pnpm exec playwright test e2e/a11y.spec.ts <the slice's specs> --trace off --reporter=line )
```

Each slice names the extra end-to-end specs it must run. The whole browser suite and every gate of handoff section 6 run once, in the close.

**Locators the probe reads.** `apps/web/scripts/probe-preview.mjs` may not change, so every test id, label and role name it reads must still resolve after each slice, inside the same container where it scopes one. List them before a slice with `grep -no "getByTestId([^)]*)\|getByLabel([^)]*)\|getByRole([^)]*)" apps/web/scripts/probe-preview.mjs` and check each one the slice touches. The ones this plan comes closest to: `packages-card` holding the Start package button (slice 10); the label `ai.extraction enabled` on the flag switch (slices 5 and 14); `data-health-tiles` and the table named Definitions (slice 5); `portfolio-count` reading "... positions shown" (slice 6); the Stage buttons named "Stage, <file>", the source buttons named "Show Revenue LTM on page N", the labels Period end and Quarter end (slice 8); Edit draft (slice 9); Export CSV (slices 6 and 12); the flag message containing "is now on (simulated in this preview" (slice 14).

**Locators match a substring.** Playwright's `getByLabel` and `getByRole(..., { name })` match a substring, case-insensitively, unless `exact: true`. A new control whose accessible name contains an old one's makes the old locator match twice and fail strict mode: a crumb "Sponsors" beside the rail's "Sponsors", or a button named "Choose file, Weekly values (CSV)" beside the input labelled "Weekly values (CSV)". New controls get names that do not contain an existing locator's words, and every e2e locator the plan rewrites is scoped to its container (a crumb through `page.getByRole('navigation', { name: 'Breadcrumb' })`).

**Tests that read structure.** A grep for words does not find a test that reads `getAllByRole('row')[1]` or `.slice(1)` as the first body row, counts `thead th`, waits on a test id or asserts a class on a given element. A slice that adds a header row, moves a test id, or changes which element carries a class or a live region names the tests that read that structure; each slice below lists the ones found while planning, and a grep for the test id, the class and `getAllByRole('row')` on the touched table is the authority.

**Tests that assert words.** Before committing, grep the web tests for every visible string the slice changes (`grep -rn --include=*.test.ts* --include=*.spec.ts -F '<old words>' apps/web/src apps/web/e2e`) and update each hit in the same commit. Each slice lists the hits found while planning; the grep is the authority. Playwright's `getByRole(..., { name: 'x' })` matches case-insensitively and by substring unless `exact: true`; Testing Library matches exactly. Unit tests mock the router (`src/test/router-mock.tsx` gives only `useNavigate`, `useParams`, `Outlet`, `Link`): no shared component may start calling another router hook.

**Screenshots.** Copy `$SCRATCH/capture-all.mjs` to `$SCRATCH/capture-after.mjs`, change its output folder to `shots/after` (it deletes its output folder first, so it must never point at `shots/before`), and add an area filter read from `PB_AREAS` (skip a spec whose area is not listed). After the preview build, run `PB_AREAS=<areas> node $SCRATCH/capture-after.mjs` and compare each named shot with its `before` twin at 1440 and 390. The script emulates reduced motion, so the shots show the composed, static page.

**Commit.** One commit per slice, message in the house style, ending with the session's attribution lines. Append a short entry to `docs/SESSION_LOG.md` in every slice (what changed, what was checked, open items), so the record survives if the session stops.

## 2. Decisions the plan takes

Where reviewers proposed different values, this is the one the slices build. The options set aside are in section 7.2.

### 2.1 Colour (config/brand.json)

The design system review's values, checked with `$SCRATCH/plan-calc/palette.mjs` (a copy of the `theme.ts` formulas and every assertion of `lib/theme.test.ts`): every AA pair passes and every "forbidden pair" assertion still holds, so `theme.test.ts` needs no change. The shell review's cobalt `#3258C9` would make two of those assertions fail; it is set aside.

| Token | Old | New | Use |
|---|---|---|---|
| `brand.primary` | #0F4C5C | **#1E3A5F** | Ink blue: links, primary buttons, the wordmark mark, the sign-in panel |
| `brand.accent` | #2A9D8F | **#4C72D9** | Cobalt: focus ring, current tab underline, current step, selected row edge, chart series 1. Never text. |
| `brand.sand` | #F4EBD9 | **#EEF0F3** | Neutral panel grey (key kept for theme.ts, the site and the map code) |
| `ui.bg` | #FFFFFF | #FFFFFF | Page |
| `ui.text` | #1F2328 | **#16191D** | Text and every figure |
| `ui.muted` | #6B7280 | **#68707A** | Secondary text on the page background only |
| `ui.border` | #E5E7EB | **#DCE0E5** | Section rules |
| `status.*` | unchanged | unchanged | Meanings fixed |
| `chartSeries` | teal first | **#4C72D9, #D9782B, #2A9D8F**, then unchanged | Swap 1 and 3: same set, every prefix of three or more unchanged, the pair becomes blue and orange |

Measured: text on bg 17.63; muted on bg 5.02; muted-strong (#555c64) on bg 6.77, on surface-2 6.38, on primary-tint-8 5.88; primary on bg 11.50; accent-ink (#355098) on bg 7.63 and on accent-tint-10 6.75; accent on bg 4.45 (non-text, above 3, still under 4.5 as the test documents); muted on sand 4.39 (still under 4.5); 72% bg on primary 6.81; accent on primary 2.58 (decorative only). Derived results: primary-deep #182e4c, primary-tint-4 #f6f7f9, primary-tint-8 #edeff2, primary-tint-12 #e4e7ec, accent-tint-10 #edf1fb, sand-pale #f7f8f9, sand-edge #dbdde0, surface-2 #f8f8f8, hairline #eaecef, border-strong #c2c5ca. The scene tokens sky, sea and sea-deep remain as formulas the test pins; nothing paints with them after slice 12.

Colour roles: figures and titles in `--pb-text`; tone only through the ink tokens and dots; `--pb-muted` only on the page background (never on surface-2 or a tint; use `--pb-muted-strong` there).

### 2.2 Type

- **IBM Plex Sans** 400, 500, 600 and **IBM Plex Mono** 400, IBM's own unmodified split web files from `@ibm/plex-sans@1.1.0` and `@ibm/plex-mono@1.1.0` (both published 2024-11-11; 2.0.0 of the sans was published today and is too fresh). Licence: SIL Open Font License 1.1, "Copyright 2017 IBM Corp. with Reserved Font Name Plex"; the files are unmodified, so the name may be used. Version 3.005; all ten digits advance 600 units (tabular by default); U+2212 and U+00B7 present. Checked with fontTools.
- Files, already extracted with their hashes at `$SCRATCH/fonts-ibm/`: `IBMPlexSans-{Regular,Medium,SemiBold}-{Latin1,Latin2}.woff2`, `IBMPlexMono-Regular-{Latin1,Latin2}.woff2`, `LICENSE.txt`. 141,992 bytes in all. Copy them to `apps/web/src/app/fonts/`. `scripts/check-style.sh` skips `.woff2`; the licence holds no em dash and no address the employer-data guard blocks.
- `fonts.ui` and `fonts.display` both become `["IBM Plex Sans", "Segoe UI", "system-ui", "sans-serif"]` (keep the `display` key: `theme.ts` and `apps/site/scripts/lib/tokens.mjs` read it); new `fonts.mono` `["IBM Plex Mono", "Cascadia Mono", "Consolas", "monospace"]`. Mono is only for hashes, wire digits, lock text and page text; identifiers such as INV-0001 use the sans with tabular figures.
- Scale (`styles.css :root`): `--pb-text-xs` 11px/16px (axis ticks only), `--pb-text-sm` 12px/16px (labels, table headers, sub-lines, status words, crumbs), `--pb-text-md` 13px/20px (body, cells, nav, tabs, buttons, inputs), `--pb-text-lg` 14px/20px weight 600 (section titles), `--pb-text-xl` 16px/24px (dialog titles), `--pb-text-title` 20px/28px 600 -0.01em (page titles), `--pb-text-fig` 22px/28px 600 -0.01em (key figures; 20px/26px under 760px and in the deal workspace strip). Weights 400, 500, 600 only. No `text-transform: uppercase` anywhere in the app; letter-spacing 0 except title and figure (the wordmark too is set at 0). Each token is a size and line-height pair; the weight is set where it is used (`--pb-text-lg` is 600 in a section title and 500 for a missing key figure). There is no 15px size. Slices write sizes by token name (`font-size: var(--pb-text-sm)`, `line-height: var(--pb-text-sm-lh)`); a px value in this plan is the token's value, written for reading.
- Prose (`.pb-prose`, commentary, descriptions): 14px/22px, max 72ch.

### 2.3 Shape and space

Radii: `--pb-radius-sm` 2px (identifiers, focus outlines), `--pb-radius` 4px (buttons, inputs, notices, menus, map canvas), `--pb-radius-lg` 6px (dialogs, popovers, the sign-in user panel). No 999px except dots (50%). Shadows only on overlays: `--pb-shadow-2` tooltips, map tip, menus; `--pb-shadow-3` dialogs and the phone drawer. Spacing `--pb-space-1` 4px to `--pb-space-7` 48px on a 4px scale (4, 8, 12, 16, 24, 32, 48); every padding, margin and gap in a slice is one of these tokens by name. Below the scale, 1px and 2px appear only as rules and in tight label stacks (a figure over its label). One deliberate off-scale value: a table cell's vertical padding, `--pb-cell-py` 6px (4px in `.is-dense`), which gives a 32px row around a 20px line; docs/06 section 2 records it. Page padding 24px 32px 48px (16px gutters under 760px). Section gap 32px. Top bar `--pb-header-h` 44px (48px under 760px). Rail `--pb-nav-w` 224px.

### 2.4 Surfaces, headers, tables, figures, status, notices

- **Sections, not cards.** `Card` keeps its API and renders a flat section: a 1px `--pb-border` top rule, 16px above the content, 32px below. The first section after the header, the tabs, the figures strip or the analytics context row has no rule. A frame (1px border, `--pb-radius-lg`, no shadow) only for what stands apart: dialogs, menus, the sign-in user list, the package start form (`Card panel`). Two columns are two sections side by side with a 32px gap, each with its own rule.
- **Section titles**: h2, 14px/20px 600 `--pb-text`, sentence case, no underline; aside right-aligned 12px `--pb-muted`; optional actions slot. Sub-title `Subhead` h3 13px/20px 600.
- **Page header**: a grid of crumbs (record pages only), title with actions right-aligned and centred on it, and one meta line. No bottom rule. Area pages keep their current titles (tests assert them); a record's page shows its trail above the title (for example "Valuations / Board" over "Cobalt Energy Group").
- **Tables**: header unfilled (`--pb-bg`), 12px 600 `--pb-muted-strong`, 1px `--pb-border-strong` under it, no vertical rules; 32px rows (`--pb-cell-py` 6px by `--pb-space-2` 8px cells, 13px/20px), hairline between rows, none under the last; figures right-aligned, tabular, nowrap; cells top-aligned; links in `--pb-brand-primary` 500, underline on hover only; identifiers as 12px `--pb-muted-strong` tabular text; total rows in `tfoot` with a `--pb-border-strong` rule and 600; long tables in a height-limited region (`TableWrap tall`) with a sticky header; on phones a sticky first column and an edge shadow that says the table scrolls.
- **Figures**: one strip of cells divided by hairlines, ink figures, tone shown as a 6px dot before the label (not on a zero), hint 12px `--pb-muted`.
- **Status**: dot and word; good in `--pb-text`, watch and bad in their inks; neutral dot `--pb-border-strong`; categories as plain `--pb-muted-strong` text; the preview's "Simulated" and "AI draft" markers as a 6px hollow ring and the word in sentence case (watch-ink and accent-ink).
- **Notices**: a dot and a sentence on a quiet band (`--pb-primary-tint-4`, or the good, watch or bad tint with its ink), radius 4px, no border, no bar.
- **Empty states**: one style: left-aligned title and detail, no frame, no mark.

### 2.5 Navigation, wordmark, sign-in

- **Shell**: grid `'rail top' 'rail main'`. The rail runs the full height (`--pb-surface-2`, 1px right rule, sticky, `100dvh`), wordmark in a 44px cell at its top. The top bar (white, 44px, hairline below) spans the main column only: the prototype marker and its sentence on the left, the user on the right. Under 760px: one 48px bar (menu button, mark, a compact "Prototype" watch dot and word, Sign out) and the navigation in a Fluent `OverlayDrawer`. The `role="status"` element that holds the data rule is rendered once at every width and never inside the closed drawer: on a phone it shows the dot and "Prototype" with the full sentence in a visually hidden span inside it (and in `title`), and the drawer repeats the sentence visibly as plain text.
- **Wordmark** (`components/Wordmark.tsx`, also the site's favicon): a 16px square, 2px radius (`--pb-radius-sm`), in `--pb-brand-primary`, holding three bars of falling length in `--pb-bg`, read as an allocation; then "Portfolio Beach" 14px 600, tracking 0, `--pb-text`.
- **Nav items**: 30px, 13px 500 `--pb-text`, 16px icons in `--pb-muted-strong`, radius 4px; hover `--pb-primary-tint-8`; current: white with a 1px `--pb-border` ring, 600, icon in primary; no accent bar. Group labels 12px 500 `--pb-muted-strong`, sentence case.
- **User**: initials (24px circle, `--pb-primary-tint-12`), the name (`data-testid="current-user"`, unchanged text), the existing Fluent `Dropdown` restyled (size small, its value shows the role words, options grouped by role with `OptionGroup`, listbox at least 280px wide so nothing wraps; `aria-label` and `data-testid` unchanged), Sign out as a subtle small button.
- **Sign-in**: one column, not the split-screen template and no brand panel. A 44px top bar like the app's: the wordmark on the left, the synthetic-data sentence on the right in 12px `--pb-muted-strong` (it wraps under the wordmark under 760px). Below it, at the app's page gutter and left-aligned, a column of at most 640px: the h1 "Sign in", the existing sentence as the page's meta line, then the users as one dense list in a frame (`--pb-radius-lg`, 1px `--pb-border`), grouped by role: a group row (12px 500 `--pb-muted-strong` on `--pb-surface-2`), then one 36px row per user with the name (13px 500) on the left, the role words (12px `--pb-muted-strong`) on the right and a 16px chevron, hairlines between rows. Then the Entra note and the folded walkthroughs. No accent rule, no tagline, no scene.

### 2.6 Charts and map

Chart series 1 is the accent (cobalt). Marks: bars 12px in 26px rows with square ends, gridlines `--pb-hairline`, axis `--pb-border-strong`, ticks 11px tabular, labels 12px `--pb-text`; single-series lines without a wash at 1.75px, no end label for one series. The map is neutral: water `--pb-bg`, land `--pb-border`, country borders `--pb-bg` at 0.6 unit, a thin coast in `--pb-border-strong` (kept so the opening can draw it), no graticule, no gradient, no oval frame; markers keep the chart series by deal type; a selected marker gets a 2px `--pb-text` ring.

## 3. The motion language

One vocabulary for every page, chart, the map and the website: quick (most moves 80 to 220ms), short (4px), decelerating, never overshooting. It confirms that something arrived or that the reader's own action landed. It never carries meaning alone, never moves a figure being read, and is switched off completely by the reduced-motion setting or a slow display.

### 3.1 Tokens

In `styles.css :root`, mirrored for script in `apps/web/src/components/motion.ts` (`MOTION = { instant: 80, fast: 120, base: 180, enter: 220, slow: 320, draw: 480, stagger: 24, rise: 4 }`, `EASE`, `REDUCED_MOTION_QUERY`, `useReducedMotion()`, `dialogSurfaceMotion()`), with `motion.test.ts` reading `styles.css` and failing if the two disagree. `useReducedMotion()` matches `(prefers-reduced-motion: reduce), (update: slow)` and returns true where `matchMedia` is missing (tests), as `use-map-view.ts` does today.

```css
:root {
  --pb-ease: cubic-bezier(0.2, 0, 0, 1);        /* entrances and hovers */
  --pb-ease-inout: cubic-bezier(0.45, 0, 0.55, 1); /* lines drawing, camera moves */
  --pb-ease-exit: cubic-bezier(0.4, 0, 1, 1);   /* exits only */
  --pb-dur-instant: 80ms;  /* press, tooltip */
  --pb-dur-fast: 120ms;    /* colour, border, chevrons, exits */
  --pb-dur: 180ms;         /* small entrances, status lines */
  --pb-dur-enter: 220ms;   /* page, section and dialog entrances */
  --pb-dur-slow: 320ms;    /* bars growing, a step filling, the radar opening */
  --pb-dur-draw: 480ms;    /* a line or sparkline drawing */
  --pb-stagger: 24ms;
  --pb-rise: 4px;
}

@keyframes pb-enter { from { opacity: 0; transform: translate3d(0, var(--pb-rise), 0); } }
@keyframes pb-drop { from { opacity: 0; transform: translate3d(0, calc(var(--pb-rise) * -1), 0); } }
@keyframes pb-fade { from { opacity: 0; } }
@keyframes pb-pop { from { opacity: 0; transform: scale(0.6); } }
@keyframes pb-grow-x { from { transform: scaleX(0); } }
@keyframes pb-tab-in { from { opacity: 0; transform: scaleX(0.4); } }
@keyframes pb-wash { from { background-color: var(--pb-primary-tint-8); } to { background-color: transparent; } }
@keyframes pb-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes pb-pulse { to { opacity: 0.55; } }
```

Every entrance uses `animation-fill-mode: backwards`, never `both`: a finished element keeps no transform (no stacking context around sticky columns, no blurred text), and switching the animation off leaves the element simply in place. A keyframe with only `from` animates to the element's own resting value, so a step segment or a rail grows to whatever length it has.

### 3.2 Entrance and stagger

A CSS animation runs when its element is inserted and never again while it stays mounted. That is the whole mechanism: no wrapper keyed by the path, no remount, no JavaScript. A route change inserts the new page's blocks; a background refetch, a sort, a filter or a page of results reuses them and replays nothing. Pages render fragments, so their blocks are direct children of `.pb-main`; in the deal workspace and Analytics (both a fragment of banner, tabs and `Outlet`) the banner and tabs persist and only the new tab's blocks rise. A page whose body is one wrapper adds `pb-enter-children` to it.

```css
/* Page and tab entrance: each new top-level block, once. The frame (title, tabs) stays still. */
.pb-main > :not(.pb-banner, .pb-tabs, .pb-skeleton, .pb-tiles),
.pb-enter-children > * {
  animation: pb-enter var(--pb-dur-enter) var(--pb-ease) backwards;
}
.pb-main > :nth-child(2), .pb-enter-children > :nth-child(2) { animation-delay: var(--pb-stagger); }
.pb-main > :nth-child(3), .pb-enter-children > :nth-child(3) { animation-delay: calc(var(--pb-stagger) * 2); }
.pb-main > :nth-child(4), .pb-enter-children > :nth-child(4) { animation-delay: calc(var(--pb-stagger) * 3); }
.pb-main > :nth-child(5), .pb-enter-children > :nth-child(5) { animation-delay: calc(var(--pb-stagger) * 4); }
.pb-main > :nth-child(n + 6), .pb-enter-children > :nth-child(n + 6) { animation-delay: calc(var(--pb-stagger) * 5); }

/* The figures strip: cells arrive left to right; a figure never counts up. */
.pb-tiles > * { animation: pb-enter var(--pb-dur-enter) var(--pb-ease) backwards; }
.pb-tiles > :nth-child(2) { animation-delay: 20ms; }
.pb-tiles > :nth-child(3) { animation-delay: 40ms; }
.pb-tiles > :nth-child(4) { animation-delay: 60ms; }
.pb-tiles > :nth-child(5) { animation-delay: 80ms; }
.pb-tiles > :nth-child(6) { animation-delay: 100ms; }
.pb-tiles > :nth-child(7) { animation-delay: 120ms; }
.pb-tiles > :nth-child(n + 8) { animation-delay: 140ms; }

/* The tab that became current: its underline draws in. Plays on every tab change,
   whether the row was re-rendered or kept, because the pseudo-element is created then. */
.pb-tabs a[aria-current='page']::after {
  content: '';
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: -1px;
  height: 2px;
  background: var(--pb-brand-accent);
  animation: pb-tab-in var(--pb-dur) var(--pb-ease) backwards;
}

/* Steps: done segments fill in order, the current one last; after a command only the
   segment whose status changed fills (its animation-name changes from none). */
.pb-steps > li[data-status='done']::before,
.pb-steps > li[aria-current='step']::before {
  transform-origin: left center;
  animation: pb-grow-x var(--pb-dur) var(--pb-ease) backwards;
  animation-delay: calc(var(--i, 0) * 30ms);
}
```

The whole page settles within about 340ms; text is legible from the first frame because only opacity and 4px of travel are animated.

### 3.3 What is interactive

Colour only, never a transform: links, nav items, tabs, quiet buttons, segmented buttons, sign-in rows and Fluent buttons change colour, background or border over `--pb-dur-fast`; a press changes background over `--pb-dur-instant`; a disclosure's chevron turns 90 degrees over `--pb-dur-fast` and its content appears at once (no height animation, so the table below never moves while read). Table row hover and focus rings change instantly, so a pointer running down a dense table leaves no trail. The positions grid's filter and resize controls fade in on header hover or focus over `--pb-dur-fast`.

```css
a, .pb-nav-item, .pb-nav-icon, .pb-tabs a, .pb-btn-quiet, .pb-segmented > button, .pb-signin-row {
  transition:
    color var(--pb-dur-fast) var(--pb-ease),
    background-color var(--pb-dur-fast) var(--pb-ease),
    border-color var(--pb-dur-fast) var(--pb-ease),
    text-decoration-color var(--pb-dur-fast) var(--pb-ease);
}
.pb-btn-quiet:active, .pb-segmented > button:active, .pb-signin-row:active {
  transition-duration: var(--pb-dur-instant);
}
.pb-details > summary::before { transition: transform var(--pb-dur-fast) var(--pb-ease); }
.pb-details[open] > summary::before { transform: rotate(90deg); }
```

### 3.4 Feedback on the reader's own action

The result line drops in beside the controls; the row the command touched washes once from `--pb-primary-tint-8` to clear. The row carries `data-just-changed` set in the mutation's `onSuccess` and cleared on `animationend` (a small `useJustChanged()` in `motion.ts`). Never on a refetch, never on a row the reader did not act on, never on a figure. No toast, no shake on a refusal: the bad tone and the sentence say it, and the `role="status"` region is not animated.

```css
.pb-action-status > *, .pb-action-log > li:first-child {
  animation: pb-drop var(--pb-dur) var(--pb-ease) backwards;
}
.pb-table tr[data-just-changed] > * {
  animation: pb-wash calc(var(--pb-dur-slow) * 2) var(--pb-ease-inout);
}
/* A table whose rows are being replaced (keepPreviousData): aria-busy says the same in words. */
.pb-table-wrap { transition: opacity var(--pb-dur-fast) var(--pb-ease); }
.pb-table-wrap[aria-busy='true'] { opacity: 0.55; }
/* A view the reader swaps in place: the outgoing one leaves at once, the incoming one fades in.
   Set only after the reader's own swap, never on first render, and never with a height change. */
.pb-swap-in { animation: pb-fade var(--pb-dur-fast) var(--pb-ease) backwards; }
```

Views swapped in place: the chart and its table twin (`ChartFigure` adds `pb-swap-in` to the incoming view once the reader has pressed "Show table" or "Show chart"), and a document's page (the page text in `DocumentDetail`'s page view and the drawn page in the extraction run, keyed on the page number, class added only after the reader picks another page).

### 3.5 Dialogs and the phone drawer

Every Fluent `Dialog` gets `surfaceMotion` from `dialogSurfaceMotion(useReducedMotion())`: scale from 0.98 and fade over 200ms on `--pb-ease`, out over 120ms on `--pb-ease-exit`, 0ms when reduced (Fluent itself only checks `prefers-reduced-motion`, so this covers a slow display too). The installed `@fluentui/react-dialog` 9.18.6 types `surfaceMotion` as a presence motion slot with scale parameters; if the slot will not take the parameters, pass a component made with `createPresenceComponent` from `@fluentui/react-motion`, and if neither works leave Fluent's default and record it. Backdrop `rgba(var(--pb-text-rgb), 0.32)`, surface radius 6px and `--pb-shadow-3`. The phone `OverlayDrawer` slides 16px and fades in over `--pb-dur-enter`, out over `--pb-dur-fast`, the same way through its `surfaceMotion` slot.

### 3.6 Loading

```css
/* Appears only if loading lasts; pulses until replaced. The app's only loop.
   Declared after the entrance rules: .pb-main > .pb-skeleton outranks the nth-child delays. */
.pb-skeleton,
.pb-main > .pb-skeleton { animation: pb-fade var(--pb-dur) var(--pb-ease) 120ms backwards; }
.pb-skeleton-bar { animation: pb-pulse 1200ms var(--pb-ease-inout) infinite alternate; }
```

Skeletons take the shape of what replaces them (a 20px title bar, a hairline figures strip, 32px rows), so nothing jumps; the content then rises in where the skeleton was.

### 3.7 Charts and the map

`ChartFigure` keeps an `entering` flag: set once, after `useWidth` reports a real measurement (it gains a `measured` boolean, so nothing animates at the 640px fallback and then jumps), and cleared after the longest mark has finished. It lives on `ChartFigure`, which stays mounted when "Show table" swaps the canvas, so the toggle, a filter, a grouping or a sort never replays it. It is never set when `useReducedMotion()` is true. Axes, gridlines, ticks, the summary and the table twin are there from the first frame.

```css
/* charts.css */
.pb-chart[data-entering] .pb-chart-line {               /* solid series only: path has pathLength="1" */
  stroke-dasharray: 1;
  animation: pb-draw var(--pb-dur-draw) var(--pb-ease-inout) backwards;
}
.pb-chart[data-entering] .pb-chart-end {                /* end markers and end labels */
  animation: pb-fade var(--pb-dur) var(--pb-ease) calc(var(--pb-dur-draw) - 80ms) backwards;
}
.pb-chart[data-entering] .pb-chart-bar {                /* the bar or segment path only; --i on its row group */
  transform-box: fill-box;
  transform-origin: left center;
  animation: pb-grow-x var(--pb-dur-slow) var(--pb-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 8) * var(--pb-stagger));
}
.pb-chart[data-entering] .pb-chart-bar.is-negative { transform-origin: right center; }
.pb-chart[data-entering] .pb-chart-step {               /* the bridge step's path only, in order */
  transform-box: fill-box;
  transform-origin: left center;
  animation: pb-grow-x var(--pb-dur) var(--pb-ease) backwards;
  animation-delay: calc(var(--i, 0) * var(--pb-stagger) * 2);
}
.pb-chart[data-entering] .pb-chart-value {              /* printed values arrive after their bar */
  animation: pb-fade var(--pb-dur) var(--pb-ease) backwards;
  animation-delay: calc(var(--pb-dur-slow) + min(var(--i, 0), 8) * var(--pb-stagger));
}
.pb-chart[data-entering] .pb-chart-reference { animation: pb-fade var(--pb-dur-enter) var(--pb-ease) backwards; }
.pb-chart[data-entering] .pb-chart-point {
  transform-box: fill-box;
  transform-origin: center;
  animation: pb-pop var(--pb-dur) var(--pb-ease) backwards;
  animation-delay: calc(var(--pb-dur-enter) + min(var(--i, 0), 20) * 12ms);
}
.pb-sparkline-line { stroke-dasharray: 1; animation: pb-draw var(--pb-dur-draw) var(--pb-ease-inout) 120ms backwards; }
.pb-sparkline-dot { animation: pb-fade var(--pb-dur) var(--pb-ease) var(--pb-dur-draw) backwards; }
.pb-radar-web { animation: pb-fade var(--pb-dur) var(--pb-ease) backwards; }
.pb-radar-shape { animation: pb-radar-open var(--pb-dur-slow) var(--pb-ease) 80ms backwards; }
@keyframes pb-radar-open { from { opacity: 0; transform: scale(0.85); } }
.pb-radar-point {
  animation: pb-fade var(--pb-dur-fast) var(--pb-ease) backwards;
  animation-delay: calc(240ms + var(--pb-radar-i, 0) * var(--pb-stagger));
}
.pb-chart-tooltip { animation: pb-fade var(--pb-dur-instant) var(--pb-ease); }
```

A dashed series (none today) must not take `pathLength="1"`, because that rescales its dash pattern; it fades instead. The pipeline fit meter fills over `--pb-dur-slow` delayed `calc(80ms + var(--pb-radar-i) * var(--pb-stagger))`, so each measure's bar lands with its point on the radar.

The bar rule animates only the bar or segment `<path>`, which takes the new class `pb-chart-bar`; the bridge rule only the step's `<path>` (`pb-chart-step`). `pb-chart-mark` stays what it is today, the interaction hook on the whole row group (hit rect, label, bar and printed value in `HorizontalBars`, `BridgeChart` and `StackedBars`; every radar axis group; every scatter point), and no animation is ever set on it, so a label or a printed figure is never squashed. `--i` sits on the row group and the path inherits it. The radar keeps its own `pb-radar-*` rules; no bar rule reaches it. The scatter pop (`pb-chart-point`) scales a group that holds only its hit circle and its dot.

The **map** is the one showpiece and stays one, shortened and without the bounce. Opening (`.pb-map.is-intro`): the coast draws over `calc(var(--pb-dur-draw) * 2)` on `--pb-ease-inout`; land fades over 240ms at 240ms; borders over 240ms at 480ms; markers pop (0.6 to 1, `--pb-dur`, `--pb-ease`) at `calc(600ms + min(var(--pb-map-i), 16) * 16ms)`, so it ends near 1.04s instead of about 3s. The overshoot curve `cubic-bezier(0.34, 1.56, 0.64, 1)` is removed from every rule that uses it. A marker that later comes into view: 0.8 to 1 over `--pb-dur-fast`. Hover: the halo fades in over `--pb-dur-fast`. Selection or focus: the ripple plays once (600ms, scale 1 to 2.2, opacity 0.5 to 0), then the static ring holds. Camera moves keep `use-map-view.ts`'s own cubic ease-in-out (the file is not edited, section 1.2); their durations come from `MOTION` at the `flyTo` call sites in `MapTab.tsx` and `WorldMap.tsx`, and they jump when the `reduced` flag, now from `useReducedMotion()`, is true.

### 3.8 Never animated

Figures being read (key figures, cells, tooltip values, map panel figures, scores): no count-up, no cross-fade on refetch, no colour pulse. Table rows on refresh, sort, filter, pagination or selection (AG Grid keeps `animateRows={false}`). Anything per keystroke (quick filter, search, validation messages, counters). The rail, the top bar, the prototype marker, page titles, the tab row itself, focus rings, the crosshair, scrolling (no smooth scroll except a reviewer's explicit pick of a source page, and only without reduced motion). Layout and height changes. The missing-value placeholder and every status marker change instantly. Nothing loops except the skeleton pulse.

### 3.9 Reduced motion

A media block adds no specificity, so a switch-off rule only wins if its selector is at least as specific as the one that animates and comes later. Every animated or transitioned selector is therefore repeated **exactly as it is declared** (same compound, same `:not()`, attribute and pseudo parts), at the foot of the file that animates it, inside `@media (prefers-reduced-motion: reduce), (update: slow)` with `animation: none` and `transition: none`. A shorter form (`.pb-main > *` for `.pb-main > :not(...)`, `.pb-steps > li::before` for `.pb-steps > li[data-status='done']::before`) loses: checked in headless Chromium with `reducedMotion: 'reduce'` (`$SCRATCH/critic2/rm.mjs`), the shorter forms leave `pb-enter`, `pb-fade`, `pb-grow-x` and `pb-drop` running and the exact forms read `none`. Opting every animation in under `(prefers-reduced-motion: no-preference) and (update: fast)` was set aside: the repo's existing blocks (`map.css`, `charts.css`, `pipeline.css`) already use the repeat-exactly form, and one convention is easier to guard. The files: `styles.css` ("Motion policy"), `components/charts/charts.css`, `pages/pipeline/pipeline.css`, `pages/analytics/map/map.css`, `pages/analytics/analytics.css`, `pages/reporting/packages/packages.css`, `pages/deal/deal.css` (the sticky tab bar's stuck state), `pages/valuations/valuations.css` (the chosen suggestion's entrance), `pages/documents/documents.css` and `pages/extraction/extraction.css` (the page swap and the source highlight), and each other data operations stylesheet that adds one. docs/06 section 5 lists every one of these files. JavaScript motion (dialogs, drawer, map camera, chart `entering` flag, the extraction page view's scroll) goes through `useReducedMotion()`. Fluent's spinner keeps turning under reduced motion (its own rule only slows the ring to 1.8s), so the policy stops it; its rules come from Griffel at run time, injected after our stylesheet at one class of specificity, so the policy reaches it at two classes (`.fui-Spinner > .fui-Spinner__spinner`, `.fui-Spinner__spinner > .fui-Spinner__spinnerTail`; check the rendered order of root, ring and tail once in the browser). Under reduced motion the page is the same page, already composed.

```css
@media (prefers-reduced-motion: reduce), (update: slow) {
  /* Each selector exactly as it animates above: same specificity, later in the file, so it wins. */
  .pb-main > :not(.pb-banner, .pb-tabs, .pb-skeleton, .pb-tiles),
  .pb-enter-children > *,
  .pb-tiles > *,
  .pb-tabs a[aria-current='page']::after,
  .pb-steps > li[data-status='done']::before,
  .pb-steps > li[aria-current='step']::before,
  .pb-action-status > *,
  .pb-action-log > li:first-child,
  .pb-table tr[data-just-changed] > *,
  .pb-swap-in,
  .pb-skeleton,
  .pb-main > .pb-skeleton,
  .pb-skeleton-bar,
  .pb-signin-picker > *,
  .pb-signin-row,
  .fui-Spinner > .fui-Spinner__spinner,
  .fui-Spinner__spinner > .fui-Spinner__spinnerTail {
    animation: none;
  }
  a, .pb-nav-item, .pb-nav-icon, .pb-tabs a, .pb-btn-quiet, .pb-segmented > button,
  .pb-signin-row, .pb-details > summary::before, .pb-table-wrap,
  .pb-grid .ag-header-cell-filter-button, .pb-grid .ag-header-cell-resize {
    transition: none;
  }
  .pb-skeleton-bar { opacity: 0.7; }
}
/* charts.css foot */
@media (prefers-reduced-motion: reduce), (update: slow) {
  .pb-chart[data-entering] .pb-chart-line,
  .pb-chart[data-entering] .pb-chart-end,
  .pb-chart[data-entering] .pb-chart-bar,
  .pb-chart[data-entering] .pb-chart-bar.is-negative,
  .pb-chart[data-entering] .pb-chart-step,
  .pb-chart[data-entering] .pb-chart-value,
  .pb-chart[data-entering] .pb-chart-reference,
  .pb-chart[data-entering] .pb-chart-point,
  .pb-chart-tooltip, .pb-sparkline-line, .pb-sparkline-dot,
  .pb-radar-web, .pb-radar-shape, .pb-radar-point {
    animation: none;
  }
}
```

Every rule a later slice adds (the deal tab bar's stuck state, the suggestion detail's entrance, the extraction highlight and page swap, the map, the sort mark, the packages chevron and start panel, the pipeline columns) follows the same form in its own file.

**Proving it.** Three checks:
1. `components/motion.test.ts` gains a guard: for each stylesheet under `apps/web/src` (`styles.css`, `components/charts/charts.css` and every `.css` under `pages`), a small brace-walking reader (no new dependency) collects the selectors of every rule outside a reduced-motion block that sets `animation`, `animation-name` or `transition` to anything but `none`, and fails unless each selector appears verbatim in a `@media (prefers-reduced-motion: reduce), (update: slow)` block of the same file. Rules that set only `animation-delay` or `transition-duration` are exempt. Selector lists split on top-level commas only (`:not(.pb-banner, .pb-tabs)` holds commas); whitespace is normalised before comparing. A working sketch is at `$SCRATCH/critic2/guard.mjs`: it passes on today's 35 animated selectors and fails on the shorter `.pb-main > *` form (`$SCRATCH/critic2/bad.css`). Write the test first in slice 1 and see it fail on the short form, then pass.
2. The accessibility spec gains a `settled(page)` helper, called before every axe scan, that awaits `finished` on every finite animation (`document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity)`), so axe never measures contrast mid-fade.
3. A browser test that, under emulated reduced motion, reads the computed `animationName` and expects `none` for `.pb-main > section`, a skeleton (a page held pending by a delayed route), a done step's `::before` (`getComputedStyle(el, '::before')` on `.pb-steps > li[data-status='done']`), the newest action log entry after a command, `.pb-chart-line` and `.pb-signin-row`; slices 3, 4 and 11 add their selectors to it as they land.

Capture scripts emulate reduced motion, so screenshots never show motion; the close records one short clip with motion on for the owner.

### 3.10 Motion proposals taken, and those not taken

The 74 motion proposals of the eight reviews are all answered by sections 3.1 to 3.9. Taken: the tokens, the once-only entrance and its stagger, the figures strip, the tab underline, colour-only hover and press, the dialog and drawer motion, the result line and the row wash, busy tables, shaped skeletons, every chart entrance (lines draw, bars and bridge steps grow from their baseline, scatter points after their reference line, the radar and fit meter together), the sparkline, the step strip filling, the sticky deal tab bar's stuck state, the flags row wash, swapped views fading in, the shortened map opening with a ripple that plays once, the sign-in settle and the website's shorter reveal. Not taken, with the reason:

- A sliding indicator for the rail and the tab row, measured in script: most tab rows remount with their route, so a slide needs measurement or view transitions; the CSS underline that draws in on every change says the same with no script, and the rail does not move.
- A wrapper keyed by the path around the outlet or the tab panel: CSS animations already run once on insertion; a keyed wrapper would also replay on routes that only change their search.
- Height animation on disclosures, the suggestion detail and the start form (`::details-content` with `interpolate-size`, `grid-template-rows` from 0fr): content below would move while it is read. The chevron turns; the content appears at once, or fades without changing height.
- A scroll-driven shadow under sticky table headers (`animation-timeline: scroll()`): motion tied to scrolling is excluded, and the header's static rule already marks it.
- Lift, scale or shadow on hover and press (map chips and zoom buttons, the website's screenshots): colour changes only.
- Any count-up or cross-fade of a figure: excluded by section 3.8.

## 4. The slices

Each slice: the plan findings it carries (section 5 maps them to the reviewers' ids), files, changes, tests, what it must not change, and its checks.

### Slice 1: Tokens, type and the motion system

**Carries** P01 theme colours, P02 one sans family and the type scale, P03 shape tokens, P04 the motion system, P05 the written look (decision record, docs/06 sections 1 and 5).

**Files**: `config/brand.json`; `apps/web/src/app/fonts/` (new, 8 files and `LICENSE.txt` copied from `$SCRATCH/fonts-ibm/`); `apps/web/src/app/fonts.css` (new); `apps/web/src/app/theme.ts` (named exception); `apps/web/src/styles.css`; `apps/web/src/components/motion.ts` and `motion.test.ts` (new); `apps/web/src/components/charts/charts.css`; `apps/web/src/pages/pipeline/pipeline.css`; `pages/valuations/valuations.css`, `pages/capital/capital.css`, `pages/documents/documents.css`; `apps/web/src/lib/theme.test.ts` (one added assertion); `apps/web/e2e/a11y.spec.ts`; `apps/site/src/styles/site.css` (one `@import` line, see below); `docs/06_BRAND_AND_UI.md` sections 1 and 5 (token lines); `docs/decisions/0026-the-ledger-look.md` (new); status lines in `0007-derived-ui-tokens.md` ("Accepted; the sign-in scene and the serif title are superseded by 0026") and `0017-co-investment-map.md` ("Accepted; the map palette is superseded by 0026"); `docs/SESSION_LOG.md`.

**Changes**
- `brand.json`: the values of section 2.1 and the fonts of 2.2 (`ui`, `display`, new `mono`).
- `fonts.css`: eight `@font-face` blocks, family `'IBM Plex Sans'` (400, 500, 600) and `'IBM Plex Mono'` (400), `font-style: normal`, `font-display: swap`, `src: url('./fonts/IBMPlexSans-Regular-Latin1.woff2') format('woff2')` and so on (no `local()`, so every machine renders the same version), and IBM's own `unicode-range` for Latin1 (`U+0000, U+000D, U+0020-007E, U+00A0-00FF, U+0131, U+0152-0153, U+02C6, U+02DA, U+02DC, U+2013-2014, U+2018-201A, U+201C-201E, U+2020-2022, U+2026, U+2030, U+2039-203A, U+2044, U+20AC, U+2122, U+2212, U+FB01-FB02`) and Latin2 (copy from IBM's `IBMPlexSans-Regular.css`).
- `styles.css`: first statement `@import './app/fonts.css';` (the file itself still names no font); `:root` gets the radius, shadow, spacing, type scale, motion tokens and `--pb-header-h: 44px`; `html, body, #root` 13px/20px with `font-variant-numeric: tabular-nums lining-nums` (Plex is tabular already; this covers the fallback stack); `.pb-prose` 14px/22px max 72ch; the keyframes, page and tab entrance, figures strip stagger, action status drop, row wash, busy table fade, skeleton timing and the motion policy block of section 3, which also stops the Fluent spinner.
- `theme.ts`: `--pb-font-mono:${brand.fonts.mono.join(', ')};` in `cssVariables()`; in `createTheme()` `fontFamilyMonospace`, `borderRadiusSmall: '2px'`, `borderRadiusMedium: '4px'`, `borderRadiusLarge: '4px'`, `borderRadiusXLarge: '6px'`, `fontSizeBase300: '13px'`, `lineHeightBase300: '20px'`. The `derived` block is untouched.
- The four hand-written monospace stacks (`valuations.css:160`, `capital.css:114`, `pipeline.css:273`, `documents.css:73`) become `var(--pb-font-mono)`. `.pb-chart-tooltip` box-shadow becomes `var(--pb-shadow-2)` (the one literal colour in the app).
- Radar and fit meter onto tokens (section 3.7); their reduced-motion lists stay complete.
- The website reads `brand.json` through `apps/site/scripts/lib/tokens.mjs`, so its text switches to the Plex stack in this slice too. So that it renders Plex rather than the fallback until slice 13 restyles it, `site.css` gains `@import '../../../web/src/app/fonts.css';` as its first line (Vite, which loads `site.css` from `index.html`, emits the same files). If the site build or `check:artifact` refuses the path, copy the eight files and the licence to `apps/site/src/styles/fonts/` with a copy of the `@font-face` blocks instead.
- `motion.ts`: `MOTION`, `EASE`, `REDUCED_MOTION_QUERY`, `useReducedMotion()` (built like `lib/media.ts` `useNarrowScreen`), `dialogSurfaceMotion(reduced)`, `useJustChanged()`. `motion.test.ts` reads `styles.css` (resolve the path as `lib/copy-guard.test.ts` does) and checks each `--pb-dur-*`, `--pb-stagger`, `--pb-rise` and ease equals `motion.ts`; and holds the reduced-motion guard of section 3.9 (each animating selector repeated verbatim in its file's reduced-motion block).
- `a11y.spec.ts`: the `settled(page)` helper inside `expectNoSeriousViolations` and `seriousViolations`; the new reduced-motion test of section 3.9, in this slice for `.pb-main > section` and a pending page's `.pb-main > .pb-skeleton`.
- `0026-the-ledger-look.md`: context (the owner's direction, word for word), options (keep and retune; a system stack: three different faces on three platforms and screenshots that never match use; Inter and Geist: the faces most generated interfaces default to, and Inter is the capture machine's own system font; IBM Plex, chosen), decision (palette with its contrast table, Plex with licence, version 3.005, package versions, files, sizes and hashes, the type scale, radii, surfaces, status, motion tokens), consequences (the site follows through `tokens.mjs`; the preview carries the fonts in its `assets/`; 142 KB), verification (fontTools check, `palette.mjs`, `theme.test.ts`), supersedes the scene and serif parts of 0007 and the palette sentence of 0017.
- docs/06 section 1: the new table with purposes, the fonts line, the colour roles of 2.1, chart series order; section 5: the motion tokens (layout rules follow in slices 2 to 4, the map in slice 12).

**Tests**: `lib/theme.test.ts` passes unchanged (proved by `palette.mjs`); add `expect(css).toContain('--pb-font-mono:')`. New `components/motion.test.ts`. `e2e/a11y.spec.ts` as above. No test asserts Georgia, Segoe or a teal value (grepped).

**Must not change**: any derived formula, status colour, the set of chart series colours, page markup, a request.

**Check**: section 1.3 with `e2e/a11y.spec.ts`. After the preview build, `ls apps/web/dist-preview/assets/*.woff2` lists 8 files and `grep -c woff2 apps/web/dist-preview/publish.json` prints 8 (Vite inlines nothing above 4 KB); open `dist-preview/index.html` with the network off and confirm the computed `font-family` resolves to Plex (`document.fonts.check('13px "IBM Plex Sans"')`). Website: `pnpm --filter @pb/site typecheck && pnpm --filter @pb/site test && pnpm --filter @pb/site build:site-only && pnpm --filter @pb/site check`, then `build:artifact` and `check:artifact` (never `pnpm --filter @pb/site build`, which re-records the media). Shots, all areas: compare `shell__home__approver__1440`, `valuations__board__operations__1440`, `analytics__performance__approver__1440`, `shell__sign-in__anonymous__1440`, `portfolio__positions__deal-team__1440` (colour and type only; structure is unchanged in this slice).

### Slice 2: Sections, page headers, tables and figures

**Carries** P06 flat sections, P07 section titles, P08 page header, P09 tables, P10 table links and identifiers, P11 the figures strip, P12 tables on phones.

**Files**: `apps/web/src/styles.css`; `apps/web/src/components/ui.tsx`; `apps/web/src/components/ui.test.tsx`; `docs/06` section 2 (surfaces, type, page header, section titles, tables, figures); `docs/SESSION_LOG.md`.

**Changes**
- `.pb-card`: `background: none; border: 0; border-top: 1px solid var(--pb-border); border-radius: 0; box-shadow: none; padding: 16px 0 0; margin: 0 0 32px`. `.pb-banner + .pb-card, .pb-tabs + .pb-card, .pb-tiles + .pb-card, .pb-page-context + .pb-card { border-top: 0; padding-top: 0 }`. `.pb-card-tinted` renders exactly as `.pb-card` (the prop goes in slice 6). New `Card panel` (`.pb-card.is-panel`: 1px `--pb-border`, `--pb-radius-lg`, padding 16px, no shadow). `.pb-card-error`: no inset bar; its section title in `--pb-bad-ink` after a 6px `--pb-bad` dot. `.pb-two-col`: `gap: 0 32px; margin-bottom: 32px`, sections keep their own rule.
- `.pb-section-header`: 14px/20px 600 `--pb-text`, `letter-spacing: 0; text-transform: none; margin: 0 0 12px`; `> span:first-child` loses its padding and border; `.pb-section-aside` 12px/16px 400 `--pb-muted`. `SectionHeader` gains an optional `actions` slot (right-aligned) and its doc comment is rewritten. New `Subhead` (h3, `.pb-subhead` 13px/20px 600, `margin: 16px 0 4px`, first child 0).
- `PageHeader` gains `crumbs?: { label: string; to?: string }[]` (renders `<nav aria-label="Breadcrumb" className="pb-crumbs"><ol>`; earlier items links, 12px/16px `--pb-muted-strong`, no underline until hover, `/` separators in `--pb-border-strong` drawn by `li + li::before`). No other new prop: a page's command test ids stay on the blocks that hold them today (slice 9). `.pb-banner` becomes the grid of section 2.4: `grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'crumbs crumbs' 'title actions' 'meta actions'; column-gap: var(--pb-space-5); row-gap: 2px; align-items: center; margin: 0 0 var(--pb-space-5); padding: 0; border: 0`. `h1`: `var(--pb-font-ui)` `--pb-text-title` 600 -0.01em `--pb-text`. Meta `--pb-text-md` `--pb-muted`; it wraps onto a second line at any width rather than hide anything (the meta is a node that often holds links, dates and figures; `ExtractionRun.tsx` has eight items). Only a single plain-text item that can run long, such as a file name, takes `.pb-meta-clip` (`max-width: 40ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom`) with that item's own text in `title`. Under 760px a single column, actions under the meta, left-aligned. The meta list keeps its middle dots; under 560px its items stack and the dots go.
- Tables: the CSS of section 2.4. `.pb-table-wrap { margin-inline: -8px; border: 0; border-radius: 0; background: none }` (8px cell padding then aligns text with the section title and lets the hover band run 8px past it), overflow and focus kept. `TableWrap` gains `tall?: boolean` (`.is-tall`: `max-height: min(72vh, 760px); overflow: auto; overscroll-behavior: contain`, `thead th { position: sticky; top: 0; z-index: 1; background: var(--pb-bg) }`) and `busy?: boolean` (sets `aria-busy`). `thead th`: `--pb-text-sm` 600 `--pb-muted-strong`, `letter-spacing: 0`, `height: 32px`, `padding: 0 var(--pb-space-2) var(--pb-space-2)`, `vertical-align: bottom`, `border-bottom: 1px solid var(--pb-border-strong)`; delete the `thead th + th` inset. Body: `padding: var(--pb-cell-py) var(--pb-space-2); vertical-align: top`, row headers `font-weight: 500`; hover `--pb-primary-tint-4` with no transition; `.pb-table tr.is-selected > *` `--pb-primary-tint-8`, its first cell `box-shadow: inset 2px 0 0 var(--pb-brand-accent)` (one rule for every selected row). `.pb-table .num { text-align: right; white-space: nowrap }`. `tfoot td, tfoot th { border-top: 1px solid var(--pb-border-strong); font-weight: 600 }`. `.pb-table.is-dense` (`--pb-cell-py` 4px by `--pb-space-1` 4px cells). Utility `.pb-col-fit { width: 1%; white-space: nowrap }`, `.pb-col-text { min-width: 18ch }`.
- Print: `thead th { color: var(--pb-text); border-bottom-color: var(--pb-text) }`, `thead { display: table-header-group }`, `.pb-table tr { break-inside: avoid }`, `.pb-table-wrap.is-tall { max-height: none; overflow: visible }`. This fixes the printed weekly report, whose white header text vanished on paper.
- Links and identifiers: `.pb-table a { color: var(--pb-brand-primary); font-weight: 500; text-decoration: none }`, underline in `currentColor` on hover and `:focus-visible`. Global `a`: underline 1px in `rgba(var(--pb-primary-rgb), 0.35)`, full primary on hover. `.pb-key`: `display: inline; padding: 0; background: none; border-radius: 0; color: var(--pb-muted-strong); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; margin-right: var(--pb-space-1)`.
- Figures strip: `.pb-tiles { --pb-tile-min: 150px; gap: 0; background: var(--pb-bg); border-block: 1px solid var(--pb-border); overflow: hidden; margin: 0 0 var(--pb-space-6) }`. The rules are drawn by the cells, not by a background showing through a gap (that would paint any empty cell of a short last row, 4 + 3 for seven tiles or 3 + 2 for five, as a solid grey block): `.pb-tiles > * { box-shadow: -1px 0 0 var(--pb-hairline), 0 -1px 0 var(--pb-hairline) }`, a rule on each cell's left and top; the container's `overflow: hidden` clips the ones on the first column and the first row, so only the rules between cells show, and the empty end of a short last row stays plain page. A control inside a cell uses `outline-offset: -2px` so the clip never hides its focus ring. `balanceTiles` reads `columnGap` as 0 and still balances the rows. `.pb-stat-tile { background: var(--pb-bg); border: 0; border-radius: 0; min-height: 0; padding: var(--pb-space-2) var(--pb-space-4) var(--pb-space-3); gap: 2px }`. Label `--pb-text-sm` 500 `--pb-muted-strong`, sentence case, `inline-flex` with a 6px dot `::before` in the tone colour when `data-tone` is set and the value is not zero (`StatTile` adds `data-zero` when `value === '0'`; `data-tone` stays as it is, for tests). Value `--pb-text-fig` 600 `--pb-text` (tone no longer colours it), `.is-missing` `--pb-text-lg` 500 `--pb-muted-strong`. Hint 12px `--pb-muted`. Under 480px `--pb-tile-min: 140px` (two across), value 20px/26px. The `.pb-home-tiles` and `.is-wide` rules stay until slice 5.
- Phones (under 760px): first column sticky (`position: sticky; left: 0; z-index: 1; background: var(--pb-bg); box-shadow: inset -1px 0 0 var(--pb-hairline)`), and the edge cue on `.pb-table-wrap` (two `background-attachment: local` gradients from `var(--pb-bg)` over two `scroll` gradients from `rgba(var(--pb-text-rgb), 0.08)`, 8px wide). `KeyValueTable` reads `useNarrowScreen()` and renders one pair per row under 760px (it stays a table: tests query it by role and name).

**Tests**: `components/ui.test.tsx`: crumbs render a `navigation` named "Breadcrumb" with links; `KeyValueTable` under a stubbed narrow `matchMedia` renders one pair per row (stub as `PreviewGuide.test.tsx:231` does); `StatTile` keeps `data-tone` and adds `data-zero`; `TableWrap busy` sets `aria-busy`. Grep for `data-tone`, `pb-stat`, `pb-card-tinted` before committing. Check the strip at 1440 and 390 on Home (seven tiles, 4 + 3 below 1100px) and the extraction run (five): no grey block at the end of a short row.

**Must not change**: the APIs of `Card`, `SectionHeader`, `PageHeader` (new props only), `TableWrap`, `StatTile`, `CountTile` (`PARTIAL_PAGE_HINT` behaviour), `KeyValueTable`; class names tests select (`.pb-stat-value`, `.pb-table`, `.pb-badge`); table semantics and labels.

**Check**: section 1.3 with `e2e/a11y.spec.ts`. Shots: every area at 1440 and 390; compare in particular `shell__home__approver__1440`, `portfolio__deal-equity-performance__deal-team__1440`, `valuations__board__operations__1440`, `valuations__capital-commitments__operations__1440` (still wide until slice 9), `reporting__weekly-report__investor-relations__1440`, `shell__data-dictionary__platform-admin__390`. Print the weekly report to PDF once (`page.pdf()` in a scratch script against the preview) and confirm the column headers print.

### Slice 3: Status, notices, states, steps, tabs and controls

**Carries** P13 status as dot and word, P14 notices, P15 empty, error and unavailable states, P16 skeletons, P17 the step strip, P18 tabs, P19 fields and quiet controls, P20 shared helpers, P21 touch targets, P22 dialogs, P23 the workflow action components.

**Files**: `apps/web/src/styles.css`; `components/ui.tsx`; `components/StepStrip.tsx`; `components/WorkflowActions.tsx`; `components/UnavailableState.tsx`; the twelve files that render a `DialogSurface` (from `grep -rln DialogSurface apps/web/src`), surface, backdrop and `surfaceMotion` props only: `components/WorkflowActions.tsx` (ReasonDialog), `pages/extraction/dialogs.tsx`, `pages/pipeline/StageActions.tsx`, `pages/pipeline/DiligenceTasks.tsx`, `pages/pipeline/ClosingPanel.tsx`, `pages/capital/DraftTicketDialog.tsx`, `pages/reporting/packages/PackageActions.tsx`, `pages/valuations/Suggestions.tsx`, `pages/valuations/ChangeRequests.tsx`, `pages/valuations/EditValuation.tsx`, `pages/valuations/NewValuation.tsx`, `pages/valuations/Valuations.tsx`; their tests; `docs/06` section 2 (status, notices) and section 6; `docs/SESSION_LOG.md`.

**Changes**
- Badge: `.pb-badge { height: auto; padding: 0; border: 0; border-radius: 0; background: none; gap: var(--pb-space-1); font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: 0; vertical-align: baseline }`. Dot 6px: good `--pb-good`, watch `--pb-watch`, bad `--pb-bad`, brand `--pb-brand-primary`, accent `--pb-brand-accent`, neutral `--pb-border-strong`. Word: good, brand, accent `--pb-text`; watch `--pb-watch-ink`; bad `--pb-bad-ink`; neutral `--pb-muted-strong`. `.pb-badge-plain`: `--pb-muted-strong` text, no dot. `.pb-chips { gap: 4px 12px }`; `.pb-dot` 6px. Comment on `Badge` rewritten.
- Markers: `.pb-simulated, .pb-ai-draft` lose border, fill, uppercase and tracking; 12px/16px 500, `margin-left: 8px`, `::before` a 6px ring (`border: 1.5px solid var(--pb-watch)`, box-sizing border-box); `.pb-ai-draft` in `--pb-accent-ink` with an accent ring. Words, `title` and presence unchanged.
- Notices: `.pb-notice { position: relative; display: block; margin: var(--pb-space-3) 0; padding: var(--pb-space-2) var(--pb-space-3) var(--pb-space-2) var(--pb-space-5); border: 0; border-radius: var(--pb-radius); background: var(--pb-primary-tint-4); color: var(--pb-text) }`, `::before` a 6px dot at `left: var(--pb-space-3)`, vertically centred on the first line (`top: calc(var(--pb-space-2) + 7px)`), in `--pb-brand-accent`; `-good` good tint and ink, new `-watch` watch tint and ink, `-bad` bad tint and ink, each dot in the raw tone. `display: block` also removes the stray gap DO-11 found; a notice that holds a control puts it in a trailing span with `margin-left: 8px`. New `Notice` component (`tone: 'info' | 'good' | 'watch' | 'bad'`, renders the same `<p>`); pages migrate as their slice touches them.
- Empty, error, unavailable: delete `HorizonMark`. `.pb-empty { display: grid; gap: 2px; justify-items: start; padding: 12px 0; border: 0; background: none; text-align: left }`, title 13px/20px 600 `--pb-text`, detail 13px/20px `--pb-muted-strong` max 72ch; on its own in a section or on the page, padding 24px 0 and a 14px title. Delete the `:not(:only-child)` rules. `.pb-empty + .pb-meta { margin-top: 8px }`. `ErrorState` uses the error section of slice 2. `UnavailableState` (forbidden or not ready) renders the same flat empty state: the title `--pb-text-lg` 600, the detail `--pb-text-md`, no icon (it has none today; a lock beside the title would bring back the empty state with a mark, and the title already says "not visible to your role" or "Not built yet"); with `card` it is a flat section, never a framed box.
- Workflow action components: `CommandButtons` with no options renders `<span className="pb-visually-hidden">No actions</span>` instead of a visible "None"; new optional `primary?: string` marks one command `appearance="primary"`, every other stays as today; new `showBlockedReason?: boolean` renders the existing `blockedTitle` text as a visible 12px `.pb-meta` line under the group, linked by `aria-describedby` (pages with a single command group opt in; the board's rows do not). `ActionStatus` keeps its markup exactly: the live region, the keying, the `<p>` and its classes `pb-notice pb-notice-good` or `pb-notice pb-notice-bad` (unit tests assert the class on that paragraph: good at `NoticeDetail.preview.test.tsx:112, 153`, `PackageActions.test.tsx:283, 333`, `WireInstruction.test.tsx:176`, `WireRegister.test.tsx:207`, `Valuations.test.tsx:198`, `Valuations.preview.test.tsx:138`; bad at `PackageActions.test.tsx:540, 562, 583`, `ExtractionRun.test.tsx:708`, `Extraction.test.tsx:225`, `WireInstruction.test.tsx:351`, `WireRegister.test.tsx:286`, `Valuations.test.tsx:249`, `NoticeDetail.preview.test.tsx:209`) and its text (`report-packages.spec.ts:206, 337, 359, 367, 383` read it with exact `toHaveText`, and `Valuations.preview.test.tsx:138` finds it by its exact sentence). No leading word is added: the dot is the notice's `::before`, decoration only, and the log already says Done or Refused. The look changes through CSS alone: `.pb-action-status > .pb-notice-good` renders on the neutral band (`--pb-primary-tint-4`) with a `--pb-good` dot, `.pb-action-status > .pb-notice-bad` on the bad band with its dot (the recorded tone is unchanged; only its look). `ActionLogCard` with no entries keeps its heading and test id and shows one muted line, "No actions yet", with no frame and no second sentence.
- Skeletons: `PageSkeleton` takes the new layout (20px title bar at 30%, a figures strip of hairline-separated blocks, 32px hairline rows with bars at 40%, 15%, 15%, 10%); new `RowsSkeleton rows={n}` for a list loading inside a section (`aria-busy`, visually hidden "Loading", never `role="status"`). Bars in `--pb-primary-tint-8`.
- Step strip (shared by the pipeline and the packages gate; the valuation and notice pages adopt it in slice 9): `li` loses border, fill, radius and inset shadow; `padding: var(--pb-space-2) 0 0`; `::before` a 2px segment across the top (`--pb-border`; done `--pb-muted-strong`; current `--pb-brand-accent`); labels 12px/16px, done `--pb-text`, current `--pb-text` 600 with "Current" in `--pb-accent-ink`, upcoming `--pb-muted-strong` 400 (still named to screen readers only); `column-gap: 4px`; `StepStrip` sets `style={{ '--i': index }}` per item. Delete the 1240px and 560px grid overrides; under 560px the labels of all but the current step become visually hidden and a line "Step 5 of 8: IC" (`aria-hidden`, the list says the same) shows under the row.
- Tabs: the CSS of section 3.2 plus `.pb-tabs { display: flex; flex-wrap: wrap; gap: 0 4px; margin: 0 0 24px; border-bottom: 1px solid var(--pb-border) }`, `a { position: relative; height: 36px; padding: 0 12px; color: var(--pb-muted-strong); font-size: 13px; font-weight: 500 }`, hover `--pb-text`, current `--pb-text` 600 and the underline pseudo-element (the border-bottom underline goes). Keep one comment: tabs wrap on a wide screen; under 760px they are one row that scrolls (`flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; mask-image: linear-gradient(to right, var(--pb-text) calc(100% - 24px), transparent)`). `TabNav` scrolls the current tab into view on mount when `useNarrowScreen()` is true, guarded as `el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })` (jsdom has none).
- Fields and controls: `.pb-field > label, .pb-field > .fui-Label` 12px/16px 500 `--pb-muted-strong`, no uppercase, no tracking. `.pb-toolbar { gap: 12px 16px; margin: 0 0 16px; padding: 0; border-bottom: 0 }`. Shared `.pb-form-row` (flex wrap, `align-items: end`, gap 12px 16px), `.pb-form-grid` (`repeat(auto-fill, minmax(min(100%, 200px), 1fr))`, `align-items: start`), widths `.pb-w-s` 150px, `.pb-w-m` 200px, `.pb-w-l` 260px, each 100% under 760px. `.pb-btn-quiet` and `.pb-segmented` (section 2.4 of the design review: 28px segments, `aria-pressed` gets `--pb-primary-tint-8`, primary text, 600; no transform on press).
- Shared helpers (`.pb-cell-sub` 12px/16px `--pb-muted-strong`; `.pb-details` disclosure with a turning triangle and `summary { display: inline-flex; align-items: center; min-height: 32px }`; `.pb-item-list`; `.pb-marker-row`; `.pb-note` `margin: 8px 0 0` 12px `--pb-muted-strong`; `.pb-actions` flex wrap gap 8px). Page copies are aliased or deleted by each area slice.
- Touch targets: `@media (pointer: coarse), (max-width: 760px) { .pb-main .fui-Button, .pb-tabs a, .pb-nav-item, .pb-chart-toggle, .pb-details > summary, .pb-guide-compact summary, .pb-btn-quiet, .pb-segmented > button { min-height: 44px } .pb-command-buttons, .pb-actions { gap: 8px } }`.
- Dialogs: each `DialogSurface` gets `className="pb-dialog"` and `backdrop={{ className: 'pb-dialog-backdrop' }}`; each `Dialog` gets `surfaceMotion` from `dialogSurfaceMotion(useReducedMotion())`; `.pb-dialog-backdrop { background: rgba(var(--pb-text-rgb), 0.32) }`. `html { scrollbar-gutter: stable }` so opening a dialog no longer shifts the page 15px. No dialog's fields, validation, enablement or handlers change.

**Tests**: `components/ui.test.tsx` (no svg in `EmptyState`; `Notice` tones; `RowsSkeleton` busy); `components/StepStrip.test.tsx` (the summary line; "Upcoming" stays visually hidden text); `components/WorkflowActions.test.tsx` (empty `CommandButtons` reads "No actions" and shows nothing; `ActionStatus` still renders the sentence alone in a `<p>` with `pb-notice-good` or `pb-notice-bad`, so the class assertions and the five exact-text lines of `report-packages.spec.ts` pass unchanged; `ActionLogCard` empty still contains "No actions yet", so `PackageDetail.test.tsx:262`, `Opportunity.test.tsx:180` and `Valuations.test.tsx:472` pass unchanged); grep for `'None'` in page tests of the valuation board, change requests and notices. `e2e/a11y.spec.ts`: the reduced-motion test of section 3.9 gains a done step's `::before` (the pipeline's step strip) and the newest action log entry after a command.

**Must not change**: the words and presence of every badge, marker and status; `lib/states.ts` tones; `ActionStatus` keying and live region; command options, roles, enablement and handlers; the Packages pages' logic; the role focus order of tabs.

**Check**: section 1.3 with `e2e/a11y.spec.ts e2e/suggestions.spec.ts e2e/report-packages.spec.ts` (both open dialogs). Shots: `valuations__suggestion-dismiss-dialog__operations__1440`, `reporting__package-override-dialog__approver__1440`, `pipeline__opportunity-detail__deal-team__1440` and 390, `reporting__package-detail__investor-relations__1440`, `valuations__suggestions-empty__operations__1440`, `dataops__intake-not-shown__viewer__1440`, `shell__admin-audit-trail__auditor__1440`, any 390 shot with tabs (`portfolio__deal-equity-overview__deal-team__390`).

### Slice 4: The shell and the sign-in page

**Carries** P24 the shell, P25 the phone shell, P26 skip link and focus, P27 the sign-in page.

**Files**: `components/AppShell.tsx`; `components/Wordmark.tsx` (new); `components/BeachBackground.tsx` (deleted); `pages/SignIn.tsx`; `components/PreviewGuide.tsx` (sign-in variant label only); `apps/web/src/styles.css` (shell, nav, top bar, drawer, skip link, sign-in; delete `.pb-header` Fluent overrides, `.pb-header :focus-visible`, `.pb-mock-tag` pill, every `.pb-scene*` rule and keyframe); `components/AppShell.test.tsx`; `pages/SignIn.test.tsx`; `e2e/a11y.spec.ts`; `docs/06` section 2 (navigation, sign-in); `docs/SESSION_LOG.md`.

**Changes**
- `AppShell` markup: `<a href="#main" className="pb-skip">Skip to content</a>` first; desktop `aside.pb-rail` (brand cell with `<Link to="/" className="pb-wordmark"><Wordmark /></Link>`, then the existing `nav.pb-nav aria-label="Main"` with the three `NavGroup`s); `header.pb-topbar` (prototype marker on the left: `.pb-mock-banner role="status"` holding a 6px watch dot, "Prototype" 12px 600 and the same sentence in 12px `--pb-muted-strong` with ellipsis and the full text in `title`; spacer; identity: initials, the name with `data-testid="current-user"`, `RoleSwitcher`, Sign out); `main#main.pb-main tabIndex={-1}`. Under 760px (`useNarrowScreen()`): the 48px top bar holds a 44px menu button (`aria-label="Open navigation"`, `Navigation20Regular`), the wordmark, the same `.pb-mock-banner role="status"` element compacted to its watch dot and "Prototype" (the full sentence stays inside it as a visually hidden span and in `title`, so the data rule is still stated at every width and never only inside a closed drawer), and Sign out as an icon button (`aria-label="Sign out"`); the navigation renders inside a Fluent `OverlayDrawer` (position start, 300px) holding the same `NavGroup`s, the identity and the full prototype sentence as plain text (not a second status region); the drawer closes on navigation. Only one `nav aria-label="Main"` and one prototype status element are ever rendered.
- Grid `.pb-shell { grid-template-columns: var(--pb-nav-w) minmax(0, 1fr); grid-template-areas: 'rail top' 'rail main' }`; `.pb-rail { grid-area: rail; position: sticky; top: 0; height: 100dvh; overflow-y: auto; background: var(--pb-surface-2); border-right: 1px solid var(--pb-border) }` (the rule now runs to the bottom of every page); `.pb-topbar { grid-area: top; position: sticky; top: 0; z-index: 30; height: var(--pb-header-h); background: var(--pb-bg); border-bottom: 1px solid var(--pb-hairline); padding: 0 24px }`. Nav and group label styles of section 2.5. `.pb-skip` visually hidden until `:focus`, then top left, `padding: 8px 12px`, `var(--pb-bg)` on `var(--pb-text)`, `z-index: 40`. The focus ring stays the global 2px accent outline (4.45:1 on white and 4.19:1 on the rail's surface-2, both above the 3:1 a focus indicator needs).
- `RoleSwitcher`: keep the `Dropdown`, `aria-label="Switch mock user"`, `data-testid="role-switcher"`, `onOptionSelect` and its four lines of switching logic exactly. Its `value` shows the current user's role words (`ROLE_WORDS`); options keep `text={userLabel(u)}` (the e2e fixtures pick options by display name) and sit in `OptionGroup`s by role in `ROLE_WORDS` order; `listbox={{ className: 'pb-user-list' }}` with `min-width: 280px`.
- `Wordmark`: inline SVG (16 by 16, `aria-hidden`, a 2px-radius `rect` in `var(--pb-brand-primary)` and three `rect` bars of 10, 7 and 4 units in `var(--pb-bg)`) and the name; one prop, `size` (the sign-in page no longer sets it on a brand panel, so there is no second tone).
- Sign-in page per section 2.5, one column, no split screen, no brand panel, no accent rule, no tagline: `.pb-signin-bar` (44px, hairline below: the wordmark left; the synthetic-data sentence right, `--pb-text-sm` `--pb-muted-strong`, wrapping under the wordmark under 760px); `.pb-signin-picker` at the app's gutter, left-aligned, `max-width: 640px` (h1 "Sign in" `--pb-text-title` 600, the existing sentence as its meta line, `.pb-signin-list` framed (`--pb-radius-lg`, 1px `--pb-border`) with `data-testid="mock-user-list"`, one group per role with a group row (`--pb-text-sm` 500 `--pb-muted-strong` on `--pb-surface-2`), each user a `button.pb-signin-row` 36px, full width, with `style={{ '--i': n }}`, `aria-label={userLabel(u)}`, the display name left, the role words right in `--pb-muted-strong`, a 16px chevron, hairlines between rows, the same `onClick`); the Entra note `--pb-text-sm` `--pb-muted`; the folded `PreviewGuide variant="sign-in"` titled "Preview walkthroughs (14)". The error detail becomes "The sign-in service did not answer. Reload the page to try again."; the loading state uses `RowsSkeleton` in the list frame. Motion of section 3: the picker's children `pb-enter` at 0 and 40ms; rows at `calc(80ms + min(var(--i), 12) * 20ms)`, so eleven rows settle by about 520ms; then nothing moves. The reduced-motion block lists `.pb-signin-picker > *` and `.pb-signin-row` exactly as declared.

**Tests**: `AppShell.test.tsx` (the combobox and option names are unchanged; add: the skip link targets `#main`; nav labels unchanged in this slice); `SignIn.test.tsx` (`findByRole('button', { name: /Ops One/ })` still matches through the aria-label; update the error-copy assertion if present); `e2e/a11y.spec.ts:75` "sign-in scene is static under reduced motion" becomes "sign-in is still under reduced motion" reading `.pb-signin-picker > *, .pb-signin-row` (the section 3.9 test gains them here). `AppShell.test.tsx` adds: under a stubbed narrow `matchMedia`, the status element is present outside the drawer and holds the full sentence. `e2e/fixtures.ts` `signInAs` and `switchTo` work unchanged.

**Must not change**: the switching, sign-out and rejected-credential logic; role focus (`navFor`, `focusOf`); nav links, hrefs and order; the `role="status"` sentence's words; `mock-user-list` and `current-user` test ids and texts.

**Check**: section 1.3 with `e2e/a11y.spec.ts e2e/journey1.spec.ts` (switcher, flags). Keyboard: Tab from the address bar lands on "Skip to content", Enter moves focus to `main`. Shots: `shell__sign-in__anonymous__1440` and 390, `shell__home__approver__1440` and 390, `shell__navigation-role-switcher-open__approver__1440`, `analytics__map__approver__1440` (the rail rule reaches the bottom), `shell__taxonomy__platform-admin__1440`.

### Slice 5: Home, admin and data pages, assistants

**Carries** P28 Home, P29 the data dictionary, P30 the Admin tab row and names, P31 the flags page, P32 one checks pattern, P33 Taxonomy, P34 the assistant, P35 the preview guide on Home.

**Files**: `pages/Home.tsx`; `components/NavTrendCard.tsx`; `components/charts/Sparkline.tsx` (classes `pb-sparkline-line`, `pb-sparkline-dot`, `pathLength="1"`); `components/ui.tsx` (`CheckList`, new, props in section 1.1); `pages/Data.tsx`; `pages/admin/Admin.tsx`; `pages/AdminFlags.tsx`; `pages/admin/Taxonomy.tsx`; `pages/assistants/Assistants.tsx`; `pages/assistants/AssistantSwitch.tsx`; `components/PreviewGuide.tsx`; `pages/intake/Intake.tsx` (tab row only); `app/nav.ts` (named exception); `apps/web/src/styles.css` (home, checks, taxonomy, questions, guide); tests; `docs/SESSION_LOG.md`.

**Changes**
- Home: title "Home"; meta "As of Jun 30, 2025. {name}, {role words}. Figures cover the positions visible to you." from the same values (the same words slice 12 uses on the analytics tabs). Figures strip: one row of seven at 1100px and up, four then three below, two under 480px; drop the wide variant and `.pb-home-tiles`; the NAV sparkline (64 by 20) sits under its value; hints name the basis ("Locked marks", "Pooled, XIRR"), the formula moves to the cell's `title` (same words as today). "Your work": a two-column list of 36px rows, link 13px 600 `--pb-text` (underline on hover), its description on the same line in `--pb-muted` with ellipsis; the role sentence becomes the section meta. Attention: a compact table, Company (vehicle as `.pb-cell-sub`) and Flags (dot-and-word list); the counts become one aside line of dots, "3 need action", "2 watch", "11 clear", 16px apart. Capital activity: keep the table; "Overdue" becomes a bad dot and the word beside the date, the date in `--pb-bad-ink`. Charts: drop the inner `SectionHeader` of the exposure card and of `NavTrendCard`; the chart title is the section title; "Show table" stays. Data health: the first three rows of `CheckList`. Section order stays as the role's configuration gives it.
- `CheckList` (new in `ui.tsx`, `.pb-checks`; it does not exist today): `CheckList({ label, testId, rows })` renders a compact `table` named `label` inside `TableWrap`, with `data-testid={testId}` on the wrap, columns Check, Result, Detail and an optional action cell right; 32px rows; an empty detail cell stays blank. Each row's `result` is a node the caller passes and `tone` only draws the dot before it: CheckList adds no word of its own, so no page gains a judgement it does not make today. Readiness passes today's words, "OK" or "Degraded" (`Admin.test.tsx:146, 149` assert them); Data health passes the count in tabular figures with today's tile tone (bad for orphans, watch for open exceptions and stale positions, none otherwise), so a zero carries no dot.
- Data health page: one `CheckList` labelled "Data checks" with `testId="data-health-tiles"` (the probe waits on that id, `probe-preview.mjs:184`, and `e2e/journey1.spec.ts:60` asserts it visible; the id names a strip that is now a list, recorded as an open item for a session that may change the probe): orphan investments (detail: today's hint), open exceptions (action: "Open the queue", same link and search), stale positions (detail: today's hint), locked valuations of the latest quarter (detail: the active position count), client ownership with its sentence; `.pb-stat-link`, which had no rule, goes. Integration health: its readiness table becomes a `CheckList` labelled "Readiness checks" (the name `Admin.test.tsx:144` finds), each check named in words only (a small label map, sentence case of the API's name as fallback; the code is not shown, section 6 of docs/06), "no detail" becomes blank, the page's "Ready" or "Degraded" pill becomes a dot and the same word in the header actions. The kill switches table shows each flag's description in place of its key (the key leaves page text; `Admin.test.tsx:154-155` then assert the description words, "Mail and calendar capture adapter", and that "Kill switch for Ask Portfolio Beach" is absent).
- Data dictionary (presentation only, same query): the table keeps its accessible name "Definitions" (`<table aria-label="Definitions">` inside `TableWrap label="Definitions"`; the probe waits on it, `probe-preview.mjs:187`). Each term a group of rows, the term in words only (a small label map, split camelCase as fallback; the configuration key is not shown, docs/06 section 6); plain values in a tabular value column; object values as nested rows indented 16px, `overflow-wrap: anywhere`; arrays comma-separated; keys starting with `_` skipped at every level. Every shown string value passes through `withoutReferences()` and then drops any clause (split on "; ") that names a file path (`/\b(?:packages|apps|config|docs|tools)\/[\w./-]+/`), so "dollars as exact decimals; AI outputs declare units; convert in packages/calc/units.ts" shows as "dollars as exact decimals; AI outputs declare units" and "... or Azure SQL (docs/13)." as "... or Azure SQL." (display only; the API's value is unchanged). The filter matches the term's words, its key and the shown value; `table.is-dense` in `TableWrap tall`; title "Data dictionary"; meta "{n} terms" (the file path goes).
- Admin tab row: `<TabNav label="Admin" items={ADMIN_TABS} />` on Data health, Data dictionary and Intake, so every page in the row shows it. `nav.ts`: "Capital activity", "Data health", "Data dictionary". `Data.tsx` titles "Data health", "Data dictionary".
- Flags (logic unchanged: the reason of at least three characters, the disabled conditions and the existing `isAdmin` check stay exactly): reason field directly above the table (max 480px), under it 12px `--pb-muted-strong` "Type a reason to unlock the switches. Every change is audited.", "Clear reason" a subtle button at the field's end; the meta keeps "You can change flags; every change needs a reason and is audited." (an e2e spec reads it). Columns: Flag (the description, `--pb-text-md` 500, with today's marker after it exactly where today's `includes('Kill switch')` test puts it, now plain `--pb-muted-strong` text instead of a badge; no Type column, because the data says only which flags are kill switches: `valuation.suggestions` is not an adapter, and `ops.autonomy.observe_only` says "kill switch" in lower case and today's test misses it, so a column would state a category the data does not support), State (dot and "On" or "Off"), Change (the `Switch`, right-aligned, in `.pb-switch-cell { display: inline-flex; align-items: center; gap: var(--pb-space-2) }`, with a 44px row on touch). The key is no longer shown as text; the `Switch` keeps `aria-label={`${f.key} enabled`}` exactly, because the probe clicks `getByLabel('ai.extraction enabled')` (`probe-preview.mjs:255`) and may not change. An accessible name that holds a configuration key is against docs/06 section 6: recorded as an open item for a session allowed to change the probe (then the name becomes "{description}, on" or similar). On success the row washes (`data-just-changed`). Under 760px the columns order Flag, Change, State so the switch stays on screen.
- Access and walls: members as a comma-separated list of names; "Your role" as muted words after the role label.
- Taxonomy: one table, `table-layout: fixed` with a `colgroup` (Code 36%, Label 36%, Parent 16%, Status 12%), one `tbody` per domain opening with a group row (`th colSpan={4}`, domain 13px 600, "{n} terms" muted); `TableWrap tall`; Parent empty when there is none (a fact, not a missing figure); "Active" muted, "Inactive" with a neutral dot; codes in the identifier style; the filter and count in one toolbar row; from 1100px a sticky index of domain links with counts on the left.
- Assistant: state said once (header actions: dot and "Off"; one line "Switched off. A platform admin turns it on under Admin, Flags." with the switch button and the marker on the same row, margin-bottom 24px); questions as a single-column list of 36px text buttons with a chevron, readable in `--pb-muted-strong` with `aria-disabled` while off; from 1100px questions left (360px) and the answer right, the empty answer pane "Choose a question to see the answer and its sources."; sources keep their own labels from `lib/assistant.ts` ("Analytics, Performance", "Admin, Access and walls": more specific than an area name) and lose only the extra `<span className="pb-meta">{s.to}</span>` that prints the route path (`Assistants.tsx:181`). The mock line under the answer is slice 14's.
- Preview guide on Home: the folded form at every width, "Preview walkthroughs" with 14 disclosure rows (two columns from 1100px), sample file names in the identifier style; "turn on AI extraction under Flags" instead of the key; reset row order button, sentence, marker; "Hide guide" unchanged.

**Tests**: `pages/Home.test.tsx` (`'Welcome, Emerson Marchetti'` becomes `'Home'`; `home-tiles` test id kept on the strip); `components/AppShell.test.tsx:129, 146` ("Capital activity", "Data dictionary"); `pages/Data.test.tsx` (`:65` finds `group` "Open exceptions" on a tile: it now finds the row "Open exceptions" in the table "Data checks" and its "Open the queue" link); `pages/admin/Admin.test.tsx` (`:144-149` "Readiness checks" with "OK" twice and "Degraded" pass unchanged; `:154-155` assert descriptions, not keys; Ready as dot and word; the flag table's marker as text); the AdminFlags assertions, wherever they live (grep `Feature flags`); `pages/admin/Taxonomy.test.tsx`; `pages/assistants/Assistants.test.tsx`, `AssistantSwitch.test.tsx`; `components/PreviewGuide.test.tsx`; `components/NavTrendCard.test.tsx`; `pages/intake/Intake.test.tsx` (tab row present); `e2e/journey1.spec.ts:61` passes (case-insensitive heading match).

**Must not change**: every query and figure; Home's section order per role; the flag toggle's mutation and conditions; the assistant switch logic; the role read in `AdminFlags` and `AssistantSwitch` (see section 7.1).

**Check**: section 1.3 with `e2e/a11y.spec.ts e2e/journey1.spec.ts`. Shots: area `shell` (27): `shell__home__*__1440` (7 roles), `shell__home__approver__390`, `shell__data-health__operations__1440` and 390, `shell__data-dictionary__platform-admin__1440` and 390, `shell__admin-flags__platform-admin__1440` and 390, `shell__admin-integration-health__platform-admin__1440`, `shell__admin-access-and-walls__platform-admin__1440` and 390, `shell__taxonomy__platform-admin__1440` and 390, `shell__assistants__platform-admin__1440` and 390, `shell__admin-audit-trail__auditor__1440`.

### Slice 6: Portfolio and the deal workspace

**Carries** P36 the positions grid, P37 the deal workspace header, P38 the Watchlist table, P39 the quarterly tables, P40 deal tabs' empty and not-built states, P41 Overview without tinted panels, P42 vehicles, P43 the outlook card, P44 Activity and Capital activity tabs, P45 the Sponsor tab.

**Files**: `pages/Portfolio.tsx`; `pages/deal/DealWorkspace.tsx`, `deal.css`, `PerformanceTab.tsx`, `parts.tsx`, `ValueCreationCard.tsx`, `UnderwritingCard.tsx`, `LaterTabs.tsx`, `DocumentsTab.tsx`, `SponsorTab.tsx`, `ActivityTab.tsx`, `CapitalTab.tsx`; `pages/InvestmentDetail.tsx`; `pages/portfolio/Watchlist.tsx` (structure; its threshold copy is slice 14), `Vehicles.tsx`, `vehicles.css`; `components/NavTrendCard.tsx` (no end label for one series); `components/ui.tsx` (remove the `tinted` prop and `.pb-card-tinted` once unused); `apps/web/src/styles.css` (grid companions); tests; `docs/06` section 2 (one-pager bullet); `docs/SESSION_LOG.md`.

**Changes**
- Positions grid: `decimalColumn.cellClass` becomes `['ag-right-aligned-cell', 'pb-num']` plus `.pb-grid .ag-cell.pb-num { justify-content: flex-end; text-align: right }`. Column order: Inv # (pinned left, 88), Company (pinned left, flex 1, min 200, `tooltipField`), Invested, Distributed, NAV, Gross MOIC, Gross IRR (100 to 108 each), Status (96, dot and word), then Vehicle, Sponsor, Deal type (each with `tooltipField`) and Entry. Every column stays; `exportDataAsCsv` gets `columnKeys` in today's field order so the file is identical. The grid theme: in `Portfolio.tsx`, `gridThemes.comfortable.withParams({...})` and `compact` likewise, with `headerBackgroundColor: tokens.ui.bg`, `headerTextColor: derived.mutedStrong`, `headerFontWeight: 600`, `headerColumnBorder: false`, `headerColumnResizeHandleColor: tokens.ui.border`, `wrapperBorder: false`, `wrapperBorderRadius: 0`, `accentColor: tokens.brand.accent` (`lib/grid.ts` stays untouched; section 7.1). Header filter and resize controls hidden at rest (`.pb-grid .ag-header-cell:not(:hover):not(:focus-within) .ag-header-cell-filter-button:not(.ag-filter-active)` and `.ag-header-cell:not(:hover) .ag-header-cell-resize` at opacity 0, fading over `--pb-dur-fast`, listed in the motion policy).
- Positions toolbar: drop the "Positions" card and header (the tab names it); one row: Search (min 260, label visually hidden), Deal type with its visible label, Active only, spacer, the count (the existing `<p className="pb-meta" data-testid="portfolio-count">` moved into the toolbar, still filled by `shownLabel()` with today's words, "15 positions shown" or "3 of 15 positions shown": the probe checks `.includes('positions shown')`, `probe-preview.mjs:174`, and `e2e/journey1.spec.ts:22, 37, 39` and `journey6.spec.ts:459` assert `/^\d+ positions shown$/` and `/^1 of \d+ positions shown$/`), a density `ToggleButton` ("Compact rows", `aria-pressed`), Export CSV as a subtle button. Previous and Next under the grid, right-aligned, rendered only when a second page exists (`cursors.length > 0 || page.data?.nextCursor`); requests unchanged. `.pb-grid { height: max(360px, calc(100dvh - var(--pb-header-h) - 220px)) }`. Under 760px Search takes its own line; density and Export may fold into an overflow menu.
- Deal workspace: `crumbs` Portfolio (`/portfolio`) and the vehicle name (`/portfolio/vehicles/$vehicleId`); title the company, then the investment number 13px tabular `--pb-muted-strong` and the status as dot and word; the middot meta line stays; actions right; `data-testid="detail-banner"` stays on the header. Then the figures strip (20px values), then the tab bar, now sticky. `TabNav` gains an optional `className` appended after `pb-tabs` (new prop, section 1.1), so the bar stays a `.pb-tabs` and keeps its exclusion from the page entrance (a wrapper div would be animated as a new block): `<TabNav className="pb-deal-tabs" ...>`, `.pb-tabs.pb-deal-tabs { position: sticky; top: var(--pb-header-h); z-index: 10; background: var(--pb-bg) }` (top 48px under 760px); when stuck its rule darkens to `--pb-border` with `0 1px 0 rgba(var(--pb-text-rgb), 0.06)` over `--pb-dur-fast` (an `IntersectionObserver` sentinel sets `data-stuck`; the transition is declared on `.pb-tabs.pb-deal-tabs` and repeated exactly in a new reduced-motion block at the foot of `deal.css`). The Tasks tab drops `PhasePage` and its second h1.
- Performance tab: "Since entry" and "Value creation" merge into one section titled "Since entry" with the snapshot range as its only aside, then the two strips, the bridge, the narrative (14px/22px `--pb-text`, 72ch) and the indexed chart. A row "On this tab" (12px links to `#since-entry`, `#base-case`, `#quarterly`, `#highlights`, `#outlook`) sits at the right of the sticky tab bar on desktop and under it on phones. Base case missing cells use the small missing style. Section order unchanged.
- Quarterly tables: a group header row in `thead` with `th scope="colgroup" colSpan` (equity: LTM | Balance sheet | Multiples | Year on year; credit: Position | LTM flows | Ratios), while the single columns Period, Status and Source (credit: Period and the two status columns) take `rowSpan={2}` in the first row, so each column has exactly one header cell and `e2e/deal-tabs.spec.ts:118` (`thead th` with text exactly "Source" counts 1) still holds. `.pb-deal-group-start { box-shadow: inset 1px 0 0 var(--pb-hairline) }`, `.pb-deal-dense th.num, td.num { min-width: 8ch; padding: var(--pb-cell-py) var(--pb-space-3); white-space: nowrap }`, Source cell `padding-left: var(--pb-space-4)`; credit covenant and payment in two columns, each dot and word, each keeping today's visually hidden "Covenant" and "Payment" word so the row still reads "Covenant Waiver" and "Payment Current" (`PerformanceTab.test.tsx:545-546`); `PeriodCell` shows "Entry" inline after the date in muted text, spaced by a margin and not by a text space, so the row text still reads "Sep 30, 2025Entry" (`PerformanceTab.test.tsx:260`). A second header row moves the first body row from index 1 to 2, so the tests that read rows by index change in this commit to read body rows (`tbody tr`, or `table.locator('tbody tr')` in Playwright): `e2e/deal-tabs.spec.ts:87` (`getByRole('row').nth(1)` as the latest quarter), `pages/deal/PerformanceTab.test.tsx:111` and `:538` (`getAllByRole('row').slice(1)`) and `:260` (`getAllByRole('row')[1]`). `e2e/journey2.spec.ts:236-243` filters rows by text and passes unchanged. The footnote shortens to "Year on year compares the same fiscal quarter a year earlier; without it the change shows -. Source opens the page the figures were read from." (built with `MISSING`, not a literal hyphen).
- Empty and not-built states: Tasks one line "Not built yet. This tab will list the position's tasks from the task tool, with owners, due dates and reminders, and the approvals waiting on you."; Documents shows its aside only when `n > 0`; Sponsor "Contacts and interactions" a muted line under the other positions; "Other positions with this sponsor" a full-width table (Company link, Vehicle, Deal type) under Funds.
- Overview: drop `tinted` on both cards; key-value rows flat; the Status row goes (the header carries it on every tab); the investment number as plain tabular text; credit terms keep their badges as dot and word. Delete `.pb-card-tinted` and the prop. docs/06 section 2 loses "Tinted panels only on the deal one-pager tab".
- Outlook card: note "Set by hand. The reason is kept on the audit trail."; beside the disabled button 12px `--pb-muted-strong` "Add a reason to save."; a normal-size secondary button.
- Activity: the kind as 12px `--pb-muted-strong` text in the 96px column, no badge; the audit note one muted line. Capital activity tab: one compact strip "Invested capital", "Distributions".
- Vehicles: vehicle detail strip in two labelled groups, "Capital" (Positions, Invested, Distributions, NAV) and "Returns" (DPI, TVPI, Gross MOIC, Gross IRR); `crumbs` Portfolio / Vehicles replace `BackToVehicles`; the footer in 12px `--pb-muted` (its words change in slice 14 with the two other footers). Vehicles list: the bar chart beside the table from 1200px (`.pb-two-col` 2fr 1fr). `NavTrendCard`: no end label for one series.
- Watchlist: `FlaggedTable` in two columns, Position (company link 500, then a `.pb-cell-sub` "INV-0004 · Beach Co-Invest Fund I · Co-investment (equity)") and Flags (each a dot, the label 600, the message in `--pb-muted-strong`), `vertical-align: top`; under 760px the flags sit under the position (still one table, columns stacked by width); the four tiles become the strip; the count said once (keep the aside, drop the fourth tile's hint).

**Tests**: `pages/deal/DealWorkspace.test.tsx`, `PerformanceTab.test.tsx` (note text, footnote, credit columns, and the row-index reads at `:111`, `:260`, `:538` named above), `LaterTabs.test.tsx` ("Not built yet" kept; "Tasks is planned" gone), `DocumentsTab.test.tsx` (aside when empty), `SponsorTab.test.tsx`, `ActivityTab.test.tsx`, `CapitalTab.test.tsx`, `ValueCreationCard.test.tsx`; `pages/portfolio/Watchlist.test.tsx` (two columns), `Vehicles.test.tsx:180, 326` (the "All vehicles" link becomes the crumb "Vehicles", read inside `getByRole('navigation', { name: 'Breadcrumb' })`; "Calc version" stays until slice 14), any Portfolio grid test; `e2e/deal-tabs.spec.ts` (`:87` to body rows; `:118` passes because Source spans both header rows), `journey1.spec.ts` (`portfolio-count` words unchanged), `vehicles-sponsors.spec.ts`.

**Must not change**: the grid's columns, filters, export file and requests; the period selector; every figure and missing reason; role-ordered tabs; `pages/deal/data.ts`.

**Check**: section 1.3 with `e2e/a11y.spec.ts e2e/deal-tabs.spec.ts e2e/journey1.spec.ts e2e/vehicles-sponsors.spec.ts e2e/underwriting.spec.ts`. Shots: area `portfolio` (48), comparing in particular `portfolio__positions__deal-team__1440` and 390, `portfolio__deal-equity-overview__deal-team__1440` and 390, `portfolio__deal-equity-performance__deal-team__1440` and 390, `portfolio__deal-credit-performance__deal-team__1440`, `portfolio__deal-equity-tasks__deal-team__1440`, `portfolio__watchlist__deal-team__1440` and 390, `portfolio__vehicle-detail__operations__1440`, `portfolio__vehicles__operations__390`.

### Slice 7: Pipeline and sponsors

**Carries** P46 the board, P47 board cards, P48 the opportunity page, P49 forms, P50 the stage as a neutral word, P51 the stage reference folded, P52 the sponsor pages, P53 the closing panel (shared with the deal Closing tab), P54 pipeline styles.

**Files**: `pages/pipeline/Pipeline.tsx`, `pipeline.css`, `Opportunity.tsx`, `StageActions.tsx`, `Closing.tsx`, `ClosingPanel.tsx`, `AllocationsEditor.tsx`, `AllocationLines.tsx`, `IcDecisions.tsx`, `DiligenceTasks.tsx`, `NewOpportunity.tsx`, `DealFit.tsx`; `components/WorkflowSpec.tsx` (fold and chips; its copy is slice 14); `pages/sponsors/Sponsors.tsx`, `sponsors.css`; tests; `docs/SESSION_LOG.md`.

**Changes**
- Board: columns for Sourced to Closing only; `.pb-pipe-board { grid-auto-flow: column; grid-template-columns: repeat(7, minmax(148px, 1fr)); align-items: start }`, `.pb-pipe-column { align-self: start; background: var(--pb-bg) }` with a 1px `--pb-border` rule between columns; heading 12px 600 `--pb-text`, sentence case, the count as tabular `--pb-muted-strong` text. Closed and Passed follow the board as an open table "Closed and passed" with the card's fields (deal, company, sponsor and fund, deal type, target, deal lead, days in stage, stage): same rows, same fields, nothing folded. Under 760px each live stage is a section ("Screening 2"), an empty stage its heading and "None". When the filters match nothing, only the one empty state. Columns enter left to right (`--i` per column, section 3.2); cards have no entrance of their own. Keep `data-testid="pipeline-column-<stage>"` on the live columns; give the table `aria-label="Closed and passed"`.
- Cards: `.pb-pipe-card { grid-template-columns: minmax(0, 1fr) auto; gap: 2px var(--pb-space-3); padding: var(--pb-space-2) var(--pb-space-3); background: var(--pb-bg); border: 0; border-bottom: 1px solid var(--pb-hairline); border-radius: 0; box-shadow: none; position: relative }`; delete the watch left bar; three fixed rows: name (13px 600, underline on hover) and target (13px tabular right; muted `MISSING` with `aria-label="Target not recorded"`), company and sponsor (12px `--pb-muted-strong`, ellipsis, full text in `title`), deal type and days in stage (aging: a watch dot and "45 days" in `--pb-watch-ink`, `agingHint` in `title`); the whole card is the link target (`> a::after { content: ''; position: absolute; inset: 0 }`); hover `--pb-primary-tint-4`, border colour change only.
- Opportunity, in order: header with `crumbs` Pipeline, title, the context line with company, sponsor and fund, deal type, received date, deal lead and the four record facts moved up (delete the bottom `KeyValueTable`), actions right (stage as a neutral dot and "IC, 6 days", the `StageActions` buttons at size medium, the marker); the step strip; the figures strip (Days in stage gets a hint only when `agingHint` gives one); one full-width "Gates" section merging the workflow and gates cards, `StageActions` showing the existing `advanceBlocker` sentence as visible `.pb-meta` text beside the disabled button, which reads "Advance to Approved"; diligence tasks; IC decisions and allocations side by side; portfolio fit; stage history at full width (the stage as plain text); the closing summary; the action log.
- Forms: `.pb-pipe-new` uses `.pb-form-grid` (`minmax(min(100%, 260px), 1fr)`, `align-items: start`), controls 32px (40px under 760px); `.pb-pipe-form` a grid with `align-items: start`, the textarea across two tracks. IC decisions: for a role `blockedTitle` refuses, one line (the disabled "Record decision" button with its reason visible) in place of the disabled form; the form stays open, as today, for a role the contract allows. Add task stays an open row under the table. Legal terms form label "Source document (optional)".
- Closing panel (also the deal Closing tab): legal term values rendered at the page by a local helper over `Object.entries(t.value)`: sentence-case words from the key ("Lock up months"), `true` and `false` as Yes and No, one per line (`pipeline.ts termValueText` untouched); "The position exists; record the change through a deal change request." said once at the top; an empty checklist "No checklist items."; an Actions cell blank when nothing is offered; the tie-out as a ledger (Commitment, Allocated: sum of received, Difference, right-aligned tabular, a `--pb-border-strong` rule above Difference, Difference in the good or bad ink, "Tied out" in the section aside), every figure still the API's; "Change close date" moves into the action row beside "Confirm closing"; the add-term form `grid-template-columns: 220px 1fr`, labels top-aligned. `AllocationsEditor` leaves out "Received ..." when there are no lines. Checklist and diligence rows wash after the reader's own change. `.pb-col-fit` and `.pb-col-text` on the checklist, legal terms, diligence and history tables.
- Stage neutral: headers of `Opportunity.tsx` and `Closing.tsx` show the stage as a neutral dot and word; the aging watch tone only when `isAging`; the closing state (Open, Confirmed) keeps its tone. `STAGE_TONES` unchanged. The accent in this area marks only the current step, the primary button, focus and the active fit measure.
- Stage reference: `WorkflowSpec` on the board inside a `.pb-details` that starts closed, summary "How a deal moves between stages", no chips (the table names every state).
- Sponsors: directory header meta `sponsorCountLabel` (plus the more-exist note), search `Input` in the header actions (240px, placeholder "Search sponsors", label visually hidden), the table directly under the header, sticky name column under 560px. Detail: `crumbs` Sponsors; the description under the title 14px max 72ch; the strip replaces the two wide tiles; Funds first, then Our positions, Commitments, Contacts and interactions, each empty state one muted line; aliases as a comma list; tier as text. Delete `.pb-sponsors-back` and the negative margin on `.pb-sponsors-lead`; delete `BackLink` in `Opportunity.tsx` and `Closing.tsx` and the back paragraph in `NewOpportunity.tsx` (crumbs instead, also in their error states).
- Styles: `.pb-pipe-column > h3`, `.pb-pipe-empty` and `.pb-fit-measure.is-active .pb-fit-rule` use `--pb-muted-strong` (they sat on tints); `.pb-pipe-note`, `.pb-pipe-gap`, `.pb-pipe-period` replace the borrowed `.pb-cap-notes`, `.pb-deal-note`, `.pb-deal-gap`, `.pb-deal-period` (or the shared `.pb-note`); the disclosure chevrons turn over `--pb-dur-fast`.

**Tests**: `pages/pipeline/Pipeline.test.tsx:88` (`pipeline-column-Passed` becomes a row of the "Closed and passed" table), `Opportunity.test.tsx` ("Received $" when empty, layout), `NewOpportunity.test.tsx`, IC decision tests, `pages/deal/ClosingTab.test.tsx`, `components/WorkflowSpec.test.tsx` (chips gone), `pages/sponsors/Sponsors.test.tsx:148, 302` ("All sponsors" becomes the crumb "Sponsors", read inside the Breadcrumb navigation), `Closing.test.tsx:94` ("Back to the opportunity" becomes the crumb with the deal's name); `e2e/vehicles-sponsors.spec.ts:99` becomes `page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Sponsors', exact: true })` (an unscoped `getByRole('link', { name: 'Sponsors' })` matches the rail's "Sponsors" link too and fails strict mode), `e2e/journey6.spec.ts` (`pipeline-column-Sourced` kept), `e2e/deal-fit.spec.ts`.

**Must not change**: gating through `PIPELINE_ROLES` and `blockedTitle`; advance, pass, confirm, waive and allocation handlers; every tie-out figure (the API's); `pipeline.ts`; `STAGE_TONES`; the radar and its table twin.

**Check**: section 1.3 with `e2e/a11y.spec.ts e2e/journey6.spec.ts e2e/deal-fit.spec.ts e2e/vehicles-sponsors.spec.ts`. Shots: area `pipeline` (12): `pipeline__board__deal-team__1440` and 390, `pipeline__opportunity-detail__deal-team__1440` and 390, `pipeline__opportunity-closing__deal-team__1440` and 390, `pipeline__new-opportunity__deal-team__1440`, `pipeline__sponsors__deal-team__1440` and 390, `pipeline__sponsor-detail__deal-team__1440` and 390; plus `portfolio__deal-equity-closing__deal-team__1440` and 390.

### Slice 8: Documents, extraction, monitoring and the data intakes

**Carries** P55 area headers and marker placement, P56 figures laid out to compare, P57 monitoring, P58 the staging panel, P59 the extraction review, P60 extraction consistency, P61 expected documents' timing, P62 look-through cells, P63 the exceptions queue, P64 the document page and two subtitles, P65 in-section loading and busy tables.

**Files**: `pages/documents/Documents.tsx`, `DocumentsTable.tsx`, `ExpectedDocuments.tsx`, `DocumentDetail.tsx`, `ReviewQueue.tsx`, `documents.css`; `pages/extraction/Extraction.tsx`, `ExtractionRun.tsx`, `PageView.tsx` (the source highlight, its crossfade and the drawn page's swap live here), `extraction.ts` (`valueText` sign order only), `extraction.css`; `pages/monitoring/Monitoring.tsx`, `monitoring.css`; `pages/intake/Intake.tsx`, `IntakeFile.tsx`, `intake.ts` (`INTAKE_META` words), `intake.css`; `pages/weekly/Weekly.tsx`, `WeeklyFile.tsx`, `weekly.ts` (`WEEKLY_META` words), `weekly.css`; `pages/lookthrough/Lookthrough.tsx`, `LookthroughRun.tsx`, `lookthrough.css`; `pages/exceptions/Exceptions.tsx`, `ExceptionDetail.tsx` (layout; labels are slice 14), `exceptions.css`; `apps/web/src/styles.css` (`.pb-file`); tests; `docs/SESSION_LOG.md`.

**Changes**
- Headers: record pages get `crumbs` (Documents; Documents / Extraction; Intake; Weekly values; Look-through; Exceptions) in place of every `BackLink`; area titles stay as they are; run, document and file status moves into the meta line as a dot and word; the actions slot holds commands only. The Simulated marker moves from section asides to the toolbar end beside the command it qualifies (Index documents, Start extraction, Generate expected documents, Stage, Reconcile, Approve validated rows, the exception actions); `AiDraftBadge` stays in the narrative header.
- Status in rows: severity once on the finding line ("2 findings" with a bad or watch dot) in the findings cells of `IntakeFile.tsx`, `LookthroughRun.tsx` and `ExtractionRun.tsx`; rule ids as `.pb-rule-id` (`var(--pb-font-mono)` 12px `--pb-muted-strong`, comma-separated, no pill); unchanged intake rows show nothing (or the muted words "No change"); exception severity dot and word, state a plain word. Identifiers inline after the company name, not on their own line (`DocumentsTable.tsx`, `ExpectedDocuments.tsx`, `Extraction.tsx`, `Monitoring.tsx`). Hub title and file name single-line with ellipsis (max 420px, full text in `title`); Type column nowrap. Per-page `vertical-align` rules go (slice 2 sets top everywhere).
- Figures to compare: the extraction Value column right-aligned (`th.num`, `td.num pb-nowrap`, the "was" line too); `valueText` writes "-$7.94M" (the sign before the dollar sign; string order only). Intake `DiffCell` a small grid (`display: grid; grid-template-columns: auto auto auto; column-gap: 12px`): field in `--pb-muted-strong`, record right-aligned tabular muted, file right-aligned tabular `--pb-text` 500, from the exported `FIELD_LABELS` and `exactMoney`; `describeChange(c, 'millions')` stays as `title`; a new row leaves the record column empty and is titled "New, nothing on record". Look-through: a watch dot before the provider figure that differs; Differences lists only the field words.
- Monitoring: Quarter and As of in a toolbar under the tabs, above the strip; meta "Quarter ended Jun 30, 2025, as of Jun 30, 2025"; Report split into Report (dot and word, the word links to the document when on file, `aria-label` kept) and Due (`formatDate`, nowrap, the age line muted only when late or missing); Run a dot and word linking to the run; Approval a dot and word with the date muted beside it; Inv # inside the Company cell (sticky on phones).
- Staging: the three file inputs (`Intake.tsx:169, 284`, `Weekly.tsx:110`) stay native `<input type="file">` elements with today's `<label>` words ("Accounting export (CSV)", "Operations workbook (XLSX)", "Weekly values (CSV)": `intake.spec.ts:61, 129`, `ops-drop.spec.ts:22`, `weekly.spec.ts:47, 127` and `a11y.spec.ts:233` find them with `getByLabel` and `setInputFiles`), in the tab order, with their own focus ring. Only their look changes, through a shared `.pb-file` class: `.pb-file::file-selector-button` drawn as the app's secondary small button (`--pb-radius`, 1px `--pb-border-strong`, `--pb-bg`, `--pb-text-md` 500, 28px, `margin-right: var(--pb-space-3)`, colour transition listed in the motion policy), the browser's own "No file chosen" or file name after it in `--pb-muted-strong`; then Stage. No hidden input and no extra button: a visible "Choose file" button whose name held the label's words would make every one of those `getByLabel` calls match twice (Playwright matches a label by substring, `aria-label` included) and fail strict mode, and one named only "Choose file" would give Intake two controls of the same name. `accept`, size checks and handlers unchanged; the drop-folder lists in `Intake.tsx` and `Weekly.tsx` become one table "Waiting in the drop folders" (File, Folder, Received, a right-aligned Stage button; the same buttons and requests); `.pb-card > * + .pb-section-header { margin-top: 24px }`; staging first, then the files list.
- Extraction review: when every decided value has the same `decidedBy` and `decidedAt` (a string compare), say it once above the table and let the decision cell show the dot and word; when `gates.reviewable` is false for the whole run, show `gates.blocked` once above the table and leave out the Actions column (no button there could be pressed); a value and page both null shows `MISSING` with "Not in the document"; Page and Quote become one Source column (a link-styled button "p. 2" in `--pb-accent-ink`, same `aria-label` and handlers, then the quote 12px `--pb-muted-strong`); the selected row uses the shared `.is-selected`. The page view's highlight crossfades over `--pb-dur-fast`; on an explicit pick the frame scrolls the quote into view (`behavior: 'smooth'` only when `useReducedMotion()` is false). When the reader picks another page, the drawn page here and the page text in `DocumentDetail`'s page view, keyed on the page number, take `pb-swap-in` (section 3.4); the highlight and the swap are listed in the reduced-motion blocks at the foot of `extraction.css` and `documents.css`. Decided rows wash. Quote and title columns take `min-width` (`.pb-extraction-quote` 160 to 260px, `.pb-documents-title` 220px, `.pb-exceptions-text` 140px; `overflow-wrap: break-word`), so a phone scrolls the table instead of breaking "reven/ue".
- Extraction page: the batch period an `<Input type="date">` (it returns YYYY-MM-DD, so `batchFormProblem` works as before); Start extraction `size="small"`; Tokens split into "Tokens in" and "Tokens out" `NumCell`s; error codes as `.pb-rule-id`; the explanation "Reads every classified document of this type for the quarter, removes personal details and stages the values for review. Quarterly financials and capital account statements can be read today." with `extractableTypesText()` kept.
- Expected documents: "Age (days)" becomes "Timing" showing `ageTitle(row)` ("45 days before due") right-aligned tabular, the signed number in `title`; the Document column's placeholder `<td className="is-missing">{MISSING}</td>` aligned left with the links.
- Look-through: the provider label alone when `labelOf(code)` equals it; otherwise the provider label and a muted "maps to Software"; unmapped a watch dot and "Not mapped"; first line nowrap.
- Exceptions: Rule as `.pb-rule-id` link, sticky on phones; Context one line ("lookthrough-2025-06-30.json, row 8", the file name the link) with the position as a muted second line; Owner "Unassigned" in `--pb-muted-strong`, Ticket "None"; Expected and Actual nowrap, min 140px. Detail: "What the intake found" leads with Expected and Actual as a two-column pair (14px 600 tabular), the rest in the key-value table.
- Document page: the header meta keeps the subject links and the period; file name and received date stay only in the metadata; the type as text in the meta, omitted when null. `WEEKLY_META` "Weekly values checked against the last locked mark; an approved value becomes a draft valuation"; `INTAKE_META` "Accounting exports and operations workbooks, checked row by row before anything is written".
- Loading and busy: `RowsSkeleton` replaces `PageSkeleton` inside list sections (hub, runs, batches, pages); tables fed by `keepPreviousData` pass `busy={isPlaceholderData}` to `TableWrap` (hub, monitoring board, exceptions queue, extraction runs, staged rows). Findings disclosures use the shared `.pb-details`; the three per-page `.pb-*-details` rules go.

**Tests**: `pages/extraction/ExtractionRun.test.tsx` (Actions column absent when not reviewable, Source column, Tokens), `Extraction.test.tsx`, `extraction.test.ts` (add `valueText('-7.94', 'USD_M', 'money')` is "-$7.94M"); `pages/intake/IntakeFile.test.tsx`, `Intake.test.tsx` ("Staging, validation, approval" meta), `pages/weekly/Weekly.test.tsx` ("Weekly report values to valuation staging"), `WeeklyFile.test.tsx`; `pages/documents/ExpectedDocuments.test.tsx` ("Age (days)"), `DocumentDetail.test.tsx:123, 354` ("All documents" link becomes the crumb "Documents"), and the other back links that become crumbs, each read inside `getByRole('navigation', { name: 'Breadcrumb' })`: `ExtractionRun.test.tsx:129, 806` ("All extraction runs"), `ExceptionDetail.test.tsx:83, 293` ("All exceptions"), `WeeklyFile.test.tsx:87, 374` ("All weekly files"), `LookthroughRun.test.tsx:77, 234` ("All reconcile runs"), `IntakeFile.test.tsx:95, 490` ("All intake files"), `Documents.test.tsx`, `ReviewQueue.test.tsx`; `pages/monitoring/Monitoring.test.tsx`; `pages/lookthrough/LookthroughRun.test.tsx`; exceptions tests; `e2e/documents.spec.ts`, `monitoring.spec.ts`, `intake.spec.ts`, `weekly.spec.ts`, `ops-drop.spec.ts` (the file inputs keep their labels, so these pass unchanged), `lookthrough.spec.ts` (`:210` clicks `getByRole('link', { name: 'All exceptions' })`: it becomes `page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Exceptions', exact: true })`, scoped because the rail's Data group has an "Exceptions" link too).

**Must not change**: requests; accept, edit and reject handlers and gates; staging checks; the import pages' role checks (section 7.1); every figure, exact to the cent.

**Check**: section 1.3 with `e2e/a11y.spec.ts e2e/documents.spec.ts e2e/monitoring.spec.ts e2e/intake.spec.ts e2e/weekly.spec.ts e2e/lookthrough.spec.ts e2e/ops-drop.spec.ts`. Shots: area `dataops` (33), comparing in particular `dataops__extraction-run__operations__1440` and 390, `dataops__extraction-run-approved-statement__operations__1440`, `dataops__intake-file__operations__1440` and 390, `dataops__monitoring__operations__1440` and 390, `dataops__documents-hub__operations__1440`, `dataops__documents-expected__operations__1440`, `dataops__look-through-run__operations__1440`, `dataops__exceptions__operations__1440` and 390, `dataops__intake__operations__1440`.

### Slice 9: Valuations and capital activity

**Carries** P66 the commitments table, P67 one step strip, P68 the forward command in the header, P69 the area's empty states, P70 suggestions as list and detail, P71 holds and alerts, P72 inputs as key-value pairs, P73 the actions column and "Due today", P74 figures and the variance flag slot, P75 long registers, P76 area headers and markers.

**Files**: `pages/valuations/Valuations.tsx`, `ValuationDetail.tsx`, `Suggestions.tsx`, `SuggestionWorkings.tsx`, `ChangeRequests.tsx`, `valuations.css`; `pages/capital/CapitalActivity.tsx`, `NoticeDetail.tsx`, `TradeTickets.tsx`, `WireRegister.tsx`, `WireTable.tsx`, `WireInstruction.tsx`, `Commitments.tsx`, `capital.css`; tests; `docs/SESSION_LOG.md`.

**Changes**
- Commitments: fold the descriptive columns into second lines (Sponsor fund cell: fund name, then `.pb-cell-sub` "Sponsor · 2018 · Buyout"; Vehicle cell: vehicle, then the client), so the table has Sponsor fund, Vehicle, Committed, Called, Distributed, Recallable, Unfunded, Committed on, and every figure still shows; remove the `.pb-cap-name` min-width; `td.num { width: 1%; white-space: nowrap }`; the over-called word on the figure's line as a watch dot and word; the total row in `tfoot` (`--pb-text` 600, `--pb-border-strong` rule), still the API's row. The two footnotes' words change in slice 14.
- One step strip: `ValuationDetail.tsx` and `NoticeDetail.tsx` render `StepStrip` (`label` "Valuation progress" or "Notice progress", steps mapped from `valuationSteps` and `progressSteps` with `humanizeState`); delete `.pb-val-progress`, `.pb-val-step*`, `.pb-cap-progress`, `.pb-cap-step*` and their media rules (about 120 lines).
- Forward command: in `ValuationDetail.tsx` and `NoticeDetail.tsx` the Workflow card becomes a flat command block directly under the header (no "Workflow" heading, no rule, no frame) that keeps `data-testid="valuation-workflow"` and `"notice-workflow"` and holds everything the card holds today, in this order: the command row (`CommandButtons` with `primary` set to the forward command (lock, approve, prepare, review, draft ticket) and `showBlockedReason`; on a Draft the "Edit draft" button beside them, same disabled state and `title`; the Simulated marker at the row's end); `ActionStatus`; the `valuation-reopened` notice, its classes and link unchanged; the last-step sentence when no command is left ("Reconciled is the last step; nothing further to do.", "Reopened is the last step of this version; ..."); the Edit draft note, the command notes, the reopen reason and the bank-details rule as muted lines. Nothing moves into `PageHeader`, so every reader finds what it finds today inside the same test id: `e2e/journey3.spec.ts:278, 294, 323, 341, 400, 411`, `e2e/journey4.spec.ts:99, 343` ("Reconciled is the last step; nothing further to do." inside `notice-workflow`), `ValuationDetail.test.tsx:266, 339`. Same options, roles and handlers. The board: `VersionTable` passes `appearance` subtle for Reopen and keeps outline for a forward command; Actions right-aligned; a disabled "New valuation" shows `newTitle` as a muted line under the header actions too. Rows wash after a command on the board, change requests and wire register.
- Area headers: record pages `crumbs` (Valuations / Board; Valuations / Suggestions; Capital activity / Notices; Capital activity / Wire register) replacing `BackLink`; titles stay; each tab's long rule sentence leaves the meta and becomes one muted line at the top of the tab body (`Valuations.tsx` Gate: "Reports read Locked versions only. In this preview, simulated changes do not recalculate NAV, MOIC or IRR."); detail titles followed by the muted tabular suffix ("Jun 30, 2025 · v1") and the state as a dot and word. Simulated markers beside the command they qualify, every instance kept.
- Empty states: `MissingMarksCard` one muted sentence when none are missing; `LockCard` "Not locked" one muted line; suggestions not-shown: "Suggestions are not shown to your role." with the readers sentence under it, under the normal header.
- Suggestions: the queue table first; the chosen suggestion a flat section under it (from 1280px a split: queue 40% left, detail right), its header an h2 with the company, meta "Jun 30, 2025 · INV-0007 · Beach Co-Invest Fund III · Capital account statement", state dot and word, actions right (Open a draft valuation primary, Dismiss secondary); the strip; the workings with `Subhead`s; the selected row the shared `.is-selected`; "Shown above" becomes "Selected"; the detail section, keyed on the chosen suggestion's id, enters with `pb-enter` over `--pb-dur` once per selection (opacity and a 4px rise, no height animation; listed in `valuations.css`'s reduced-motion block), and the selected row's accent edge appears at once. The page's opening notice becomes one muted line under the tabs.
- Holds and alerts: `NoticeDetail.tsx` shows one "Holds and alerts" block under the header (each line a dot, a word and its sentence; the only bad tint on the page, once); the ticket's release blockers the same dot list with no box (`.pb-cap-release` loses `pb-notice-bad`); the Currency tile goes and "USD" joins the Amount hint (the header meta already states it).
- Inputs: `InputsCard` uses `KeyValueTable` for its own inputs and "From the suggestion" (money values right-aligned), not two headed tables.
- Figures: the variance flag sits in a fixed 12px slot before the figure in `ChangeCell` (a watch dot; the word "Variance" visually hidden; `title` the reworded `VARIANCE_TITLE` from slice 14), so every percentage keeps one right edge. Counterparty kind as `.pb-cell-sub` in `WireTable.tsx`; the scenario tag as muted text after a middle dot in `CapitalActivity.tsx`.
- Long registers: `TableWrap tall` on the notice register, trade tickets and wire register; `.pb-nowrap` on Prepared by, Approved by, Owner, Submitted, Proposed and the approvals Step, By and When; the ticket's Notice cell the company or fund as the link with the notice type as `.pb-cell-sub`; on phones the board's Fair value and Change come right after Position in source order (the key figure is the first column the sticky identity column reveals). No pager added (section 7.1).
- `AttentionCard`: the list stays as the API gives it; the due cell says "Due today" when `dueLabel` already gives it.
- Batch bar: `.pb-val-batch` loses its frame, radius and tint (`border: 0; border-radius: 0; background: none; padding: var(--pb-space-2) 0; border-bottom: 1px solid var(--pb-hairline)`), a flat row of the selected count and the batch commands above the table; same buttons and conditions.

**Tests**: `pages/valuations/ValuationDetail.test.tsx:162, 879` ("Valuation board" link becomes the crumb), its step and workflow assertions; `pages/capital/NoticeDetail.test.tsx` ("Upcoming" now visually hidden text in the shared strip), `NoticeDetail.preview.test.tsx`; `pages/valuations/Valuations.test.tsx`, `Suggestions.test.tsx` ("Shown above"), `ChangeRequests.test.tsx`; `pages/capital/CapitalActivity.test.tsx`, `TradeTickets.test.tsx`, `WireRegister.test.tsx`, `WireInstruction.test.tsx`; `e2e/journey3.spec.ts` and `e2e/journey4.spec.ts` pass unchanged (the test ids stay on the command block, which still holds the buttons, the reopened notice and the last-step sentence), `e2e/suggestions.spec.ts`.

**Must not change**: command options, roles, handlers and gates; ticket rules; the notice pager; the over-called caveat; totals from the API; `board.ts` logic; `lib/states.ts`.

**Check**: section 1.3 with `e2e/a11y.spec.ts e2e/journey3.spec.ts e2e/journey4.spec.ts e2e/suggestions.spec.ts`. Shots: area `valuations` (24): `valuations__board__operations__1440` and 390, `valuations__version-detail__approver__1440` and 390, `valuations__capital-notice-detail__operations__1440` and 390, `valuations__capital-commitments__operations__1440` and 390, `valuations__suggestion-detail__operations__1440`, `valuations__suggestions__operations__390`, `valuations__trade-tickets__approver__1440`, `valuations__wire-register__operations__1440` and 390, `valuations__change-requests__operations__1440`.

### Slice 10: Reporting, restyled only

**Carries** P77 report tables, P78 headers and actions, P79 loading and errors keep the frame, P80 a client's reason said once (shared with Analytics, Clients), P81 the package page layout, P82 a disabled command's reason visible, P83 report wording, P84 the start form and dialog order, P85 empty states and the Disclosures page, P86 Movers in neutral words, P87 the action result's tone.

**Files**: `pages/reporting/Reporting.tsx`; `pages/reporting/packages/Packages.tsx`, `PackageDetail.tsx`, `StartPackageForm.tsx`, `packages.css`; `components/ClientLookThrough.tsx`; tests; `docs/06` section 5 (packages.css reduced-motion block); `docs/SESSION_LOG.md`. `PackageActions.tsx` and `packages.ts` are not touched beyond slice 3's dialog classes.

**Changes**
- Report tables: By vehicle's Total row moves into `tfoot`; Movers' Period and Capital activity's Due cells `pb-nowrap`; Type becomes the `.pb-cell-sub` line under the vehicle name in By vehicle and in `ClientLookThrough` (same words, one column fewer); the package list orders Client, Quarter, State, Checks, Basis, Label, Version, Prepared by; the Version cell shows the number alone, right-aligned under "Version"; `ChangeLogCard`'s Run header `pb-nowrap`.
- Headers and actions: the weekly report meta becomes a middot list (Period, As of, Prepared for); "PowerPoint, Word and Excel output is not built yet" moves to the footnotes line. Packages: meta "Newest quarter first"; the rule sentence goes (each package's gate states it). The `Card testId="packages-card"` stays, now a flat section (slice 2; the action status line sits between it and the tabs, so it keeps its top rule); only its "Packages" section heading goes (its aside, "Newest quarter first", moves to the meta). Inside it the filter toolbar sits directly on the table, and Start package stays where it is today, at the toolbar's end, with the same disabled state and `title`: the probe clicks `getByTestId('packages-card').getByRole('button', { name: 'Start package' })` (`probe-preview.mjs:3216`), as do `e2e/report-packages.spec.ts:155, 422` and `Packages.test.tsx:281`; `Packages.test.tsx:163` picks the filters inside the card; `e2e/a11y.spec.ts:156` waits on the card. Moving the button into the header would break the probe, which may not change. Package page: `crumbs` Reporting / Packages replace `BackLink`; `PackageStateBadge` first in the meta list; `<PackageActions>` (unchanged) in the actions slot. Clients: the subtitle goes; the formula sentence a `.pb-meta` note after the last client. Titles stay as they are.
- Loading and errors: `WeeklyReportPage` renders its `PageHeader` and `TabNav` in the pending and error branches with the skeleton or message below; `PackagesPage` returns `<>{header}<PageSkeleton rows={8} /></>` while pending; `PackageDetailPage`'s not-available branch gets a `PageHeader` (crumbs, title "Client package") and the message left-aligned.
- Clients (shared component): the client heading a sentence-case section title with aside "Quarterly reporting · Gross, Net" as text; the figures strip with no per-tile reason, then one `.pb-meta` line built from the same `why` string ("Totals not calculable: no share for Beach Primary Program."), each missing tile pointing to it with `aria-describedby`; the row that causes it carries the reason on its dashes (title and visually hidden text, as `FigureTd` does); "Closing" header becomes "Closing no.".
- Package page: Footnotes and Client share full width, one after the other (no `.pb-two-col`); a visible superscript letter after a dash in Positions with "a. {why}" in a `.pb-meta` list under the table, from the strings `beginNavCell`, `gainLossCell` and `markCell` already return; Mark cells holding the quarter-end default in `--pb-muted` (`pb-pkg-mark-default`) so exceptions stand out; the passed-checks toggle transparent with `ChevronRight16Regular`, left on the table's last rule, min 36px; `ExplanationsCard` renders no empty state when there are no rows (its note already says why). The checks toggle's chevron turns; revealed rows fade in over `--pb-dur-fast`; the start panel opens with `pb-drop`; all listed in a new reduced-motion block at the foot of `packages.css`.
- Disabled reasons: the package gate's `CommandButtons` opt into `showBlockedReason`; Start package shows its `title` text as a visible muted line when disabled. Nothing new is decided.
- Wording: the commentary source line "Written by a fixed template from the figures above." with margin-top 8px; Disclosures shows a neutral dot and "Not built yet" followed by a short list of what the page will hold (the approved wording reports insert, with its versions; the register of approved statistics; consents from affiliated parties; a log of every report sent); the Due cell adds `dueLabel(n.daysToDue)` on a second line in `--pb-bad-ink` after a bad dot when overdue.
- Start form: `.pb-pkg-form-actions { justify-content: flex-end }`, Cancel before Start package; the form is a `Card panel`.
- Movers: `changeBadge` is still called, its tone ignored here: the word Up, Down or Flat in `--pb-muted-strong` after an `aria-hidden` triangle, never in status colours.
- Action result: slice 3's `ActionStatus` look applies (a result recorded as good shows on the neutral band, so a gate that ran and failed its checks no longer arrives on green); markup, classes and words unchanged.

**Tests**: `pages/reporting/Reporting.test.tsx:61` (source line), `:138` (reason moves from tile to the line), Disclosures assertions ("Not built yet" kept); `pages/reporting/packages/PackageDetail.test.tsx:528` and layout assertions; `Packages.test.tsx` (`:163` and `:281` pass unchanged: the card, its filters and the button stay together); `e2e/report-packages.spec.ts` (heading "Client packages" kept; `:155, 422` unchanged; the five exact `toHaveText` reads of `package-action-status` pass because slice 3 adds no word).

**Must not change**: `PackageActions`, `packages.ts`, which commands are offered and when, tones recorded, requests, If-Match, the gate sentences, the not-visible titles (section 7.1).

**Check**: section 1.3 with `e2e/a11y.spec.ts e2e/report-packages.spec.ts`. Shots: area `reporting` (14) and `analytics__clients__investor-relations__1440`; print the weekly report once.

### Slice 11: The chart library

**Carries** P88 chart chrome, P89 line charts, P90 bar labels on phones, P91 a shared scale for paired charts, P92 scatter outliers, P93 stacked bar labels; and the chart motion of section 3.7.

**Files**: `components/charts/ChartFigure.tsx`, `LineChart.tsx`, `HorizontalBars.tsx`, `StackedBars.tsx`, `BridgeChart.tsx`, `ScatterChart.tsx`, `Sparkline.tsx`, `RadarChart.tsx` (classes only), `scale.ts`, `useWidth.ts`, `SharedScale.tsx` (new), `index.ts`, `charts.css`; one-prop adoptions in `pages/analytics/ExposureTab.tsx`, `PerformanceTab.tsx`, `ValueCreationTab.tsx`, `CreditTab.tsx`, `pages/deal/ValueCreationCard.tsx`, `pages/deal/PerformanceTab.tsx`; tests; `docs/SESSION_LOG.md`.

**Changes**
- Chrome: the "Show table" and "Show chart" toggle becomes a quiet text button (`.pb-btn-quiet` look, 12px primary, a 16px table or chart icon, hover `--pb-primary-tint-4`, outline only on `:focus-visible`, 44px on touch), same words; tooltip radius `--pb-radius-sm`, border `--pb-border`; `.pb-chart-subtitle { display: block; margin-left: 0; font-size: 12px; color: var(--pb-muted) }`; chart title 13px 600; `ChartFigure` gains `hideCaption` so a chart whose section title names it keeps its title only for the aria label and table label (Home and vehicle NAV trends, Analytics single-chart sections).
- Marks: `ROW` 26 and `BAR` 12 in `HorizontalBars`, `StackedBars`, `BridgeChart`; bar ends square (radius at most 1px); `.pb-chart-grid` stroke `--pb-hairline`; `.pb-chart-axis` `--pb-border-strong`; ticks 11px tabular; labels 12px `--pb-text`. The bar or segment `<path>` takes the new class `pb-chart-bar` (`is-negative` for a negative bar) and the row group takes `style={{ '--i': index }}`, which the path inherits; the bridge step's `<path>` takes `pb-chart-step`; printed values keep `pb-chart-value`. `pb-chart-mark` is not moved or reused: it stays the interaction class on the whole row group (`HorizontalBars.tsx:140`, `BridgeChart.tsx:135`, `StackedBars.tsx:134`), on every radar axis group (`RadarChart.tsx:173`) and on scatter points, and its hover and focus rules in `charts.css` stay as they are. No animation targets it, so no label, printed value or radar score is ever scaled.
- Lines: no wash for a single series (none at all), 1.75px; solid series paths take `className="pb-chart-line"` and `pathLength={1}`; end markers and labels `pb-chart-end`; no end label for one series; end labels dodge instead of dropping (after sorting, `y = max(y, prev.y + 14)`, clamped to the plot, with a 1px `--pb-border-strong` leader when moved); optional `breakAfter` index (a 12px gap and two short slanted strokes, `pb-chart-break` in `--pb-muted`, between index 0 and 1); when `baselineZero` is false the lowest gridline is labelled and no zero line drawn; the tooltip writes `MISSING` where it wrote "n/a".
- Phones: `labelLayout(width)` in `scale.ts` returns `'side'` or `'above'`; under 480px of chart width the three bar charts put the full label on its own line above its bar at full width (`ROW` 40); truncation only at side layout.
- `SharedScale`: a context provider that collects each child chart's extent and hands every child the same domain (geometry only; the page computes nothing). `HorizontalBars` reads it when present.
- `ScatterChart` `clampOutliers`: the domain from marks within 3 times the interquartile range; a mark beyond is drawn at the plot edge as a hollow ring with a 4px arrow and its x figure printed from `xDisplay`; the note under the chart says "1 mark beyond the axis is drawn at its edge"; tooltip and table twin keep the exact figures; 360px tall from 900px when it is its section's main figure.
- `StackedBars`: every figure printed today stays printed (`StackedBars.tsx:165-181` prints each segment's value where it fits, and `ExposureTab` shows them). A single-segment row prints its value after the bar's tip (`valueLabelPosition`), no plate. In a multi-segment row each value that fits stays inside its segment on a quieter plate: `.pb-chart-inlabel-plate` keeps its job (no series colour gives either text colour 4.5:1, `lib/theme.test.ts`) and is restyled to `rx` 2 (`--pb-radius-sm`), `--pb-bg` fill, no stroke; segments get 1px `--pb-bg` separators; the fit rule (`w >= display.length * 7 + 12`) and which values print are unchanged. No total is computed.
- Motion: `useWidth` gains `measured`; `ChartFigure` sets `data-entering` once measured and clears it after the longest mark (never when reduced), and gives the incoming view `pb-swap-in` after the reader presses "Show table" or "Show chart" (never on first render); the CSS of section 3.7 and its reduced-motion block at the foot of `charts.css`; the sparkline draw.
- Adoptions: `ExposureTab` wraps its two side-by-side charts and `PerformanceTab` (analytics) its Contributions and Distributions in `<SharedScale>`; `ValueCreationTab` passes `clampOutliers` to "Valuation growth against EBITDA growth"; `CreditTab` "Fair value and par" and the deal page's "Indexed since entry" pass `baselineZero={false}`; `ValueCreationCard` passes `breakAfter={0}` when `x[0]` is Entry.

**Tests**: `components/charts/charts.test.tsx`, `bridge-scatter.test.tsx`, `RadarChart.test.tsx`, `scale.test.ts` (`labelLayout`), `NavTrendCard.test.tsx`, `pages/deal/ValueCreationCard.test.tsx`, `pages/analytics/ValueCreation.test.tsx`; add a `SharedScale` test (two charts with different maxima read one domain), a dodge test (two end labels 6px apart both drawn), a test that the entering classes sit only on paths (`.pb-chart-bar` and `.pb-chart-step` match `path` elements and no `g`), and a `StackedBars` test that every segment value that fits is still printed (`.pb-chart-inlabel-text`, one per fitting segment), next to the existing `HorizontalBars` check at `charts.test.tsx:213` that printed values stay inside the plot. "Show table" and "Show chart" names are unchanged, so the nine files that click them pass. `e2e/a11y.spec.ts`: the reduced-motion test gains `.pb-chart-line` and `.pb-chart-bar` on the analytics performance tab.

**Must not change**: table twins, summaries, keyboard stepping and its live region, null as a gap, printed values (which ones print and where they fit), the series colour set, the radar's missing spoke rule, the `pb-chart-mark` interaction class and its hover and focus rules.

**Check**: section 1.3 with `e2e/a11y.spec.ts e2e/value-creation.spec.ts e2e/deal-fit.spec.ts e2e/underwriting.spec.ts`. Shots: `analytics__exposure__approver__1440` and 390, `analytics__performance__approver__1440` and 390, `analytics__value-creation__approver__1440` and 390, `analytics__credit-book__approver__1440`, `portfolio__deal-equity-performance__deal-team__1440` and 390, `portfolio__vehicles__operations__390`, `pipeline__opportunity-detail__deal-team__1440`.

### Slice 12: Analytics pages and the co-investment map

**Carries** P94 the value creation table, P95 the map tables' headers, P96 the map palette and panel, P97 map controls, P98 one context row per tab, P99 the filter bar, P100 credit sections, P101 the map on a phone, P102 map motion, P103 analytics wording, P104 the exposure grouping control.

**Files**: `pages/analytics/Analytics.tsx`, `ExposureTab.tsx`, `PerformanceTab.tsx`, `ValueCreationTab.tsx`, `ValueCreationFilterBar.tsx`, `EntryMetricsTab.tsx`, `CreditTab.tsx`, `RealizationsTab.tsx`, `analytics.css`; `components/ClientLookThrough.tsx` (context row only); `components/ui.tsx` (`PageContext`, new, props in section 1.1); `pages/deal/ValueCreationCard.tsx` (the switch label at `:114`, the same words as the analytics tab's); `pages/analytics/map/MapTab.tsx`, `WorldMap.tsx`, `map.css` (`use-map-view.ts` is not edited, section 1.2); tests; `docs/06` section 5 (map paragraph, radar line); `docs/SESSION_LOG.md`.

**Changes**
- Sections: the analytics tabs adopt slice 2's sections; when a section holds one chart the chart title is the section title and the scope is said once in one context line (NAV trend "NAV by quarter" plus "Positions held at each quarter end, at their latest Locked mark"); section labels that repeat the tab go; inner subsections (credit's "Amortization schedule") become `Subhead`s.
- `PageContext` (`ui.tsx`, `.pb-page-context`) directly under the tabs: a middot list left ("As of Jun 30, 2025 · 16 active positions · Locked marks only"), the tab's own controls right (Exposure's grouping, Export CSV), an optional muted second line for a scope sentence that adds information; every analytics tab and `ClientLookThrough` use it; the asides that repeated the as-of date go. `.pb-banner:has(+ .pb-tabs)` drops its margin so the tab rule is the only line.
- Value creation table: a two-tier header (`th scope="colgroup" colSpan`: "EV / EBITDA" (Entry, Current), "Net debt / EBITDA" (Entry, Current), "Growth since entry" (EBITDA, Mark), "Gain by driver" (EBITDA growth, Multiple, Debt paydown, Mark and timing); Inv #, Company, Entry stake, Our gain, Gross MOIC, Gross IRR take `rowSpan={2}`); sort buttons on the lower row. Each lower header shows the short word and carries the rest of today's name as visually hidden text ("Entry<span class=\"pb-visually-hidden\"> EV / EBITDA</span>"), so every column header and sort button keeps today's accessible name and no two read "Entry" or "Current" alone (`e2e/value-creation.spec.ts:248` finds `columnheader` `/^Gross MOIC/`; `ValueCreation.test.tsx:690-705` reads `aria-sort` by header name). Tests that assume one header row change in this commit: the `firstCells` helper at `ValueCreation.test.tsx:78-82` reads `tbody tr` instead of `getAllByRole('row').slice(1)` (a second header row has no `cell` and would throw), which fixes its uses at `:630, 702-712, 764, 778, 784, 821, 920, 955`; the exact column-header list at `:631-640` gains the four group headers in document order, the lower headers' text unchanged by the hidden words; group headers centred over a 1px `--pb-border` underline; `.is-group-start { box-shadow: inset 1px 0 0 var(--pb-hairline) }`; Company nowrap min 180px; Inv # and Company sticky left; `TableWrap tall`; Export CSV in the context row, its name and `data-testid="value-creation-export"` unchanged (the probe clicks the id, `probe-preview.mjs:2359`, and `e2e/value-creation.spec.ts:260, 353` the name), the section keeping `value-creation-positions` and the tab keeping `value-creation-action-status`; the shared reason cell kept. The probe counts `tbody tr` (`:2349`), so the second header row does not change its count. "No position matches these filters" keeps its title and detail and gets no button of its own: the filter bar already shows "Clear filters" (`value-creation-filters-clear`, `ValueCreationFilterBar.tsx:39-48`) whenever a filter is set, and the detail already says "or clear the filters".
- Filter bar: the element is the existing `<div data-testid="value-creation-filters">` around a `Toolbar` (`ValueCreationFilterBar.tsx:30`; there is no `.pb-analytics-filters` today). It gains the class `pb-vc-filters` (test id unchanged), and `.pb-vc-filters > .pb-toolbar { display: grid; grid-template-columns: repeat(6, minmax(132px, 1fr)) auto; align-items: end; gap: var(--pb-space-2) var(--pb-space-3) }` lays out the six fields and the end slot (count and Clear filters); each dropdown keeps `.pb-analytics-filter`, values nowrap with ellipsis, the count on the controls' baseline, controls size small; under 760px a "Filters" button with the active count opens the six fields in a disclosure. Filters stay in the address.
- Credit: section heading "Quill Brands Group" `--pb-text-lg` 600 after the muted "INV-0009"; `--pb-space-4` above the strip; terms in `KeyValueTable` (one pair per row on phones); covenant and payment states one meta line under the strip ("Covenants compliant · Payments current", each with its dot); the amortization table `is-compact { width: auto; min-width: 280px }`.
- Exposure: from 760px the grouping becomes a segmented "Group by" control (Sector, Geography, Deal type, Vehicle, Sponsor, Vintage) in the context row; the dropdown under 760px. Largest positions keeps its chart and table.
- Map tables: `className="num"` on the three headers at `MapTab.tsx:376, 377, 445`.
- Map palette (section 2.6) in `map.css`: water `--pb-bg` (the `linearGradient` defs and graticule go), land `--pb-border`, borders `--pb-bg` 0.6, coast `--pb-border-strong` 0.5, `.pb-map-canvas` no border or radius with hairlines top and bottom, the selected marker's 2px `--pb-text` ring; `.pb-map-panel` no frame or fill, `border-left: 1px solid var(--pb-hairline); padding-left: 16px`, its empty state one muted line.
- Map controls: `.pb-map-field-label` (`map.css:299-306`, the chip groups' label) loses `text-transform: uppercase` and its 0.06em tracking and takes the field-label style of slice 3 (`--pb-text-sm` 500 `--pb-muted-strong`, sentence case); Status a `.pb-segmented` group; deal types two checkbox toggles (a 14px square filled with the series colour when on, then the label); regions a segmented control in the map's top-left with "Play tour" as a text button at its end; zoom in, zoom out and World one vertical 32px group with hairlines; the row action a 28px locate icon button (`aria-label` unchanged) with a 44px hit area on touch (`::after { inset: -8px }`); no 999px radius.
- Map on a phone: under 760px `.pb-map-svg { aspect-ratio: 4 / 3 }` with the opening view fitted to the placed markers (`fitPoints`); 28px zoom buttons bottom-right with 44px hit areas; the selection panel only once a marker is chosen.
- Map motion: section 3.7 (opening about 1.04s, no overshoot, ripple once). `use-map-view.ts` is not edited: `useMapView(reduced)` already takes the flag as an argument, so `MapTab.tsx:117` passes `useReducedMotion()` from `motion.ts` (which also answers `(update: slow)`) in place of `usePrefersReducedMotion()`, and the `reduced` it hands to `WorldMap` follows; the flight durations are set where `flyTo` is called (`MapTab.tsx:149, 154, 194, 236`, `WorldMap.tsx:193-206, 250, 351`) from `MOTION` (`draw` for flights and the tour, `slow` for a zoom step, `base` for a keyboard pan); the hook's own cubic ease-in-out stays. Every animated selector stays in the reduced-motion block at the foot of `map.css`, repeated exactly as declared; the sort mark (fade and a 180-degree turn over `--pb-dur` when the direction flips) gets a new block at the foot of `analytics.css`.
- Wording: drop "The largest is emphasised"; "Entry EV / EBITDA bands" and "Entry net debt / EBITDA bands" for the asides that said "bands from configuration"; "visible to you" for "that you are entitled to see" on the three tabs; "Listed under the table" for "Listed below the map, never placed by a guess"; the switch label "Split EBITDA growth into revenue and margin"; the bridge note cut to one line with the method in a "How the split works" disclosure (`.pb-analytics-details`). The map credit is slice 14.
- docs/06 section 5: the map paragraph (neutral palette, markers by deal type, a selected marker's ring plays once), the radar timings on tokens.

**Tests**: `pages/analytics/Analytics.test.tsx`, `ValueCreation.test.tsx:475` and `pages/deal/ValueCreationCard.test.tsx:68` (switch label), `ValueCreation.test.tsx:78-82` (`firstCells` to body rows) and `:631-640` (header list with the group headers), `MapTab.test.tsx`; `e2e/value-creation.spec.ts:141, 593` (switch name; `:248` passes, Gross MOIC spans both header rows), `e2e/map.spec.ts`.

**Must not change**: what is filtered and how; the address-held filters; every figure and its missing reason; the unplaced list and the table under the map; the Realized marker; the "positions not in this split" disclosure.

**Check**: section 1.3 with `e2e/a11y.spec.ts e2e/value-creation.spec.ts e2e/map.spec.ts`. Shots: area `analytics` (16), all compared. Record the map opening once with motion on (scratch Playwright `recordVideo`, reduced motion `no-preference`) and confirm it ends within about 1.1s and nothing keeps moving.

### Slice 13: The website

**Carries** P105 the website.

**Files**: `apps/site/src/styles/site.css`; `apps/site/src/render/page.ts`; `apps/site/src/render/not-found.ts` (it imports `crest` too); `apps/site/src/render/favicon.ts`; `apps/site/src/render/scene.ts` (deleted, once neither `page.ts` nor `not-found.ts` imports it); `apps/site/scripts/lib/tokens.mjs` only if the motion tokens are emitted there (add only; the scene tokens stay, because `apps/site/scripts/check-site.mjs:272-285` checks contrast pairs that read `sceneSkyTop`, `sceneSky` and `sceneSeaNear` and would throw on a missing key, and the checker is not the look, section 1.2); `apps/site/src/site.test.ts`; `docs/SESSION_LOG.md`.

**Changes**
- Fonts and colours already follow `brand.json` through `tokens.mjs`, and the font files through the import added in slice 1. Headings 600, -0.02em, h2 `clamp(28px, 3.6vw, 44px)`; `--radius` 6px and `--radius-sm` 4px, buttons 4px, no 999px except dots; a solid header (`var(--pb-bg)` and a hairline, no blur); the hero a plain section on `--pb-bg` holding the product screenshot in a 1px `--pb-border` frame, the scene layers and their six loops removed (the "Hero and the scene" section of `site.css`, lines 368 to 620, goes down to what the plain hero needs); screenshots change border colour on hover instead of lifting; the app's motion token names and values; reveal 240ms, 8px, 40ms stagger, once; the reduced-motion query gains `(update: slow)` and `.tour-nav a`. The site has its own token names (`apps/site/scripts/lib/tokens.mjs`): `--pb-muted` (already AA on every site surface), `--pb-surface` (a mix of sand and page, so neutral grey once `brand.sand` is `#EEF0F3`), `--pb-border`, `--pb-border-strong`, `--pb-primary`, `--pb-deep`; the bullets below use those.
- The section heading label: `eyebrow()` in `page.ts:57-58` stops appending `ripple()`, the wave underline; `.eyebrow` (`site.css:200-211`) becomes a sentence-case label, 12px, 500, `--pb-muted`, `letter-spacing: 0`, no `text-transform`, no underline, `margin-bottom: 8px`; `.ripple` and its rule go.
- The bands: the six `crest()` wave dividers in `page.ts` (lines 263, 313, 391, 445, 459, 483) and the one in `not-found.ts:47` go, with `.crest` (`site.css` and the inline rule in `not-found.ts:23-24`). Sections meet at a 1px `--pb-border` rule. `band-sand` and `band-shore` (`site.css:634-646`) become neutral surfaces: `--pb-bg` and `--pb-surface` alternating, no sand chip colour, no gradient; `band-deep` stays a dark band but flat `--pb-deep` (no gradient). The not-found page's sky gradient (`not-found.ts:14`) becomes `--pb-bg`. The "shoreline" under the status steps (`.flow::before`, `site.css:792-800`) becomes a 1px `--pb-border-strong` line.
- No uppercase and no tracked lettering anywhere on the site: `.chip-mark` (`site.css:408`, a sand pill) becomes plain `--pb-muted` text; `.together-label` (`:700`) and `.feature-kicker` (`:877`) the sentence-case label above; `.feature-number` (`:982`, a pill) a plain tabular number in `--pb-muted`; `.meta`'s 0.02em tracking goes. A test in `site.test.ts` reads `site.css` and asserts no `text-transform: uppercase` and no `letter-spacing` above `0.01em` except the headings' negative tracking.
- `favicon.ts`: the new mark (section 2.5) drawn from the `primary` and `bg` tokens, no longer on `sceneSky`.
- `scene.ts` is deleted once `page.ts` (which imports `crest`, `ripple` and `scene`) and `not-found.ts` (which imports `crest`) no longer import it; `site.test.ts` asserts the built page holds no `class="crest"`, `class="ripple"` or `band-sand`.

**Tests**: `apps/site/src/site.test.ts` (the new no-uppercase and no-scene assertions; the theme and contrast tests pass unchanged because the tokens stay).

**Must not change**: the site's words, sections, navigation and links (`site.test.ts:181-212`), the demo links, the prototype footer on every page, the tokens `check-site.mjs` reads.

**Check**: `pnpm --filter @pb/site typecheck && pnpm --filter @pb/site test && pnpm --filter @pb/site build:site-only && pnpm --filter @pb/site check`, then `build:artifact` and `check:artifact` (never `pnpm --filter @pb/site build`, which re-records the media). Shoot the site with `node scripts/shoot-site.mjs --out $SCRATCH/site-before` from `apps/site` on the clean tree before the slice, and `--out $SCRATCH/site-after` after it, and compare desktop and phone, light and dark; `bash scripts/check-style.sh`.

### Slice 14: Page copy that names the build, and the guards

**Carries** P106 page copy that names a file, a config key, a code identifier, a command or the build, with the guards that keep it out.

**Files**: the copy files listed below; `apps/web/src/lib/copy-guard.test.ts` (extended, with one named exception); `apps/web/src/pages/rendered-copy.test.tsx` (new); `docs/06` section 6; `docs/SESSION_LOG.md`.

**Changes: copy** (each line of page copy that names the build; area slices already fixed the ones they rebuilt: the sign-in error, the dictionary's keys and file paths, the flag and kill switch keys, the readiness codes, the assistant's route paths)
- `pages/valuations/board.ts` `VARIANCE_TITLE`: "Moved more than 10.0% from the prior Locked mark" (built from `VARIANCE_FLAG` as today).
- `pages/portfolio/Watchlist.tsx`: heading and table label "Monitoring thresholds"; no aside, no key chip; values in the reader's units through existing formatters (`formatPct` for keys ending in `Pct`, "{n} months" and "{n} days" for those keys, the multiple formatter for `netDebtToEbitdaMax`, raw for any other key); note "Each flag above names the limit it was tested against."
- `pages/monitoring/monitoring.ts` `thresholdsLine`: drop "(config/definitions.json documents)". `pages/documents/ExpectedDocuments.tsx:78`: drop "(config)".
- `pages/pipeline/NewOpportunity.tsx`: "Starts at Sourced with the standard diligence tasks for its deal type." `ClosingPanel.tsx:404`: "Operations cannot confirm the closing while a required item is open. Optional items are tracked but never block." `StageActions.tsx` closing dialog: "The close date becomes the single date every report uses, and the closing checklist opens with it." `DealFit.tsx`: "A draft set of measures, not a recommendation. Every threshold can be changed. A measure whose figure is not recorded has no score."
- `components/WorkflowSpec.tsx`: drop the aside "Built and tested ahead of the screens"; strip a parenthesised "(section N)" from each rule before showing it with a local regex in the component (`lib/references.ts` untouched).
- `pages/sponsors/Sponsors.tsx`: "Not built yet. This section will hold contacts, the relationship score, warm paths, coverage and AGM notes."; footers in `Sponsors.tsx`, `portfolio/Vehicles.tsx` and `capital/Commitments.tsx`: "Figures use calculation rules version {v}." `Commitments.tsx` notes: "The total covers every vehicle, so it shows only with All vehicles selected." and "Totals add the commitments whose figures are known; one with no recorded cash flow shows {MISSING}."
- `pages/AdminFlags.tsx`: each description through `withoutReferences()`; the success message names the description, not the key ("Accounting import and export adapter is now on (simulated in this preview, not audited)."; the probe checks only `is now on (simulated in this preview`); the `Switch` keeps `aria-label={`${f.key} enabled`}` exactly, because the probe clicks `getByLabel('ai.extraction enabled')` (`probe-preview.mjs:255`) and may not change (open item 6). `pages/admin/Admin.tsx`: the kill switches table's descriptions and `WallCard`'s description through `withoutReferences()`; note "Off stops the integration at once. Platform admins change these under Flags, with a reason; the switches for the assistant and AI processing are there too."; empty state "No integration switches are configured." `pages/admin/roles.ts`: the service row ends at "...never straight to production records." `pages/admin/Taxonomy.tsx` placeholder "Deal type, credit, healthcare".
- `pages/extraction/ExtractionRun.tsx`: the banner keeps company, period and requester; schema, model, prompt, tokens and cost move to a closed "Run details" disclosure in words ("Read as Quarterly financials" via `labelOf(run.schemaId)`, "Model: mock, prompt version 1", "230 tokens in, 64 out", "Cost $0.0017"); narrative footnote "Drafted from the extracted figures only. Accepting the clean values accepts the draft if it passed the style rules." `pages/documents/DocumentDetail.tsx`: candidates through `docTypeLabel` or `labelOf` ("Suggested type: Other"). `pages/lookthrough/LookthroughRun.tsx` differences: "Financials on record, provider says Technology" from `labelOf`. `pages/exceptions/Exceptions.tsx` and `ExceptionDetail.tsx`: Expected and Actual through `labelOf` when the value is a known taxonomy code, otherwise exactly as the record holds it (no unit added; section 7.1); the detail title from `positionText` and `rowText` ("Juniper Payments Group, row 8") with "Rule LT-DIFF-01" in the meta.
- `pages/capital/NoticeDetail.tsx`: each note through `withoutReferences()`. `pages/analytics/map/MapTab.tsx`: the credit "Map outline: Natural Earth, public domain." (a fixed string).
- `pages/assistants/Assistants.tsx`: the line under the answer stops rendering `MOCK_ASSISTANT_LINE` (`lib/assistant.ts:114-115`, which ends "(config/definitions.json agentModels.default = mock)" and lives in a production `lib` module this pass never edits) and renders its own sentence with the same facts and no reference: "Answered by the preview's mock assistant: built from the recorded figures by a fixed template, not by a model." `data-testid="assistant-mock-line"` stays. `Assistants.test.tsx:64-66` asserts the new sentence instead of the constant. `lib/assistant.test.ts:257` still reads the constant for its em dash check and needs no change; the constant is now unused by any page (open item 7).

**Changes: guards**
- `lib/copy-guard.test.ts`: `REFERENCE` also matches `config\/[\w-]+\.json`, `\(config\)`, `\(section \d+\)`, `CLAUDE\.md` and `pnpm (?:dev|build)`; `codeLines()` skips `import` statements (ten source files import `config/*.json`). Write the extension first and see it fail on the lines above, then fix them. The extended pattern also matches `lib/assistant.ts:115`, the `MOCK_ASSISTANT_LINE` string, which no page shows after this slice and which the pass may not edit: the guard gains one named, string-only exception, `{ file: 'lib/assistant.ts', text: 'config/definitions.json agentModels.default' }`, with a comment saying why (a constant kept for the `lib` tests; the page renders its own sentence) and a test that the exception still matches a line, so it cannot outlive the line.
- `pages/rendered-copy.test.tsx`: render the pages whose text comes from the API (flags, access and walls, integration health, data dictionary, assistant answer, exceptions queue and detail, extraction run, notice detail) from the existing test fixtures, adding one fixture sentence with a reference ("(SEC-8.10)") where none exists, and assert the visible text never matches the extended `REFERENCE` or `/CLAUDE\.md|config\/|packages\//`. The assistant answer is rendered with the mock line in place, so a page that went back to showing the constant would fail here. Configuration keys are words like `ai.extraction` that the regex cannot tell from prose, so the test also asserts that no flag key, readiness check code or dictionary key from the fixtures appears in the rendered text of the flags, integration health and data dictionary pages (slice 5 shows words only there).
- docs/06 section 6: "Quiet beside content" becomes one empty-state style with no frame and no mark; "A status marker is for a state that matters"; add that the guard also reads rendered text. Add that admin pages are no exception: they show descriptions and words, not keys; the one key still reachable is the flag switch's accessible name, kept for the probe (open item 6).

**Tests to update**: `pages/valuations/board.test.ts:71`, `Valuations.test.tsx` (variance title if asserted); `pages/monitoring/monitoring.test.ts:174, 229`; `pages/portfolio/Watchlist.test.tsx:49`; `pages/pipeline/NewOpportunity.test.tsx`, `Closing.test.tsx`; `components/WorkflowSpec.test.tsx`; `pages/sponsors/Sponsors.test.tsx`, `pages/portfolio/Vehicles.test.tsx`, `pages/capital/CapitalActivity.test.tsx` ("Calc version" and the commitments notes; the "comes from the API" hit in `pages/deal/CapitalTab.test.tsx` is a comment); `pages/documents/ExpectedDocuments.test.tsx`; `pages/extraction/ExtractionRun.test.tsx` (the run details words; its one "CLAUDE.md" hit is a comment); `pages/documents/DocumentDetail.test.tsx`, `pages/lookthrough/LookthroughRun.test.tsx`, `pages/exceptions/ExceptionDetail.test.tsx` ("Candidates"); `pages/capital/NoticeDetail.test.tsx`; `pages/admin/Admin.test.tsx`; `pages/assistants/Assistants.test.tsx:64-66` (the page's own sentence); `pages/analytics/map/world.test.ts` (credit). Grep `e2e/monitoring.spec.ts`, `documents.spec.ts`, `lookthrough.spec.ts`, `journey3.spec.ts` for the old lines (their `config/definitions` hits read the file for values).

**Must not change**: the API's sentences (the page strips references at display); `lib/references.ts`, `lib/unavailable.ts`; any figure or unit.

**Check**: section 1.3 with `e2e/a11y.spec.ts`, and a grep of every e2e spec for each old sentence (`e2e/monitoring.spec.ts`, `documents.spec.ts`, `lookthrough.spec.ts`, `journey3.spec.ts`; their `config/definitions` hits read the file for values and stay).

### The close

1. Every gate of handoff section 6 from a clean tree, including `pnpm openapi:generate` with a clean `git status` and the whole browser suite (about 20 minutes).
2. Site: `pnpm --filter @pb/site typecheck`, `pnpm --filter @pb/site test`, `pnpm --filter @pb/site build:site-only`, `pnpm --filter @pb/site check`, and `build:artifact` with `check:artifact`. Never `pnpm --filter @pb/site build` (it re-records the media).
3. All 174 shots retaken to `shots/after` and compared pair by pair with `shots/before`; one short clip with motion on (home, a tab change, a chart entering, a command result, the map opening) saved under `$SCRATCH/motion/` for the owner.
4. `docs/SESSION_LOG.md`: what changed by slice, what was checked with its output, and the open items of section 8.
5. Republishing the owner's demo artifact (handoff section 3) only when the orchestrator or the owner asks.
## 5. Findings register

173 reviewer findings (and 74 motion proposals, merged into section 3) became 106 plan findings. The source ids are the reviewers'. "Partly" marks a source part of whose fix is dropped under a rule (section 7.1); options set aside for a better shared fix (section 7.2) are not marked.

| Plan | Finding | Sources | Slice |
|---|---|---|---|
| P01 | Theme colours: ink, one cobalt accent, neutral greys, cobalt series 1 | shell-01 (partly), VL-02, PF-09, PIPE-02, R5, AN-07, VAL-15 | 1 |
| P02 | One sans family bundled with the app, a mono token, a type scale, no uppercase labels | shell-01, VL-01, PF-09, PIPE-02, R5, DO-20, DS-05, DS-02, VAL-07, AN-06, DO-08, PIPE-16 | 1 |
| P03 | Shape tokens: radii, shadows on overlays only, spacing, Fluent radii and size, the literal tooltip shadow | VL-14, DS-05, shell-03, R1, PIPE-16, VL-12, AN-24 | 1 |
| P04 | The motion system: tokens, entrance, policy gaps (spinner, slow displays), literals onto tokens | DS-08, PIPE-18, AN-21 | 1 |
| P05 | The written look: docs/06 and decision record 0026 | VL-17 | 1 |
| P06 | Flat sections instead of cards inside cards | shell-03, PF-02, PIPE-02, DO-01, VAL-00, VAL-03, R1, AN-01, VL-03 | 2 |
| P07 | Section titles in sentence case, aside, sub-titles | shell-03, PF-02, PIPE-02, VAL-03, R5, AN-01, DS-02 | 2 |
| P08 | Page header: crumbs on record pages, title, meta line, actions right | shell-06, PF-06, PIPE-17, DO-08, VAL-07, R7, VL-06, AN-06 | 2 |
| P09 | Tables: quiet header, 32px rows, aligned figures, tall region with sticky header, tfoot, print | shell-05, PF-03, PIPE-05, DO-03, VAL-04, R2, AN-02, VL-04 (partly) | 2 |
| P10 | Table links and identifiers as text | VAL-15, PF-23, VAL-16, R15, DO-03, VL-05 | 2 |
| P11 | Key figures as one strip, ink figures, tone as a dot | shell-07, PF-07, PIPE-06, DO-07, VAL-09, R1, AN-03, VL-11 | 2 |
| P12 | Tables on phones: sticky first column, scroll cue, min widths, one pair per row | PF-08, PIPE-05, PIPE-12, DO-05, VAL-05, R4, shell-10, AN-16, VAL-14 | 2 |
| P13 | Status as dot and word; categories as text; ring markers for Simulated and AI draft | shell-04, PF-05, PIPE-07, DO-02, VAL-08, R6, AN-15, VL-05, DO-12, VAL-17 | 3 |
| P14 | Notices without the coloured bar; a Notice component | shell-16, PF-02, DO-11, VAL-13, R3, VL-09, DS-07 | 3 |
| P15 | Empty, error and unavailable states without frame or horizon mark; a quiet action log | shell-16, PF-14, PIPE-11, DO-13, VAL-11, R9, AN-20, VL-10 | 3 |
| P16 | Skeletons in the page's shape; rows skeleton | DO-22, R10, AN-20, DS-07 | 3 |
| P17 | One step strip drawn as segments | PIPE-08, R8, DS-01, VAL-02 | 3 |
| P18 | Tabs: drawn underline, one scrolling row on phones | shell-10, PF-08, R17, AN-06, DS-10 | 3 |
| P19 | Field labels, form layouts, quiet buttons, segmented controls | PF-15, PIPE-10, DS-04, DS-06, AN-14, DO-20 | 3 |
| P20 | Shared helpers instead of page copies | DS-03, PIPE-19, DO-19 | 3 |
| P21 | 44px touch targets | shell-10, PF-20, PIPE-12, DO-19, R13, AN-24 | 3 |
| P22 | Dialogs: backdrop, radius, motion, no page shift | R16 (partly), VAL-18, DS-07 | 3 |
| P23 | Workflow components: blank actions cell, primary command, visible blocked reason, result mark | VAL-19, VAL-10, R3, R13 | 3 |
| P24 | Shell: full-height rail, light top bar, wordmark, prototype marker, user | shell-02, VL-07, shell-18 | 4 |
| P25 | Phone shell: one bar and a drawer | shell-10, VL-15 | 4 |
| P26 | Skip link and the light-header focus ring | shell-18 | 4 |
| P27 | Sign-in page without the beach | shell-08, VL-08, DS-09 | 4 |
| P28 | Home: title, figures strip, your work, attention, charts, data health | shell-06, shell-07 | 5 |
| P29 | Data dictionary readable, no raw JSON | shell-11 | 5 |
| P30 | Admin tab row on every page in it; sentence-case names | shell-12 | 5 |
| P31 | Flags page controls | shell-13 (partly) | 5 |
| P32 | One checks pattern | shell-14, shell-18 | 5 |
| P33 | Taxonomy as one aligned table | shell-15 | 5 |
| P34 | The assistant's off state and layout | shell-17 | 5 |
| P35 | The preview guide folded on Home | shell-19 | 5 |
| P36 | Positions grid: figures first, alignment, quiet header, toolbar | PF-01, PF-03 (partly), PF-15, PF-21 | 6 |
| P37 | Deal workspace header, strip, sticky tabs, one "Since entry" section, jump row | PF-06, PF-07, PF-12 | 6 |
| P38 | Watchlist as position and flags | PF-10 | 6 |
| P39 | Quarterly tables with group headers | PF-11 | 6 |
| P40 | Deal tabs' empty and not-built states | PF-14 | 6 |
| P41 | Overview without tinted panels | PF-17 | 6 |
| P42 | Vehicles: grouped strip, NAV card, list chart beside the table | PF-18 (partly) | 6 |
| P43 | Outlook card note and helper | PF-19 | 6 |
| P44 | Activity and Capital activity tabs | PF-22 (partly) | 6 |
| P45 | Sponsor tab's other positions as a table | PF-23 | 6 |
| P46 | Pipeline board: live stages, closed and passed table | PIPE-01, PIPE-11 | 7 |
| P47 | Board cards comparable | PIPE-09 | 7 |
| P48 | Opportunity page order and stage actions | PIPE-03, PIPE-06 | 7 |
| P49 | Forms aligned; IC form for blocked roles | PIPE-10 | 7 |
| P50 | The stage as a neutral word | PIPE-13 | 7 |
| P51 | The stage reference folded | PIPE-14 | 7 |
| P52 | Sponsor pages | PIPE-15 | 7 |
| P53 | Closing panel: term values, ledger, actions | PF-13, PIPE-04 (partly), PIPE-06, PIPE-11, PIPE-12 | 7 |
| P54 | Pipeline styles: muted on tints, borrowed classes | PIPE-16, PIPE-19 | 7 |
| P55 | Data operations headers and marker placement | DO-08, DO-12 | 8 |
| P56 | Figures laid out to compare | DO-06 | 8 |
| P57 | Monitoring controls and board | DO-09 | 8 |
| P58 | Staging panel | DO-10 | 8 |
| P59 | Extraction review repetition and source | DO-14 | 8 |
| P60 | Extraction page consistency | DO-15 | 8 |
| P61 | Expected documents' timing | DO-16 | 8 |
| P62 | Look-through cells | DO-17 | 8 |
| P63 | Exceptions queue | DO-18 | 8 |
| P64 | Document page and two subtitles | DO-21 | 8 |
| P65 | In-section loading and busy tables | DO-22 | 8 |
| P66 | Commitments table folded to its figures | VAL-01 | 9 |
| P67 | One step strip on a version and a notice | VAL-02, DS-01 | 9 |
| P68 | The forward command in the header | VAL-10 | 9 |
| P69 | The area's empty states | VAL-11 | 9 |
| P70 | Suggestions as list and detail | VAL-12 | 9 |
| P71 | Holds and alerts once | VAL-13 | 9 |
| P72 | Inputs as key-value pairs | VAL-14 | 9 |
| P73 | Actions column and "Due today" | VAL-19 | 9 |
| P74 | Figures and the variance flag slot | VAL-08, VAL-09 | 9 |
| P75 | Long registers and nowrap columns | VAL-04 (partly), VAL-05 | 9 |
| P76 | Area headers and markers | VAL-07, VAL-17 | 9 |
| P77 | Report tables | R2, R4 | 10 |
| P78 | Headers and actions | R7 | 10 |
| P79 | Loading and errors keep the frame | R10 | 10 |
| P80 | A client's reason said once | R11, AN-23 | 10 |
| P81 | Package page layout | R12 | 10 |
| P82 | A disabled command's reason visible | R13 | 10 |
| P83 | Report wording | R14 (partly) | 10 |
| P84 | Start form and dialog order | R16 (partly) | 10 |
| P85 | Empty states and the Disclosures page | R9 | 10 |
| P86 | Movers in neutral words | R6 | 10 |
| P87 | The action result's tone | R3 | 10 |
| P88 | Chart chrome | VL-12, AN-07, AN-24, AN-01 | 11 |
| P89 | Line charts: no wash, dodged labels, axis break, baseline, tooltip placeholder | PF-16, AN-10 | 11 |
| P90 | Bar labels on phones | AN-17, PF-16 | 11 |
| P91 | A shared scale for paired charts | AN-04 | 11 |
| P92 | Scatter outliers at the edge | AN-09 | 11 |
| P93 | Stacked bar labels | AN-18 | 11 |
| P94 | Value creation table | AN-05 | 12 |
| P95 | Map tables' headers | AN-08 | 12 |
| P96 | Map palette and panel | AN-11, VL-13 | 12 |
| P97 | Map controls | AN-12, DS-06 | 12 |
| P98 | One context row per analytics tab | AN-13 | 12 |
| P99 | Filter bar | AN-14 | 12 |
| P100 | Credit sections | AN-16 | 12 |
| P101 | Map on a phone | AN-19 | 12 |
| P102 | Map motion | AN-21, DS-08 | 12 |
| P103 | Analytics wording | AN-22 | 12 |
| P104 | Exposure grouping control | AN-25 (partly) | 12 |
| P105 | The website | VL-16, DS-08 | 13 |
| P106 | Page copy that names the build, and the guards | VAL-06, PF-04, PIPE-04, DO-04 (partly), shell-09, shell-08 | 14 |

## 6. Counts

- Reviewer findings: 173 (shell 19, portfolio 23, pipeline 19, data operations 23, valuations and capital 20, reporting 17, analytics 25, design system 27). Motion proposals: 74 (shell 8, portfolio 8, pipeline 7, data operations 9, valuations and capital 7, reporting 6, analytics 11, design system 18), merged into section 3; section 3.10 says which were not taken.
- Plan findings: 106. Of these, 48 merge two or more reviewer findings (the shared problems seen on several pages, 2 to 12 sources each); 58 come from one reviewer finding. 133 distinct reviewer findings take part in the 48 merged ones (some also carry a page-specific part as their own plan finding).
- Carried in whole or in part: 172. Dropped whole: 1 (DO-23). Dropped in part under a rule: 12 sources (shell-01, shell-13, PF-03, PF-18, PF-22, PIPE-04, DO-04, VAL-04, R14, R16, AN-25, VL-04; section 7.1). Options set aside for a better shared fix: 19 (section 7.2).
- After the critique (section 7.3): two more sources are dropped in part under a rule, R7 (Start package in the header: the probe may not change) and AN-18 (multi-segment values left to the tooltip: which figures a page shows), so 14 in all; the other rows of 7.3 change how a finding is carried, not whether.

## 7. Dropped and set aside

### 7.1 Dropped, with the rule each would break

| Item | Rule |
|---|---|
| DO-23 (whole): read the import pages' role check from the contract instead of `roles.includes('operations')` in `Intake.tsx`, `Weekly.tsx`, `Lookthrough.tsx` | What a page does and who is offered which action: changing where an access rule is read is logic, and a list that differed would change who is offered the form. A real gap against the rule that access comes from the contract; recorded as an open item for a build session. |
| shell-13, last bullet: the flags page and `AssistantSwitch` take the editing role from the contract | Same rule; same open item. |
| PF-03 and VL-04: edit `lib/grid.ts` | Scope: `lib` production modules are outside the pass. Done instead in `Portfolio.tsx` by `withParams` on the exported themes. |
| PIPE-04 and DO-04: add a "(section N)" pattern to `lib/references.ts` | Scope. Done in `WorkflowSpec.tsx` with a local strip; the guard test is extended instead. |
| DO-04: show exceptions' Expected and Actual as dollars through `exactMoney` | Never invent: the queue's values carry no unit, so adding "$" asserts one. Codes get their labels; other values show exactly as recorded. |
| R14: retitle the Packages pages' not-visible states | Scope and the unreviewed Packages pages: `lib/unavailable.ts` writes "X: not visible to your role" for every page; changing two titles would split the pattern. |
| R16: keep the override dialog's primary button enabled; a textarea | The Packages pages' logic, and the shared `ReasonDialog`'s behaviour (when a command may be sent) is logic. The dialog's look, order and backdrop change; its enablement does not. |
| VAL-04: a 25-row pager on trade tickets | Which figures a page shows: paging hides rows the page shows today. A tall region with a sticky header solves the scanning instead. |
| PF-18 and AN-25 options: replace a bar chart with in-cell data bars | What a page shows: a chart would disappear. Both charts stay; the vehicles chart moves beside its table. |
| shell-01: rewrite the "forbidden pair" assertions of `lib/theme.test.ts` | The AA test is fixed; not needed, since the chosen palette passes it unchanged. |
| PF-22: the Activity timeline repeats its kind | The words are composed in `pages/deal/data.ts` logic; the reviewer left it too. Open item. |

### 7.2 Set aside for a better shared fix

- The shell review's cobalt #3258C9 palette: VL-02's values pass `theme.test.ts` unchanged.
- Inter (PF-09, R5) or a pure system stack: Inter is the face generated interfaces default to and the capture machine's own system font; a system stack renders three different faces. Fontsource subsets (VL-01): IBM's own unmodified split files respect the Reserved Font Name.
- A `MenuButton` user menu (shell-02): the unit test and the e2e fixtures drive the combobox; the `Dropdown` is restyled and grouped instead.
- Breadcrumbs derived from the route (shell-06) and an area-name title on every tab (DO-08, VAL-07, R7): 63 page tests mock the router without `useRouterState`, and unit and e2e tests assert the per-tab titles; record pages get explicit trails, area pages keep their titles, and the rail and tab row carry the area.
- Stacked table rows on phones (shell-10, VAL-05) and `KeyValueTable` as a `dl` (VAL-14, AN-16): tests and screen readers rely on table semantics; sticky identity column, scroll cue and one pair per row instead.
- Sliding tab and rail indicators measured in script (shell, portfolio and data operations motion) and a route wrapper keyed by the path: the CSS underline draws in on every tab change without a remount; the rail does not move.
- Height animation on disclosures: the chevron turns; content appears at once so nothing under it moves.
- A "Chart | Table" segmented toggle (AN-24): nine test files click "Show table"; the words stay, the look changes.
- Sticky table headers by letting wraps overflow at desktop widths (DO-03, R2): wide tables would spill out of the page; `TableWrap tall` instead.
- Tone colouring the key figure (AN-03, VL-11): a dot before the label keeps meaning and leaves every figure in ink (DO-07, VAL-09).
- Map water in primary tints with white land (VL-13): neutral land on a white page, with a thin coast kept so the opening can draw it.
- A vertical rule between two columns (VAL-03, R1): each column keeps its own top rule.
- Notices with no band at all (DO-11) or hairlines only (R3, VAL-13): one quiet band with a dot (VL-09).
- Category badges as tags (VL-05): plain muted text. Identifiers in mono (VL-05): the sans with tabular figures.
- The wordmark as a square crossed by one line (VL-07): a horizontal line reads as a horizon; three falling bars read as an allocation.
- The action log removed until it has an entry (R9, PF-14): one muted line keeps its place and leaves four tests unchanged.
- Add task behind a button (PIPE-10) and the IC form behind a click for approvers: no extra click at desktop widths.
- Watchlist severity buttons in place of its dropdown (PF-10 option): the dropdown stays.
- Closed and passed deals in a closed disclosure (PIPE-01): an open table, so nothing is hidden by default.

### 7.3 Changed after the plan critique (2026-11-18)

Each was checked against the code; the slice text above already carries the change.

| Plan finding | Was | Now, and why |
|---|---|---|
| P04 (section 3.9) | Short selectors in the reduced-motion blocks | Every animating selector repeated exactly; a guard test in `motion.test.ts`. The short forms lose on specificity (checked in Chromium). |
| P78 (R7, part dropped) | Start package in the header actions; the "Packages" card removed | The card stays as a flat section with `packages-card`, and the button stays at its toolbar's end: the probe clicks it inside that card and may not change. |
| P31 (shell-13) | A Type column; the switch named by its description | No Type column (the data names only kill switches); the switch keeps `{key} enabled` for the probe, open item 6. |
| P32 (shell-14) | `CheckList` with new words "Needs attention" and "Failing" | `CheckList` adds no word: readiness keeps "OK" and "Degraded", Data health shows its counts with today's tones. It keeps `data-health-tiles`. |
| P29 (shell-11) | The key under each term | Words only; values without references or file paths. |
| P34 (shell-17) | Sources as area names | The existing labels, which are more specific; only the route path goes. |
| P36 | "15 positions" | Today's words and test id, "15 positions shown". |
| P23, P87 (R3) | A leading "Done" or "Refused" and a class change | Markup, words and classes unchanged; the look changes through CSS on the existing classes. |
| P68 (VAL-10) | Commands in the page header with a test id prop | A flat command block directly under the header keeps the test ids, the reopened notice, the last-step sentence and Edit draft together; `PageHeader` gets no `actionsTestId`. |
| P39, P94 | Group header rows with no test changes named | Single columns span both header rows; the tests that read rows by index read body rows, listed in slices 6 and 12; lower headers keep today's accessible names through hidden words. |
| P93 (AN-18, part dropped) | Multi-segment values left to the tooltip | Every printed value stays (which figures a page shows); the plate is restyled. |
| Slice 11 marks (section 3.7) | Bars animate `pb-chart-mark` | Only the bar's path (`pb-chart-bar`) animates; `pb-chart-mark` stays the row's interaction hook. |
| P58 (DO-10) | A "Choose file" button over a hidden input | The native file input keeps its label, tab stop and focus ring; only `::file-selector-button` is restyled. |
| P11 | Hairlines from a grey background through 1px gaps | Rules drawn on the cells, so a short last row never shows a grey block. |
| P08 | One-line meta with an ellipsis | The meta wraps; only a single plain-text item such as a file name may clip, with its own `title`. |
| P22 | Eight dialog files | All twelve `DialogSurface` files. |
| P102 | Edit `use-map-view.ts` | Left alone; `MapTab.tsx` passes `useReducedMotion()` and the call sites set durations. |
| P94 | A second "Clear filters" in the empty state | Dropped: the filter bar already shows it. |
| P27 (shell-08, VL-08) | A split page with a brand panel and an accent rule | One column, a top bar like the app's, a dense list grouped by role; no rule. |
| P25 | The prototype sentence only inside the closed drawer on a phone | The status element stays in the phone bar as a dot and "Prototype", with the sentence inside it. |
| P15 | A lock icon added to `UnavailableState` | No icon. |
| P97 (map controls); slice 9 (the batch bar) | `.pb-map-field-label` and `.pb-val-batch` not named | Both restyled flat and in sentence case. |
| P105 (VL-16) | Eyebrow, wave dividers and sand bands kept; scene tokens removed | All four go from the site; the scene tokens stay because `check-site.mjs` reads them. |
| P106 | The mock assistant line not handled; one slice with the website | The page renders its own sentence and the guard names one string-only exception; the copy and guards are their own slice (14). |
| P02, P03 | Off-scale sizes (15px, 10px, 7px, 26px, 20px) and raw px | Every size and space by token; the cell's 6px vertical padding is the one named exception. |

## 8. Open items to record in docs/SESSION_LOG.md

1. Access read in components: `Intake.tsx:459`, `Weekly.tsx:293`, `Lookthrough.tsx:186`, `AdminFlags.tsx:42`, `AssistantSwitch.tsx:24`, `Valuations.tsx:674` decide with `roles.includes(...)` instead of the contract's route roles. For a build session (handoff section 10).
2. The Activity timeline repeats its kind in its text (`pages/deal/data.ts`).
3. The website's screenshots, tour video and brochures show the old look until the media is re-recorded (`pnpm --filter @pb/site build` re-records everything; handoff section 7 already lists the tour video).
4. The derived tokens sky, sea and sea-deep are no longer painted; removing them is a decision 0007 formula change for a later record.
5. The demo artifact still shows the old look until it is republished (handoff section 3).
6. The flag switch's accessible name is `{key} enabled` (`AdminFlags.tsx`), a configuration key a screen reader reads, against docs/06 section 6. It stays because `apps/web/scripts/probe-preview.mjs:255` clicks `getByLabel('ai.extraction enabled')`. For a session allowed to change the probe: name the switch by its description.
7. `lib/assistant.ts` `MOCK_ASSISTANT_LINE` names `config/definitions.json` and is no longer shown by any page; `lib/copy-guard.test.ts` carries a string-only exception for it. For a build session: reword or remove it, then drop the exception.
8. The test id `data-health-tiles` now sits on the Data health check list, because the probe (`probe-preview.mjs:184`) and `e2e/journey1.spec.ts:60` wait on it. For a session allowed to change the probe: rename it.
9. The website's scene tokens (`sceneSky`, `sceneSkyTop`, `sceneSeaNear` and the rest in `apps/site/scripts/lib/tokens.mjs`) are no longer painted but stay because `apps/site/scripts/check-site.mjs:272-285` reads them. Remove them with the checker's pairs in one change, with item 4.
