# 0007: Derived UI tokens and the Horizon Line design system
- **Status:** Accepted for the prototype
- **Date:** 2026-10-08
- **Deciders:** repo owner (asked for a sleek, professional UI and an animated beach on the sign-in page)
## Context
`docs/06` allows only the tokens in `config/brand.json` and forbids hard-coded colours. A modern interface needs tints for hover and selection, inks that keep status text at WCAG AA, and a sign-in scene. Two of the raw tokens fail as text on white (accent 3.32:1, watch 3.64:1).
## Options considered
1. Add every needed colour to `config/brand.json`. Thirty extra values a deploying firm would have to maintain by hand.
2. Derive them in `apps/web/src/app/theme.ts` as formulas over the brand tokens (tint toward the page background, shade toward black) and emit them as CSS variables, with a unit test that pins every text pair the stylesheet uses at AA. Chosen.
## Decision
- `derived` in `theme.ts` holds the formulas; `cssVariables()` emits them as `--pb-*` variables plus rgb triplets for alpha use. A firm's theme file re-derives everything by changing `brand.json` only.
- Usage rules (added to `docs/06` section 1): `--pb-muted` only on the page background; secondary text on any tinted surface uses `--pb-muted-strong`; the accent is never text (use `--pb-accent-ink`); status colours as text only through `--pb-good-ink`, `--pb-watch-ink`, `--pb-bad-ink`, with the raw values kept for dots, borders and fills.
- The sign-in scene (sky, sea, glow, swells, sand, foam, horizon) is built from these tokens, animates transform and opacity only, and parks at composed offsets under `prefers-reduced-motion`. Nothing else in the app animates except skeleton pulses.
- Navigation icons come from `@fluentui/react-icons`, already a dependency; the serif appears only on page titles and the wordmark.
## Consequences (security, cost, operations, migration)
No new dependencies. The theme test fails if a token change breaks a contrast pair. The e2e accessibility run (axe, WCAG 2.1 AA, zero serious issues) and a reduced-motion check guard the markup.
## SEC IDs affected
None (presentation only).
## Verification
`apps/web/src/lib/theme.test.ts` (contrast pairs), `apps/web/e2e/a11y.spec.ts` (axe and reduced motion), screenshots at 1440 and 390 wide reviewed on 2026-10-08.
