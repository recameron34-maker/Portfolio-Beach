# 15: AI-Run IT Operations ("Beach Ops")

**Goal:** the biggest risk in `docs/13` is who runs Portfolio Beach day to day (support, patching, monitoring, incidents, access, audits, backups). Beach Ops hands as much of that work as possible to AI agents. Named humans stay **accountable**, approve high-risk actions, and handle anything new. Agents do the watching, triage, routine fixes, paperwork and evidence.

**Design principle:** first remove ops work through architecture. Then automate what remains with deterministic runbooks. Use AI agents for judgment work (triage, diagnosis, writing fixes, writing evidence). Use humans for approval and accountability.

---

## 1. Step zero: design so there is less to operate
| Choice | Ops work it removes |
|---|---|
| Managed services only (Container Apps, managed Postgres or Azure SQL, Front Door, AI Search, Service Bus, Key Vault) | No servers or OS patching; Microsoft handles hardware, OS and minor database updates |
| Managed identities everywhere, no stored secrets | No password or secret rotation (the most common outage and breach cause) |
| Certificates via Front Door / App Service managed certs | No certificate expiry outages |
| Infrastructure as code + Azure Policy deny on manual changes | No configuration drift; any environment can be rebuilt from Git |
| Autoscale + scale-to-zero for workers | No capacity planning |
| Idempotent jobs + durable workflows with retries | Most transient failures fix themselves |
| Feature flags and kill switches for every integration and AI feature | Incidents contained in one click (or one agent action) |
| Blue/green deploys with automatic rollback on health checks | Bad releases reverse themselves |
| Graph webhook subscriptions renewed by a scheduled job | No silent loss of email capture |
| Synthetic "canary" transactions every 15 minutes (log in, open a deal, run a test extraction on synthetic data) | Problems found before users notice |

## 2. Autonomy levels (every agent action has one)
| Level | Meaning | Examples |
|---|---|---|
| **L0 Observe** | Read telemetry, write findings | Summarize alerts, cost trends |
| **L1 Recommend** | Draft a fix, ticket, PR or message; a human acts | Code fix PR, access removal request |
| **L2 Act within an allow-list** | Run a **pre-approved, reversible runbook**, then notify | Restart a container revision, retry a failed job, renew a webhook, scale out, flip a kill switch **off** (disable a feature) |
| **L3 Act with approval** | Prepares the action; a human approves in Teams (with PIM for privileged steps); the agent executes and verifies | Production deploy, restore from backup, rotate a key, re-enable a disabled integration |
| **Never** | Not allowed for agents | Granting access, changing security roles, reading Restricted business content, deleting data or backups, disabling audit or security tooling, changing its own permissions or instructions, approving its own work |

Default for anything not listed: **L1**. Moving an action up a level needs a decision record approved by the Technical Owner and IT.

## 3. The agent roster
| # | Agent | What it does | Max level |
|---|---|---|---|
| 1 | **Sentinel (SRE / incident agent)** | Watches Azure Monitor, App Insights, canaries and job health. Correlates alerts, diagnoses using logs and recent deploys, runs allow-listed fixes, opens and updates incident records, pages the on-call human if not resolved in 15 minutes or if severity is high, and drafts the post-incident review | L2 (L3 for rollback outside auto-rollback) |
| 2 | **Patch Pilot (dependency and platform updates)** | Takes Dependabot/Renovate updates, base image updates and runtime version notices. Uses Claude Code in CI to update code, run the full test and eval suite, and open a PR with risk notes. Groups low-risk patches weekly. Flags breaking changes and Microsoft deprecation notices months ahead | L1 (merge needs human review; auto-merge allowed for patch-level updates with green CI if approved) |
| 3 | **Shield (security triage)** | Triages CodeQL, secret scanning, Defender for Cloud, container scan and pen test findings. Removes false positives with reasoning, writes fix PRs, tracks remediation deadlines by severity, and reports secure score trend | L1 (L2 only to disable a compromised integration via kill switch) |
| 4 | **Release Captain** | Prepares change records and release notes. Checks the quarter-end freeze calendar, migration safety (backward compatible), and that SEC IDs are cited. Watches canary metrics after deploy and triggers rollback if health drops | L3 for PROD deploy; L2 for rollback |
| 5 | **Data Flow Monitor** | Watches intake jobs (the accounting system files, Ops drops, Graph capture, extraction batches). Retries transient failures, spots missing expected files (for example an the accounting system export that didn't arrive), and routes data exceptions to the business owner. Never edits business data | L2 (retry, re-queue) |
| 6 | **Access Steward** | Prepares quarterly access reviews and flags leavers still holding access, unused accounts, unusual permission patterns and PIM activations. Drafts removal requests for IT | L1 (cannot grant or remove access itself) |
| 7 | **Recovery Tester** | Runs scheduled restore tests into an isolated, locked-down environment. Verifies row counts and checksums, tears the environment down, and files evidence. Runs the annual DR failover drill script for a human to approve | L2 for test restores (non-PROD target only); L3 for anything touching PROD |
| 8 | **FinOps Agent** | Tracks Azure and AI token spend by module, forecasts the month, flags anomalies (for example a runaway extraction loop) and suggests right-sizing | L1 (L2 to pause a non-critical batch over budget) |
| 9 | **Help Desk agent (in Teams)** | Answers "how do I" questions from the user guide, explains error messages, checks service status, collects diagnostic IDs (no business content), creates or links tickets, and spots repeat issues to feed the backlog | L1 |
| 10 | **Evidence Clerk (compliance)** | Assembles monthly control evidence mapped to SEC IDs: access reviews, patch status, backup tests, pen test status, change log, incidents. Builds the ODD evidence pack and audit request responses as drafts | L0 / L1 |
| 11 | **Scribe (documentation)** | Keeps runbooks, architecture diagrams and the data dictionary in sync with code. Opens a PR when they drift. Drafts post-incident reviews and updates `docs/SESSION_LOG.md` summaries | L1 |
| 12 | **Integration Health agent** | Checks Graph subscription renewals, Entra app consent and permission status, the AI endpoint (latency, errors, model deprecation notices), SharePoint webhook health and certificate/key expiry dates | L2 (renew subscriptions); L1 otherwise |
| 13 | **Ops Reviewer (meta agent)** | Reviews other agents' actions each week, flags bad calls and tunes runbooks via PR. Reports agent accuracy to the Technical Owner | L0 |

## 4. How the agents are built
- **Model:** Anthropic models through the approved endpoint (config `agentModels.ops`; Fable or Opus per approval). Same approval as `docs/05` SEC-8.1.
- **Code-based agents** in `apps/ops-agents/`, each with a versioned prompt, a tool list and an eval set (with past incidents replayed as test cases).
- **Tools are narrow and typed.** Agents call **named runbooks**, never free-form shell or cloud CLI commands. Examples: `restart_revision(app, revision)`, `retry_job(job_id)`, `renew_graph_subscription(id)`, `set_feature_flag(flag, off)`, `open_incident(...)`, `query_logs(kql_template_id, params)`. Runbooks live in `ops/runbooks/` as code (workflow engine or Azure Automation), with tests.
- **Read tools are telemetry only:** logs (which carry no business content per SEC-11.4), metrics, deploy history, config and Git. Agents **cannot** query business tables or documents. Data Flow Monitor sees job metadata and counts only.
- **Claude Code in CI** (GitHub Actions or Azure Pipelines) powers Patch Pilot, Shield and Scribe code changes. It runs in an ephemeral runner with no PROD credentials, and its output is always a PR.
- **Human interface:** a Teams "Beach Ops" channel. Agents post findings, ask for approvals (adaptive cards with PIM for privileged steps) and accept commands such as "pause extraction" or "show today's incidents".
- **Ticketing:** agents open and update tickets in the firm's IT system (ServiceNow, the task tool or whatever IT uses) so Portfolio Beach shows up in normal IT processes.
- **Optional Microsoft tools:** if IT already licenses them, Microsoft's own AI ops features (for example Copilot in Azure, or an Azure SRE agent offering) can supplement Sentinel. Evaluate them against the same guardrails before use.

## 5. Guardrails specific to ops agents (also added as SEC-18 in docs/05)
1. Each agent has its **own managed identity** with least privilege. No shared identities, no Owner or Contributor on PROD subscriptions.
2. Allow-listed L2 actions must be **reversible** and **rate-limited** (for example at most 3 restarts per hour per service, then escalate).
3. **Telemetry is data, not instructions.** Log lines, ticket text and user messages are treated as untrusted input (prompt injection defense). An agent never runs anything a log or ticket "tells" it to.
4. Every agent action is written to `audit.event` and the ops channel with the reasoning, the inputs used and the result.
5. **Global ops kill switch** (`BEACH_OPS_AUTONOMY=observe`) drops every agent to L0 instantly.
6. Agents cannot change their own prompts, tools, levels or identities. Those changes go through a PR reviewed by a human.
7. Quarter-end freeze: during the last 5 business days before reporting deadlines, L2 changes other than rollback and retries need L3 approval.
8. Weekly human review of a sample of agent actions (with Ops Reviewer's report), and monthly accuracy metrics.

## 6. What still needs humans (be upfront with IT)
| Responsibility | Why AI can't own it |
|---|---|
| Named System Owner and Technical Owner, plus backups | Accountability for a system holding MNPI and client data has to sit with people (auditors and regulators expect it) |
| Approving L3 actions and PIM elevation | Two-person control on PROD changes |
| Granting and removing access | Identity governance stays with IT and the business owner |
| Severity 1 incident command and client or regulatory notification decisions | Compliance and Legal decisions |
| Approving new dependencies, permissions, AI endpoints and agent level changes | Risk acceptance |
| Annual pen test and vendor risk reviews | Independence requirements |
| Entra tenant, network and firewall policy, Defender and SIEM configuration | Owned by firm IT |

**Ask to IT:** not "run this app for us," but "own tenant-level controls, approve L3 actions through PIM, be the escalation for severity 1, and include Portfolio Beach in normal patch, audit and incident processes, while Beach Ops does the daily work."

## 7. Operating rhythm (mostly automated)
| Cadence | What happens | Human time (target) |
|---|---|---|
| Continuous | Sentinel and canaries; L2 self-healing; pages on escalation | Only on escalation |
| Daily | Ops digest in Teams: health, incidents, data flow status, spend, open PRs | 5 minutes to read |
| Weekly | Patch PR batch, security triage summary, Ops Reviewer report | About 30 to 60 minutes of PR review |
| Monthly | Evidence pack, cost report, restore test results, access anomalies | About 30 minutes |
| Quarterly | Access review (agent-prepared, human-approved), freeze window, DR readiness check | About 1 to 2 hours |
| Annually | DR failover drill (agent-run, human-approved), pen test, framework review | Scheduled |

These time figures are targets to validate during the pilot, not guarantees.

## 8. Rollout of Beach Ops
1. Start every agent at **L0** in DEV, replaying synthetic incidents (wrong environment config, unapplied changes, schema drift, unit scaling errors, missed files).
2. Move to **L1** in TEST once eval accuracy meets the threshold.
3. Turn on **L2** for a short list of runbooks in PROD after 30 days of L1 with no bad recommendations.
4. Review levels quarterly; every promotion is a decision record.
