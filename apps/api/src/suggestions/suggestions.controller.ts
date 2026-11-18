import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Principal } from '@pb/adapters';
import { valuationSuggestionListQuery } from '@pb/contracts';
import type { ValuationSuggestionPage, ValuationSuggestionRow } from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { withEtag } from '../common/row-version.js';
import { parseOrProblem, requireUuid } from '../common/validate.js';
import { SUGGESTION_NOT_FOUND } from './rows.js';
import { SuggestionsService } from './suggestions.service.js';

/**
 * Valuation suggestions (docs/04 M10, docs/18 section 14, decision 0023). The role lists mirror
 * the contract's route table (routes-controls.ts): the deal team, operations, approvers and
 * auditors read. Row-level security says the same below and adds the wall of the position, so a
 * suggestion the caller cannot see is 404 whatever their role.
 */
@Controller('api/v1')
export class SuggestionsController {
  constructor(private readonly service: SuggestionsService) {}

  @Get('valuation-suggestions')
  @Roles('deal_team', 'operations', 'approver', 'auditor')
  list(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<ValuationSuggestionPage> {
    const parsed = parseOrProblem(valuationSuggestionListQuery, query, 'query');
    return this.service.list(principal, req.id ?? 'unknown', parsed);
  }

  @Get('valuation-suggestions/:id')
  @Roles('deal_team', 'operations', 'approver', 'auditor')
  async detail(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ValuationSuggestionRow> {
    // A malformed id is simply not found: existence is never revealed.
    requireUuid(id, SUGGESTION_NOT_FOUND);
    return withEtag(res, await this.service.detail(principal, req.id ?? 'unknown', id));
  }
}
