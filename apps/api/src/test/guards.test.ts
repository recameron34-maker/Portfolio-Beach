import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ProductionGuardError } from '@pb/adapters';
import { createLogger, FORBIDDEN_LOG_KEYS, redactDeep } from '../common/logging.js';
import { buildRuntime } from '../composition.js';
import { loadConfig } from '../config.js';

describe('startup guard (docs/17 section 6, SEC-17.6)', () => {
  it('refuses to build a production runtime with the prototype mocks', async () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PB_MOCK_IDENTITY: 'false',
      PB_LOG_LEVEL: 'silent',
    });
    await expect(buildRuntime(config, { mockUsers: [] })).rejects.toBeInstanceOf(
      ProductionGuardError,
    );
  });
  it('refuses the mock identity flag in production even before adapters are considered', async () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PB_MOCK_IDENTITY: 'true',
      PB_LOG_LEVEL: 'silent',
    });
    await expect(buildRuntime(config, { mockUsers: [] })).rejects.toThrow(/mock identity flag/);
  });
  it('rejects unknown log levels and malformed ports', () => {
    expect(() => loadConfig({ PB_LOG_LEVEL: 'loud' })).toThrow();
    expect(() => loadConfig({ PORT: '99999' })).toThrow();
  });
});

describe('log redaction (docs/17 section 7, SEC-11.4)', () => {
  it('removes forbidden keys at any depth', () => {
    const out = redactDeep({
      request_id: 'r1',
      amount: '1000000.00',
      nested: { body: 'Dear sponsor', bank_details: { iban: 'x' }, ok: 1 },
      list: [{ prompt: 'extract', fine: true }],
    }) as Record<string, unknown>;
    expect(out.amount).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).body).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).bank_details).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
    expect((out.list as Record<string, unknown>[])[0]?.prompt).toBe('[redacted]');
  });

  it('never writes a forbidden field value to the log stream', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const logger = createLogger('info', sink);
    const payload: Record<string, unknown> = { request_id: 'r2' };
    for (const key of FORBIDDEN_LOG_KEYS) payload[key] = `SECRET-${key}`;
    payload.deep = { more: { subject: 'SECRET-subject-deep', amount: 'SECRET-amount-deep' } };
    logger.info(payload, 'test line');
    logger.flush?.();
    await new Promise((r) => setTimeout(r, 20));
    const text = lines.join('');
    expect(text).toContain('r2');
    expect(text).not.toContain('SECRET-');
  });
});
