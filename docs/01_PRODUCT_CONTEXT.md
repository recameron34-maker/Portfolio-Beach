# 01: Product Context

## 1. The user
An institutional **LP / co-investor / allocator** private equity team that:
- commits to sponsor (GP) primary funds through a fund of funds / primary program vehicle,
- co-invests alongside sponsors whose funds it backs, through pooled co-invest funds,
- invests in GP-led continuation vehicles (CVs), mostly single-asset, through dedicated CV funds,
- invests in private credit (senior secured, unitranche, second lien, mezzanine and NAV loans, usually alongside sponsors it backs) through a credit vehicle,
- manages capital for several clients (the LPs in its vehicles, plus client-directed separately managed accounts) with client-specific reporting,
- uses subscription credit lines on some vehicles.

**Two layers of commitment.** Clients commit to the firm's vehicles (`core.lp_commitment`); the firm's vehicles commit to sponsor funds and deals (`core.commitment`, `core.investment`). Every client view is a look-through of vehicle positions by the client's ownership share, so a position is stored once and allocated, never duplicated per client.

Typical scale to design for: 10 to 20 users, 150 to 300 active co-investment, CV and credit positions, 400+ fund commitments, several vehicles and 2 to 5 clients.

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
LP / GP, co-invest, CV, fund of funds (FoF), SMA (separately managed account), NAV, MOIC, TVPI, DPI, RVPI, IRR (XIRR), LTM, SOI, ODD, subline, entry multiple, ILPA templates, PME, LPAC.

Private credit: unitranche, second lien, mezzanine, NAV loan, base rate (for example SOFR) and floor, spread, cash coupon vs. PIK (paid in kind), OID (original issue discount), par, amortization, call protection, maturity, covenant, interest coverage, DSCR, LTV, leverage through the tranche.
