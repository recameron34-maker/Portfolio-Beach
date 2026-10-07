import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import type { MockIdentityProvider } from '@pb/adapters/mocks';
import type { Principal as PrincipalDto } from '@pb/contracts';
import { ADAPTERS, CONFIG } from '../common/tokens.js';
import { ProblemError } from '../common/problem.js';
import type { ApiConfig } from '../config.js';
import { CurrentPrincipal, Public } from './principal.js';
import type { RequestWithPrincipal } from './principal.js';

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('me')
  me(@CurrentPrincipal() principal: Principal, @Req() req: RequestWithPrincipal): PrincipalDto {
    return { ...principal, mockIdentity: req.mockIdentity ?? false };
  }

  /** The role switcher's choices. Exists only while the mock identity adapter is wired in; never in production. */
  @Public()
  @Get('mock-users')
  mockUsers(): { users: { externalId: string; displayName: string; roles: string[] }[] } {
    if (this.config.NODE_ENV === 'production' || this.adapters.identity.info.kind !== 'mock') {
      throw new ProblemError(404, 'not-found', 'Not available');
    }
    const mock = this.adapters.identity as MockIdentityProvider;
    return {
      users: mock.listUsers().map((u) => ({
        externalId: u.externalId,
        displayName: u.displayName,
        roles: [...u.roles],
      })),
    };
  }
}
