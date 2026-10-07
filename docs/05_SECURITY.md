# 05: Portfolio Beach Security Requirements

Portfolio Beach holds some of the most sensitive data at the firm:
- **material non-public information (MNPI)** from sponsors, received under LPA and side letter confidentiality
- valuations and client commitments
- LP positions
- wire instructions
- summaries of internal and external communications

This document sets the security bar. It is written to the standard that vendors such as a commercial vendor, a commercial vendor and a commercial vendor advertise to institutional LPs, so the application can stand up to IT and InfoSec review, internal audit, external audit, and prospective LP operational due diligence (ODD).

Every requirement has an ID (SEC-x.y). Claude Code (Fable) must cite the IDs it satisfies in each pull request. "Must" is mandatory before go-live. "Should" is expected unless a decision record explains otherwise.

---

## 1. Security objectives
1. **Confidentiality:** only authorized firm staff see data, and only the data their role and entitlements allow.
2. **Integrity:** numbers that reach clients, auditors or the accounting system are correct, traceable to their source, and cannot change silently.
3. **Availability:** the app is available during quarter-end and reporting windows. Recovery after an incident is fast and tested.
4. **Accountability:** every change and every sensitive read can be tied to a person, a time and a reason.
5. **Containment:** data never leaves the firm's Microsoft tenant and Azure subscription, except to approved AI endpoints under approved terms.

## 2. Data classification (SEC-2)
| Class | Examples in Portfolio Beach | Handling |
|---|---|---|
| **Restricted: MNPI / client** | Sponsor financials and quarterly reports, valuations, NAV, IRR/MOIC by deal, LP commitments, client positions, side letter terms, IC decisions, pipeline deals under NDA | Encrypted, role- and entitlement-gated, audited reads, never in logs, AI only via approved endpoint |
| **Restricted: payment** | Wire instructions, bank details, trade tickets | Field-level encryption, Ops-only full view, dual control (section 12) |
| **Confidential: personal** | Contact names, emails, phones; email metadata and AI summaries; employee activity | Minimize, role-gated, retention limits, privacy notice to staff |
| **Internal** | Taxonomies, config, templates, approved statistics | Standard access |
| **Public** | Brand assets, published disclosures | No restriction |

- SEC-2.1 (must): every table and column has a classification in `packages/db` metadata. CI fails on an unclassified column.
- SEC-2.2 (must): Microsoft Purview sensitivity labels apply to generated files (reports, exports). Restricted exports carry the "Highly Confidential" label and a watermark with the user and time.

## 3. Threat model (summary)
| Threat | Example | Primary controls (sections) |
|---|---|---|
| Unauthorized internal access | Non-PE employee or wrong team member views client data | 4, 5 |
| Account takeover | Phished credentials | 4 (MFA, Conditional Access), 13 |
| Data exfiltration | Bulk export, copying to personal storage | 5, 6, 13 |
| Tampering with reported numbers | Valuation changed after approval | 9, 11 |
| AI data leakage | Sponsor PDF sent to a non-approved model or retained by a provider | 8 |
| Prompt injection | Instructions hidden in a sponsor PDF or email | 8 |
| Payment fraud | Changed wire instructions in a spoofed email | 12 |
| Supply chain | Compromised npm/PyPI package | 10 |
| Insider misuse | Snooping on deals or colleagues' emails | 5, 11, 13 |
| Outage at quarter-end | Region failure, bad deployment | 14 |
| Key-person risk | Only one person can run or fix the app | 16 |

## 4. Identity and authentication (SEC-4)
- SEC-4.1 (must): **Entra ID single sign-on only** (OIDC / MSAL). No local accounts or passwords.
- SEC-4.2 (must): phishing-resistant **MFA** and **Conditional Access**: compliant or managed device, trusted locations or risk-based sign-in, session timeout (8 hours max, 30 minutes idle for admin pages).
- SEC-4.3 (must): **Entra app roles** assigned via security groups. Group membership is owned by IT or the PE team head, never self-service.
- SEC-4.4 (must): **Privileged Identity Management (PIM)** for admin roles: just-in-time elevation with approval and an expiry. No standing admin access in PROD.
- SEC-4.5 (must): access tokens are validated server side (issuer, audience, signature, expiry, roles) on every request. Short-lived tokens. No tokens in local storage (use MSAL's secure handling).
- SEC-4.6 (must): service-to-service calls use **managed identities**, never shared secrets.
- SEC-4.7 (must): a quarterly **access review** (Entra Access Reviews), plus automatic removal on leaver events within 24 hours.
- SEC-4.8 (should): a break-glass account kept in a vault, monitored, and tested twice a year.

## 5. Authorization and information barriers (SEC-5)
**Roles:**

| Role | Can do |
|---|---|
| Viewer | Read the portfolio and pipeline, excluding Restricted fields they aren't entitled to |
| Deal Team | Edit pipeline, diligence, commentary and change requests; first-step valuation approval |
| Operations | Valuations, closings, capital activity, imports, full wire details |
| Approver (team head) | Final approvals, IC decisions |
| Investor Relations | Client reporting, the request library, client data for their entitled clients |
| Platform Admin | Configuration only, with no automatic access to Restricted data |
| Auditor | Read-only access plus audit logs |

- SEC-5.1 (must): **defense in depth.** The UI hides what a user can't use, the API enforces role checks, and **PostgreSQL row-level security** enforces the same rules at the data layer. A bug in one layer must not expose data.
- SEC-5.2 (must): **entitlements** beyond roles. Client-specific data is visible only to users entitled to that client. Deals under NDA or in a restricted pipeline stage are visible only to the deal team, approvers and Operations.
- SEC-5.3 (must): **information barriers / MNPI walls.** Support "restricted lists" and "walled deals" where only named users can see the record, and searches and AI answers never reveal that the record exists to others. (a commercial vendor positions this as ethical walls enforced at the architecture level. Portfolio Beach must match that.)
- SEC-5.4 (must): **least privilege for Platform Admin.** Configuration rights do not grant data access. Elevation to data access goes through PIM with a reason.
- SEC-5.5 (must): the **export controls** follow the same rules as screen access. Bulk exports over a set threshold (config) need a reason, are logged, are labeled, and alert security.
- SEC-5.6 (must): **segregation of duties.** The person who prepares a valuation, wire instruction or report package cannot be its final approver.

## 6. Data protection (SEC-6)
- SEC-6.1 (must): **encryption in transit** with TLS 1.2 or higher everywhere (1.3 preferred) and HSTS on the web app.
- SEC-6.2 (must): **encryption at rest** for PostgreSQL, Blob Storage, AI Search, backups and queues. Use **customer-managed keys** in Key Vault (HSM-backed) for PROD, with key rotation.
- SEC-6.3 (must): **field-level encryption** (application layer) for bank details and other payment fields. The keys can only be used by the payment service identity.
- SEC-6.4 (must): **minimization.**
  - Raw email bodies are never stored. Only metadata plus the AI summary is kept.
  - Document text is held only for processing, then deleted. Extracted values plus citations (page number and a short span) are kept instead.
  - Personal data is limited to what workflows need.
- SEC-6.5 (must): **retention policies** per table and document type, approved by Compliance and aligned with the firm's books-and-records obligations. Support legal hold and eDiscovery (documents stay in SharePoint so Purview covers them).
- SEC-6.6 (must): **no real data outside approved environments.** DEV uses synthetic data only. TEST uses approved data only (`docs/10`). PROD data is never copied down to lower environments without masking and Compliance approval.
- SEC-6.7 (must): **data residency** in a US Azure region (paired region for DR). AI processing stays in the US where the endpoint allows it.

## 7. Network and infrastructure (SEC-7)
- SEC-7.1 (must): **private endpoints** for PostgreSQL, Storage, Key Vault, AI Search and Service Bus. No public network access to data services.
- SEC-7.2 (must): the web front end sits behind **Azure Front Door with WAF** (OWASP rule set, bot protection, rate limiting). Admin routes can be restricted to the corporate network.
- SEC-7.3 (must): outbound traffic goes through an **egress allow-list** (Microsoft Graph, the approved AI endpoint, package mirrors in CI only). Everything else is denied.
- SEC-7.4 (must): containers are minimal images that run as non-root with read-only file systems, are scanned before deploy, and are pinned by digest.
- SEC-7.5 (must): **infrastructure as code only.** Manual changes in the portal are blocked by policy (Azure Policy deny plus drift detection).
- SEC-7.6 (must): **Microsoft Defender for Cloud** is enabled on all resources. Secure score findings are tracked to closure.
- SEC-7.7 (should): separate subscriptions (or management groups) for PROD and non-PROD.

## 8. AI security (SEC-8)
- SEC-8.1 (must): an **approved endpoint registry.** Anthropic models (Fable or Opus, per approval) are called only through the endpoint IT approves (for example Azure AI Foundry, or Anthropic's API under an enterprise agreement). Confirm in writing: **no training on firm data, zero data retention where available**, US processing, and the list of sub-processors.
- SEC-8.2 (must): **confidentiality check.** Compliance confirms that LPA and side letter confidentiality terms allow processing GP materials through the approved AI service (some agreements allow an "agency" provision; get a legal view).
- SEC-8.3 (must): **prompt injection defense.**
  - Document and email content is passed as clearly delimited data.
  - System prompts say embedded instructions must be ignored.
  - Extraction calls have **no tools**.
  - Assistant tools are **read-only and permission-scoped** to the requesting user.
- SEC-8.4 (must): **output validation.** Outputs follow strict JSON schemas, units are declared, values are range-checked, and every number carries a page citation. Failed outputs never write. They go to review.
- SEC-8.5 (must): **AI respects permissions.** "Ask Portfolio Beach" and search only retrieve what the user can already see (row-level security and walls are applied *before* retrieval). Walled records never appear in answers.
- SEC-8.6 (must): **human in the loop** for anything reaching clients, the accounting system, valuations or payments.
- SEC-8.7 (must): **redaction before AI** of bank details, personal identifiers and privileged legal content, using deterministic filters.
- SEC-8.8 (must): **evals as release gates.** Each prompt has an eval set, including an injection suite. Release is blocked if accuracy drops or any injection case succeeds.
- SEC-8.9 (must): **AI logging without content.** Log the model, prompt version, token counts, latency, the requesting user and the record IDs. Never log prompts or outputs that contain Restricted data.
- SEC-8.10 (should): a kill switch per AI feature (config flag) to disable it instantly.

## 9. Data integrity and financial controls (SEC-9)
- SEC-9.1 (must): **staging, validation, approval, then production** for every external or AI-sourced value.
- SEC-9.2 (must): **versioning and history.** Every financial record keeps its full history (system-versioned tables), including restatements.
- SEC-9.3 (must): **approval locks.** Approved valuations and report packages are locked with a content hash. Any change creates a new version, reopens approval, and alerts the approver.
- SEC-9.4 (must): **click-to-source lineage.** Every reported number links to its source document, page and extraction run (parity with the vendor "click-to-audit" capability).
- SEC-9.5 (must): **reconciliation controls.** These include the NAV roll-forward, the prior-report tie-out, the QTD basis check and the accounting system tie-out (`docs/04` M14). Release is blocked on failure unless an approver overrides with a reason.
- SEC-9.6 (must): **calculation integrity.** The calculation library is tested against golden files and cross-checked against an independent implementation. Calculation version is stored with results.

## 10. Application and supply chain security (SEC-10)
- SEC-10.1 (must): build to **OWASP ASVS Level 2** and cover the OWASP Top 10, including the OWASP Top 10 for LLM applications for AI features.
- SEC-10.2 (must): input validation at every boundary (Zod / Pydantic), parameterized queries only (ORM), output encoding, a strict Content Security Policy, and CSRF protection where cookies are used.
- SEC-10.3 (must): **file upload safety.**
  - Allow-listed types only (PDF, XLSX, DOCX, PPTX, CSV, MSG/EML).
  - Size limits.
  - **Malware scanning** (Defender for Storage) before processing.
  - Office macros are never executed.
  - Parsers run in an isolated sandbox container.
- SEC-10.4 (must): **CI security:** SAST (CodeQL), secret scanning with push protection, dependency scanning (Dependabot), container and IaC scanning, license allow-list, and an SBOM per release.
- SEC-10.5 (must): **dependency policy.** Lockfiles are required. New dependencies need review. Pin versions, and use a private package mirror for PROD builds.
- SEC-10.6 (must): **DAST** against TEST before each release, and an **independent penetration test** before go-live and annually after that (web app, API, Outlook add-in, Teams app).
- SEC-10.7 (must): the Outlook add-in and Teams app use Entra single sign-on (nested app authentication), request least-privilege Graph scopes, and are deployed centrally by IT (not sideloaded).

## 11. Logging, monitoring and audit (SEC-11)
- SEC-11.1 (must): an **audit trail** in `audit.event`. It is append-only (no update or delete permissions even for admins) and records who, what, when, before/after hashes and the reason. It covers: create, update and delete of business records; approvals; overrides; exports; sensitive reads (Restricted records opened); role changes; and config changes.
- SEC-11.2 (must): **immutable retention.** Audit events are exported daily to immutable (WORM) storage and kept for the retention period Compliance sets.
- SEC-11.3 (must): **security monitoring.** App, database, Entra and Defender signals flow to the firm's SIEM (for example Microsoft Sentinel). Alert rules cover:
  - impossible travel
  - bulk exports
  - repeated authorization failures
  - access to walled records
  - wire instruction changes
  - admin elevation
  - AI injection detections
- SEC-11.4 (must): **logs never contain Restricted content** (document text, email bodies, values, bank details). Log IDs and status codes only.
- SEC-11.5 (must): an **ODD evidence pack** export: access list by role, access review results, approval history, change history for reported numbers, exceptions, pen test summary and the incident log.

## 12. Payment and wire fraud controls (SEC-12)
- SEC-12.1 (must): wire details are **never** taken from email text or AI output. The extractor may only flag that wire instructions are present.
- SEC-12.2 (must): a **wire instruction register** with versioning. Any new or changed instruction requires a **callback to an independently sourced phone number**, made by a person other than the requester. The call is logged with date, number source and result.
- SEC-12.3 (must): **dual control** on trade tickets. The preparer and approver must be different people. A ticket can't be released if the instruction is unverified or was recently changed without a second approval.
- SEC-12.4 (must): alerts for changed instructions, urgency language, look-alike sender domains, and due dates under 2 business days.

## 13. Privacy and acceptable use (SEC-13)
- SEC-13.1 (must): **email and calendar capture is opt-in** per user. The scope is limited to messages with known external sponsor contacts. Internal-only, personal, HR and privileged content is excluded. A privacy notice is approved by HR, Legal and Compliance before rollout.
- SEC-13.2 (must): users can see what was captured from their mailbox and remove items.
- SEC-13.3 (must): **Graph application permissions**, if used, are restricted to opted-in mailboxes through an Exchange application access policy (or RBAC for Applications).
- SEC-13.4 (should): insider risk signals (Purview) for unusual downloads of Restricted data.

## 14. Resilience, backup and disaster recovery (SEC-14)
- SEC-14.1 (must): zone-redundant high availability for PostgreSQL and the app tier in PROD.
- SEC-14.2 (must): **backups** with point-in-time restore (35 days) plus long-term retention (monthly, 7 years or per Compliance), and geo-redundant copies in the paired region.
- SEC-14.3 (must): **targets:** RPO 15 minutes or less, RTO 4 hours or less for core functions. Quarter-end freeze windows apply: no risky deployments in the last 5 business days before reporting deadlines.
- SEC-14.4 (must): a **restore test** each quarter and a DR failover exercise each year, with documented results.
- SEC-14.5 (must): **safe deployments.** Blue/green or staged rollouts with automatic rollback. Database migrations are backward compatible.

## 15. Third parties and sub-processors (SEC-15)
- SEC-15.1 (must): keep an inventory of every external service (Microsoft Azure / Microsoft 365, the AI model provider, any data enrichment provider such as PitchBook if added). Each needs a vendor risk assessment by the firm's vendor management process.
- SEC-15.2 (must): contracts or terms in place covering confidentiality, no training on firm data, breach notification, data deletion on exit, and audit rights or a SOC 2 report.
- SEC-15.3 (should): any future outsourced data operations (for example offshore review support) only through Portfolio Beach roles and audit, never by sending files outside the app.

## 16. Governance, change and continuity (SEC-16)
- SEC-16.1 (must): named **System Owner** (business), **Technical Owner** (IT or the owner), and a trained **backup** for each. Two people minimum can deploy, restore and rotate keys.
- SEC-16.2 (must): **change management.** Changes go through pull requests with human review, a CI security gate, a change record for PROD releases, and Compliance review for client-facing output changes.
- SEC-16.3 (must): **runbooks** for deploy, rollback, restore, key rotation, incident response, user onboarding and offboarding, and quarter-end.
- SEC-16.4 (must): **incident response plan** aligned with the firm's plan: detect, contain (kill switches, disable integrations, revoke tokens), assess client impact, notify Compliance and Legal, then remediate and review. Regulatory and client notification decisions are made by Compliance and Legal (for example under the SEC's amended Regulation S-P requirements where applicable).
- SEC-16.5 (must): annual security review against a recognized framework (NIST CSF 2.0 or ISO 27001 Annex A control mapping), with findings tracked.

## 17. Secure development with Claude Code (Fable)
- SEC-17.1 (must): **Prototype stage:** Claude Code runs in Anthropic's cloud sandbox against a private repo on a GitHub account registered to the owner's work email, outside the employer's GitHub organization. Because the employer cannot manage that account, the repo and sessions contain **no employer information of any kind** (`docs/10`): synthetic data only, no credentials to any real system, network limited to package registries and docs (`docs/16`). The repo moves into the employer's GitHub organization before any employer data, branding or integration is added.
- SEC-17.6 (must): **mock adapters and mock identity can never run in production:** build exclusion plus a startup assertion, both tested (`docs/17` section 6).
- SEC-17.7 (must): an automated employer-information check (`scripts/check-employer-data.sh` + local deny-list) runs before every push and in CI.
- SEC-17.5 (must): GitHub controls in place (personal repo: 2FA, private visibility, secret scanning with push protection, Dependabot, CodeQL; org repo adds SSO, teams and protected environments): org SSO, branch protection, CODEOWNERS, required human review (Claude cannot approve its own PRs), secret scanning with push protection, CodeQL, Dependabot, SHA-pinned actions, and OIDC-only Azure deployment from protected environments.
- SEC-17.2 (must): `.claude/settings.json` blocks reading secrets, applying infrastructure, deploying, and targeting TEST or PROD.
- SEC-17.3 (must): all AI-generated code goes through the same review and CI gates as human code. Security-sensitive areas (auth, row-level security, payment, audit, AI tool scoping) need a second human reviewer.
- SEC-17.4 (must): before the repo moves into the employer's environment, IT, InfoSec and Legal approve the code transfer, Claude Code cloud use and the model (gate G0).

## 18. AI operations agents (SEC-18, see docs/15)
- SEC-18.1 (must): each ops agent has its own least-privilege managed identity; no Owner or Contributor rights on PROD.
- SEC-18.2 (must): agents act only through named, tested, reversible runbooks with rate limits. No free-form shell or CLI in PROD.
- SEC-18.3 (must): ops agents read telemetry only and cannot read business tables, documents or Restricted content.
- SEC-18.4 (must): log, ticket and chat text is untrusted input; injection test cases are in each ops agent's eval set.
- SEC-18.5 (must): agents can never grant access, change roles, delete data or backups, disable audit or security tooling, or change their own prompts, tools or autonomy level.
- SEC-18.6 (must): L3 actions require human approval with PIM; every agent action is audited with its reasoning.
- SEC-18.7 (must): a global ops kill switch drops all agents to observe-only.

## 19. Go-live security acceptance (all must pass)
- [ ] Data classification complete; Purview labels on exports
- [ ] Entra SSO, MFA, Conditional Access, PIM, access review configured
- [ ] Row-level security and walls proven by automated tests (positive and negative cases)
- [ ] Private networking, WAF, egress allow-list, Defender enabled
- [ ] CMK encryption, field-level encryption for payment data
- [ ] AI endpoint approval letter on file; injection suite passing
- [ ] Audit trail immutable; SIEM alerts live
- [ ] Backup restore and DR test passed
- [ ] Penetration test with no open critical or high findings
- [ ] Runbooks, owners and backups named; incident plan approved
- [ ] Compliance sign-off on retention, privacy notice and data gates
- [ ] Beach Ops agents at approved autonomy levels; kill switch tested; IT escalation path agreed

## 20. Per-change security checklist (every pull request)
- [ ] Which SEC IDs does this change touch? Listed in the PR.
- [ ] New data? Classified, minimized, retention set.
- [ ] New access path? Enforced in the API **and** row-level security; negative test added.
- [ ] Secrets only in Key Vault / managed identity?
- [ ] AI involved? Approved endpoint, delimited input, schema-validated output, eval updated, no content in logs.
- [ ] New dependency or permission? Reviewed and recorded.
- [ ] Audit events emitted for business-significant actions?
