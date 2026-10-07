import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@pb/adapters';
import type { ClientList, CommitmentList, VehicleDetail } from '@pb/contracts';
import { DEFINITIONS } from '../common/tokens.js';
import { ProblemError } from '../common/problem.js';
import { DbService } from '../db/db.service.js';

/** Calculation settings from config/definitions.json (docs/03 section 4); only the keys this service reads. */
interface Definitions {
  priorYearPeriodEndToleranceDays?: number;
  [key: string]: unknown;
}

const notImplemented = (): never => {
  throw new ProblemError(501, 'not-implemented', 'This endpoint is not implemented yet');
};

@Injectable()
export class VehiclesService {
  constructor(
    private readonly db: DbService,
    @Inject(DEFINITIONS) private readonly definitions: Definitions,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async detail(
    _principal: Principal,
    _requestId: string,
    _id: string,
    _asOf: string,
  ): Promise<VehicleDetail> {
    return notImplemented();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async commitments(
    _principal: Principal,
    _requestId: string,
    _asOf: string,
  ): Promise<CommitmentList> {
    return notImplemented();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async clients(_principal: Principal, _requestId: string, _asOf: string): Promise<ClientList> {
    return notImplemented();
  }
}
