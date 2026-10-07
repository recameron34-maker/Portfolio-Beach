/** Portfolio Beach application roles (docs/05 SEC-5). `service` is the system actor for workers. */
export const APP_ROLES = [
  'viewer',
  'deal_team',
  'operations',
  'approver',
  'investor_relations',
  'platform_admin',
  'auditor',
  'service',
] as const;
export type AppRole = (typeof APP_ROLES)[number];

export function isAppRole(value: string): value is AppRole {
  return (APP_ROLES as readonly string[]).includes(value);
}

/** Fixed id of the system actor row inserted by migration 0006. */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';
