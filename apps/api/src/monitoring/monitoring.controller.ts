import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Principal } from '@pb/adapters';
import { monitoringBoardQuery, realizationOutlookBody } from '@pb/contracts';
import type { MonitoringBoard, RealizationOutlookDetail } from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { parseOrProblem } from '../common/validate.js';
import { MonitoringService } from './monitoring.service.js';

/**
 * The monitoring board and the realization outlook (docs/04 M9). The role guard mirrors the
 * contract's route table; row-level security enforces it again below. The export answers
 * text/csv, the one route of the API whose body is not JSON (the contract says so).
 */
@Controller('api/v1')
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get('monitoring/board')
  board(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<MonitoringBoard> {
    const q = parseOrProblem(monitoringBoardQuery, query, 'query');
    return this.monitoring.board(principal, req.id ?? 'unknown', q);
  }

  @Get('monitoring/board/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async export(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const q = parseOrProblem(monitoringBoardQuery, query, 'query');
    const { periodEnd, csv } = await this.monitoring.export(principal, req.id ?? 'unknown', q);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="monitoring-board-${periodEnd}.csv"`,
    );
    return csv;
  }

  @Get('monitoring/outlook/:investmentId')
  outlook(
    @Param('investmentId') investmentId: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<RealizationOutlookDetail> {
    return this.monitoring.outlook(principal, req.id ?? 'unknown', investmentId);
  }

  @Put('monitoring/outlook/:investmentId')
  @Roles('deal_team')
  @HttpCode(200)
  setOutlook(
    @Param('investmentId') investmentId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<RealizationOutlookDetail> {
    const parsed = parseOrProblem(realizationOutlookBody, body, 'body');
    return this.monitoring.setOutlook(principal, req.id ?? 'unknown', investmentId, parsed);
  }
}
