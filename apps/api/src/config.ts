import { z } from 'zod';

/** Runtime configuration from the environment. No secrets are read here (SEC-4.6, docs/16). */
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  PB_DATABASE_URL: z.string().optional(),
  PB_PGLITE_DIR: z.string().default('.pglite/dev'),
  /** Prototype only. The production guard refuses 'true' when NODE_ENV is production. */
  PB_MOCK_IDENTITY: z.enum(['true', 'false']).default('true'),
  PB_MOCK_USERS: z.string().default('.synthetic/dataset.json'),
  PB_CONFIG_DIR: z.string().default('config'),
  PB_DOCUMENT_ROOT: z.string().default('.synthetic/documents'),
  PB_ACCOUNTING_ROOT: z.string().default('.synthetic/accounting'),
  PB_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
  PB_VERSION: z.string().default('0.1.0'),
});
export type ApiConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return configSchema.parse(env);
}
