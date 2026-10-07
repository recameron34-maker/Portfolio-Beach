import { Body, Controller, Get, Param, Patch, Req } from '@nestjs/common';
import type { Principal } from '@pb/adapters';
import { featureFlagPatch } from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { ProblemError } from '../common/problem.js';
import { parseOrProblem } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import { FlagsService } from './flags.service.js';

/** Extends the driver's row shape so it can type a raw query result. */
interface FlagRow extends Record<string, unknown> {
  key: string;
  enabled: boolean;
  description: string;
}

@Controller('api/v1/flags')
export class FlagsController {
  constructor(
    private readonly flags: FlagsService,
    private readonly db: DbService,
  ) {}

  @Get()
  async list(): Promise<{ flags: FlagRow[] }> {
    return { flags: await this.flags.list() };
  }

  /** Config change: platform admins only, audited with the reason (SEC-11.1). */
  @Roles('platform_admin')
  @Patch(':key')
  async set(
    @Param('key') key: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<FlagRow> {
    const patch = parseOrProblem(featureFlagPatch, body, 'flag update');
    if (!/^[a-z0-9_.]{3,64}$/.test(key)) throw new ProblemError(404, 'not-found', 'Unknown flag');
    const updated = await this.db.run(principal, req.id ?? 'unknown', async (tx, audit) => {
      const r = await tx.execute<FlagRow>(this.flags.updateSql(key, patch.enabled));
      const row = r.rows[0];
      if (row === undefined) return null;
      await audit({
        action: 'feature_flag.set',
        entity: 'ops.feature_flag',
        reason: patch.reason,
        details: { key, enabled: patch.enabled },
      });
      return row;
    });
    if (updated === null) throw new ProblemError(404, 'not-found', 'Unknown flag');
    this.flags.invalidate();
    return updated;
  }
}
