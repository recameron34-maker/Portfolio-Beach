import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Principal } from '@pb/adapters';
import {
  allocationsPutBody,
  diligenceTaskCommandBody,
  diligenceTaskCreateBody,
  icDecisionBody,
  opportunityCommandBody,
  opportunityCreateBody,
  opportunityListQuery,
} from '@pb/contracts';
import type { OpportunityDetail, OpportunityPage } from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { parseOrProblem } from '../common/validate.js';
import { PipelineService } from './pipeline.service.js';

/**
 * The pipeline routes (docs/04 M5 skeleton, docs/18 section 4): the role lists mirror the
 * contract's route table (packages/contracts routes-controls.ts); the machine refuses a role per
 * transition again, and row-level security hides what the caller may not see.
 */
const READ_ROLES = [
  'viewer',
  'deal_team',
  'operations',
  'approver',
  'investor_relations',
  'auditor',
] as const;

@Controller('api/v1')
export class PipelineController {
  constructor(private readonly service: PipelineService) {}

  @Get('opportunities')
  @Roles(...READ_ROLES)
  list(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<OpportunityPage> {
    const q = parseOrProblem(opportunityListQuery, query, 'query');
    return this.service.list(principal, req.id ?? 'unknown', q);
  }

  @Get('opportunities/:id')
  @Roles(...READ_ROLES)
  detail(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<OpportunityDetail> {
    return this.service.detail(principal, req.id ?? 'unknown', id);
  }

  @Post('opportunities')
  @Roles('deal_team')
  @HttpCode(201)
  create(
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<OpportunityDetail> {
    const parsed = parseOrProblem(opportunityCreateBody, body, 'body');
    return this.service.create(principal, req.id ?? 'unknown', parsed);
  }

  @Post('opportunities/:id/commands')
  @Roles('deal_team', 'operations', 'approver')
  @HttpCode(200)
  command(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<OpportunityDetail> {
    const parsed = parseOrProblem(opportunityCommandBody, body, 'command');
    return this.service.command(principal, req.id ?? 'unknown', id, parsed, ifMatch);
  }

  @Post('opportunities/:id/diligence-tasks')
  @Roles('deal_team')
  @HttpCode(201)
  createTask(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<OpportunityDetail> {
    const parsed = parseOrProblem(diligenceTaskCreateBody, body, 'body');
    return this.service.createTask(principal, req.id ?? 'unknown', id, parsed);
  }

  @Post('opportunities/:id/diligence-tasks/:taskId/commands')
  @Roles('deal_team', 'approver')
  @HttpCode(200)
  taskCommand(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<OpportunityDetail> {
    const parsed = parseOrProblem(diligenceTaskCommandBody, body, 'command');
    return this.service.taskCommand(principal, req.id ?? 'unknown', id, taskId, parsed);
  }

  @Post('opportunities/:id/ic-decisions')
  @Roles('approver')
  @HttpCode(201)
  icDecision(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<OpportunityDetail> {
    const parsed = parseOrProblem(icDecisionBody, body, 'body');
    return this.service.recordIcDecision(principal, req.id ?? 'unknown', id, parsed);
  }

  @Put('opportunities/:id/allocations')
  @Roles('deal_team', 'operations')
  @HttpCode(200)
  putAllocations(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<OpportunityDetail> {
    const parsed = parseOrProblem(allocationsPutBody, body, 'body');
    return this.service.putAllocations(principal, req.id ?? 'unknown', id, parsed);
  }
}
