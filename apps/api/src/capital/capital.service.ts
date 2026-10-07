import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@pb/adapters';
import type { CapitalNoticeDetail, CapitalNoticePage, capitalNoticeListQuery } from '@pb/contracts';
import type { z } from 'zod';

export type CapitalNoticeListOptions = Omit<z.infer<typeof capitalNoticeListQuery>, 'asOf'> & {
  asOf: string;
};
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
export class CapitalService {
  constructor(
    private readonly db: DbService,
    @Inject(DEFINITIONS) private readonly definitions: Definitions,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async list(
    _principal: Principal,
    _requestId: string,
    _opts: CapitalNoticeListOptions,
  ): Promise<CapitalNoticePage> {
    return notImplemented();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async detail(
    _principal: Principal,
    _requestId: string,
    _id: string,
    _asOf: string,
  ): Promise<CapitalNoticeDetail> {
    return notImplemented();
  }
}
