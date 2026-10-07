# worker-py

Python side of Portfolio Beach. In Phase 0 it holds `calc_check`, the independent implementation of `docs/08` that cross-checks `packages/calc` (SEC-9.6). Document parsing and Office generation arrive in later phases.

```bash
uv sync                                  # one-time environment (uv.lock is committed)
uv run pytest -q                         # golden fixtures (shared with packages/calc) + Hypothesis properties
uv run ruff check . && uv run mypy src   # lint and strict typing
python -m calc_check.cross_check <cases.json>   # compare TS results; run via `pnpm --filter @pb/calc cross-check`
```

`calc_check` is deliberately written without reference to the TypeScript internals so the two implementations are separate evidence.
