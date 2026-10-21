// Starts the API for end-to-end tests: fresh in-process database, small synthetic profile, mock identity.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateDataset, generateDocuments } from '@pb/synthetic';
import { createDb, loadSyntheticDataset, migrate } from '@pb/db';
import { FixedClock } from '@pb/adapters';
import { buildRuntime } from '../../api/dist/composition.js';
import { createApp } from '../../api/dist/app.js';
import { loadConfig } from '../../api/dist/config.js';

const dir = process.env.PB_E2E_DIR ?? '.e2e';
mkdirSync(dir, { recursive: true });
const dataset = generateDataset({ profile: 'small', seed: 42 });
writeFileSync(join(dir, 'dataset.json'), JSON.stringify(dataset));

/**
 * The synthetic document set the hub indexes, written the way `pnpm synth:documents` and the
 * API harness write it: every PDF under inbox/ (both names of the duplicate pair) and one truth
 * sidecar per content hash under truth/, before the runtime is built so the composition loads
 * the truths and registers the prototype models over them.
 */
function writeDocumentRoot(root, set) {
  rmSync(root, { recursive: true, force: true });
  const inbox = join(root, 'inbox');
  const truth = join(root, 'truth');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(truth, { recursive: true });
  const written = new Set();
  for (const doc of set.documents) {
    writeFileSync(join(inbox, doc.fileName), doc.bytes);
    if (written.has(doc.truth.contentHash)) continue;
    written.add(doc.truth.contentHash);
    writeFileSync(
      join(truth, `${doc.truth.contentHash}.json`),
      `${JSON.stringify(doc.truth, null, 2)}\n`,
    );
  }
}

const documentRoot = join(dir, 'documents');
writeDocumentRoot(documentRoot, generateDocuments(dataset));

const db = await createDb({ kind: 'pglite' });
await migrate(db);
await loadSyntheticDataset(db, dataset);

const config = loadConfig({
  NODE_ENV: 'test',
  PORT: process.env.PORT ?? '3101',
  PB_LOG_LEVEL: 'warn',
  PB_MOCK_USERS: join(dir, 'dataset.json'),
  PB_CONFIG_DIR: new URL('../../../config/', import.meta.url).pathname,
  PB_DOCUMENT_ROOT: documentRoot,
  PB_ACCOUNTING_ROOT: join(dir, 'accounting'),
  PB_DROP_ROOT: join(dir, 'drops'),
});
const runtime = await buildRuntime(config, {
  db,
  clock: new FixedClock(`${dataset.asOf}T12:00:00Z`),
});
const app = await createApp(runtime);
await app.listen(config.PORT, '127.0.0.1');

/**
 * The extraction kill switch is off by default (migration 0003); the journeys need it on. It is
 * turned on the way the API harness does it: through the flags endpoint as a platform admin,
 * audited like any flag change (decision 0012).
 */
const admin = dataset.users.find((u) => u.roles.includes('platform_admin'));
if (admin === undefined) throw new Error('the synthetic dataset has no platform admin');
const flag = await fetch(`http://127.0.0.1:${config.PORT}/api/v1/flags/ai.extraction`, {
  method: 'PATCH',
  headers: {
    authorization: `Bearer ${admin.externalId}`,
    'content-type': 'application/json',
    accept: 'application/json',
  },
  body: JSON.stringify({ enabled: true, reason: 'enabled by the e2e API script' }),
});
if (!flag.ok)
  throw new Error(`could not enable ai.extraction: ${flag.status} ${await flag.text()}`);

process.stdout.write(
  `e2e api listening on ${config.PORT}; dataset at ${join(dir, 'dataset.json')}; documents at ${documentRoot}\n`,
);
