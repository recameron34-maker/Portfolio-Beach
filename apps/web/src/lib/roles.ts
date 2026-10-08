import type { z } from 'zod';
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
