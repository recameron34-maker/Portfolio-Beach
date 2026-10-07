import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertProductionSafe, SystemClock } from '@pb/adapters';
import type { AdapterSet, Clock } from '@pb/adapters';
import {
  FixtureLookThroughProvider,
  FixtureMailSource,
  LocalFolderAccountingSystem,
  LocalFolderDocumentStore,
  MockAiClient,
  MockIdentityProvider,
  SyntheticBenchmarkProvider,
} from '@pb/adapters/mocks';
import type { MockUser } from '@pb/adapters/mocks';
import { createDb, dbConfigFromEnv, migrate } from '@pb/db';
import type { DbHandle } from '@pb/db';
import type { ApiConfig } from './config.js';
import { createLogger } from './common/logging.js';
import type { Logger } from './common/logging.js';

export interface Runtime {
  config: ApiConfig;
  db: DbHandle;
  adapters: AdapterSet;
  logger: Logger;
  definitions: Record<string, unknown>;
}

export interface RuntimeOverrides {
  db?: DbHandle;
  adapters?: Partial<AdapterSet>;
  logger?: Logger;
  mockUsers?: readonly MockUser[];
  clock?: Clock;
}

interface DatasetUsers {
  users?: {
    id: string;
    externalId: string;
    displayName: string;
    roles: MockUser['roles'];
    clientIds?: string[];
  }[];
}

/** Mock sign-in users come from the synthetic dataset so the role switcher and the seeded database agree. */
export function loadMockUsers(path: string): MockUser[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as DatasetUsers;
  return (parsed.users ?? []).map((u) => ({
    id: u.id,
    externalId: u.externalId,
    displayName: u.displayName,
    roles: u.roles,
    clientIds: u.clientIds ?? [],
  }));
}

export function loadDefinitions(configDir: string): Record<string, unknown> {
  const path = join(configDir, 'definitions.json');
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : {};
}

/**
 * Builds everything the Nest module needs. In the prototype every adapter is a mock; the
 * production guard runs before anything else so a misconfigured deployment stops here (SEC-17.6).
 */
export async function buildRuntime(
  config: ApiConfig,
  overrides: RuntimeOverrides = {},
): Promise<Runtime> {
  const logger = overrides.logger ?? createLogger(config.PB_LOG_LEVEL);
  const clock = overrides.clock ?? new SystemClock();
  const mockUsers = overrides.mockUsers ?? loadMockUsers(config.PB_MOCK_USERS);
  if (config.NODE_ENV !== 'production') {
    // Local folder mocks need their roots; creating them is harmless on a developer machine or in CI.
    for (const dir of [config.PB_DOCUMENT_ROOT, config.PB_ACCOUNTING_ROOT])
      mkdirSync(dir, { recursive: true });
  }
  const adapters: AdapterSet = {
    clock,
    identity: new MockIdentityProvider(mockUsers),
    documents: new LocalFolderDocumentStore(config.PB_DOCUMENT_ROOT),
    mail: new FixtureMailSource([]),
    accounting: new LocalFolderAccountingSystem(config.PB_ACCOUNTING_ROOT),
    lookThrough: new FixtureLookThroughProvider([]),
    ai: new MockAiClient(),
    benchmarks: new SyntheticBenchmarkProvider(),
    ...overrides.adapters,
  };
  assertProductionSafe(adapters, {
    NODE_ENV: config.NODE_ENV,
    PB_MOCK_IDENTITY: config.PB_MOCK_IDENTITY,
  });

  let db = overrides.db;
  if (db === undefined) {
    const dbConfig = dbConfigFromEnv({
      PB_DATABASE_URL: config.PB_DATABASE_URL,
      PB_PGLITE_DIR: config.PB_PGLITE_DIR,
    });
    db = await createDb(dbConfig);
    const result = await migrate(db);
    logger.info(
      { applied: result.applied.length, skipped: result.skipped.length, kind: db.kind },
      'database migrated',
    );
  }
  if (mockUsers.length === 0 && adapters.identity.info.kind === 'mock') {
    logger.warn(
      { path: config.PB_MOCK_USERS },
      'no mock users found; run pnpm synth and pnpm db:seed:synthetic',
    );
  }
  return { config, db, adapters, logger, definitions: loadDefinitions(config.PB_CONFIG_DIR) };
}
