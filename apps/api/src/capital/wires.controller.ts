import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Principal } from '@pb/adapters';
import {
  wireInstructionCommandBody,
  wireInstructionListQuery,
  wireInstructionProposeBody,
} from '@pb/contracts';
import type { WireInstructionDetail, WireInstructionPage } from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ifMatchVersions } from '../common/row-version.js';
import { parseOrProblem } from '../common/validate.js';
import { WiresService } from './wires.service.js';

/**
 * The wire instruction register (docs/04 M16, SEC-12.2). The role guard mirrors WIRE_ROLES of
 * the contract's route table (operations, approver, auditor, platform_admin read; operations
 * propose; operations and approvers record the callback); the register's own row-level security
 * enforces the readers again below. Commands honour If-Match (412 when stale).
 */
@Controller('api/v1')
export class WiresController {
  constructor(private readonly service: WiresService) {}

  @Get('wire-instructions')
  @Roles('operations', 'approver', 'auditor', 'platform_admin')
  list(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<WireInstructionPage> {
    const q = parseOrProblem(wireInstructionListQuery, query, 'query');
    return this.service.list(principal, req.id ?? 'unknown', q);
  }

  @Get('wire-instructions/:id')
  @Roles('operations', 'approver', 'auditor', 'platform_admin')
  detail(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<WireInstructionDetail> {
    return this.service.detail(principal, req.id ?? 'unknown', id);
  }

  @Post('wire-instructions')
  @Roles('operations')
  @HttpCode(201)
  propose(
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<WireInstructionDetail> {
    const parsed = parseOrProblem(wireInstructionProposeBody, body, 'body');
    return this.service.propose(principal, req.id ?? 'unknown', parsed);
  }

  @Post('wire-instructions/:id/commands')
  @Roles('operations', 'approver')
  @HttpCode(200)
  command(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<WireInstructionDetail> {
    const parsed = parseOrProblem(wireInstructionCommandBody, body, 'command');
    return this.service.command(
      principal,
      req.id ?? 'unknown',
      id,
      parsed,
      ifMatchVersions(req.header('if-match')),
    );
  }
}
