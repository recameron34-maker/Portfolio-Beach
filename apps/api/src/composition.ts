import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
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
import {
  AiError,
  fixtureExtractor,
  keywordClassifier,
  loadExtractionSchemas,
  parseTruth,
} from '@pb/ai';
import type { ExtractionSchemas, Truth } from '@pb/ai';
import {
  closingChecklist,
  diligenceTemplates,
  lookthroughMapping,
  opsDropTemplates,
} from '@pb/contracts';
import type {
  ClosingChecklist,
  DiligenceTemplates,
  LookthroughMapping,
  OpsDropTemplates,
} from '@pb/contracts';
import { APP_ROLES, createDb, dbConfigFromEnv, migrate } from '@pb/db';
import type { DbHandle } from '@pb/db';
import { z } from 'zod';
import type { ApiConfig } from './config.js';
import { createLogger } from './common/logging.js';
import type { Logger } from './common/logging.js';
import { zodIssues } from './common/problem.js';
import { documentSettingsOf, extractionSettingsOf } from './documents/settings.js';

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
  /** config/extraction_schema.json as @pb/ai loads it, checked at startup: a bad schema file stops the process. */
  extractionSchemas: ExtractionSchemas;
  /** config/closing_checklist.json, checked at startup: the items every closing starts with (docs/04 M8). */
  closingChecklist: ClosingChecklist;
  /** config/diligence_templates.json, checked at startup: the tasks per deal type on entering Diligence (docs/04 M7). */
  diligenceTemplates: DiligenceTemplates;
  /** The recorded truths of <PB_DOCUMENT_ROOT>/truth/<contentHash>.json, the prototype extractor's fixtures (decision 0012). */
  truths: ReadonlyMap<string, Truth>;
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

/** config/closing_checklist.json: the required-document checklist of every closing (docs/04 M8, docs/18 section 12). */
export function loadClosingChecklist(configDir: string): ClosingChecklist {
  return loadStrict(configDir, 'closing_checklist.json', closingChecklist);
}

/** config/diligence_templates.json: the diligence tasks per deal type (docs/04 M7, docs/18 section 4). */
export function loadDiligenceTemplates(configDir: string): DiligenceTemplates {
  return loadStrict(configDir, 'diligence_templates.json', diligenceTemplates);
}

/** config/extraction_schema.json through @pb/ai's loader (docs/04 M4): a missing or unusable file stops the process. */
export function loadExtractionSchemaConfig(configDir: string): ExtractionSchemas {
  const fileName = 'extraction_schema.json';
  const path = join(configDir, fileName);
  if (!existsSync(path)) throw new Error(`config file is missing: ${fileName}`);
  try {
    return loadExtractionSchemas(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error instanceof AiError)
      throw new Error(`config file is not valid (${fileName}): ${error.message}`, { cause: error });
    throw error;
  }
}

const CONTENT_HASH_FILE = /^[0-9a-f]{64}\.json$/;

/**
 * The truth sidecars the synthetic document set wrote next to its inbox, keyed by content hash
 * (the file's base name): what the fixture-backed extractor answers for each document. A
 * missing folder means no fixtures, which is fine until documents are generated; a sidecar that
 * does not parse stops the process by name, since a half-read fixture would fail every run of
 * that document for no visible reason.
 */
export function loadTruths(documentRoot: string): Map<string, Truth> {
  const folder = join(documentRoot, 'truth');
  const truths = new Map<string, Truth>();
  if (!existsSync(folder)) return truths;
  for (const name of readdirSync(folder).sort()) {
    if (!CONTENT_HASH_FILE.test(name)) continue;
    try {
      truths.set(
        name.slice(0, -5),
        parseTruth(JSON.parse(readFileSync(join(folder, name), 'utf8'))),
      );
    } catch (error) {
      throw new Error(
        `truth sidecar is not usable (truth/${name}): ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return truths;
}

/**
 * The prototype models behind the mock client (decision 0012): the keyword classifier answers
 * the document_classifier prompt from the input, and the fixture extractor answers the
 * quarterly_extraction prompt from the recorded truth of the document's content hash. A client
 * that is not the mock is left as it is.
 */
export function registerPrototypeModels(
  ai: AdapterSet['ai'],
  truths: ReadonlyMap<string, Truth>,
): void {
  if (!(ai instanceof MockAiClient)) return;
  ai.register('document_classifier', keywordClassifier);
  ai.register('quarterly_extraction', fixtureExtractor(truths));
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
  const truths = loadTruths(config.PB_DOCUMENT_ROOT);
  registerPrototypeModels(adapters.ai, truths);
  logger.info({ truths: truths.size }, 'document truths loaded');

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
  const definitions = loadDefinitions(config.PB_CONFIG_DIR);
  // The document hub and the extraction engine read their blocks at every request; a bad block
  // is refused here, before anything is served (rule 9), with the same readers.
  documentSettingsOf(definitions);
  extractionSettingsOf(definitions);
  return {
    config,
    db,
    adapters,
    logger,
    definitions,
    accountingLayout: loadAccountingLayout(config.PB_CONFIG_DIR),
    lookthroughMapping: loadLookthroughMapping(config.PB_CONFIG_DIR),
    opsDropTemplates: loadOpsDropTemplates(config.PB_CONFIG_DIR),
    extractionSchemas: loadExtractionSchemaConfig(config.PB_CONFIG_DIR),
    closingChecklist: loadClosingChecklist(config.PB_CONFIG_DIR),
    diligenceTemplates: loadDiligenceTemplates(config.PB_CONFIG_DIR),
    truths,
  };
}
