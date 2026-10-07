# 0001: Platform stack
- **Status:** Accepted for the prototype; to be re-confirmed with IT at merge
- **Date:** prototype start
## Context
Financial-grade precision, testability and auditability are required; low-code tools make these hard. See `docs/13`.
## Decision
Custom application: React + TypeScript web, NestJS API, Python document workers, PostgreSQL, workflow engine, adapters with mocks. Azure hosting design applies after merge.
## Consequences
Higher build and operations effort, reduced by Beach Ops (`docs/15`). All outside systems sit behind adapters so production integrations are configuration plus adapter code.
