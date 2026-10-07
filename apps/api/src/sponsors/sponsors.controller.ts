import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import { asOfQuery } from '@pb/contracts';
import type { SponsorDetail, Taxonomy, WallList } from '@pb/contracts';
import { CurrentPrincipal } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ADAPTERS } from '../common/tokens.js';
import { ProblemError } from '../common/problem.js';
import { parseOrProblem } from '../common/validate.js';
import { SponsorsService } from './sponsors.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('api/v1')
export class SponsorsController {
  constructor(
    private readonly service: SponsorsService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  private asOf(query: unknown): string {
    return parseOrProblem(asOfQuery, query, 'query').asOf ?? this.adapters.clock.today();
  }

  @Get('sponsors/:id')
  detail(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<SponsorDetail> {
    if (!UUID.test(id)) throw new ProblemError(404, 'not-found', 'Sponsor not found');
    return this.service.detail(principal, req.id ?? 'unknown', id, this.asOf(query));
  }

  @Get('taxonomy')
  taxonomy(
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<Taxonomy> {
    return this.service.taxonomy(principal, req.id ?? 'unknown');
  }

  @Get('walls')
  walls(
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<WallList> {
    return this.service.walls(principal, req.id ?? 'unknown');
  }
}
