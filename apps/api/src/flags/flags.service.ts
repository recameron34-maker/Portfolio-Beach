import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbHandle } from '@pb/db';
import type { KillSwitchReader } from '@pb/adapters';
import { DB_HANDLE } from '../common/tokens.js';

/**
 * Feature flags and kill switches from ops.feature_flag, read with a short cache so every adapter
 * call can check its switch cheaply (docs/17 section 5). Reads bypass RLS (flags are internal);
 * writes go through the caller's context so only platform admins can change them.
 */
@Injectable()
export class FlagsService implements KillSwitchReader {
  private cache: { at: number; flags: Map<string, boolean> } | null = null;
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  private async load(now: number): Promise<Map<string, boolean>> {
    if (this.cache !== null && now - this.cache.at < 5000) return this.cache.flags;
    const rows = await this.handle.query<{ key: string; enabled: boolean }>(
      'select key, enabled from ops.feature_flag',
    );
    const flags = new Map(rows.map((r) => [r.key, r.enabled]));
    this.cache = { at: now, flags };
    return flags;
  }

  invalidate(): void {
    this.cache = null;
  }

  async isEnabled(key: string, now: number = Date.now()): Promise<boolean> {
    return (await this.load(now)).get(key) ?? false;
  }

  async list(): Promise<{ key: string; enabled: boolean; description: string }[]> {
    return this.handle.query<{ key: string; enabled: boolean; description: string }>(
      'select key, enabled, description from ops.feature_flag order by key',
    );
  }

  /** SQL fragment for updating a flag inside a user transaction (RLS applies). */
  updateSql(key: string, enabled: boolean): ReturnType<typeof sql> {
    return sql`update ops.feature_flag set enabled = ${enabled} where key = ${key} returning key, enabled, description`;
  }
}
