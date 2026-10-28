import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AdapterSet, Principal } from '@pb/adapters';
import {
  valuationBatchCommandBody,
  valuationCommandBody,
  valuationCreateBody,
  valuationListQuery,
} from '@pb/contracts';
import type {
  ValuationBatchResult,
  ValuationDetail,
  ValuationPage,
  ValuationRow,
} from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ifMatchVersions, withEtag } from '../common/row-version.js';
import { ADAPTERS } from '../common/tokens.js';
import { parseOrProblem, requireUuid } from '../common/validate.js';
import { ValuationsService } from './valuations.service.js';
import { ValuationWorkflowService } from './workflow.service.js';

const NOT_FOUND = 'Valuation not found';

/**
 * The valuation board and workflow (docs/04 M10, docs/18 section 1). The role guards mirror the
 * contract's route table (routes-controls.ts); row-level security enforces visibility again below,
 * so a version the caller cannot see is 404 whatever their role.
 */
@Controller('api/v1')
export class ValuationsController {
  constructor(
    private readonly service: ValuationsService,
    private readonly workflow: ValuationWorkflowService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

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

  @Post('valuations')
  @Roles('operations')
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ValuationRow> {
    const parsed = parseOrProblem(valuationCreateBody, body, 'body');
    return withEtag(res, await this.workflow.create(principal, req.id ?? 'unknown', parsed));
  }

  @Post('valuations/batch-commands')
  @Roles('deal_team', 'approver')
  @HttpCode(200)
  batch(
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<ValuationBatchResult> {
    const parsed = parseOrProblem(valuationBatchCommandBody, body, 'body');
    return this.workflow.batch(principal, req.id ?? 'unknown', parsed);
  }

  @Get('valuations/:id')
  @Roles('viewer', 'deal_team', 'operations', 'approver', 'investor_relations', 'auditor')
  async detail(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ValuationDetail> {
    requireUuid(id, NOT_FOUND);
    return withEtag(res, await this.workflow.detail(principal, req.id ?? 'unknown', id));
  }

  @Post('valuations/:id/commands')
  @Roles('operations', 'deal_team', 'approver')
  @HttpCode(200)
  async command(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ValuationRow> {
    requireUuid(id, NOT_FOUND);
    const parsed = parseOrProblem(valuationCommandBody, body, 'command');
    return withEtag(
      res,
      await this.workflow.command(
        principal,
        req.id ?? 'unknown',
        id,
        parsed,
        ifMatchVersions(ifMatch),
      ),
    );
  }
}
