import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { AppRole } from '@pb/db';
import { loadSyntheticDataset } from '@pb/db';
import { createTestDb } from '@pb/db/testing';
import { generateDataset } from '@pb/synthetic';
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
  http: () => request.Agent;
  /** Bearer credential for the first user holding a role (or the named external id). */
  as: (roleOrExternalId: string) => string;
  close: () => Promise<void>;
}

/** An API over a fresh in-memory database seeded with the small synthetic profile. */
export async function startHarness(): Promise<Harness> {
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
  });
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
  const app = await createApp(runtime);
  const server = app.getHttpServer() as Parameters<typeof request>[0];
  return {
    app,
    runtime,
    dataset,
    http: () => request(server),
    as: (roleOrExternalId) => {
      const byId = dataset.users.find((u) => u.externalId === roleOrExternalId);
      const user = byId ?? dataset.users.find((u) => u.roles.includes(roleOrExternalId as AppRole));
      if (!user) throw new Error(`no user for ${roleOrExternalId}`);
      return `Bearer ${user.externalId}`;
    },
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
