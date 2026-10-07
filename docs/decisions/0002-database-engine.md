# 0002: Database engine
- **Status:** Proposed
## Context
PostgreSQL is the prototype engine (in-process for tests). The deploying firm may prefer Azure SQL to align with its existing SQL estate.
## Decision (prototype)
PostgreSQL 16, engine-neutral ORM usage; avoid Postgres-only features outside `packages/db` (RLS policies and triggers are isolated there so they can be re-implemented).
## Revisit
At merge, with IT.
