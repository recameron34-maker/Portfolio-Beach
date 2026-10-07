import { createDb } from './client.js';
import type { DbHandle } from './client.js';
import { migrate } from './migrate.js';

/** A fresh in-memory database with every migration applied. Tests own and close it. */
export async function createTestDb(): Promise<DbHandle> {
  const handle = await createDb({ kind: 'pglite' });
  await migrate(handle);
  return handle;
}
