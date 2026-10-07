import { rmSync } from 'node:fs';
import { createDb, dbConfigFromEnv } from '../client.js';
import { migrate } from '../migrate.js';

/** Drops the local PGlite database and re-applies every migration. Refuses to touch a real Postgres. */
const config = dbConfigFromEnv();
if (config.kind !== 'pglite') {
  process.stderr.write(
    'db:reset only works on the local PGlite database; real databases are never reset from a script\n',
  );
  process.exit(1);
}
const dataDir = config.dataDir ?? '.pglite/dev';
rmSync(dataDir, { recursive: true, force: true });
const handle = await createDb({ kind: 'pglite', dataDir });
const result = await migrate(handle);
process.stdout.write(`db:reset: recreated ${dataDir}, applied [${result.applied.join(', ')}]\n`);
await handle.close();
