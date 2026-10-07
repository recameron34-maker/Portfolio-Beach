import { readFileSync } from 'node:fs';
import { createDb, dbConfigFromEnv } from '../client.js';
import { migrate } from '../migrate.js';
import { loadSyntheticDataset } from '../seed.js';

/** Loads a synthetic dataset (tools/synthetic output) into the local database. Synthetic data only. */
const [, , pathArg] = process.argv;
const path = pathArg ?? '.synthetic/dataset.json';
const config = dbConfigFromEnv();
if (config.kind === 'postgres' && process.env.PB_ALLOW_SEED_POSTGRES !== 'true') {
  process.stderr.write(
    'db:seed:synthetic refuses to seed a real Postgres unless PB_ALLOW_SEED_POSTGRES=true (DEV only, synthetic data only)\n',
  );
  process.exit(1);
}
const handle = await createDb(
  config.kind === 'pglite' && config.dataDir === undefined
    ? { kind: 'pglite', dataDir: '.pglite/dev' }
    : config,
);
await migrate(handle);
const dataset: unknown = JSON.parse(readFileSync(path, 'utf8'));
const counts = await loadSyntheticDataset(handle, dataset);
process.stdout.write(
  `db:seed:synthetic: loaded ${path}: ${Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')}\n`,
);
await handle.close();
