# 13: Build Approach and Stack

Portfolio Beach is built the way a specialist software vendor would build an institutional private markets platform: real code, a relational database, typed AI services, and infrastructure as code. It is designed to run inside a firm's own Microsoft tenant and Azure subscription when it is deployed.

## 1. Options considered
| | A. Low-code (Power Platform) | B. Custom app on Azure in the firm's tenant (**chosen**) | C. External SaaS hosting |
|---|---|---|---|
| Database | Dataverse | **PostgreSQL** (or Azure SQL) | Managed DB outside the firm |
| Logic | Flows | Typed TypeScript + Python | Code |
| AI | Low-code agents | Anthropic models from code, typed outputs, evals | Same as B |
| Testability | Weak | Strong (unit, integration, e2e, evals in CI) | Strong |
| Financial precision | Limited | Exact decimals, constraints, transactions | Strong |
| Data location | Firm tenant | **Firm tenant** | Outside the firm (hard to approve) |
| Ops burden | Low | Medium (reduced by Beach Ops, `docs/15`) | Low |

**Why B:** low-code tools make financial-grade testing, versioning and precision hard (environment mix-ups, unpublished changes, schema caches, unit conversions inside expressions). Code fixes all of these, and deploying into the firm's own tenant keeps data inside its security boundary.

## 2. Recommended stack
| Layer | Choice |
|---|---|
| Database | PostgreSQL 16 (Azure Flexible Server) or Azure SQL; engine-neutral ORM (Drizzle) |
| History and audit | System-versioned history tables + append-only `audit.event` |
| Search | Azure AI Search (hybrid keyword + vector), permission-filtered |
| Documents | SharePoint Online via Microsoft Graph in production; local folder adapter in the prototype |
| Backend API | TypeScript, Node 22, NestJS, Zod validation |
| Document and Office workers | Python 3.12 (PDF parsing, python-pptx, python-docx, openpyxl) |
| Workflow and jobs | Temporal or Azure Durable Functions |
| Messaging | Azure Service Bus |
| Front end | React + TypeScript + Vite, TanStack Router and Query, Fluent UI v9, AG Grid, ECharts |
| Hosting | Azure Container Apps + Front Door with WAF, private networking |
| Identity | Entra ID OIDC (MSAL), app roles; a mock identity provider in the prototype |
| Microsoft 365 integration | Graph (mail, calendar, SharePoint, Teams), Outlook add-in, Teams app |
| AI | Anthropic models through an approved endpoint; model set in config |
| Analytics | Power BI on a reporting schema with row-level security |
| Secrets | Azure Key Vault + managed identities |
| Observability | Azure Monitor, Application Insights, OpenTelemetry |
| IaC and CI/CD | Bicep or Terraform; GitHub Actions with OIDC |

## 3. Adapter pattern (keeps the prototype neutral)
Every outside system sits behind an interface in `packages/adapters` with a **mock** used in the prototype:
| Adapter | Prototype | Production (decided at merge) |
|---|---|---|
| Identity | Mock users and roles | Entra ID |
| Documents | Local folder of synthetic PDFs | SharePoint via Graph |
| Mail and calendar | Synthetic mailbox fixtures | Graph change notifications |
| Accounting system | Generic CSV import / export format | The firm's fund accounting system layout |
| Look-through data | Synthetic exposure file | The firm's data provider |
| AI model | Mock client + optional personal API key for synthetic data only | Approved enterprise endpoint |
| Benchmarks | Synthetic benchmark set | Licensed benchmark provider |

## 4. Database choice
If the deploying firm's IT runs SQL Server estates, Azure SQL may fit better; otherwise PostgreSQL. Both meet every requirement here. Keep the ORM and migrations engine-neutral and decide at merge.

## 5. Fallback
If the deploying firm will not approve option B, module specs, data model concepts, security rules and checklists still apply to option A; only `docs/02` and `docs/03` change.
