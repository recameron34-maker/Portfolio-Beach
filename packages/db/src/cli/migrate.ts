import { createDb, dbConfigFromEnv } from '../client.js';
import { migrate } from '../migrate.js';

const config = dbConfigFromEnv();
const handle = await createDb(
  config.kind === 'pglite' && config.dataDir === undefined
    ? { kind: 'pglite', dataDir: '.pglite/dev' }
    : config,
);
const result = await migrate(handle);
process.stdout.write(
  `db:migrate (${handle.kind}): applied [${result.applied.join(', ')}], already applied [${result.skipped.join(', ')}]\n`,
);
await handle.close();
