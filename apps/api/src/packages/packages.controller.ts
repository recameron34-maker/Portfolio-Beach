import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Principal } from '@pb/adapters';
import { reportPackageCommandBody, reportPackageCreateBody } from '@pb/contracts';
import type { ReportPackageDetail, ReportPackageList } from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ifMatchVersions, withEtag } from '../common/row-version.js';
import { parseOrProblem } from '../common/validate.js';
import { PackagesService } from './packages.service.js';

/**
 * Reporting packages (docs/04 M14, docs/18 section 5). The role lists mirror the contract's
 * REPORTING_ROUTES (routes-reporting.ts); the machine refuses a role per transition again, and
 * row-level security shows each caller only the clients it reads (SEC-5.2). Every single-record
 * answer carries the row version as its ETag, which a command may send back as If-Match.
 */
const READ_ROLES = [
  'deal_team',
  'operations',
  'approver',
  'investor_relations',
  'auditor',
] as const;

@Controller('api/v1/report-packages')
export class PackagesController {
  constructor(private readonly service: PackagesService) {}

  @Get()
  @Roles(...READ_ROLES)
  list(
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<ReportPackageList> {
    return this.service.list(principal, req.id ?? 'unknown');
  }

  @Post()
  @Roles('investor_relations')
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReportPackageDetail> {
    const parsed = parseOrProblem(reportPackageCreateBody, body, 'body');
    return withEtag(res, await this.service.create(principal, req.id ?? 'unknown', parsed));
  }

  @Get(':id')
  @Roles(...READ_ROLES)
  async detail(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReportPackageDetail> {
    return withEtag(res, await this.service.detail(principal, req.id ?? 'unknown', id));
  }

  @Post(':id/commands')
  @Roles('investor_relations', 'approver', 'operations')
  @HttpCode(200)
  async command(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReportPackageDetail> {
    const parsed = parseOrProblem(reportPackageCommandBody, body, 'command');
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
