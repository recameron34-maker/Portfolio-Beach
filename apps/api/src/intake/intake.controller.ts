import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Principal } from '@pb/adapters';
import { intakeCommandBody, intakeFileListQuery, intakeImportBody } from '@pb/contracts';
import type { IntakeFileDetail, IntakeFilePage, IntakeImportResult } from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { parseOrProblem } from '../common/validate.js';
import { IntakeService } from './intake.service.js';
import type { IntakeExportList } from './intake.service.js';

/**
 * Accounting intake (docs/04 M2): staging, validation, approval, then production (SEC-9.1). The
 * role guard mirrors the contract's route table; row-level security enforces it again below.
 */
@Controller('api/v1/intake')
export class IntakeController {
  constructor(private readonly service: IntakeService) {}

  @Get('accounting/exports')
  @Roles('operations')
  exports(): Promise<IntakeExportList> {
    return this.service.exports();
  }

  @Post('accounting')
  @Roles('operations')
  @HttpCode(201)
  import(
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<IntakeImportResult> {
    const parsed = parseOrProblem(intakeImportBody, body, 'import');
    return this.service.import(principal, req.id ?? 'unknown', parsed);
  }

  @Get('files')
  @Roles('operations', 'deal_team', 'approver', 'auditor')
  list(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<IntakeFilePage> {
    const q = parseOrProblem(intakeFileListQuery, query, 'query');
    return this.service.list(principal, req.id ?? 'unknown', q);
  }

  @Get('files/:id')
  @Roles('operations', 'deal_team', 'approver', 'auditor')
  detail(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<IntakeFileDetail> {
    return this.service.detail(principal, req.id ?? 'unknown', id);
  }

  @Post('files/:id/commands')
  @Roles('operations', 'deal_team')
  @HttpCode(200)
  command(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<IntakeFileDetail> {
    const parsed = parseOrProblem(intakeCommandBody, body, 'command');
    return this.service.command(principal, req.id ?? 'unknown', id, parsed);
  }
}
