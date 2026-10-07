import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { is, Table } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { createTestDb } from './testing.js';
import type { DbHandle } from './client.js';
import * as schema from './schema/index.js';

/**
 * The SQL migrations are the source of truth; the Drizzle definitions are a typed mirror. This test
 * fails when either side changes without the other (docs/decisions/0005).
 */
describe('schema drift', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });

  const tables = Object.values(schema).filter((v) => is(v, Table)) as PgTable[];

  it('mirrors at least the tables the API needs', () => {
    expect(tables.length).toBeGreaterThanOrEqual(30);
  });

  for (const table of tables) {
    const config = getTableConfig(table);
    const name = config.name;
    const schemaName = config.schema ?? 'public';
    it(`${schemaName}.${name} has exactly the columns the migration created`, async () => {
      const rows = await handle.query<{ column_name: string }>(
        'select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position',
        [schemaName, name],
      );
      expect(rows.length, `table ${schemaName}.${name} missing in database`).toBeGreaterThan(0);
      const inDb = rows.map((r) => r.column_name).sort();
      const inDrizzle = config.columns.map((c) => c.name).sort();
      expect(inDrizzle).toEqual(inDb);
    });
  }
});
