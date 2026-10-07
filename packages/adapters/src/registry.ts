import type { Clock } from './clock.js';
import type {
  AccountingSystem,
  Adapter,
  AiModelClient,
  BenchmarkProvider,
  DocumentStore,
  IdentityProvider,
  LookThroughProvider,
  MailSource,
} from './types.js';

/** Everything the application reaches outside itself, resolved once at startup. */
export interface AdapterSet {
  clock: Clock;
  identity: IdentityProvider;
  documents: DocumentStore;
  mail: MailSource;
  accounting: AccountingSystem;
  lookThrough: LookThroughProvider;
  ai: AiModelClient;
  benchmarks: BenchmarkProvider;
}

export interface GuardEnvironment {
  NODE_ENV?: string | undefined;
  PB_MOCK_IDENTITY?: string | undefined;
}

export class ProductionGuardError extends Error {
  constructor(public readonly offenders: string[]) {
    super(`refusing to start in production with mock components: ${offenders.join(', ')}`);
    this.name = 'ProductionGuardError';
  }
}

function adaptersOf(set: AdapterSet): Adapter[] {
  return [
    set.identity,
    set.documents,
    set.mail,
    set.accounting,
    set.lookThrough,
    set.ai,
    set.benchmarks,
  ];
}

/**
 * Startup assertion (docs/17 section 6, SEC-17.6): in production no adapter may be a mock and mock
 * identity may not be enabled. Returns the offenders so a test can assert on them; throws so the
 * process never serves traffic.
 */
export function assertProductionSafe(set: AdapterSet, env: GuardEnvironment): void {
  if (env.NODE_ENV !== 'production') return;
  const offenders = adaptersOf(set)
    .filter((a) => a.info.kind === 'mock')
    .map((a) => a.info.name);
  if (env.PB_MOCK_IDENTITY === 'true') offenders.push('mock identity flag');
  if (offenders.length > 0) throw new ProductionGuardError(offenders);
}

/** Health of every adapter, for /health/ready and Integration Health (docs/15). */
export async function healthOf(
  set: AdapterSet,
): Promise<Record<string, { ok: boolean; detail?: string }>> {
  const out: Record<string, { ok: boolean; detail?: string }> = {};
  for (const a of adaptersOf(set)) {
    try {
      out[a.info.name] = await a.healthCheck();
    } catch (error) {
      out[a.info.name] = {
        ok: false,
        detail: error instanceof Error ? error.message : 'health check threw',
      };
    }
  }
  return out;
}
