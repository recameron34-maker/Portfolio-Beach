import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Principal } from '@pb/adapters';
import { lookthroughReconcileBody } from '@pb/contracts';
import type { LookthroughReconcileResult, LookthroughRunDetail } from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../../auth/principal.js';
import type { RequestWithPrincipal } from '../../auth/principal.js';
import { parseOrProblem } from '../../common/validate.js';
import { LookthroughService } from './lookthrough.service.js';

/**
 * Look-through reconcile (docs/04 M2): the provider's extract against the taxonomy and the
 * approved values; differences open data exceptions and nothing on record changes (decision 0010).
 * The role guard mirrors the contract's route table; row-level security enforces it again below.
 */
@Controller('api/v1/intake/lookthrough')
export class LookthroughController {
  constructor(private readonly service: LookthroughService) {}

  @Post('reconcile')
  @Roles('operations')
  @HttpCode(201)
  reconcile(
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<LookthroughReconcileResult> {
    const parsed = parseOrProblem(lookthroughReconcileBody, body, 'reconcile');
    return this.service.reconcile(principal, req.id ?? 'unknown', parsed);
  }

  @Get('runs/:id')
  @Roles('operations', 'deal_team', 'approver', 'auditor')
  detail(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<LookthroughRunDetail> {
    return this.service.detail(principal, req.id ?? 'unknown', id);
  }
}
