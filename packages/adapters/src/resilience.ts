import type { Clock } from './clock.js';
import type { KillSwitchReader } from './types.js';

export type AdapterErrorCode =
  'timeout' | 'circuit_open' | 'kill_switch' | 'exhausted' | 'not_idempotent';

export class AdapterError extends Error {
  constructor(
    message: string,
    public readonly code: AdapterErrorCode,
    public readonly adapter: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AdapterError';
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** How long the circuit stays open before one trial call is allowed. */
  resetAfterMs: number;
  clock: Clock;
}

export type CircuitState = 'closed' | 'open' | 'half_open';

/** Classic circuit breaker: closed, open after N consecutive failures, half-open after the reset period. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;

  constructor(private readonly options: CircuitBreakerOptions) {}

  get state(): CircuitState {
    if (this.openedAt === null) return 'closed';
    return this.options.clock.nowMs() - this.openedAt >= this.options.resetAfterMs
      ? 'half_open'
      : 'open';
  }

  /** True when a call may proceed; a half-open circuit admits exactly one trial call. */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'half_open' && !this.trialInFlight) {
      this.trialInFlight = true;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }

  recordFailure(): void {
    this.failures++;
    this.trialInFlight = false;
    if (this.failures >= this.options.failureThreshold) this.openedAt = this.options.clock.nowMs();
  }
}

export interface ResilienceOptions {
  timeoutMs: number;
  /** Retries are only attempted when the operation is idempotent (docs/17 section 5). */
  idempotent: boolean;
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Jitter source in [0, 1); injected so tests are deterministic. */
  jitter?: () => number;
  sleep?: (ms: number) => Promise<void>;
  breaker?: CircuitBreaker;
  killSwitch?: { reader: KillSwitchReader; key: string };
  /** Decides whether an error is worth retrying (default: everything except AdapterError codes that never recover). */
  isRetryable?: (error: unknown) => boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps an adapter call with a timeout, retries with exponential backoff and jitter (idempotent
 * operations only), a circuit breaker and a kill switch (docs/17 section 5). Every outside call
 * goes through here.
 */
export async function withResilience<T>(
  adapter: string,
  operation: (signal: AbortSignal) => Promise<T>,
  options: ResilienceOptions,
): Promise<T> {
  if (
    options.killSwitch !== undefined &&
    !(await options.killSwitch.reader.isEnabled(options.killSwitch.key))
  ) {
    throw new AdapterError(
      `${adapter} is disabled by kill switch ${options.killSwitch.key}`,
      'kill_switch',
      adapter,
    );
  }
  const attempts = options.idempotent ? (options.retries ?? 3) + 1 : 1;
  const base = options.baseDelayMs ?? 200;
  const max = options.maxDelayMs ?? 5000;
  const jitter = options.jitter ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.breaker !== undefined && !options.breaker.tryAcquire()) {
      throw new AdapterError(`${adapter} circuit is open`, 'circuit_open', adapter);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const result = await Promise.race([
        operation(controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () =>
            reject(
              new AdapterError(
                `${adapter} timed out after ${options.timeoutMs} ms`,
                'timeout',
                adapter,
              ),
            ),
          );
        }),
      ]);
      options.breaker?.recordSuccess();
      return result;
    } catch (error) {
      lastError = error;
      options.breaker?.recordFailure();
      const retryable =
        options.isRetryable?.(error) ??
        !(
          error instanceof AdapterError &&
          (error.code === 'kill_switch' || error.code === 'circuit_open')
        );
      if (attempt === attempts || !retryable) break;
      const delay = Math.min(max, base * 2 ** (attempt - 1)) * (0.5 + jitter() * 0.5);
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastError instanceof AdapterError) throw lastError;
  throw new AdapterError(`${adapter} failed after ${attempts} attempt(s)`, 'exhausted', adapter, {
    cause: lastError,
  });
}
