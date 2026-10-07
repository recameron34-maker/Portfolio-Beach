import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import { asOfQuery } from '@pb/contracts';
import type { ClientList, CommitmentList, VehicleDetail } from '@pb/contracts';
import { CurrentPrincipal } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ADAPTERS } from '../common/tokens.js';
import { ProblemError } from '../common/problem.js';
import { parseOrProblem } from '../common/validate.js';
import { VehiclesService } from './vehicles.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('api/v1')
export class VehiclesController {
  constructor(
    private readonly service: VehiclesService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  private asOf(query: unknown): string {
    return parseOrProblem(asOfQuery, query, 'query').asOf ?? this.adapters.clock.today();
  }

  @Get('vehicles/:id')
  detail(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<VehicleDetail> {
    // A malformed id is simply not found: existence is never revealed, and the database never sees garbage.
    if (!UUID.test(id)) throw new ProblemError(404, 'not-found', 'Vehicle not found');
    return this.service.detail(principal, req.id ?? 'unknown', id, this.asOf(query));
  }

  @Get('commitments')
  commitments(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<CommitmentList> {
    return this.service.commitments(principal, req.id ?? 'unknown', this.asOf(query));
  }

  @Get('clients')
  clients(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<ClientList> {
    return this.service.clients(principal, req.id ?? 'unknown', this.asOf(query));
  }
}
