import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertProductionSafe, SystemClock } from '@pb/adapters';
import type { AdapterSet, Clock } from '@pb/adapters';
import {
  FixtureMailSource,
  LocalFolderAccountingSystem,
  LocalFolderDocumentStore,
  LocalFolderDrop,
  LocalFolderLookThroughProvider,
  MockAiClient,
  MockIdentityProvider,
  SyntheticBenchmarkProvider,
} from '@pb/adapters/mocks';
import type { MockUser } from '@pb/adapters/mocks';
import { lookthroughMapping, opsDropTemplates } from '@pb/contracts';
import type { LookthroughMapping, OpsDropTemplates } from '@pb/contracts';
import { APP_ROLES, createDb, dbConfigFromEnv, migrate } from '@pb/db';
import type { DbHandle } from '@pb/db';
import { z } from 'zod';
import type { ApiConfig } from './config.js';
import { createLogger } from './common/logging.js';
import type { Logger } from './common/logging.js';
import { zodIssues } from './common/problem.js';

export interface Runtime {
  config: ApiConfig;
  db: DbHandle;
  adapters: AdapterSet;
  logger: Logger;
  definitions: Record<string, unknown>;
  /** config/accounting_layout.json as parsed JSON; validated where it is used (a bad layout is a 500 there). */
  accountingLayout: unknown;
  /** config/lookthrough_mapping.json, checked at startup: a bad mapping stops the process. */
  lookthroughMapping: LookthroughMapping;
  /** config/ops_drop_templates.json, checked at startup: a bad template file stops the process. */
  opsDropTemplates: OpsDropTemplates;
}

export interface RuntimeOverrides {
  db?: DbHandle;
  adapters?: Partial<AdapterSet>;
  logger?: Logger;
  mockUsers?: readonly MockUser[];
  clock?: Clock;
}

/**
 * The users block of the synthetic dataset. Roles are checked by value against the application
 * roles: the roles of a principal travel to Postgres as one comma-joined setting, so a role string
 * such as "viewer,service" from a users file would otherwise sign in as the system actor (SEC-5.3).
 */
const datasetUsers = z.object({
  users: z
    .array(
      z.object({
        id: z.string().min(1),
        externalId: z.string().min(1),
        displayName: z.string().min(1),
        roles: z.array(z.enum(APP_ROLES)),
        clientIds: z.array(z.string().min(1)).optional(),
      }),
    )
    .optional(),
});

/** Mock sign-in users come from the synthetic dataset so the role switcher and the seeded database agree. */
export function loadMockUsers(path: string): MockUser[] {
  if (!existsSync(path)) return [];
  const parsed = datasetUsers.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    const issues = zodIssues(parsed.error)
      .map((i) => `${i.path}: ${i.message}`)
      .join('; ');
    throw new Error(`mock users file is not valid (${path}): ${issues}`);
  }
  return (parsed.data.users ?? []).map((u) => ({
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

/** The accounting export layout (docs/04 M2); an absent file reads as an empty object, which fails validation at use. */
export function loadAccountingLayout(configDir: string): unknown {
  const path = join(configDir, 'accounting_layout.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : {};
}

/**
 * Reads a config file against its contract and refuses to start on a bad one, naming the file and
 * the path of each problem, never a value: an intake that read a half-right mapping or template
 * would stage wrong rows for everyone (rule 9), and a missing file is the same mistake.
 */
function loadStrict<T>(configDir: string, fileName: string, schema: z.ZodType<T>): T {
  const path = join(configDir, fileName);
  if (!existsSync(path)) throw new Error(`config file is missing: ${fileName}`);
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    const issues = zodIssues(parsed.error)
      .map((i) => `${i.path}: ${i.message}`)
      .join('; ');
    throw new Error(`config file is not valid (${fileName}): ${issues}`);
  }
  return parsed.data;
}

/** config/lookthrough_mapping.json: provider labels onto taxonomy codes (docs/04 M1, M2). */
export function loadLookthroughMapping(configDir: string): LookthroughMapping {
  return loadStrict(configDir, 'lookthrough_mapping.json', lookthroughMapping);
}

/** config/ops_drop_templates.json: workbook templates by signature (docs/04 M2 ops-drop-import). */
export function loadOpsDropTemplates(configDir: string): OpsDropTemplates {
  return loadStrict(configDir, 'ops_drop_templates.json', opsDropTemplates);
}

/** The drop folders under PB_DROP_ROOT, one per intake that reads files from a folder. */
export function dropFolders(dropRoot: string): {
  weekly: string;
  opsDrop: string;
  lookthrough: string;
} {
  return {
    weekly: join(dropRoot, 'weekly'),
    opsDrop: join(dropRoot, 'ops-drop'),
    lookthrough: join(dropRoot, 'lookthrough'),
  };
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
  const drops = dropFolders(config.PB_DROP_ROOT);
  if (config.NODE_ENV !== 'production') {
    // Local folder mocks need their roots; creating them is harmless on a developer machine or in CI.
    for (const dir of [
      config.PB_DOCUMENT_ROOT,
      config.PB_ACCOUNTING_ROOT,
      join(drops.weekly, 'in'),
      join(drops.opsDrop, 'in'),
      drops.lookthrough,
    ])
      mkdirSync(dir, { recursive: true });
  }
  const adapters: AdapterSet = {
    clock,
    identity: new MockIdentityProvider(mockUsers),
    documents: new LocalFolderDocumentStore(config.PB_DOCUMENT_ROOT),
    mail: new FixtureMailSource([]),
    accounting: new LocalFolderAccountingSystem(config.PB_ACCOUNTING_ROOT),
    weeklyDrop: new LocalFolderDrop('weekly', drops.weekly, ['.csv']),
    opsDrop: new LocalFolderDrop('ops_drop', drops.opsDrop, ['.xlsx']),
    lookThrough: new LocalFolderLookThroughProvider(drops.lookthrough),
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
  return {
    config,
    db,
    adapters,
    logger,
    definitions: loadDefinitions(config.PB_CONFIG_DIR),
    accountingLayout: loadAccountingLayout(config.PB_CONFIG_DIR),
    lookthroughMapping: loadLookthroughMapping(config.PB_CONFIG_DIR),
    opsDropTemplates: loadOpsDropTemplates(config.PB_CONFIG_DIR),
  };
}
