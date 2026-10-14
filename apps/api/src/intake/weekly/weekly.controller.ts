import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Principal } from '@pb/adapters';
import { intakeCommandBody, weeklyImportBody } from '@pb/contracts';
import type { IntakeExportList, WeeklyFileDetail, WeeklyImportResult } from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../../auth/principal.js';
import type { RequestWithPrincipal } from '../../auth/principal.js';
import { parseOrProblem } from '../../common/validate.js';
import { WeeklyService } from './weekly.service.js';

/**
 * Weekly report values intake (docs/04 M2 weekly-report-intake): staging, validation against the
 * prior, approval, then a Draft valuation (SEC-9.1). The role guard mirrors the contract's route
 * table; row-level security enforces it again below. The file list is GET /intake/files with
 * source=weekly (the intake controller).
 */
@Controller('api/v1/intake/weekly')
export class WeeklyController {
  constructor(private readonly service: WeeklyService) {}

  @Get('drops')
  @Roles('operations')
  drops(): Promise<IntakeExportList> {
    return this.service.drops();
  }

  @Post()
  @Roles('operations')
  @HttpCode(201)
  import(
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<WeeklyImportResult> {
    const parsed = parseOrProblem(weeklyImportBody, body, 'import');
    return this.service.import(principal, req.id ?? 'unknown', parsed);
  }

  @Get('files/:id')
  @Roles('operations', 'deal_team', 'approver', 'auditor')
  detail(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<WeeklyFileDetail> {
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
  ): Promise<WeeklyFileDetail> {
    const parsed = parseOrProblem(intakeCommandBody, body, 'command');
    return this.service.command(principal, req.id ?? 'unknown', id, parsed);
  }
}
