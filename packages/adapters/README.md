# @pb/adapters

Every outside system sits behind an interface here (`docs/13` section 3): identity, documents, mail and calendar, the accounting system, the look-through data provider, the AI model and benchmarks, plus the injected `Clock`.

- `@pb/adapters` exports the interfaces, `withResilience` (timeout, retry with exponential backoff and jitter for idempotent calls only, circuit breaker, kill switch), the `AdapterSet` registry, `healthOf` and `assertProductionSafe`.
- `@pb/adapters/mocks` exports the prototype implementations: mock identity (credential = external id), a local folder document store, mail fixtures, local accounting drop folders, look-through fixtures, a mock AI client that only ever returns registered fixtures, and a synthetic benchmark series. They are imported only from non-production composition code.

`assertProductionSafe(set, process.env)` runs at API startup. With `NODE_ENV=production` it throws, naming every mock adapter and the mock identity flag, so the process never serves traffic with a mock wired in (`docs/17` section 6, SEC-17.6). Real implementations (Entra ID, SharePoint via Graph, Graph mail, the firm's accounting layout, the licensed data and benchmark providers, the approved AI endpoint) are written after merge against the same interfaces.

Each adapter declares its kill switch key; the API reads `ops.feature_flag` and `withResilience` refuses the call when the flag is off.
