import type { z } from 'zod';
import { ALL_CLIENT_ROLES, seesAllClients as rolesSeeAllClients } from '@pb/contracts';
import type { appRole } from '@pb/contracts';

export type Role = z.infer<typeof appRole>;

/**
 * Each role in words, the way the sign-in picker, the user switcher and the preview guide write it
 * ("Blake Mbeki (deal team)"). The admin role table keeps its own capitalized labels and sentences.
 */
export const ROLE_WORDS: Readonly<Record<Role, string>> = {
  viewer: 'viewer',
  deal_team: 'deal team',
  operations: 'operations',
  approver: 'approver',
  investor_relations: 'investor relations',
  platform_admin: 'platform admin',
  auditor: 'auditor',
  service: 'service',
};

/** "Blake Mbeki (deal team)": the display name and every role the user holds, in words. */
export function userLabel(user: { displayName: string; roles: readonly Role[] }): string {
  return `${user.displayName} (${user.roles.map((r) => ROLE_WORDS[r]).join(', ')})`;
}

/**
 * Roles that see every client's data: ALL_CLIENT_ROLES in @pb/contracts, the one statement of
 * pb.sees_all_clients() in packages/db, which row-level security applies (operations, the deal
 * team and approvers, who are the investment team, and the auditor). A check that needs every
 * commitment, such as LP ownership summing to 100%, means something only for them; anyone else
 * would sum the subset they are entitled to.
 */
export const SEES_ALL_CLIENTS: ReadonlySet<Role> = new Set(ALL_CLIENT_ROLES);

export const seesAllClients = (roles: readonly Role[]): boolean => rolesSeeAllClients(roles);

/**
 * The same roles in the words every page uses when it says who reads client data, so the list is
 * written once: "operations, the investment team (the deal team and approvers) and auditors".
 */
export const WHO_READS_EVERY_CLIENT =
  'operations, the investment team (the deal team and approvers) and auditors';
