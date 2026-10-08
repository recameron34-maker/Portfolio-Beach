import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import type { SponsorDetail, Taxonomy, WallList } from '@pb/contracts';
import { CurrentPrincipal } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ADAPTERS } from '../common/tokens.js';
import { asOfOrToday, requireUuid } from '../common/validate.js';
import { SponsorsService } from './sponsors.service.js';

@Controller('api/v1')
export class SponsorsController {
  constructor(
    private readonly service: SponsorsService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  @Get('sponsors/:id')
  detail(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<SponsorDetail> {
    requireUuid(id, 'Sponsor not found');
    return this.service.detail(
      principal,
      req.id ?? 'unknown',
      id,
      asOfOrToday(query, this.adapters.clock),
    );
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
