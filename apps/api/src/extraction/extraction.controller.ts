import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Principal } from '@pb/adapters';
import {
  extractionBatchBody,
  extractionRunCommandBody,
  extractionRunListQuery,
  pageQuery,
} from '@pb/contracts';
import type {
  ExtractionBatch,
  ExtractionBatchPage,
  ExtractionRunDetail,
  ExtractionRunPage,
} from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { parseOrProblem } from '../common/validate.js';
import { ExtractionService } from './extraction.service.js';
import { ExtractionReviewService } from './review.service.js';

/**
 * The extraction engine (docs/04 M4): batches, runs and the review commands. The role guard
 * mirrors the contract's route table; row-level security enforces it again below. The command
 * body is parsed for its shape here and checked against the run's own schema (the money fields)
 * in the review service.
 */
@Controller('api/v1')
export class ExtractionController {
  constructor(
    private readonly extraction: ExtractionService,
    private readonly review: ExtractionReviewService,
  ) {}

  @Post('extraction/batches')
  @Roles('operations')
  @HttpCode(201)
  createBatch(
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<ExtractionBatch> {
    const parsed = parseOrProblem(extractionBatchBody, body, 'body');
    return this.extraction.createBatch(principal, req.id ?? 'unknown', parsed);
  }

  @Get('extraction/batches')
  listBatches(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<ExtractionBatchPage> {
    const q = parseOrProblem(pageQuery, query, 'query');
    return this.extraction.listBatches(principal, req.id ?? 'unknown', q);
  }

  @Get('extraction/runs')
  listRuns(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<ExtractionRunPage> {
    const q = parseOrProblem(extractionRunListQuery, query, 'query');
    return this.extraction.listRuns(principal, req.id ?? 'unknown', q);
  }

  @Get('extraction/runs/:id')
  detail(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<ExtractionRunDetail> {
    return this.extraction.detail(principal, req.id ?? 'unknown', id);
  }

  @Post('extraction/runs/:id/commands')
  @Roles('deal_team', 'operations')
  @HttpCode(200)
  command(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<ExtractionRunDetail> {
    const parsed = parseOrProblem(extractionRunCommandBody(), body, 'command');
    return this.review.command(principal, req.id ?? 'unknown', id, parsed);
  }
}
