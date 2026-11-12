import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Principal } from '@pb/adapters';
import {
  closingCommandBody,
  closingItemCommandBody,
  legalTermCommandBody,
  legalTermCreateBody,
} from '@pb/contracts';
import type { ClosingDetail } from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ifMatchVersions, withEtag } from '../common/row-version.js';
import { parseOrProblem } from '../common/validate.js';
import { ClosingService } from './closing.service.js';

/**
 * The closing routes (docs/04 M8, M22, docs/18 section 12): the role lists mirror the contract's
 * route table (packages/contracts routes-controls.ts); the machine refuses a role per transition
 * again, and row-level security hides what the caller may not see.
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
export class ClosingController {
  constructor(private readonly service: ClosingService) {}

  @Get('closings/:id')
  @Roles(...READ_ROLES)
  async detail(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ClosingDetail> {
    return withEtag(res, await this.service.detail(principal, req.id ?? 'unknown', id));
  }

  @Post('closings/:id/items/:itemCode/commands')
  @Roles('operations', 'deal_team')
  @HttpCode(200)
  async itemCommand(
    @Param('id') id: string,
    @Param('itemCode') itemCode: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ClosingDetail> {
    const parsed = parseOrProblem(closingItemCommandBody, body, 'command');
    return withEtag(
      res,
      await this.service.itemCommand(principal, req.id ?? 'unknown', id, itemCode, parsed),
    );
  }

  @Post('closings/:id/commands')
  @Roles('operations')
  @HttpCode(200)
  async command(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ClosingDetail> {
    const parsed = parseOrProblem(closingCommandBody, body, 'command');
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

  @Post('closings/:id/legal-terms')
  @Roles('deal_team', 'operations')
  @HttpCode(201)
  async createLegalTerm(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ClosingDetail> {
    const parsed = parseOrProblem(legalTermCreateBody, body, 'body');
    return withEtag(
      res,
      await this.service.createLegalTerm(principal, req.id ?? 'unknown', id, parsed),
    );
  }

  @Post('closings/:id/legal-terms/:termId/commands')
  @Roles('deal_team', 'operations')
  @HttpCode(200)
  async legalTermCommand(
    @Param('id') id: string,
    @Param('termId') termId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ClosingDetail> {
    const parsed = parseOrProblem(legalTermCommandBody, body, 'command');
    return withEtag(
      res,
      await this.service.legalTermCommand(principal, req.id ?? 'unknown', id, termId, parsed),
    );
  }
}
