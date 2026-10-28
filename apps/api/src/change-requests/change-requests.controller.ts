import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Principal } from '@pb/adapters';
import {
  changeRequestCommandBody,
  changeRequestCreateBody,
  changeRequestListQuery,
  quarterEndCheckBody,
} from '@pb/contracts';
import type { ChangeRequestPage, ChangeRequestRow, QuarterEndCheckResult } from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ifMatchVersions, withEtag } from '../common/row-version.js';
import { parseOrProblem } from '../common/validate.js';
import { ChangeRequestsService } from './change-requests.service.js';

/**
 * Deal change requests (docs/04 M11, docs/18 section 8). The role lists mirror the contract's
 * CONTROL_ROUTES (routes-controls.ts: CHANGE_REQUEST_READ_ROLES for the reads, the deal team and
 * operations for the form and the commands, operations for the quarter-end check); the split
 * within the commands (route by the deal team, the rest by operations) is the transition table's,
 * and row-level security enforces the walls again below. Every single-record answer carries the
 * row version as its ETag, which a command may send back as If-Match (docs/17 section 3).
 */
@Controller('api/v1/change-requests')
export class ChangeRequestsController {
  constructor(private readonly service: ChangeRequestsService) {}

  @Get()
  @Roles('deal_team', 'operations', 'approver', 'auditor')
  list(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<ChangeRequestPage> {
    const q = parseOrProblem(changeRequestListQuery, query, 'query');
    return this.service.list(principal, req.id ?? 'unknown', q);
  }

  @Post()
  @Roles('deal_team', 'operations')
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ChangeRequestRow> {
    const parsed = parseOrProblem(changeRequestCreateBody, body, 'body');
    return withEtag(res, await this.service.create(principal, req.id ?? 'unknown', parsed));
  }

  @Post('quarter-end-check')
  @Roles('operations')
  @HttpCode(200)
  quarterEndCheck(
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<QuarterEndCheckResult> {
    const parsed = parseOrProblem(quarterEndCheckBody, body, 'body');
    return this.service.quarterEndCheck(principal, req.id ?? 'unknown', parsed);
  }

  @Get(':id')
  @Roles('deal_team', 'operations', 'approver', 'auditor')
  async detail(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ChangeRequestRow> {
    return withEtag(res, await this.service.detail(principal, req.id ?? 'unknown', id));
  }

  @Post(':id/commands')
  @Roles('deal_team', 'operations')
  @HttpCode(200)
  async command(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ChangeRequestRow> {
    const parsed = parseOrProblem(changeRequestCommandBody, body, 'command');
    return withEtag(
      res,
      await this.service.command(
        principal,
        req.id ?? 'unknown',
        id,
        parsed,
        ifMatchVersions(ifMatch),
      ),
    );
  }
}
