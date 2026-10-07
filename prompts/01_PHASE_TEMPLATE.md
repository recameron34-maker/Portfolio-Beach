# Ticket session template

GitHub Issue: #<number>
Roadmap item: <e.g. P2-3>   Module: M<n>

Before coding:
- Re-read: the module in `docs/04`, plus `docs/03`, `docs/05` checklist, and as relevant `docs/08` (math), `docs/17` (standards), `docs/18` (states), `docs/14` (seed scenarios).
- Write a plan: files, migrations, API endpoints, state transitions, tests (including negative RLS and forbidden-transition tests), SEC IDs. Wait for "go".

While coding:
- Synthetic data only. Tests first for calculations and state machines. No mocks in production code paths.
- Commit small and often; branch `pb/<issue#>-<short-name>`.

When finished:
- Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:rls && pnpm test:workflows && pnpm check:style && bash scripts/check-employer-data.sh` (plus `test:calc` / `test:evals` if touched). Paste the summary.
- Show each acceptance criterion from `docs/04` and the test that proves it.
- Open a PR with the template; update `docs/SESSION_LOG.md` and `docs/11` statuses.
