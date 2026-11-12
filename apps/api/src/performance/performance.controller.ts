import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import type { InvestmentPerformance } from '@pb/contracts';
import { CurrentPrincipal } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ADAPTERS } from '../common/tokens.js';
import { asOfOrToday, requireUuid } from '../common/validate.js';
import { PerformanceService } from './performance.service.js';

@Controller('api/v1')
export class PerformanceController {
  constructor(
    private readonly service: PerformanceService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  @Get('investments/:id/performance')
  performance(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<InvestmentPerformance> {
    requireUuid(id, 'Investment not found');
    return this.service.performance(
      principal,
      req.id ?? 'unknown',
      id,
      asOfOrToday(query, this.adapters.clock),
    );
  }
}
