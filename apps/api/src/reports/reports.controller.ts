import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import { asOfQuery } from '@pb/contracts';
import type { WeeklyReport } from '@pb/contracts';
import { CurrentPrincipal } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ADAPTERS } from '../common/tokens.js';
import { parseOrProblem } from '../common/validate.js';
import { ReportsService } from './reports.service.js';

@Controller('api/v1')
export class ReportsController {
  constructor(
    private readonly service: ReportsService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  private asOf(query: unknown): string {
    return parseOrProblem(asOfQuery, query, 'query').asOf ?? this.adapters.clock.today();
  }

  @Get('reports/weekly')
  weekly(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<WeeklyReport> {
    return this.service.weekly(principal, req.id ?? 'unknown', this.asOf(query));
  }
}
