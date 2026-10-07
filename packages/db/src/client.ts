import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Db = PgliteDatabase<Schema> | NodePgDatabase<Schema>;

export type DbConfig =
  | { kind: 'pglite'; dataDir?: string }
  | { kind: 'postgres'; connectionString: string; max?: number };

export interface DbHandle {
  db: Db;
  kind: DbConfig['kind'];
  /** Raw SQL for migrations and tests. Statements run as the connection's own role. */
  exec: (sql: string) => Promise<void>;
  query: <T extends object>(sql: string, params?: unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
}

/**
 * Opens a database. PGlite (in-process Postgres) is the prototype default and the only option in
 * tests; node-postgres is the production path (docs/decisions/0005). Both return the same handle.
 */
export async function createDb(config: DbConfig): Promise<DbHandle> {
  if (config.kind === 'pglite') {
    const client = config.dataDir === undefined ? new PGlite() : new PGlite(config.dataDir);
    await client.waitReady;
    const db = drizzlePglite(client, { schema });
    return {
      db,
      kind: 'pglite',
      exec: async (text) => {
        await client.exec(text);
      },
      query: async <T extends object>(text: string, params: unknown[] = []) =>
        (await client.query<T>(text, params)).rows,
      close: () => client.close(),
    };
  }
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max ?? 10 });
  const db = drizzlePg(pool, { schema });
  return {
    db,
    kind: 'postgres',
    exec: async (text) => {
      await pool.query(text);
    },
    query: async <T extends object>(text: string, params: unknown[] = []) =>
      (await pool.query(text, params)).rows as T[],
    close: () => pool.end(),
  };
}

export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const url = env.PB_DATABASE_URL;
  if (url !== undefined && url.length > 0) return { kind: 'postgres', connectionString: url };
  const dataDir = env.PB_PGLITE_DIR;
  return dataDir !== undefined && dataDir.length > 0
    ? { kind: 'pglite', dataDir }
    : { kind: 'pglite' };
}
