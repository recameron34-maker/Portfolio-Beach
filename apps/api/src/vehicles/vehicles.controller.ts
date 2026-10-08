import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import type { ClientList, CommitmentList, VehicleDetail } from '@pb/contracts';
import { CurrentPrincipal } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ADAPTERS } from '../common/tokens.js';
import { asOfOrToday, requireUuid } from '../common/validate.js';
import { VehiclesService } from './vehicles.service.js';

@Controller('api/v1')
export class VehiclesController {
  constructor(
    private readonly service: VehiclesService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
  ) {}

  @Get('vehicles/:id')
  detail(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<VehicleDetail> {
    // A malformed id is simply not found: existence is never revealed, and the database never sees garbage.
    requireUuid(id, 'Vehicle not found');
    return this.service.detail(
      principal,
      req.id ?? 'unknown',
      id,
      asOfOrToday(query, this.adapters.clock),
    );
  }

  @Get('commitments')
  commitments(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<CommitmentList> {
    return this.service.commitments(
      principal,
      req.id ?? 'unknown',
      asOfOrToday(query, this.adapters.clock),
    );
  }

  @Get('clients')
  clients(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<ClientList> {
    return this.service.clients(
      principal,
      req.id ?? 'unknown',
      asOfOrToday(query, this.adapters.clock),
    );
  }
}
