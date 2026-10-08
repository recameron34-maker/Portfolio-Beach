import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import { capitalNoticeListQuery } from '@pb/contracts';
import type { CapitalNoticeDetail, CapitalNoticePage } from '@pb/contracts';
import { CurrentPrincipal } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ADAPTERS } from '../common/tokens.js';
import { asOfOrToday, parseOrProblem, requireUuid } from '../common/validate.js';
import { CapitalService } from './capital.service.js';

@Controller('api/v1')
export class CapitalController {
  constructor(
    private readonly service: CapitalService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

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
    requireUuid(id, 'Capital notice not found');
    return this.service.detail(
      principal,
      req.id ?? 'unknown',
      id,
      asOfOrToday(query, this.adapters.clock),
    );
  }
}
