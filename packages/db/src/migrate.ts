import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DbHandle } from './client.js';

export interface Migration {
  id: string;
  name: string;
  sql: string;
  hash: string;
}

/** Default location of the numbered SQL migrations (resolved relative to this package). */
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), 'utf8');
      return {
        id: file.slice(0, 4),
        name: file.slice(5, -4),
        sql,
        hash: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies migrations forward-only in file order, each in its own transaction, recording id, name
 * and content hash in ops.schema_migration. A changed hash on an applied migration is an error:
 * migrations are immutable once applied (docs/03 section 6).
 */
export async function migrate(
  handle: DbHandle,
  migrations: Migration[] = loadMigrations(),
): Promise<MigrationResult> {
  await handle.exec(`
    create schema if not exists ops;
    create table if not exists ops.schema_migration (
      id text primary key,
      name text not null,
      hash text not null,
      applied_at timestamptz not null default now()
    );
  `);
  const rows = await handle.query<{ id: string; hash: string }>(
    'select id, hash from ops.schema_migration',
  );
  const applied = new Map(rows.map((r) => [r.id, r.hash]));
  const result: MigrationResult = { applied: [], skipped: [] };
  for (const m of migrations) {
    const existing = applied.get(m.id);
    if (existing !== undefined) {
      if (existing !== m.hash) {
        throw new Error(
          `migration ${m.id}_${m.name} was applied with a different content hash; migrations are immutable`,
        );
      }
      result.skipped.push(m.id);
      continue;
    }
    try {
      await handle.exec(
        `begin;\n${m.sql}\ninsert into ops.schema_migration (id, name, hash) values ('${m.id}', '${m.name.replace(/'/g, "''")}', '${m.hash}');\ncommit;`,
      );
    } catch (error) {
      // Leave the connection usable: a failed migration must not poison later statements.
      await handle.exec('rollback').catch(() => undefined);
      throw new Error(
        `migration ${m.id}_${m.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    result.applied.push(m.id);
  }
  return result;
}
