import { Controller, Get, Inject } from '@nestjs/common';
import type { AdapterSet } from '@pb/adapters';
import { healthOf } from '@pb/adapters';
import { ADAPTERS, CONFIG } from '../common/tokens.js';
import type { ApiConfig } from '../config.js';
import { Public } from '../auth/principal.js';
import { DbService } from '../db/db.service.js';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DbService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('live')
  live(): { status: 'ok'; version: string } {
    return { status: 'ok', version: this.config.PB_VERSION };
  }

  /** Readiness checks the database and every adapter (docs/17 section 7). */
  @Get('ready')
  async ready(): Promise<{
    status: 'ok' | 'degraded';
    version: string;
    checks: Record<string, { ok: boolean; detail?: string }>;
  }> {
    const checks: Record<string, { ok: boolean; detail?: string }> = {
      database: { ok: await this.db.ping() },
      ...(await healthOf(this.adapters)),
    };
    const ok = Object.values(checks).every((c) => c.ok);
    return { status: ok ? 'ok' : 'degraded', version: this.config.PB_VERSION, checks };
  }
}
