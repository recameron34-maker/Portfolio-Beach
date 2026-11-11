import { Controller, Get, Header, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AdapterSet, Principal } from '@pb/adapters';
import { valueCreationExportQuery } from '@pb/contracts';
import type {
  AnalyticsSummary,
  InvestmentValueCreation,
  ValueCreation,
  Watchlist,
} from '@pb/contracts';
import { CurrentPrincipal } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ADAPTERS } from '../common/tokens.js';
import { asOfOrToday, parseOrProblem, requireUuid } from '../common/validate.js';
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

  @Get('analytics/value-creation')
  valueCreation(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<ValueCreation> {
    return this.service.valueCreation(
      principal,
      req.id ?? 'unknown',
      asOfOrToday(query, this.adapters.clock),
    );
  }

  /**
   * The view's positions as text/csv (the contract says so), narrowed by the filters of the view,
   * offered as a download named by the as-of date.
   */
  @Get('analytics/value-creation/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async valueCreationExport(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { asOf: asked, ...filters } = parseOrProblem(valueCreationExportQuery, query, 'query');
    const { asOf, csv } = await this.service.valueCreationExport(
      principal,
      req.id ?? 'unknown',
      asked ?? this.adapters.clock.today(),
      filters,
    );
    res.setHeader('Content-Disposition', `attachment; filename="value-creation-${asOf}.csv"`);
    return csv;
  }

  @Get('investments/:id/value-creation')
  investmentValueCreation(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<InvestmentValueCreation> {
    // A malformed id is simply not found: existence is never revealed, and the database never sees garbage.
    requireUuid(id, 'Investment not found');
    return this.service.investmentValueCreation(
      principal,
      req.id ?? 'unknown',
      id,
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
