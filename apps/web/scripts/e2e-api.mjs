// Starts the API for end-to-end tests: fresh in-process database, small synthetic profile, mock identity.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateDataset } from '@pb/synthetic';
import { createDb, loadSyntheticDataset, migrate } from '@pb/db';
import { FixedClock } from '@pb/adapters';
import { buildRuntime } from '../../api/dist/composition.js';
import { createApp } from '../../api/dist/app.js';
import { loadConfig } from '../../api/dist/config.js';

const dir = process.env.PB_E2E_DIR ?? '.e2e';
mkdirSync(dir, { recursive: true });
const dataset = generateDataset({ profile: 'small', seed: 42 });
writeFileSync(join(dir, 'dataset.json'), JSON.stringify(dataset));

const db = await createDb({ kind: 'pglite' });
await migrate(db);
await loadSyntheticDataset(db, dataset);

const config = loadConfig({
  NODE_ENV: 'test',
  PORT: process.env.PORT ?? '3101',
  PB_LOG_LEVEL: 'warn',
  PB_MOCK_USERS: join(dir, 'dataset.json'),
  PB_CONFIG_DIR: new URL('../../../config/', import.meta.url).pathname,
  PB_DOCUMENT_ROOT: join(dir, 'documents'),
  PB_ACCOUNTING_ROOT: join(dir, 'accounting'),
});
const runtime = await buildRuntime(config, {
  db,
  clock: new FixedClock(`${dataset.asOf}T12:00:00Z`),
});
const app = await createApp(runtime);
await app.listen(config.PORT, '127.0.0.1');
process.stdout.write(
  `e2e api listening on ${config.PORT}; dataset at ${join(dir, 'dataset.json')}\n`,
);
