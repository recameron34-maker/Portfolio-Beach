import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import { investmentListQuery, pageQuery } from '@pb/contracts';
import type { InvestmentDetail, InvestmentPage } from '@pb/contracts';
import { CurrentPrincipal } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ADAPTERS } from '../common/tokens.js';
import { ProblemError } from '../common/problem.js';
import { parseOrProblem } from '../common/validate.js';
import { PortfolioService } from './portfolio.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('api/v1')
export class PortfolioController {
  constructor(
    private readonly portfolio: PortfolioService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  @Get('investments')
  list(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<InvestmentPage> {
    const q = parseOrProblem(investmentListQuery, query, 'query');
    return this.portfolio.list(principal, req.id ?? 'unknown', {
      ...q,
      asOf: q.asOf ?? this.adapters.clock.today(),
    });
  }

  @Get('investments/:id')
  detail(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<InvestmentDetail> {
    // A malformed id is simply not found: existence is never revealed, and the database never sees garbage.
    if (!UUID.test(id)) throw new ProblemError(404, 'not-found', 'Investment not found');
    const q = parseOrProblem(investmentListQuery.pick({ asOf: true }), query, 'query');
    return this.portfolio.detail(
      principal,
      req.id ?? 'unknown',
      id,
      q.asOf ?? this.adapters.clock.today(),
    );
  }

  @Get('sponsors')
  sponsors(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): ReturnType<PortfolioService['sponsors']> {
    const q = parseOrProblem(pageQuery, query, 'query');
    return this.portfolio.sponsors(principal, req.id ?? 'unknown', q.limit, q.cursor);
  }

  @Get('vehicles')
  vehicles(
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): ReturnType<PortfolioService['vehicles']> {
    return this.portfolio.vehicles(principal, req.id ?? 'unknown');
  }
}
