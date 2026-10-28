import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import {
  capitalNoticeCommandBody,
  capitalNoticeListQuery,
  tradeTicketListQuery,
} from '@pb/contracts';
import type {
  CapitalNoticeControlDetail,
  CapitalNoticePage,
  TradeTicketPage,
  TradeTicketRow,
} from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ifMatchVersions } from '../common/row-version.js';
import { ADAPTERS } from '../common/tokens.js';
import { asOfOrToday, parseOrProblem, requireUuid } from '../common/validate.js';
import { CapitalService } from './capital.service.js';

/**
 * Capital activity (docs/04 M16, docs/18 section 3, SEC-12). The notice reads are open to every
 * authenticated role (row-level security decides what exists); the command route and the ticket
 * reads mirror the contract's route table (operations, approver and the service actor command;
 * TICKET_ROLES read tickets). Commands honour If-Match (412 when stale).
 */
@Controller('api/v1')
export class CapitalController {
  constructor(
    private readonly service: CapitalService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  @Get('capital-notices')
  list(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<CapitalNoticePage> {
    const q = parseOrProblem(capitalNoticeListQuery, query, 'query');
    return this.service.list(principal, req.id ?? 'unknown', {
      ...q,
      asOf: q.asOf ?? this.adapters.clock.today(),
    });
  }

  @Get('capital-notices/:id')
  detail(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<CapitalNoticeControlDetail> {
    requireUuid(id, 'Capital notice not found');
    return this.service.detail(
      principal,
      req.id ?? 'unknown',
      id,
      asOfOrToday(query, this.adapters.clock),
    );
  }

  @Post('capital-notices/:id/commands')
  @Roles('operations', 'approver', 'service')
  @HttpCode(200)
  command(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<CapitalNoticeControlDetail> {
    const parsed = parseOrProblem(capitalNoticeCommandBody, body, 'command');
    return this.service.command(
      principal,
      req.id ?? 'unknown',
      id,
      parsed,
      ifMatchVersions(req.header('if-match')),
    );
  }

  @Get('trade-tickets')
  @Roles('operations', 'approver', 'auditor', 'deal_team')
  tickets(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<TradeTicketPage> {
    const q = parseOrProblem(tradeTicketListQuery, query, 'query');
    return this.service.listTickets(principal, req.id ?? 'unknown', q);
  }

  @Get('trade-tickets/:id')
  @Roles('operations', 'approver', 'auditor', 'deal_team')
  ticket(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<TradeTicketRow> {
    return this.service.ticketDetail(principal, req.id ?? 'unknown', id);
  }
}
