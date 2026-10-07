import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import { asOfQuery, valuationListQuery } from '@pb/contracts';
import type { ValuationPage } from '@pb/contracts';
import { CurrentPrincipal } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ADAPTERS } from '../common/tokens.js';
import { parseOrProblem } from '../common/validate.js';
import { ValuationsService } from './valuations.service.js';

@Controller('api/v1')
export class ValuationsController {
  constructor(
    private readonly service: ValuationsService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  private asOf(query: unknown): string {
    return parseOrProblem(asOfQuery, query, 'query').asOf ?? this.adapters.clock.today();
  }

  @Get('valuations')
  list(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<ValuationPage> {
    const q = parseOrProblem(valuationListQuery, query, 'query');
    return this.service.list(principal, req.id ?? 'unknown', {
      ...q,
      asOf: q.asOf ?? this.adapters.clock.today(),
    });
  }
}
