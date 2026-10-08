/**
 * What each role can read and change, one sentence per role, written from docs/05 section 5 and the
 * access matrix in packages/db/src/rls/matrix.ts (READ_MATRIX and WRITE_MATRIX), which
 * packages/db/src/rls/matrix.test.ts proves cell by cell. Keep the two in step: a change here without
 * a matrix change is a documentation bug, and the reverse is a security bug.
 */
export interface RoleRow {
  role: string;
  label: string;
  sees: string;
}

export const ROLE_ROWS: readonly RoleRow[] = [
  {
    role: 'viewer',
    label: 'Viewer',
    sees: 'Reads the portfolio, sponsors, vehicles, valuations and cash flows outside any wall; sees no client data, valuation history, walls or audit events, and changes nothing.',
  },
  {
    role: 'deal_team',
    label: 'Deal team',
    sees: 'Reads what a viewer reads, and can add sponsors, edit the investments it can see and give the first-step valuation approval; no client data, walls or audit events.',
  },
  {
    role: 'operations',
    label: 'Operations',
    sees: 'Reads every business record including clients, LP commitments, valuation history and the audit trail, and is the only role that adds clients and cash flows (it also adds taxonomy terms); it sees no walls.',
  },
  {
    role: 'approver',
    label: 'Approver (team head)',
    sees: 'Reads what operations reads plus every wall, gives final approvals and creates walls; it does not add clients, cash flows or taxonomy terms.',
  },
  {
    role: 'investor_relations',
    label: 'Investor relations',
    sees: 'Reads the portfolio plus the clients and LP commitments it is entitled to (SEC-5.2); no valuation history, walls or audit events, and no writes.',
  },
  {
    role: 'platform_admin',
    label: 'Platform admin',
    sees: 'Changes feature flags and taxonomy terms, creates walls and reads every wall and the audit trail; configuration rights give no access to client data or valuation history (SEC-5.4).',
  },
  {
    role: 'auditor',
    label: 'Auditor',
    sees: 'Read-only over every business record, including clients, valuation history and the audit trail; no walls and no writes.',
  },
  {
    role: 'service',
    label: 'Service',
    sees: 'Background jobs and agents under a managed identity; their output lands in staging tables for human approval and never straight to production records (CLAUDE.md rule 5).',
  },
];

export const ROLE_SOURCE =
  'Source: docs/05 section 5 and packages/db/src/rls/matrix.ts, proven by packages/db/src/rls/matrix.test.ts (pnpm test:rls). A wall adds its records to a member’s view on top of the role (SEC-5.3); non-members never learn the record exists.';
