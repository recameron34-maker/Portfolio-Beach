import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import { asOfQuery, auditQuery } from '@pb/contracts';
import type { AuditPage } from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ADAPTERS } from '../common/tokens.js';
import { parseOrProblem } from '../common/validate.js';
import { AuditService } from './audit.service.js';

@Controller('api/v1')
export class AuditController {
  constructor(
    private readonly service: AuditService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  private asOf(query: unknown): string {
    return parseOrProblem(asOfQuery, query, 'query').asOf ?? this.adapters.clock.today();
  }

  @Get('audit/events')
  @Roles('operations', 'approver', 'auditor', 'platform_admin')
  events(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<AuditPage> {
    const q = parseOrProblem(auditQuery, query, 'query');
    return this.service.events(principal, req.id ?? 'unknown', q);
  }
}
