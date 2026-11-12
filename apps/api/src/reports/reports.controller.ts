import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import type { WeeklyReport } from '@pb/contracts';
import { CurrentPrincipal } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ADAPTERS } from '../common/tokens.js';
import { asOfOrToday } from '../common/validate.js';
import { ReportsService } from './reports.service.js';

@Controller('api/v1')
export class ReportsController {
  constructor(
    private readonly service: ReportsService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  @Get('reports/weekly')
  weekly(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<WeeklyReport> {
    return this.service.weekly(
      principal,
      req.id ?? 'unknown',
      asOfOrToday(query, this.adapters.clock),
    );
  }
}
