import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import { asOfQuery, capitalNoticeListQuery } from '@pb/contracts';
import type { CapitalNoticeDetail, CapitalNoticePage } from '@pb/contracts';
import { CurrentPrincipal } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ADAPTERS } from '../common/tokens.js';
import { ProblemError } from '../common/problem.js';
import { parseOrProblem } from '../common/validate.js';
import { CapitalService } from './capital.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('api/v1')
export class CapitalController {
  constructor(
    private readonly service: CapitalService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  private asOf(query: unknown): string {
    return parseOrProblem(asOfQuery, query, 'query').asOf ?? this.adapters.clock.today();
  }

  @Get('capital-notices')
  list(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<CapitalNoticePage> {
    const q = parseOrProblem(capitalNoticeListQuery, query, 'query');
    return this.service.list(principal, req.id ?? 'unknown', {
      ...q,
      asOf: q.asOf ?? this.adapters.clock.today(),
    });
  }

  @Get('capital-notices/:id')
  detail(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<CapitalNoticeDetail> {
    if (!UUID.test(id)) throw new ProblemError(404, 'not-found', 'Capital notice not found');
    return this.service.detail(principal, req.id ?? 'unknown', id, this.asOf(query));
  }
}
