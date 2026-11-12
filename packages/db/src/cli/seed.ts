import { readFileSync } from 'node:fs';
import { createDb, dbConfigFromEnv } from '../client.js';
import { DEV_FIELD_KEY, FieldCipher, fieldKeyFromEnv } from '../fieldCrypto.js';
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
// The wire register's bank details are encrypted with the key the API of this environment reads
// (PB_FIELD_KEY_HEX, SEC-12.2), so what the seed writes is what that API can decrypt. The
// prototype key is the fallback outside production only, as in the API (apps/api
// common/fieldCipher.ts); a key that is set but malformed is an error, never a fallback. Decided
// before the database is opened: a refusal writes nothing.
const fieldKey = fieldKeyFromEnv(process.env);
if (fieldKey === null && process.env.NODE_ENV === 'production') {
  process.stderr.write(
    'db:seed:synthetic refuses to encrypt with the prototype field key in production: set PB_FIELD_KEY_HEX\n',
  );
  process.exit(1);
}
const cipher = new FieldCipher(fieldKey ?? DEV_FIELD_KEY);
const handle = await createDb(
  config.kind === 'pglite' && config.dataDir === undefined
    ? { kind: 'pglite', dataDir: '.pglite/dev' }
    : config,
);
await migrate(handle);
const dataset: unknown = JSON.parse(readFileSync(path, 'utf8'));
const counts = await loadSyntheticDataset(handle, dataset, { cipher });
process.stdout.write(
  `db:seed:synthetic: loaded ${path}: ${Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')}\n`,
);
await handle.close();
