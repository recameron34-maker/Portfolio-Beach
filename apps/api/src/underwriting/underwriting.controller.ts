import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import { underwritingQuery } from '@pb/contracts';
import type { UnderwritingRead } from '@pb/contracts';
import { CurrentPrincipal } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ADAPTERS } from '../common/tokens.js';
import { parseOrProblem, requireUuid } from '../common/validate.js';
import { UnderwritingService } from './underwriting.service.js';

/**
 * A position's underwritten base case (docs/04 M9, docs/18 section 13, decision 0022). The role
 * lists mirror the contract's UNDERWRITING_ROUTES (routes-underwriting.ts); row-level security
 * decides which positions a caller sees.
 */
@Controller('api/v1')
export class UnderwritingController {
  constructor(
    private readonly service: UnderwritingService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  @Get('investments/:id/underwriting')
  read(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<UnderwritingRead> {
    // A malformed id is simply not found: existence is never revealed, and the database never sees garbage.
    requireUuid(id, 'Investment not found');
    const { asOf, version } = parseOrProblem(underwritingQuery, query, 'query');
    return this.service.read(
      principal,
      req.id ?? 'unknown',
      id,
      asOf ?? this.adapters.clock.today(),
      version,
    );
  }
}
