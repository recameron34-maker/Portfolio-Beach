import pino from 'pino';
import type { Logger } from 'pino';
import { pgErrorSummary } from './pg-errors.js';

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

/**
 * An error as a log line may carry it (docs/17 section 7, SEC-11.4): its name and its message,
 * unless it came from the database. A database error is logged by its SQLSTATE code and the
 * constraint and table it names, never by its message, which carries the failed statement's
 * parameters (common/pg-errors.ts pgErrorSummary says why). Anything that is not an Error is
 * logged as its text.
 */
export function errorForLog(error: unknown): unknown {
  if (!(error instanceof Error)) return String(error);
  const database = pgErrorSummary(error);
  return database === undefined
    ? { name: error.name, message: error.message }
    : { name: error.name, message: 'database error', ...database };
}

/** Deep-redacts forbidden keys; arrays and nested objects are walked, cycles are cut. */
export function redactDeep(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, seen));
  if (value instanceof Error) return errorForLog(value);
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
