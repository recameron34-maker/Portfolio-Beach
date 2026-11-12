import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Principal } from '@pb/adapters';
import { auditQuery } from '@pb/contracts';
import type { AuditPage } from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { parseOrProblem } from '../common/validate.js';
import { AuditService } from './audit.service.js';

@Controller('api/v1')
export class AuditController {
  constructor(private readonly service: AuditService) {}

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
