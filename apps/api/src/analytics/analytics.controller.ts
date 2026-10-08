import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import type { AnalyticsSummary, Watchlist } from '@pb/contracts';
import { CurrentPrincipal } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ADAPTERS } from '../common/tokens.js';
import { asOfOrToday } from '../common/validate.js';
import { AnalyticsService } from './analytics.service.js';

@Controller('api/v1')
export class AnalyticsController {
  constructor(
    private readonly service: AnalyticsService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  @Get('analytics/summary')
  summary(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<AnalyticsSummary> {
    return this.service.summary(
      principal,
      req.id ?? 'unknown',
      asOfOrToday(query, this.adapters.clock),
    );
  }

  @Get('monitoring/watchlist')
  watchlist(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<Watchlist> {
    return this.service.watchlist(
      principal,
      req.id ?? 'unknown',
      asOfOrToday(query, this.adapters.clock),
    );
  }
}
