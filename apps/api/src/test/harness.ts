import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { AppRole } from '@pb/db';
import { loadSyntheticDataset } from '@pb/db';
import { createTestDb } from '@pb/db/testing';
import { generateDataset, generateDocuments } from '@pb/synthetic';
import type { DocumentSet } from '@pb/synthetic';
import type { SyntheticDataset } from '@pb/db';
import { FixedClock } from '@pb/adapters';
import { createApp } from '../app.js';
import { buildRuntime } from '../composition.js';
import type { Runtime } from '../composition.js';
import { createLogger } from '../common/logging.js';
import { loadConfig } from '../config.js';

export interface Harness {
  app: INestApplication;
  runtime: Runtime;
  dataset: SyntheticDataset;
  /** The synthetic document set written to PB_DOCUMENT_ROOT before the runtime was built; its expectations drive assertions. */
  documents: DocumentSet;
  http: () => request.Agent;
  /** Bearer credential for the first user holding a role (or the named external id). */
  as: (roleOrExternalId: string) => string;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  /** Top-level keys of config/definitions.json to leave out, to prove a missing key is a 500. */
  withoutDefinitions?: readonly string[];
  /** Replaces config/accounting_layout.json, to prove a malformed layout is a 500. */
  accountingLayout?: unknown;
  /** Feature flags switched on through the flags endpoint as platform_admin once the app is up (audited), such as 'ai.extraction'. */
  enableFlags?: readonly string[];
}

/**
 * Writes a document set the way `pnpm synth:documents` does: every file under inbox/ (both names
 * of the duplicate pair) and one truth sidecar per content hash under truth/, so the composition
 * loads the truths and the local folder store lists the inbox.
 */
export function writeDocumentRoot(root: string, set: DocumentSet): void {
  const inbox = join(root, 'inbox');
  const truth = join(root, 'truth');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(truth, { recursive: true });
  const written = new Set<string>();
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

/** An API over a fresh in-memory database seeded with the small synthetic profile. */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dataset = generateDataset({ profile: 'small', seed: 42 });
  const db = await createTestDb();
  await loadSyntheticDataset(db, dataset);
  const scratch = mkdtempSync(join(tmpdir(), 'pb-api-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    PB_LOG_LEVEL: 'silent',
    PB_CONFIG_DIR: new URL('../../../../config/', import.meta.url).pathname,
    PB_DOCUMENT_ROOT: join(scratch, 'documents'),
    PB_ACCOUNTING_ROOT: join(scratch, 'accounting'),
    PB_DROP_ROOT: join(scratch, 'drops'),
  });
  // The document root is written before the runtime is built, so the composition loads the
  // truths and registers the prototype models over them.
  const documents = generateDocuments(dataset);
  writeDocumentRoot(config.PB_DOCUMENT_ROOT, documents);
  const runtime = await buildRuntime(config, {
    db,
    logger: createLogger('silent'),
    clock: new FixedClock(`${dataset.asOf}T12:00:00Z`),
    mockUsers: dataset.users.map((u) => ({
      id: u.id,
      externalId: u.externalId,
      displayName: u.displayName,
      roles: u.roles,
      clientIds: u.clientIds,
    })),
  });
  const dropped = new Set(options.withoutDefinitions ?? []);
  runtime.definitions = Object.fromEntries(
    Object.entries(runtime.definitions).filter(([key]) => !dropped.has(key)),
  );
  if ('accountingLayout' in options) runtime.accountingLayout = options.accountingLayout;
  const app = await createApp(runtime);
  const server = app.getHttpServer() as Parameters<typeof request>[0];
  const as = (roleOrExternalId: string): string => {
    const byId = dataset.users.find((u) => u.externalId === roleOrExternalId);
    const user = byId ?? dataset.users.find((u) => u.roles.includes(roleOrExternalId as AppRole));
    if (!user) throw new Error(`no user for ${roleOrExternalId}`);
    return `Bearer ${user.externalId}`;
  };
  for (const key of options.enableFlags ?? []) {
    await request(server)
      .patch(`/api/v1/flags/${key}`)
      .set('authorization', as('platform_admin'))
      .set('x-request-id', `req-harness-flag-${key}`)
      .send({ enabled: true, reason: 'enabled by the test harness' })
      .expect(200);
  }
  return {
    app,
    runtime,
    dataset,
    documents,
    http: () => request(server),
    as,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
