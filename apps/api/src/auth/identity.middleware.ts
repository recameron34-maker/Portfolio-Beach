import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { AdapterSet } from '@pb/adapters';
import { ADAPTERS, CONFIG } from '../common/tokens.js';
import type { ApiConfig } from '../config.js';
import type { RequestWithPrincipal } from './principal.js';

/**
 * Resolves `Authorization: Bearer <credential>` to a principal through the identity adapter
 * (mock in the prototype, Entra ID after merge). Missing or invalid credentials leave the
 * request anonymous; the guard decides whether that is acceptable for the route (SEC-4.5).
 */
@Injectable()
export class IdentityMiddleware implements NestMiddleware {
  constructor(
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  async use(req: RequestWithPrincipal, _res: Response, next: NextFunction): Promise<void> {
    req.mockIdentity = this.adapters.identity.info.kind === 'mock';
    const header = req.header('authorization');
    if (header?.toLowerCase().startsWith('bearer ')) {
      const credential = header.slice(7).trim();
      if (credential.length > 0 && credential.length <= 4096) {
        const principal = await this.adapters.identity.authenticate(credential);
        if (principal !== null) req.principal = principal;
      }
    }
    void this.config;
    next();
  }
}
