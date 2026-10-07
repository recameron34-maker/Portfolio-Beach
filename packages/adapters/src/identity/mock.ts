import type { AppRole } from '@pb/db';
import type { HealthStatus, IdentityProvider, Principal } from '../types.js';

export interface MockUser {
  id: string;
  externalId: string;
  displayName: string;
  roles: readonly AppRole[];
  clientIds?: readonly string[];
}

/**
 * Prototype sign-in: the credential is the user's external id (chosen in the role switcher).
 * Refused in production by the startup guard (docs/17 section 6).
 */
export class MockIdentityProvider implements IdentityProvider {
  readonly info = { name: 'identity.mock', kind: 'mock', killSwitch: 'adapter.identity' } as const;
  private readonly users: Map<string, MockUser>;

  constructor(users: readonly MockUser[]) {
    this.users = new Map(users.map((u) => [u.externalId, u]));
  }

  authenticate(credential: string): Promise<Principal | null> {
    const u = this.users.get(credential);
    if (!u) return Promise.resolve(null);
    return Promise.resolve({
      userId: u.id,
      externalId: u.externalId,
      displayName: u.displayName,
      roles: [...u.roles],
      clientIds: [...(u.clientIds ?? [])],
    });
  }

  listUsers(): MockUser[] {
    return [...this.users.values()];
  }

  healthCheck(): Promise<HealthStatus> {
    return Promise.resolve({ ok: true, detail: `${this.users.size} mock users` });
  }
}
