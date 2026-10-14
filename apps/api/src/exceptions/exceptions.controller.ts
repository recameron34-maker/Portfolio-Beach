import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Principal } from '@pb/adapters';
import { dataExceptionCommandBody, dataExceptionListQuery } from '@pb/contracts';
import type { DataException, DataExceptionPage } from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { parseOrProblem } from '../common/validate.js';
import { ExceptionsService } from './exceptions.service.js';

/**
 * Data exceptions (docs/04 M1 Data Health, docs/18 section 9): the queue the intakes open and
 * operations works. The role guard mirrors the contract's route table; row-level security
 * enforces it again below.
 */
@Controller('api/v1/data-exceptions')
export class ExceptionsController {
  constructor(private readonly service: ExceptionsService) {}

  @Get()
  @Roles('operations', 'deal_team', 'approver', 'auditor')
  list(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<DataExceptionPage> {
    const q = parseOrProblem(dataExceptionListQuery, query, 'query');
    return this.service.list(principal, req.id ?? 'unknown', q);
  }

  @Get(':id')
  @Roles('operations', 'deal_team', 'approver', 'auditor')
  detail(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<DataException> {
    return this.service.detail(principal, req.id ?? 'unknown', id);
  }

  @Post(':id/commands')
  @Roles('operations')
  @HttpCode(200)
  command(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<DataException> {
    const parsed = parseOrProblem(dataExceptionCommandBody, body, 'command');
    return this.service.command(principal, req.id ?? 'unknown', id, parsed);
  }
}
