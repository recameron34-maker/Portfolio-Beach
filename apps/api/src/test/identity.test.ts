import { describe, expect, it, vi } from 'vitest';
import type { AdapterSet, Principal } from '@pb/adapters';
import { IdentityMiddleware } from '../auth/identity.middleware.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import type { ApiConfig } from '../config.js';

/**
 * The identity middleware resolves a credential through the identity adapter. The service role
 * belongs to the system actor alone (migration 0008 lets it past every wall), so a credential
 * that carries it is never signed in, whatever the provider says.
 */
const principalWith = (roles: Principal['roles']): Principal => ({
  userId: '10000000-0000-4000-8000-0000000000aa',
  externalId: 'someone',
  displayName: 'Someone',
  roles,
  clientIds: [],
});

async function resolve(roles: Principal['roles']): Promise<Principal | undefined> {
  const identity = {
    info: { name: 'identity.mock', kind: 'mock', killSwitch: 'adapter.identity' },
    authenticate: vi.fn(() => Promise.resolve(principalWith(roles))),
  };
  const middleware = new IdentityMiddleware(
    { identity } as unknown as AdapterSet,
    {} as unknown as ApiConfig,
  );
  const req = {
    header: (name: string) => (name === 'authorization' ? 'Bearer credential' : undefined),
  } as unknown as RequestWithPrincipal;
  const next = vi.fn();
  await middleware.use(req, {} as never, next);
  expect(next).toHaveBeenCalledOnce();
  expect(identity.authenticate).toHaveBeenCalledWith('credential');
  return req.principal;
}

describe('the identity middleware', () => {
  it('signs in the principal the adapter resolves', async () => {
    expect((await resolve(['operations']))?.roles).toEqual(['operations']);
  });

  it('never signs in the service role: such a credential stays anonymous', async () => {
    expect(await resolve(['service'])).toBeUndefined();
    expect(await resolve(['operations', 'service'])).toBeUndefined();
  });
});
