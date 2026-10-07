import pino from 'pino';
import type { Logger } from 'pino';

/**
 * Keys that never reach a log line, at any depth (docs/17 section 7, SEC-11.4): document text,
 * mail content, AI prompts and outputs, money values, bank details, credentials.
 */
export const FORBIDDEN_LOG_KEYS: readonly string[] = [
  'body',
  'text',
  'content',
  'prompt',
  'output',
  'completion',
  'amount',
  'fair_value',
  'fairValue',
  'nav',
  'bank_details',
  'bankDetails',
  'account_number',
  'routing',
  'iban',
  'swift',
  'authorization',
  'cookie',
  'token',
  'password',
  'secret',
  'email_body',
  'subject',
];

const REDACTED = '[redacted]';

/** Deep-redacts forbidden keys; arrays and nested objects are walked, cycles are cut. */
export function redactDeep(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, seen));
  if (value instanceof Error) return { name: value.name, message: value.message };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] =
      FORBIDDEN_LOG_KEYS.includes(k.toLowerCase()) || FORBIDDEN_LOG_KEYS.includes(k)
        ? REDACTED
        : redactDeep(v, seen);
  }
  return out;
}

export function createLogger(level: string, destination?: pino.DestinationStream): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: { service: 'pb-api' },
    formatters: {
      log: (obj) => redactDeep(obj) as Record<string, unknown>,
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

export type { Logger };
