import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import { asOfQuery } from '@pb/contracts';
import type { InvestmentPerformance } from '@pb/contracts';
import { CurrentPrincipal } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ADAPTERS } from '../common/tokens.js';
import { ProblemError } from '../common/problem.js';
import { parseOrProblem } from '../common/validate.js';
import { PerformanceService } from './performance.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('api/v1')
export class PerformanceController {
  constructor(
    private readonly service: PerformanceService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  private asOf(query: unknown): string {
    return parseOrProblem(asOfQuery, query, 'query').asOf ?? this.adapters.clock.today();
  }

  @Get('investments/:id/performance')
  performance(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<InvestmentPerformance> {
    if (!UUID.test(id)) throw new ProblemError(404, 'not-found', 'Investment not found');
    return this.service.performance(principal, req.id ?? 'unknown', id, this.asOf(query));
  }
}
