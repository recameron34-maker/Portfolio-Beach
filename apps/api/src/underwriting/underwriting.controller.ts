import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AdapterSet, Principal } from '@pb/adapters';
import { underwritingCaseBody, underwritingCommandBody, underwritingQuery } from '@pb/contracts';
import type { UnderwritingCaseVersion, UnderwritingRead } from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ifMatchVersions, withEtag } from '../common/row-version.js';
import { ADAPTERS } from '../common/tokens.js';
import { parseOrProblem, requireUuid } from '../common/validate.js';
import { UnderwritingService } from './underwriting.service.js';

/**
 * A position's underwritten base case (docs/04 M9, docs/18 section 13, decision 0022). The role
 * lists mirror the contract's UNDERWRITING_ROUTES (routes-underwriting.ts); the state machine
 * refuses a role per command again, and row-level security decides which positions a caller
 * sees. Every write answers the version it wrote, with its row version as the ETag an edit or a
 * command may send back as If-Match.
 */
@Controller('api/v1')
export class UnderwritingController {
  constructor(
    private readonly service: UnderwritingService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  @Get('investments/:id/underwriting')
  read(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<UnderwritingRead> {
    // A malformed id is simply not found: existence is never revealed, and the database never sees garbage.
    requireUuid(id, 'Investment not found');
    const { asOf, version } = parseOrProblem(underwritingQuery, query, 'query');
    return this.service.read(
      principal,
      req.id ?? 'unknown',
      id,
      asOf ?? this.adapters.clock.today(),
      version,
    );
  }

  @Post('investments/:id/underwriting')
  @Roles('deal_team')
  @HttpCode(201)
  async create(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UnderwritingCaseVersion> {
    const parsed = parseOrProblem(underwritingCaseBody, body, 'body');
    return withEtag(res, await this.service.create(principal, req.id ?? 'unknown', id, parsed));
  }

  @Patch('underwriting-cases/:id')
  @Roles('deal_team')
  async edit(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UnderwritingCaseVersion> {
    const parsed = parseOrProblem(underwritingCaseBody, body, 'body');
    return withEtag(
      res,
      await this.service.edit(principal, req.id ?? 'unknown', id, parsed, ifMatchVersions(ifMatch)),
    );
  }

  @Post('underwriting-cases/:id/commands')
  @Roles('deal_team', 'approver')
  @HttpCode(200)
  async command(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UnderwritingCaseVersion> {
    const parsed = parseOrProblem(underwritingCommandBody, body, 'command');
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
