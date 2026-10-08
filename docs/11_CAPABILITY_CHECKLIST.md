# 11: Master Capability Checklist (what the Portal must be able to do)

This is the single list used to check that the build is complete. Every line maps to a module (`docs/04`). Claude Code (Fable) should update the Status column as work completes. Sources: common LP / co-investor workflows.

Status: N = not started, P = partial, B = built. Phase 0 built the foundations (data layer, calculations, workflow tables, adapters, API and web shell); module capabilities begin in Phase 1.

## A. Deal origination and pipeline
| # | Capability | Module | Status |
|---|---|---|---|
| A1 | Log an opportunity from email or a CIM (AI draft record) | M5, M4 | N |
| A2 | Stage board (Sourced to Closed or Passed), owners, key dates | M5 | N |
| A3 | Fund-fit check: co-invest only alongside GPs we back | M5 | N |
| A4 | Required pass reason + note, searchable history | M5 | N |
| A5 | Allocation requested vs. received, split by vehicle and client | M5 | N |
| A6 | Prescreen deck build guide (one pass, deal team from record) | M7 | N |
| A7 | Deal analysis support: entry multiple, leverage, growth-to-margin bridge, key risks and "reasons to pass" checklist | M5, M9 | N |
| A8 | Duplicate / near-miss name guard on new records | M1 | P (match guards stored and seeded; enforcement on record creation arrives with M1 linking services) |

## B. Diligence, IC and closing
| # | Capability | Module | Status |
|---|---|---|---|
| B1 | Diligence templates by deal type, tasks, gates | M7 | N |
| B2 | DDQ library + AI drafting in house style, with sources | M7 | N |
| B3 | Legal document tracker (LPA, side letter, sub docs, consents) with open questions | M7, M8 | N |
| B4 | IC deck / memo section drafting from the record | M7 | N |
| B5 | IC decision + conditions converted to tasks | M7 | N |
| B6 | Closing checklist with required docs; single closing date | M8 | N |
| B7 | **New:** closing pack (subscription agreement, LPA, wire instructions, contact sheet, W-9) filed and sent to Ops | M8 | N |
| B8 | **New:** trade ticket and deal metrics sheet generated and signed off | M16 | N |
| B9 | **New:** affiliated client / interested party consent workflow blocks closing | M19 | N |
| B10 | Monthly new-deal confirmation to deal teams | M8 | N |

## C. Capital activity (New)
| # | Capability | Module | Status |
|---|---|---|---|
| C1 | Capture capital call and distribution notices (ILPA template aware) | M16 | N |
| C2 | Due date tracker with alerts; preferred funding date | M16 | P (capital notice list with an attention panel and days to due from config; alert dispatch pending) |
| C3 | Wire instruction register + change-triggered callback verification (two people) | M16 | N |
| C4 | Cash Flow rows from approved notices (feeds IRR, unfunded, weekly report) | M16 | N |
| C5 | Equalization, recallable, interest and expense true-up handling; unfunded reconciliation | M16 | N |
| C6 | Follow-on, preemptive rights and other LP elections with deadlines | M11, M16 | N |
| C7 | Deal economics received (e.g., shared monitoring fees, fee offsets) | M11 | N |
| C8 | Interest, principal and PIK notices on credit positions create the right cash flows and par changes | M16 | N |

## D. Commitments and primary program (New)
| # | Capability | Module | Status |
|---|---|---|---|
| D1 | Commitment record incl. target / hard cap / final fund size updates | M17 | P (commitment views with called, distributed, recallable and unfunded; edits pending) |
| D2 | Monthly new commitment report with approval | M17 | N |
| D3 | GP track record by vintage (promised vs. delivered), re-up history | M17 | P (sponsor 360 lists funds, aliases, our positions and commitments; promised vs delivered pending) |
| D4 | Portfolio construction targets, vintage pacing, sizing, exposure | M17 | N |
| D5 | Advisory board / LPAC seats, votes and consents | M17 | N |
| D6 | Fund-of-funds market reference data (terms, sleeve mix) | M17 | N |
| D7 | Commitment linking and multi-client dedup | M1 | P (one canonical fund, many commitments; vehicle and client-directed commitments modeled and seeded) |
| D8 | LP commitments to firm vehicles, ownership after each close, client look-through of every position | M1, M17 | P (table, RLS entitlement, ownership gap check, vehicle detail and client look-through read views under entitlement) |

## E. Portfolio monitoring and valuation
| # | Capability | Module | Status |
|---|---|---|---|
| E1 | Document hub with AI tagging + expected document tracker | M3 | N |
| E2 | Quarterly extraction (15 fields + commentary) | M4 | N |
| E3 | Review by exception with page citations | M4 | N |
| E4 | Primary fund report extraction | M4 | N |
| E5 | Deal workspace one-pager (Overview, Performance, Sponsor & Contacts, Tasks, Documents) | M5, M9 | P (workspace tabs: Overview, Performance, Sponsor, Valuations, Capital activity, Activity; Diligence, Closing, Documents and Tasks arrive with their modules) |
| E6 | Entry vs. current multiple analysis, leverage, growth | M9 | P (quarterly series with ratios, prior-year YoY and since-entry comparison in the performance endpoint and tab) |
| E7 | Watchlist rules and alerts | M9 | P (rules from config thresholds evaluated in the API and shown on the watchlist and home; alert dispatch pending) |
| E8 | Realization outlook (next 18 months) changed only by explicit edit | M9 | P (read on the performance tab; the edit workflow is pending) |
| E9 | Valuation staging, approvals, lock / reopen, batch approve | M10 | P (state machine and database rules in place; valuation board read view; approvals and locks are simulated in the static preview only, decision 0006) |
| E10 | Deal change requests routed to Ops | M11 | N |
| E11 | **New:** NAV roll-forward when sponsor marks are late, with automatic footnote | M9, M19 | N |
| E12 | Sublines: balance, usage, paydowns, documented support for paydown sources | M12 | N |
| E13 | Private credit monitoring: terms, par / cost / fair value, PIK, coverage, leverage, LTV, DSCR, covenant and payment status, maturity ladder | M9 | P (tables, calculations, scenarios, API, one-pager, credit book view and watchlist flags; DSCR inputs and the ladder view pending) |

## F. Reporting
| # | Capability | Module | Status |
|---|---|---|---|
| F1 | Weekly report generated from data; live Power BI version | M12 | P (report assembled server side from the figures with template commentary and footnotes; Office output and Power BI pending) |
| F2 | Portfolio analysis page (sector, vintage, sponsor, average check size, deal type, concentration) | M12 | P (exposures, NAV and cash-flow series, top positions from the analytics endpoint; average check and concentration limits pending) |
| F3 | Internal quarterly co-invest reports updated from last quarter, stable visuals, separate change log | M14 | N (designed) |
| F4 | **New:** report QA engine (roll-forward, QTD basis, prior-report tie-out, sign check) | M14 | N |
| F5 | Mover commentary in house style; recalculated after data corrections | M14 | N |
| F6 | Client reporting packs (Word per vehicle + PowerPoint) | M14 | N (designed) |
| F7 | Multiple reporting bases per client; deal status deck | M14 | N |
| F8 | **New:** disclosure library and approved statistics register | M19 | N |
| F9 | Reporting package tracker, distribution log | M14, M19 | N |
| F10 | Ad hoc client / DDQ answer library | M14 | N |
| F12 | Reporting views with row-level security; in-app analytics; Power BI model (post-merge) | M13 | P (in-app analytics under RLS; Power BI post-merge) |
| F11 | IRR workbook reviewer agent | M15 | N (designed) |

## G. Relationships and market knowledge
| # | Capability | Module | Status |
|---|---|---|---|
| G1 | Zero-entry email capture with AI summary (own mailbox) | M6 | N |
| G2 | Sent items and meeting capture | M6 | N |
| G3 | Relationship score, warm paths, Sponsor 360 | M6 | P (Sponsor 360 on firm-side data: funds, aliases, positions, commitments; contacts, interactions and the score arrive with M6) |
| G4 | **New:** GP coverage map with delegates during leave | M18 | N |
| G5 | **New:** AGM calendar, RSVP, travel-by date, attendees | M18 | N |
| G6 | **New:** AGM notes agent (statements about the GP, not a recap) | M18 | N |
| G7 | Market Intelligence agent in the Portal | M15 | N |
| G8 | Email drafting from deal / sponsor context (concise, tactful, no em-dashes) | M15 | N |

## H. Team operations and controls
| # | Capability | Module | Status |
|---|---|---|---|
| H1 | Task and notification hub, missed-items digest | M15 | N |
| H2 | **New:** Weekly team meeting pack auto-generated | M18 | N |
| H3 | Audit trail and ODD evidence export | M15 | P (append-only audit.event, full-row history and an audit trail view for the four permitted roles; evidence export pending) |
| H4 | Exceptions dashboard (the look-through data provider, the accounting system, extraction, reports) | M2, M15 | N |
| H5 | Systems issue intake (problem, lane, scores, decision log) | M15 | N |
| H6 | Data clearance gates enforced in code | docs/10 | P (employer-data and style guards in CI, production guard against mocks; connector gates with the connectors) |
| H7 | Backup admin, runbooks, cost tracking | M15 | N |
| H8 | Ask Portfolio Beach (permission-aware Q&A) | M15 | P (mock assistant in the preview answers fixed questions from the current user's own figures by template, labelled as mock; no model call) |

## Out of scope (confirmed)
Fund-accounting general ledger, investor onboarding / KYC, fixing the look-through data provider or the document collection service themselves, the accounting system licensing, and personal (non-firm) tax or accounting workflows.

## I. Advanced capabilities
| # | Capability | Module | Status |
|---|---|---|---|
| I1 | Click-to-source on every reported number | M4, SEC-9.4 | N |
| I2 | 100+ automated validations; restatement history | M2 | N |
| I3 | Look-through exposures on our taxonomy | M20 | P (exposure buckets by sector, geography, deal type, vehicle, sponsor and vintage; client look-through by ownership) |
| I4 | Benchmarking, PME, quartiles | M20 | N |
| I5 | Liquidity and cash flow forecasting | M20 | N |
| I6 | Value creation attribution; exit analytics | M20 | N |
| I7 | Excel add-in with live approved data | M21 | N |
| I8 | Read API and daily feed to the enterprise data warehouse | M21 | N |
| I9 | Legal terms and allocation tracker (replaces the legal tracker updates) | M22 | N |
| I10 | Background check workflow | M23 | N |
| I11 | Cooling-contact alerts and AI relationship summaries | M6 | N |
| I12 | Client / LP request routing with templated drafts | M14 | N |
| I13 | Information barriers (walled deals) in search and AI | SEC-5.3 | P (walls enforced by RLS, the API and the UI with tests; search and AI retrieval arrive in Phases 2 and 6) |
| I14 | Self-serve client view: investments, dates, performance, calls, distributions | M14, M16 | N |
| I15 | Credit analytics: weighted yield and spread, exposure by seniority and base rate, PIK share of income | M20 | N |

## J. IT operations by AI agents (docs/15)
| # | Capability | Module | Status |
|---|---|---|---|
| J1 | Self-healing incident triage and allow-listed remediation | Sentinel | N |
| J2 | Automated dependency and platform patch PRs with full test runs | Patch Pilot | N |
| J3 | Security finding triage and fix PRs | Shield | N |
| J4 | Release checks, freeze enforcement, canary watch, auto rollback | Release Captain | N |
| J5 | Data pipeline monitoring and missing-file detection | Data Flow Monitor | N |
| J6 | Access review prep and leaver detection | Access Steward | N |
| J7 | Automated restore tests and DR drill scripts | Recovery Tester | N |
| J8 | Cost tracking and anomaly alerts | FinOps Agent | N |
| J9 | Teams help desk with ticket creation | Help Desk | N |
| J10 | Monthly control evidence and ODD pack drafts | Evidence Clerk | N |
| J11 | Runbook and documentation drift detection | Scribe | N |
| J12 | Graph subscription, certificate and AI endpoint health | Integration Health | N |
| J13 | Weekly review of agent actions and accuracy | Ops Reviewer | N |
