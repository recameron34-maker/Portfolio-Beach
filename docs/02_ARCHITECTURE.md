# 02: Architecture (recommended option B: custom application in the firm's Azure tenant)

See `docs/13_BUILD_APPROACH.md` for why this stack was chosen over Power Platform, and for the fallback.

## 1. Guiding decisions
1. **Everything runs inside the firm's Microsoft tenant and Azure subscription.** No data leaves the firm's boundary. AI calls go only to approved endpoints.
2. **PostgreSQL is the system of record** for Platform data. A separate fund accounting system stays the official accounting record. Data moves in and out through controlled imports and generated upload files.
3. **SharePoint stays the document home.** Portfolio Beach indexes and links to documents through Microsoft Graph and keeps copies only where processing needs them.
4. **Code over configuration screens.** Business logic, validations, calculations, prompts and workflows are versioned code with tests.
5. **Microsoft 365 is the front door.** Entra ID single sign-on, an Outlook add-in, a Teams app, Power BI.
6. **Staging, then approval, then production** for every financial value.

## 2. System diagram

```
 Users (Entra SSO) --> Web app (React)  |  Outlook add-in  |  Teams app  |  Power BI
                              |                 |                |             |
                              v                 v                v             |
                     +------------------------------------------------+       |
                     |  API (Node/TypeScript, NestJS)                 |       |
                     |  authz by role + row-level security            |       |
                     +---------+----------------+----------------------+       |
                               |                |                              |
           +-------------------+    +-----------+-------------+                |
           v                        v                         v                v
   PostgreSQL (system of     Workflow engine           Azure AI Search    Reporting schema /
   record, audit, history)   (Temporal or Durable      (docs, notes,      read replica
                             Functions): approvals,    market research)
                             schedules, batches
                                    |
          +-------------------------+---------------------------+
          v                         v                           v
   Document worker (Python)   AI service (Anthropic,      Integration workers
   PDF parse, Office gen      approved endpoint,          Graph (mail, calendar,
                              typed outputs, evals)       SharePoint, Teams),
                                                          the accounting system files, Ops drops,
                                                          the look-through data provider extract
   Events: Azure Service Bus.  Secrets: Key Vault.  Telemetry: App Insights.
```

## 3. Environments
| Env | Purpose | Data |
|---|---|---|
| Build sandbox | Claude Code cloud session (in-process Postgres, mocks; no Docker) or a local machine (Docker Compose) | Synthetic only |
| DEV (Azure) | Shared integration | Synthetic only |
| TEST (Azure) | UAT, parallel run | Synthetic, then approved data per `docs/10` |
| PROD (Azure) | Live | Approved data |

Each environment is a separate resource group (or subscription) with its own Key Vault, database and identity. It is deployed only through the pipeline. No one has standing write access to PROD.

## 4. Repository layout

```
/
|-- CLAUDE.md
|-- docs/                         # this guide, decisions/, SESSION_LOG.md
|-- config/                       # non-sensitive config; config/local/ is gitignored
|-- apps/
|   |-- web/                      # React + TS + Vite + Fluent UI v9
|   |-- api/                      # NestJS API (modules mirror docs/04)
|   |-- worker-ts/                # workflows, integrations, schedulers
|   |-- worker-py/                # document parsing, Office generation, calc cross-check
|   |-- outlook-addin/            # Office add-in (React)
|   |-- teams-app/                # Teams app manifest, adaptive cards, bot
|   `-- ops-agents/               # Beach Ops agents (docs/15): prompts, tools, evals
|-- ops/
|   `-- runbooks/                 # named, tested, reversible runbooks agents may call
|-- packages/
|   |-- db/                       # Drizzle schema, migrations, seed, RLS policies
|   |-- calc/                     # XIRR, MOIC, TVPI, DPI, multiples, YoY, quarter matching, credit metrics
|   |-- adapters/                 # outside-system interfaces + mocks (docs/13 section 3); resilience wrappers
|   |-- workflows/                # typed state-machine transition tables (docs/18) shared by API and tests
|   |-- validation/               # shared validation rules (Zod)
|   |-- ai/                       # prompt registry, schemas, model client, redaction, evals
|   |-- report-engine/            # template binding + QA checks (TS orchestration, Python rendering)
|   |-- ui/                       # shared components + brand tokens
|   `-- contracts/                # API types shared by web, add-in and Teams app
|-- infra/                        # Bicep/Terraform per environment
|-- powerbi/                      # PBIP project over the reporting schema
|-- tools/synthetic/              # synthetic data generator (docs/14); output in gitignored .synthetic/
|-- scripts/                      # cloud-setup, check-employer-data, install-hooks
|-- tests/                        # e2e (Playwright), evals, load tests
`-- .claude/settings.json
```

## 5. Integration contracts
| System | Direction | Mechanism |
|---|---|---|
| Microsoft Graph: mail and calendar | In | Change notifications (webhooks) for opted-in mailboxes, scoped by an Exchange application access policy. Outlook add-in for manual logging. |
| SharePoint (Document Hub) | Both | Graph delta queries + webhooks; metadata written back as columns |
| Teams | Out / interactive | Bot + adaptive cards for approvals and alerts |
| the accounting system | In / Out | Scheduled export files in; generated upload files out (API later if licensed) |
| the document collection service | In | Export or email drop into SharePoint intake |
| Ops workbooks | In | SharePoint drop folder, parsed by template signature |
| the look-through data provider | In | Periodic extract, reconciled to exceptions only |
| Anthropic models | Out | Approved endpoint only (Azure AI Foundry or direct API, per G0). No training on firm data. Zero data retention where available. |
| Power BI | Out | Reporting schema / read replica with RLS |

## 6. Cross-cutting patterns
- **Auth:** Entra app roles map to Portfolio Beach roles. The API checks roles **and** Postgres row-level security enforces them, so both layers protect the data.
- **Money:** `numeric(20,2)` dollars, never floats. Units are explicit on every AI output.
- **Idempotency:** every intake has a content hash plus a natural key. Reprocessing never duplicates.
- **Outbox pattern:** database changes and events are committed together, so nothing is lost between the database and the queue.
- **Feature flags:** every real-data connector checks the data clearance gate (`docs/10`).
- **Accessibility and performance budgets:** WCAG 2.1 AA; key pages load in under 2 seconds on 150+ deals.
