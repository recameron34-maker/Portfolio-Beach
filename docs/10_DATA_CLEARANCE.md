# 10: Prototype Data Rules and the Path to Merge

## 1. The prototype rule
The repo lives on a GitHub account registered to the owner's work email but **outside the employer's GitHub organization**, and it is built in **Claude Code cloud sessions** in Anthropic's cloud. Neither is managed by the employer's IT yet. It must contain **no employer information of any kind**:
- no employer name, brand, logos, templates or style guides,
- no real deal, company, sponsor, fund, client, LP or contact names,
- no financials, valuations, documents, emails or screenshots,
- no internal system names, table names, workflows, issue lists, RFPs, vendor quotes or meeting notes,
- no employer credentials, URLs, tenant IDs or network details.

Use only synthetic data, neutral sample configuration and generic, publicly known industry practices (ILPA templates, standard return metrics, common PE workflows).

## 2. Enforcement
- `scripts/check-employer-data.sh` runs in CI (first job), in `scripts/cloud-setup.sh`, and as a pre-push hook (`scripts/install-hooks.sh`). It blocks: terms in your local `config/local/denylist.txt`; email addresses outside example domains; phone numbers other than 555-01xx; bank-detail patterns; common secret formats; em dashes.
- Keep the deny-list only on your own machine (gitignored, and Claude Code is denied read access to it). Add the employer name, internal system names, people, funds, deals and sponsors you work with.
- Secret scanning with push protection is on in GitHub.
- Claude Code refuses employer information pasted into a session and points to this file.
- If something slips through: stop, remove it, rewrite history (`git filter-repo`), force-push only after confirming with the owner, and rotate anything sensitive.

## 3. Data tiers after merge
| Tier | Examples | When |
|---|---|---|
| T0 Synthetic | Generated data | Now |
| T1 Public | Industry standards, public docs | Now |
| T2 Employer schema and config | System names, fields, house style, brand | After G1, in the employer's environment |
| T3 Internal reference | Vehicle, sponsor, fund, deal names | After G2 |
| T4 Sensitive financial | Reports, valuations, commitments, cash flows | After G3 |
| T5 Client, LP, personal | Client reports, LP positions, email content | After G4 |
Real data is only ever handled by the deployed app in the employer's Azure, never inside Claude Code sessions.

## 4. Before merging into the employer's systems (checklist)
- [ ] IT and your manager informed that the prototype repo exists (do this now, not at merge).
- [ ] Written confirmation from Legal / Compliance that the prototype is employer work product and approved to bring in.
- [ ] Any policy requirements on outside accounts and devices satisfied or waived in writing.
- [ ] IT / InfoSec approval of the stack (docs/13), Claude Code cloud use and the model (gate G0).
- [ ] Repo transferred into the employer's GitHub organization (repository transfer keeps history, issues and PRs); no other copies kept.
- [ ] Security review of the code, dependencies and licenses (SBOM).
- [ ] Employer-specific configuration, brand and integrations added **only** in the employer's environment.
