# 01: Product Context

## 1. The user
An institutional **LP / co-investor / allocator** private equity team that:
- commits to sponsor (GP) primary funds,
- co-invests alongside sponsors whose funds it backs,
- invests in GP-led continuation vehicles (CVs), single and multi-asset,
- manages capital for several clients with client-specific reporting,
- uses subscription credit lines on some vehicles.

Typical scale to design for: 10 to 20 users, 150 to 300 active co-investments and CV positions, 400+ fund commitments, several vehicles and 2 to 5 clients.

It is **not** a GP fund administrator: no general ledger, no investor onboarding or KYC. A separate fund accounting system remains the official book of record.

## 2. Roles
| Role | Needs |
|---|---|
| Deal team | Pipeline, diligence, IC materials, quarterly monitoring, commentary, valuation sign-off |
| Team head | Portfolio views, entry vs. current multiples, approvals |
| Investor relations | Client reporting, DDQ answers, ad hoc client requests |
| Operations | Valuations, closings, capital activity, accounting imports and exports |
| Platform admin | Configuration (with a named backup) |
| Auditor | Read-only, audit trail |

## 3. Common problems this product solves
- Deal, GP and relationship knowledge scattered across inboxes and spreadsheets.
- Quarterly monitoring that requires finding sponsor reports and keying data by hand (often 45 to 60 minutes per deal).
- Accounting systems that are not workflow or analytics tools; limited seats; one admin.
- No single source of truth; the team acts as the integration layer.
- Document repositories with poor tagging, disconnected from workflows.
- Handoffs between investment and operations teams by email (closings, deal changes, valuations).
- Valuations changed after approval; weekly and client reports with tie-out errors.
- Growing, customized client reporting with compressed timelines.
- Operational due diligence and audit expectations for centralized, timely monitoring.

## 4. Principles
Zero entry where possible; one record, many views; human approval before anything reaches a client or the books; self-service; audit-ready by default; maintainable by others; firm-specific details in configuration.

## 5. Glossary
LP / GP, co-invest, CV, NAV, MOIC, TVPI, DPI, IRR (XIRR), LTM, SOI, ODD, subline, entry multiple, ILPA templates, PME.
